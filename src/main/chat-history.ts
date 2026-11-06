import { createHash } from 'node:crypto'
import type { ChatRange } from '../shared/types'
import { Field, HistoryPage, ImMessage, Json, cardOf, decode, mediaInfoOf, parseMessage, propertiesOf, referenceOf } from './chat-api'
import { ExportEntry, ExportMedia, ExportMessage, ExportReaction, MediaKind, MediaSecret } from './chat-export-html'

/** TikTok said stop (rate limit, check): nothing is retried and the pull is given up. */
export class Fatal extends Error {}

/** Messages per request: the server cuts any bigger size down to this (measured on a live account). */
export const PAGE = 50
const MAX_REQUESTS = 100000

export interface PullOptions {
  /** requests in flight at once */
  concurrency: number
  /** tries per request before the whole pull is given up */
  attempts?: number
  cancelled(): boolean
  progress?(messages: number, requests: number): void
}

export interface PullResult {
  /** oldest first, every message once */
  messages: ImMessage[]
  requests: number
}

/**
 * One walk down the history. It owns the positions between `bound` (where the chain below starts) and `frontier`.
 * A position is the server's own clock for the message: it grows with every message but has gaps, so a chat cannot be cut
 * into equal parts by counting; chains are cut by position instead, and the pieces are checked against each other.
 */
interface Chain {
  /** where the next request starts: the server answers with the page just below it */
  frontier: bigint
  bound: bigint
  /** positions per message on the last page: tells how many messages may be left before `bound` */
  gap: bigint
  done: boolean
}
interface Seen { n: number; lo: bigint; hi: bigint; more: boolean }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Messages (oldest first) that fall into the range; `toMs` turns a message time into ms. */
export function selectRange(messages: ImMessage[], range: ChatRange): ImMessage[] {
  if (range.mode === 'last') return messages.slice(-range.count)
  if (range.mode === 'time') return messages.filter((m) => { const t = toMs(m.time); return (range.from === undefined || t >= range.from) && (range.to === undefined || t <= range.to) })
  return messages
}

/**
 * Walks down from the newest page, one request after another, until `enough(page, total)` says the range is covered.
 * Used for «last N» and time spans: a few pages instead of the whole history, so it is quicker than the full pull.
 * Returns what was pulled (oldest first), a bit more than the range; `selectRange` cuts it.
 */
export async function pullRecent(ask: (anchor: bigint, limit: number) => Promise<HistoryPage>, o: { enough(page: ImMessage[], total: number): boolean; cancelled(): boolean; progress?(n: number): void; attempts?: number }): Promise<PullResult> {
  const attempts = o.attempts ?? 3
  const byIndex = new Map<string, ImMessage>()
  let anchor = 0n
  let requests = 0
  for (;;) {
    let p: HistoryPage | undefined
    for (let t = 1; !p; t++) {
      if (o.cancelled()) throw new Error('cancelled')
      try {
        requests++
        const r = await ask(anchor, PAGE)
        if (r.status !== 0) throw new Error(`status ${r.status} ${r.error}`)
        p = r
      } catch (e) {
        if (t >= attempts || e instanceof Fatal || (e instanceof Error && e.message === 'cancelled')) throw e
        await sleep(300 * 2 ** (t - 1))
      }
    }
    const ms = p.messages.map(parseMessage)
    if (!ms.length) break
    let lo = ms[0].index
    for (const m of ms) { byIndex.set(String(m.index), m); if (m.index < lo) lo = m.index }
    o.progress?.(byIndex.size)
    if (anchor !== 0n && lo >= anchor) break // the server did not move down: nothing more can be paged
    anchor = lo
    if (!p.hasMore && ms.length < PAGE) break // the start of the conversation
    if (o.enough(ms, byIndex.size)) break
    if (requests > MAX_REQUESTS) throw new Error('слишком много запросов истории')
  }
  return { messages: sorted(byIndex), requests }
}
const gapOf = (p: Seen, was: bigint) => (p.n > 1 && p.hi > p.lo ? (p.hi - p.lo) / BigInt(p.n - 1) || 1n : was)

/**
 * Pulls a whole conversation. `ask(anchor, limit)` returns the page of messages just below `anchor` (0 = the newest page).
 * The server gives at most PAGE messages per request and only walks down from a position, so the history is cut into chains:
 * the first one starts at the newest page; whenever a worker is idle it splits the chain with the most left to walk in the
 * middle of its range and starts another chain there. A chain is finished when its page reaches the position the chain below
 * starts at (the two pages then share or touch a message, so nothing between them is missing), or at the start of the conversation.
 * Throws when a request keeps failing: the caller goes back to the slow way instead of exporting a conversation with holes.
 */
