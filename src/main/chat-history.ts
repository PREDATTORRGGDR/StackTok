import { Field, HistoryPage, ImMessage, asStr, decode, get, parseMessage } from './chat-api'
import { ExportEntry, ExportMedia, ExportMessage } from './chat-export-html'

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

export interface EntryContext {
  /** the account's own user id, if the page tells it */
  own?: string
  /** or: which side each sender is on, worked out by comparing with what the page shows */
  sides?: Map<string, 'me' | 'them'>
}

type Json = Record<string, unknown>

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

/** Markers the page never draws: content that is a single `hack` value (types 1805, 1813). */
export const isHidden = (m: ImMessage) => {
  if (m.type === 1805n) return true
  const j = objectOf(m.content)
  return !!j && Object.keys(j).length === 1 && 'hack' in j
}

const PICTURE = /cover|thumb|image|img|pic|sticker|emoji|emote|gif/i
const NOT_PICTURE = /avatar|icon|head|author|music|sound|play|download/i
const BORING_EXT = /^(im_callback_status_code|s:mode|s:client_message_id|source_aid|a:entrance_type|a:disable_(inner|outer)_push|mentioned_users)$/
const STRUCTURAL = new Set([2, 5, 11, 12, 13, 14, 21, 22, 25, 28]) // fields that every message has: not content

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
  try { const s = strict.decode(f.v); if (s && /^[\x20-\x7e -￿\n\t]*$/.test(s)) return s.slice(0, 400) } catch { /* not text */ }
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

const EMOJI: Record<string, string> = { love: '❤️' }

/** Reactions sit on the message as repeated field 15: a key like `e:love` and who reacted (ids deep inside the value). */
function reactionsOf(m: ImMessage, own?: string): string[] {
  const ids = m.conversationId.split(':').slice(2)
  const out: string[] = []
  for (const f of m.other) {
    if (f.no !== 15 || typeof f.v === 'bigint') continue
    let inner: Field[]
    try { inner = decode(f.v) } catch { continue }
    const key = asStr(get(inner, 1)).replace(/^e:/, '')
    if (!key) continue
    const seen = new Set<string>()
    const walk = (fs: Field[], d: number) => {
      for (const x of fs) {
        if (typeof x.v === 'bigint') seen.add(String(x.v))
        else if (d < 4) { try { walk(decode(x.v), d + 1) } catch { /* not a message */ } }
      }
    }
    const rest = inner.filter((x) => x.no !== 1)
    walk(rest, 0)
    const who = ids.find((id) => seen.has(id))
    out.push((EMOJI[key] ?? key) + (who && own ? (who === own ? ' · вы' : ' · собеседник') : ''))
  }
  return out
}

/** A system notice: text with {{1}}-style slots and the list that names them. */
function noticeText(json: Json): { text: string; item?: string } {
  const parts = [json.tips, json.template, json.fallback_tips]
  const names = parts.find(Array.isArray) as { key?: unknown; name?: unknown; extra?: { item_id?: unknown } }[] | undefined
  const text = parts.find((p) => typeof p === 'string' && p) as string | undefined
  const filled = (text ?? '').replace(/\{\{(\d+)\}\}/g, (_, n: string) => str(names?.find((x) => String(x.key) === n)?.name) || '…')
  const item = names?.map((x) => str(x.extra?.item_id)).find(Boolean)
  return { text: filled, item }
}

function entryOf(m: ImMessage, ctx: EntryContext): ExportMessage {
  const json = objectOf(m.content)
  const kind = Number(m.type)
  const system = kind === 1
  const notice = json && system ? noticeText(json) : undefined
  const recalled = m.ext['s:is_recalled'] === '1'
  const card = !!json && !!str(json.uid) && !!str(json.name) && !!json.avatar && !str(json.itemId) // a shared profile
  const text = recalled ? 'Сообщение удалено' : notice ? notice.text : card ? `Профиль: ${str(json?.name)}${str(json?.desc) ? ` (@${str(json?.desc)})` : ''}` : json ? str(json.text) : m.content
  const pics = json ? picturesOf(json) : []
  if (card) { const a = urlsIn(json?.avatar).find((u) => !/heic/i.test(u.url)); if (a) pics.push({ key: 'image', url: a.url }) }
  const itemId = notice ? notice.item ?? '' : json ? (kind === 40 ? str(json.aweme_id) : str(json.itemId) || str(json.item_id) || str(json.aweme_id) || str(json.itemID)) : ''
  const cover = itemId ? pics.find((p) => /cover/i.test(p.key)) ?? pics.find((p) => /thumb/i.test(p.key)) : undefined
  const title = json ? (kind === 40 ? [str(json.author_name) && `Комментарий ${str(json.author_name)}`, str(json.comment)].filter(Boolean).join(': ') : str(json.content_title) || str(json.title) || str(json.desc) || str(json.description) || str(json.content_name)) : ''
  const video = itemId
    ? {
        href: `https://www.tiktok.com/@/video/${itemId}`, text: title,
        cover: cover ? { kind: 'image' as const, src: cover.url, width: num(json?.cover_width), height: num(json?.cover_height) } : undefined
      }
    : undefined
  const media: ExportMedia[] = pics
    .filter((p) => p !== cover && !(itemId && /cover|thumb/i.test(p.key)))
    .map((p) => ({ kind: /sticker|emoji|emote|gif/i.test(p.key) ? 'sticker' : 'image', src: p.url }))

  const side = system ? 'unknown' : ctx.own !== undefined ? (String(m.sender) === ctx.own ? 'me' : 'them') : ctx.sides?.get(String(m.sender)) ?? 'unknown'
  const when = new Date(toMs(m.time))
  const plain = !json || Object.keys(json).every((k) => k === 'text' || k === 'aweType' || k === 'tux_text')
  const ext = Object.entries(m.ext).filter(([k]) => !BORING_EXT.test(k))
  const reactions = reactionsOf(m, ctx.own)
  const extra = m.other.filter((f) => !STRUCTURAL.has(f.no) && f.no !== 23 && !(f.no === 15 && reactions.length))
  const raw = plain && !ext.length && !extra.length ? '' : JSON.stringify({
    content: json ?? m.content,
    ext: ext.length ? Object.fromEntries(ext) : undefined,
    fields: extra.length ? Object.fromEntries(extra.map((f) => [f.no, describe(f)])) : undefined
  })
  const aweType = json && json.aweType !== undefined ? ` · aweType ${str(json.aweType)}` : ''
  return {
    side, author: system ? 'TikTok' : undefined, time: clock(when), text,
    links: [...text.matchAll(/https?:\/\/[^\s<>"']+/g)].map((x) => ({ href: x[0], text: '' })),
    media, video, reactions, rawText: raw,
    outline: `api · тип ${m.type}${aweType}` + (extra.length ? ` · поля ${[...new Set(extra.map((f) => f.no))].join(',')}` : '')
  }
}

/** Messages (oldest first) as the export's entries, with a date separator whenever the day changes. Hidden markers are left out. */
export function toEntries(messages: ImMessage[], ctx: EntryContext): ExportEntry[] {
  const out: ExportEntry[] = []
  let last = ''
  for (const m of messages) {
    if (isHidden(m)) continue
    const d = day(new Date(toMs(m.time)))
    if (d !== last) { out.push({ sep: d }); last = d }
    out.push(entryOf(m, ctx))
  }
  return out
}