export async function pullHistory(ask: (anchor: bigint, limit: number) => Promise<HistoryPage>, o: PullOptions): Promise<PullResult> {
  const attempts = o.attempts ?? 3
  const byIndex = new Map<string, ImMessage>()
  const chains: Chain[] = []
  let requests = 0
  let failure: unknown

  const page = async (anchor: bigint): Promise<Seen> => {
    for (let t = 1; ; t++) {
      if (failure) throw failure
      if (o.cancelled()) throw new Error('cancelled')
      if (requests > MAX_REQUESTS) throw new Error('слишком много запросов истории')
      try {
        requests++
        const p = await ask(anchor, PAGE)
        if (p.status !== 0) throw new Error(`status ${p.status} ${p.error}`)
        const ms = p.messages.map(parseMessage)
        let lo = 0n, hi = 0n
        ms.forEach((m, i) => {
          byIndex.set(String(m.index), m)
          if (!i || m.index < lo) lo = m.index
          if (!i || m.index > hi) hi = m.index
        })
        o.progress?.(byIndex.size, requests)
        return { n: ms.length, lo, hi, more: p.hasMore }
      } catch (e) {
        if (t >= attempts || e instanceof Fatal || (e instanceof Error && e.message === 'cancelled')) throw e
        await sleep(300 * 2 ** (t - 1))
      }
    }
  }

  const first = await page(0n)
  if (!first.n) return { messages: [], requests }
  if (!first.more && first.n < PAGE) return { messages: sorted(byIndex), requests } // the whole chat fits on one page

  // The first round: the chain of the newest page plus one probe each at growing distances below it (4, 16, 64... pages of
  // positions). How far back the chat goes is not known, so this finds out in one round trip; probes in empty space come back
  // empty and teach `floor`, probes inside the chat become chains that the idle workers then keep splitting.
  const gap = gapOf(first, 1n)
  const span = first.hi > first.lo ? first.hi - first.lo : 1n
  const probes: bigint[] = []
  for (let d = span * 4n; probes.length < Math.max(1, o.concurrency) - 1 && d < first.lo; d *= 4n) probes.push(first.lo - d)
  const top: Chain = { frontier: first.lo, bound: probes[0] ?? 0n, gap, done: false }
  chains.push(top)
  probes.forEach((a, i) => chains.push({ frontier: a, bound: probes[i + 1] ?? 0n, gap, done: false }))

  let floor = 0n // nothing exists below this position: a request there came back empty
  const lowEnd = (c: Chain) => (c.bound > floor ? c.bound : floor)

  /** walks `c` down until it joins the chain below, reaches the start of the conversation, or finds nothing */
  const walk = async (c: Chain, seen?: Seen) => {
    for (;;) {
      const asked = c.frontier
      if (asked <= floor) break // everything below is known to be empty
      const given = seen
      seen = undefined
      const p = given ?? (await page(asked))
      if (!p.n) { if (asked > floor) floor = asked; break }
      if (!given && p.lo >= asked) { // the page is not below the position that was asked for
        if (c === top && first.more) throw new Error('история не сдвигается с места') // the server ignores positions: nothing can be paged
        if (asked > floor) floor = asked // asked below the start and got a stray page from above
        break
      }
      c.frontier = p.lo
      c.gap = gapOf(p, c.gap)
      if (p.lo <= c.bound) break // this page reaches the first page of the chain below (or touches it)
      if (!p.more && p.n < PAGE) break // the start of the conversation; a full page that says "no more" is asked about once more
    }
    c.done = true
  }

  /** splits the chain with the most left to walk: a new chain starts in the middle of its range */
  const steal = (): Chain | undefined => {
    let v: Chain | undefined
    let best = 0n
    for (const c of chains) {
      if (c.done || c.frontier <= floor) continue
      const left = (c.frontier - lowEnd(c)) / c.gap
      if (left > best) { v = c; best = left }
    }
    if (!v || best < BigInt(2 * PAGE)) return undefined
    const lo = lowEnd(v)
    const at = lo + (v.frontier - lo) / 2n
    const c: Chain = { frontier: at, bound: v.bound, gap: v.gap, done: false }
    v.bound = at
    chains.push(c)
    return c
  }

  const worker = async (own?: Chain, seen?: Seen) => {
    try {
      if (own) await walk(own, seen)
      for (;;) {
        if (failure) return
        const c = steal()
        if (c) { await walk(c); continue }
        if (chains.every((x) => x.done)) return
        await sleep(40) // nothing worth splitting right now; the busy chains may still run into a dense stretch
      }
    } catch (e) {
      failure ??= e
      throw e
    }
  }
  const start = chains.slice()
  await Promise.all(Array.from({ length: Math.max(1, o.concurrency) }, (_, i) => worker(start[i], i ? undefined : first)))
  return { messages: sorted(byIndex), requests }
}

const sorted = (m: Map<string, ImMessage>) => [...m.values()].sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0))

// ----- messages -> the export's entries -----
// Types and fields below come from TikTok's own web bundle (im_proto, MessageType and the chat page), read 2026-11-06.

export interface EntryContext {
  /** the account's own user id, if the page tells it */
  own?: string
  /** or: which side each sender is on, worked out by comparing with what the page shows */
  sides?: Map<string, 'me' | 'them'>
}

const pad = (n: number) => String(n).padStart(2, '0')
/** create_time is in milliseconds on the web client; seconds and microseconds are told apart by size */
export const toMs = (t: bigint): number => { const n = Number(t); return n > 1e14 ? n / 1000 : n > 1e11 ? n : n * 1000 }
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
const day = (d: Date) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`

const objectOf = (s: string): Json | undefined => {
  try { const j: unknown = JSON.parse(s); return j && typeof j === 'object' && !Array.isArray(j) ? (j as Json) : undefined } catch { return undefined }
}
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
const num = (v: unknown): number | undefined => (typeof v === 'number' && v > 0 ? v : undefined)
const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : [])
const at = (v: unknown, ...path: string[]): unknown => path.reduce<unknown>((o, k) => obj(o)?.[k], v)

interface Found { key: string; url: string }
/** Every web address inside a content object with the name of the key that holds it; `url_list` arrays count for their parent key. */
function urlsIn(v: unknown, key = '', out: Found[] = [], depth = 0): Found[] {
  if (depth > 6) return out
  if (typeof v === 'string') {
    if (/^https?:\/\//i.test(v)) out.push({ key, url: v })
    else if (/^\s*[[{]/.test(v)) { try { urlsIn(JSON.parse(v), key, out, depth + 1) } catch { /* just text */ } } // objects sent as JSON text
  } else if (Array.isArray(v)) v.forEach((x) => urlsIn(x, key, out, depth + 1))
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) urlsIn(x, /^url_?list$/i.test(k) ? key : k, out, depth + 1)
  return out
}

/** The text of a message: the `text` of its JSON content, or the content itself when it is not JSON. */
export function textOf(m: ImMessage): string {
  try {
    const j: unknown = JSON.parse(m.content)
    return j && typeof j === 'object' && typeof (j as { text?: unknown }).text === 'string' ? (j as { text: string }).text : ''
  } catch { return m.content }
}

const PICTURE = /cover|thumb|image|img|pic|sticker|emoji|emote|gif/i
const NOT_PICTURE = /avatar|icon|head|author|music|sound|play|download/i
const BORING_EXT = /^(im_callback_status_code|s:mode|s:client_message_id|source_aid|a:entrance_type|a:disable_(inner|outer)_push|mentioned_users|s:mentioned_users)$/
// fields every message has: not content. 15, 18, 20 and 24 are read below and only stay in the details if they could not be.
const STRUCTURAL = new Set([2, 5, 11, 12, 13, 14, 17, 19, 21, 22, 23, 25, 28])

/** The first address of every picture key; a copy in a format the exporter cannot read (heic) comes last. */
function picturesOf(json: Json): Found[] {
  const byKey = new Map<string, string[]>()
  for (const f of urlsIn(json)) if (PICTURE.test(f.key) && !NOT_PICTURE.test(f.key)) byKey.set(f.key, [...(byKey.get(f.key) ?? []), f.url])
  return [...byKey].map(([key, urls]) => ({ key, url: urls.find((u) => !/heic/i.test(u)) ?? urls[0] }))
}

const strict = new TextDecoder('utf-8', { fatal: true })
/** A field the reader does not name, as something readable for the details of a message. */
function describe(f: Field, depth = 0): unknown {
  if (typeof f.v === 'bigint') return f.v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(f.v) : String(f.v)
  try { const s = strict.decode(f.v); if (s && /^[\x20-\x7e -￿\n\t]*$/.test(s)) return s.slice(0, 400) } catch { /* not text */ }
  if (depth < 4) {
    try {
      const inner = decode(f.v)
      if (inner.length) {
        const out: Record<number, unknown> = {}
        for (const x of inner) { const v = describe(x, depth + 1); out[x.no] = x.no in out ? [...(Array.isArray(out[x.no]) ? (out[x.no] as unknown[]) : [out[x.no]]), v] : v } // repeated fields stay together
        return out
      }
    } catch { /* not a message either */ }
  }
  return `bytes(${f.v.length})`
}

// ----- who -----

/** Who wrote what: a label for a user id, the same words in reactions and quotes. */
interface People { label(uid: string): string; author(uid: string): string | undefined; side(uid: string): 'me' | 'them' | 'unknown' }

function peopleOf(messages: ImMessage[], ctx: EntryContext): People {
  const others: string[] = []
  for (const m of messages) {
    const id = String(m.sender)
    if (id !== '0' && id !== ctx.own && !NOTICE.has(Number(m.type)) && !others.includes(id)) others.push(id)
  }
  const group = ctx.own !== undefined && others.length > 1 // the page's header names the group, not who wrote what
  const side = (uid: string) => (ctx.own !== undefined ? (uid === ctx.own ? 'me' : 'them') : ctx.sides?.get(uid) ?? 'unknown')
  const member = (uid: string) => { const i = others.indexOf(uid); return i < 0 ? 'участник' : `Участник ${i + 1}` }
  return {
    side,
    author: (uid) => (group && uid !== ctx.own ? member(uid) : undefined),
    label: (uid) => {
      const s = side(uid)
      return s === 'me' ? 'вы' : s === 'unknown' ? 'неизвестно' : group ? member(uid) : 'собеседник'
    }
  }
}

// ----- reactions -----

const HEART = '❤️'
const isEmoji = (s: string) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s)
const sameEmoji = (s: string) => s.replace(/️/g, '')

/**
 * Reactions as TikTok itself counts them. A reaction writes two keys: `e:love` (the plain "liked" mark) and `e:<emoji>`, so
 * `e:love` only means a heart for a user who has no other reaction on the message; `e:❤️` is the same heart. A key that is not
 * an emoji stays as a badge with its code: nothing is dropped.
 */
export function reactionsOf(m: ImMessage, people: Pick<People, 'label'>): ExportReaction[] {
  const props = propertiesOf(m)
  const marked = new Set(props.filter((p) => p.key !== 'e:love').flatMap((p) => p.items.map((i) => i.uid)))
  const groups = new Map<string, { emoji: string; code?: string; users: Map<string, number> }>()
  const add = (id: string, emoji: string, code: string | undefined, uid: string, time: number) => {
    const g = groups.get(id) ?? { emoji, code, users: new Map() }
    groups.set(id, g)
    g.users.set(uid, Math.max(g.users.get(uid) ?? 0, time))
  }
  for (const p of props) {
    const name = p.key.startsWith('e:') ? p.key.slice(2) : ''
    for (const i of p.items) {
      if (p.key === 'e:love') { if (!marked.has(i.uid)) add(sameEmoji(HEART), HEART, undefined, i.uid, i.time) }
      else if (name && isEmoji(name)) add(sameEmoji(name), sameEmoji(name) === sameEmoji(HEART) ? HEART : name, undefined, i.uid, i.time)
      else add('?' + p.key, '🏷️', name || p.key, i.uid, i.time)
    }
  }
  return [...groups.values()]
    .map((g) => {
      const last = Math.max(0, ...g.users.values())
      return { emoji: g.emoji, code: g.code, count: g.users.size, who: [...g.users.keys()].map((u) => people.label(u)).sort((a, b) => Number(b === 'вы') - Number(a === 'вы')), last }
    })
    .sort((a, b) => b.count - a.count || b.last - a.last)
    .map(({ last, ...r }) => ({ ...r, when: last ? `${day(new Date(toMs(BigInt(last))))} ${clock(new Date(toMs(BigInt(last))))}` : undefined }))
}

// ----- notices -----

/** A system notice: text with {{1}}-style slots and the list that names them. */
function noticeText(json: Json): { text: string; item?: string } {
  const parts = [json.tips, json.template, json.fallback_tips]
  const names = parts.find(Array.isArray) as { key?: unknown; name?: unknown; extra?: { item_id?: unknown } }[] | undefined
  const text = parts.find((p) => typeof p === 'string' && p) as string | undefined
  const filled = (text ?? '').replace(/\{\{(\d+)\}\}/g, (_, n: string) => str(names?.find((x) => String(x.key) === n)?.name) || '…')
  const item = names?.map((x) => str(x.extra?.item_id)).find(Boolean)
  return { text: filled, item }
}

/** Group notices (type 1031) carry only an aweType and the users it is about. */
const GROUP_NOTICE: Record<number, string> = {
  103101: 'создал(а) группу', 103102: 'удалил(а) участника', 103103: 'сменились администраторы', 103104: 'вышел(ла) из группы', 103105: 'добавил(а) участника',
  103106: 'сменил(а) название группы', 103107: 'в группу вошёл участник с пометкой риска', 103108: 'название группы нарушает правила', 103109: 'название группы нарушает правила',
  103110: 'название группы нарушает правила', 103111: 'TikTok удалил участника', 103112: 'создал(а) группу и добавил(а) участников', 103114: 'предупреждение о риске'
}
function groupNotice(json: Json): string {
  const names = (k: string) => (Array.isArray(json[k]) ? (json[k] as unknown[]).map((u) => str(obj(u)?.nickname)).filter(Boolean).join(', ') : '')
  const what = GROUP_NOTICE[Number(json.aweType)]
  return [names('subject_users'), what ?? `уведомление группы ${str(json.aweType)}`, names('object_users')].filter(Boolean).join(' ')
}

/** Everything TikTok draws as a line in the middle of the chat, not as somebody's message. */
const NOTICE = new Set([1, 9, 1006, 1007, 1030, 1031, 1032, 1037, 1039, 10008])

/** Names of the types that have no text of their own. The numbers are TikTok's `MessageType`. */
const TYPE_LABEL: Record<number, string> = {
  2: 'Фото', 3: 'Голосовое сообщение', 4: 'Видео', 5: 'Стикер', 6: 'Файл', 8: 'Видео из TikTok', 10: 'Карточка группы', 11: 'Видео для подписчиков', 15: 'Приветственный стикер', 16: 'Пересланный комментарий',
  19: 'Хэштег', 21: 'Прямой эфир', 22: 'Звук из видео', 25: 'Профиль', 26: 'Карточка', 33: 'Вопрос и ответ', 40: 'Комментарий', 43: 'Товар', 71: 'Подборка', 72: 'Эффект', 81: 'Плейлист', 101: 'Файл',
  1021: 'Прямой эфир', 1025: 'История', 1033: 'Приглашение в группу', 1034: 'Событие эфира', 1036: 'Поиск', 1038: 'Приглашение подписаться',
  1801: 'Карточка', 1802: 'Фото', 1803: 'Видео', 1804: 'Карточка', 1805: 'Стикер', 1806: 'Портрет', 1807: 'Ответ бота', 1808: 'Уведомление', 1809: 'Видео из TikTok', 1810: 'Карточка',
  1811: 'Комментарий', 1812: 'Групповой снимок', 1813: 'Голосовое сообщение', 1814: 'Интерактивная карточка', 1900: 'Карточка', 3001: 'Плейлист',
  10002: 'Стикер', 10003: 'Фото', 10004: 'Видео', 10005: 'Файл', 10006: 'Голосовое сообщение', 10007: 'Геопозиция', 10009: 'Ссылка', 10011: 'Голосовое сообщение'
}
const STICKER = new Set([5, 15, 1805, 10002])
const VOICE = new Set([3, 1813, 10006, 10011])
/** a file that shows what it is: no caption needed */
const SELF_EVIDENT = new Set([...STICKER, ...VOICE, 2, 4, 1802, 1803, 10003, 10004])

// ----- files -----

const urlOk = (u: string) => /^https?:\/\//i.test(u)
/** How the page opens an encrypted file: the key from the message, the account's id hashed, and the page's constant for photos. */
const MINT = true
const secretOf = (key: unknown, ctx: EntryContext, mint: boolean): MediaSecret | undefined => {
  const k = str(key)
  if (!/^[\da-f]{64}$/i.test(k)) return undefined
  return { key: k, user: ctx.own ? createHash('md5').update(ctx.own).digest('hex') : undefined, mint }
}

type Source = { src: string; secret?: MediaSecret }
/** Copies of one picture in order of preference; heic, which a browser cannot show, goes last. */
function sourcesOf(images: unknown[], ctx: EntryContext, mint = false): Source[] {
  const out: Source[] = []
  for (const i of images) {
    const secret = secretOf(obj(i)?.decrypt_key, ctx, mint)
    for (const u of strings(obj(i)?.url_list)) if (urlOk(u) && !out.some((s) => s.src === u)) out.push({ src: u, secret })
  }
  return [...out.filter((s) => !/heic/i.test(s.src)), ...out.filter((s) => /heic/i.test(s.src))]
}
const fileOf = (kind: MediaKind, sources: Source[], extra: Partial<ExportMedia>, why: string): ExportMedia => {
  const [first, ...rest] = sources
  return first ? { kind, src: first.src, secret: first.secret, alts: rest.length ? rest : undefined, ...extra } : { kind, src: '', note: why, ...extra }
}
const previewOf = (c?: Json) => str(at(c, 'preview_hint', 'receiver_preview_text', 'text')) || str(at(c, 'preview_hint', 'sender_preview_text', 'text'))
const sizeOf = (image: unknown) => ({ width: num(at(image, 'resolution', 'width')), height: num(at(image, 'resolution', 'height')) })

/** Sticker cards keep the file in `sticker`; the old emoji type (5) keeps it as JSON in `url`. Static or animated, the bytes decide later. */
function stickerOf(c: Json | undefined, json: Json | undefined, ctx: EntryContext): ExportMedia {
  const image = c?.sticker
  const legacy = json?.url
  const sources = [...sourcesOf([image, legacy, at(c, 'fallback', 'placeholder')], ctx)]
  const label = str(obj(image)?.display_name) || previewOf(c) || str(json?.display_name) || str(json?.text)
  const type = Number(at(c, 'req_base', 'query_data', 'extra', 'a:sticker_type'))
  return fileOf('sticker', sources, {
    label: label || undefined, alt: label || undefined, animated: type === 2 || type === 4 ? true : undefined,
    width: sizeOf(image).width ?? num(json?.width), height: sizeOf(image).height ?? num(json?.height)
  }, c ? 'в сообщении нет адреса стикера (TikTok показал бы «стикер недоступен»)' : 'TikTok не прислал данные стикера')
}

/** The address of a video from its `video_model`: JSON with `video_list`, addresses plain or in base64. */
function videoUrls(model: string): string[] {
  const j = objectOf(model)
  const list = j?.video_list
  const items = Array.isArray(list) ? list : Object.values(obj(list) ?? {})
  const out: string[] = []
  for (const v of items) for (const k of ['main_url', 'backup_url_1']) {
    const s = str(obj(v)?.[k])
    const u = urlOk(s) ? s : s ? Buffer.from(s, 'base64').toString('utf8') : ''
    if (urlOk(u)) out.push(u)
  }
  return out
}

/** Files of field 24; voice messages have nothing else. */
function attachedFiles(m: ImMessage, ctx: EntryContext, label: string | undefined): ExportMedia[] {
  const KIND: Record<number, MediaKind> = { 1: 'image', 2: 'video', 3: 'audio', 4: 'file' }
  return mediaInfoOf(m).map((f) => {
    const voice = VOICE.has(Number(m.type))
    const secret = secretOf(f.key, ctx, false)
    const urls = [...new Set(f.urls.flatMap((u) => [...u.urls.filter(urlOk), ...videoUrls(u.model)]))]
    const name = f.urls.map((u) => u.name).find(Boolean)
    return fileOf(voice ? 'audio' : KIND[f.type] ?? 'file', urls.map((src) => ({ src, secret })), { label: name || label }, 'в сообщении нет адреса файла')
  })
}

/** A card this reader has no special case for: its texts, pictures and links, wherever they sit. */
function cardParts(v: unknown, ctx: EntryContext, out: { texts: string[]; images: Json[]; links: string[] } = { texts: [], images: [], links: [] }, key = '', depth = 0) {
  if (depth > 7) return out
  if (Array.isArray(v)) v.forEach((x) => cardParts(x, ctx, out, key, depth + 1))
  else if (obj(v)) {
    const o = v as Json
    if (/hint|fallback|req_base|resp_base|context_menu/.test(key)) return out
    if (typeof o.text === 'string' && o.text && !out.texts.includes(o.text)) out.texts.push(o.text)
    if (strings(o.url_list).length) { if (/link/.test(key)) out.links.push(...strings(o.url_list).filter(urlOk)); else if (!NOT_PICTURE.test(key)) out.images.push(o) }
    for (const [k, x] of Object.entries(o)) if (k !== 'url_list') cardParts(x, ctx, out, /_map$/.test(key) ? key : k, depth + 1) // inside a map the keys are names
  }
  return out
}

/** A short line for a quoted message. */
function summary(m: ImMessage): string {
  const t = textOf(m)
  if (t) return t
  const k = Number(m.type)
  return `[${TYPE_LABEL[k] ?? 'Сообщение'}]`
}
function quoteOf(m: ImMessage, byId: Map<string, { m: ImMessage; n: number }>, people: People): Pick<ExportMessage, 'reply' | 'replyWho' | 'replyTo'> {
  const ref = referenceOf(m)
  if (!ref) return {}
  const hint = objectOf(ref.hint)
  const target = byId.get(ref.id)
  const uid = str(hint?.refmsg_uid) || (ref.sender !== '0' ? ref.sender : target ? String(target.m.sender) : '')
  const inner = objectOf(str(hint?.content))
  const type = Number(hint?.refmsg_type ?? ref.type)
  const reply = ref.status === 2 ? 'Сообщение недоступно' : ref.status ? 'Сообщение удалено' : target ? summary(target.m) : str(inner?.text) || `[${TYPE_LABEL[type] ?? 'Сообщение'}]`
  const who = uid ? people.label(uid) : ''
  return { reply, replyWho: who ? `Ответ: ${who}` : 'Ответ', replyTo: target?.n }
}

function entryOf(m: ImMessage, ctx: EntryContext, people: People, byId: Map<string, { m: ImMessage; n: number }>): ExportMessage {
  const json = objectOf(m.content)
  const kind = Number(m.type)
  const uid = String(m.sender)
  const deleted = !!m.ext['s:is_recalled']
  const blocked = Number(m.ext['a:moderation_result'] ?? 1) === 3 || m.ext['a:is_violative'] === 'true'
  const c = deleted ? undefined : cardOf(m)
  const system = NOTICE.has(kind) || (kind >= 50000 && !c)
  const notice = json && (kind === 1 || json.tips !== undefined || json.template !== undefined) && system ? noticeText(json) : undefined
  const profile = !!json && !!str(json.uid) && !!str(json.name) && !!json.avatar && !str(json.itemId) // a shared profile
  const media: ExportMedia[] = []
  const links: { href: string; text: string }[] = []
  let text = deleted ? 'Сообщение удалено' : notice?.text ? notice.text : profile ? `Профиль: ${str(json?.name)}${str(json?.desc) ? ` (@${str(json?.desc)})` : ''}` : json ? str(json.text) : m.content
  if (!text && kind === 1031 && json) text = groupNotice(json)

  const pics = deleted || !json ? [] : picturesOf(json)
  if (profile) { const a = urlsIn(json?.avatar).find((u) => !/heic/i.test(u.url)); if (a) pics.push({ key: 'image', url: a.url }) }
  const itemId = deleted ? '' : notice ? notice.item ?? '' : json ? (kind === 40 ? str(json.aweme_id) : str(json.itemId) || str(json.item_id) || str(json.aweme_id) || str(json.itemID)) : ''
  const cover = itemId ? pics.find((p) => /cover/i.test(p.key)) ?? pics.find((p) => /thumb/i.test(p.key)) : undefined
  const title = json ? (kind === 40 ? [str(json.author_name) && `Комментарий ${str(json.author_name)}`, str(json.comment)].filter(Boolean).join(': ') : str(json.content_title) || str(json.title) || str(json.desc) || str(json.description) || str(json.content_name)) : ''
  const tag = kind === 1025 ? 'История' : kind === 40 ? 'Комментарий' : kind === 1021 || kind === 21 ? 'Прямой эфир' : Number(json?.aweType) === 810 ? 'Фото из TikTok' : undefined
  let video: ExportMessage['video'] = itemId
    ? {
        href: `https://www.tiktok.com/@/${Number(json?.aweType) === 810 ? 'photo' : 'video'}/${itemId}`, text: title, tag,
        cover: cover ? { kind: 'image' as const, src: cover.url, width: num(json?.cover_width), height: num(json?.cover_height) } : undefined
      }
    : undefined

  if (!text && title && !video) text = title // a hashtag, a sound or a product: the title is all there is

  if (!deleted) {
    // a reply to a video or a story sits in the content next to the text
    const refVideo = obj(json?.reference_video)
    if (refVideo && !video && str(refVideo.reference_video_id)) {
      video = { href: `https://www.tiktok.com/@/video/${str(refVideo.reference_video_id)}`, text: '', tag: refVideo.reference_video_is_story ? 'Ответ на историю' : 'Ответ на видео' }
    }
    const label = previewOf(c?.value)
    if (STICKER.has(kind)) media.push(stickerOf(c?.kind === 'sticker_card' ? c.value : undefined, json, ctx))
    else if (c?.kind === 'picture_card') {
      const v = c.value
      media.push(fileOf('image', sourcesOf([v.image, v.image_mint, v.thumbnail, v.thumbnail_mint, at(v, 'fallback', 'image')], ctx, MINT), { label: label || undefined, ...sizeOf(v.image ?? v.thumbnail) }, 'в сообщении нет адреса фото'))
    } else if (c?.kind === 'video_card') {
      const v = obj(c.value.video)
      const urls = videoUrls(str(v?.video_model)).map((src) => ({ src }))
      if (urls.length) media.push(fileOf('video', urls, { label: label || undefined }, ''))
      else media.push(fileOf('image', sourcesOf([v?.cover, at(c.value, 'fallback', 'image')], ctx), { label: label || undefined, note: 'адреса видео нет, сохранена обложка' }, 'в сообщении нет адреса видео'))
    } else if (c?.kind === 'audio_card' || VOICE.has(kind)) {
      const files = attachedFiles(m, ctx, label || str(at(c?.value, 'fallback_info', 'text', 'text')) || undefined)
      media.push(...(files.length ? files : [fileOf('audio', [], { label: label || str(at(c?.value, 'fallback_info', 'text', 'text')) || undefined }, 'в сообщении нет адреса голосового сообщения')]))
    } else {
      media.push(...pics.filter((p) => p !== cover && !(itemId && /cover|thumb/i.test(p.key))).map((p): ExportMedia => ({ kind: /sticker|emoji|emote|gif/i.test(p.key) ? 'sticker' : 'image', src: p.url })))
      if (c && c.kind !== 'streak_cmd') {
        const parts = cardParts(c.value, ctx)
        if (!text) text = parts.texts.join('\n')
        for (const i of parts.images) { const s = sourcesOf([i], ctx); if (s.length && !media.some((x) => x.src === s[0].src)) media.push(fileOf('image', s, {}, '')) }
        for (const href of parts.links) if (!links.some((l) => l.href === href)) links.push({ href, text: '' })
      }
      if (!media.length) media.push(...attachedFiles(m, ctx, label || undefined))
    }
    if (blocked) media.forEach((x) => { x.note ??= 'TikTok скрыл этот файл как нарушение' })
  }

  const side = system ? 'unknown' : people.side(uid)
  const when = new Date(toMs(m.time))
  const plain = !json || Object.keys(json).every((k) => k === 'text' || k === 'aweType' || k === 'tux_text')
  const ext = Object.entries(m.ext).filter(([k]) => !BORING_EXT.test(k))
  const reactions = reactionsOf(m, people)
  const read = new Set<number>()
  if (propertiesOf(m).length) read.add(15)
  if (referenceOf(m)) read.add(18)
  if (c) read.add(20)
  if (mediaInfoOf(m).length) read.add(24)
  const extra = m.other.filter((f) => !STRUCTURAL.has(f.no) && !read.has(f.no))
  const shown = !!text || !!media.length || !!video
  const known = kind in TYPE_LABEL || kind === 7 || system
  const unknown = !deleted && (!known || !shown)
  const raw = plain && !ext.length && !extra.length && !c && !read.has(24) ? '' : JSON.stringify({
    content: json ?? m.content,
    card: c ? { [c.kind]: c.value } : undefined,
    files: read.has(24) ? mediaInfoOf(m).map((f) => ({ type: f.type, encrypted: !!f.key, urls: f.urls })) : undefined,
    ext: ext.length ? Object.fromEntries(ext) : undefined,
    fields: extra.length ? Object.fromEntries(extra.map((f) => [f.no, describe(f)])) : undefined
  }, (k, v: unknown) => (k === 'decrypt_key' ? undefined : v)) // the key opens the file: it stays out of the export
  const aweType = json && json.aweType !== undefined ? ` · aweType ${str(json.aweType)}` : ''
  return {
    side, author: system ? 'TikTok' : people.author(uid), time: clock(when), text,
    links: [...links, ...[...text.matchAll(/https?:\/\/[^\s<>"']+/g)].map((x) => ({ href: x[0], text: '' }))],
    media, video, reactions, rawText: raw, ...quoteOf(m, byId, people),
    service: system || undefined, deleted: deleted || undefined, unknown: unknown || undefined,
    tag: unknown ? `${TYPE_LABEL[kind] ?? 'Неизвестный тип'} · тип ${m.type}` : !SELF_EVIDENT.has(kind) && !system && kind !== 7 && !video && !profile ? TYPE_LABEL[kind] : undefined,
    outline: `api · тип ${m.type}${aweType}` + (extra.length ? ` · поля ${[...new Set(extra.map((f) => f.no))].join(',')}` : '')
  }
}

/** Messages (oldest first) as the export's entries, with a date separator whenever the day changes. Every message gets an entry. */
export function toEntries(messages: ImMessage[], ctx: EntryContext): ExportEntry[] {
  const people = peopleOf(messages, ctx)
  const byId = new Map(messages.map((m, i) => [String(m.serverId), { m, n: i + 1 }]))
  const out: ExportEntry[] = []
  let last = ''
  for (const m of messages) {
    const d = day(new Date(toMs(m.time)))
    if (d !== last) { out.push({ sep: d }); last = d }
    out.push(entryOf(m, ctx, people, byId))
  }
  return out
}
