// Repost analysis: a pure engine (no Electron). Collects the reposts of an account, lets a vision model read every cover (and a few frames),
// then asks a stronger model to write a profile of the person. All I/O comes in through `Deps`, so the tests run on fakes.

import { SYNTH_SYSTEM } from './psycho-prompt'
export interface RepostItem {
  id: string
  desc: string
  time: number // seconds, when the ORIGINAL video was published (TikTok does not say when it was reposted)
  author: string
  nick: string
  cover: string
  cover2: string
  dur: number
  music: string
  tags: string[]
  plays: number
  play: string // video address, used only to cut frames
  photo: boolean
}

export interface PageReply { http: number; code: number; msg: string; items: RepostItem[]; hasMore: boolean; cursor: string }
export interface Img { media: string; b64: string }
export interface Cover extends Img { thumb?: string } // `thumb` is a small data: URI for the report

export const VISION_MODEL = 'claude-haiku-5-5'
export const SYNTH_MODEL = 'claude-haiku-5-5'
export const BATCH = 12 // videos per vision request
export const VISION_THREADS = 6
export const PAGE_SIZE = 30
export const MAX_ITEMS = 10000

export type Phase = 'collect' | 'vision' | 'synth' | 'save'
export interface Progress { phase: Phase; done: number; total: number; message: string }

export class PsyError extends Error {
  constructor(message: string, public fatal = true) { super(message) }
}

export const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Runs `fn` over `list` with at most `n` calls at a time; results keep the input order. */
export async function pool<T, R>(list: T[], n: number, fn: (x: T, i: number) => Promise<R>, stop: () => boolean = () => false): Promise<R[]> {
  const out = new Array<R>(list.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (!stop()) {
      const i = next++
      if (i >= list.length) return
      out[i] = await fn(list[i], i)
    }
  }))
  return out
}

// ───────── model client ─────────
type Block = { type: 'text'; text: string } | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

/** `anthropic` = the Messages API; `openai` = Chat Completions, which OpenAI, Gemini, OpenRouter, DeepSeek, local servers and resellers all speak. */
export interface Provider { kind: 'anthropic' | 'openai'; base: string; key: string }

export class Vlm {
  usage = { inTok: 0, outTok: 0, calls: 0 }
  constructor(
    private p: Provider,
    private f: typeof fetch = fetch,
    private wait: (ms: number) => Promise<void> = sleepMs
  ) {}

  private request(model: string, system: string, content: Block[], maxTokens: number): { url: string; headers: Record<string, string>; body: string } {
    const base = this.p.base.replace(/\/+$/, '')
    if (this.p.kind === 'anthropic') {
      return {
        url: base + '/v1/messages',
        headers: { 'x-api-key': this.p.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] })
      }
    }
    const parts = content.map((b) => b.type === 'text' ? b : { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } })
    return {
      url: base + '/chat/completions',
      headers: { authorization: 'Bearer ' + this.p.key, 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: parts }] })
    }
  }

  /** One request. 429 and 5xx are retried with a growing pause (or the server's `retry-after`); a bad key or empty balance is fatal. */
  async ask(model: string, system: string, content: Block[], maxTokens: number, stop: () => boolean = () => false): Promise<string> {
    const who = this.p.kind === 'anthropic' ? 'Anthropic' : 'API'
    for (let attempt = 0; ; attempt++) {
      if (stop()) throw new PsyError('Остановлено.', false)
      let res: Response
      try {
        const q = this.request(model, system, content, maxTokens)
        res = await this.f(q.url, { method: 'POST', headers: q.headers, body: q.body })
      } catch (e) {
        if (attempt >= 4) throw new PsyError('Нет связи с API модели: ' + (e as Error).message)
        await this.wait(1500 * 2 ** attempt)
        continue
      }
      const body = await res.json().catch(() => null) as any
      if (res.ok) {
        this.usage.calls++
        this.usage.inTok += body?.usage?.input_tokens ?? body?.usage?.prompt_tokens ?? 0
        this.usage.outTok += body?.usage?.output_tokens ?? body?.usage?.completion_tokens ?? 0
        const text = this.p.kind === 'anthropic'
          ? (Array.isArray(body?.content) ? body.content.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text)).join('') : '')
          : String(body?.choices?.[0]?.message?.content ?? '')
        if (!text) throw new PsyError('Модель вернула пустой ответ.', false)
        return text
      }
      const msg: string = (typeof body?.error === 'string' ? body.error : body?.error?.message) ?? ''
      if (res.status === 401 || res.status === 403) throw new PsyError('Ключ API не принят. Проверьте его в настройках.')
      if (res.status === 402 || (res.status === 400 && /credit balance|billing|insufficient/i.test(msg))) throw new PsyError('На счёте провайдера закончились средства или токены.')
      if (res.status === 404) throw new PsyError(`Модель «${model}» или адрес API не найдены (${msg || '404'}). Проверьте настройки.`)
      if (res.status === 429 || res.status === 529 || res.status >= 500) {
        if (attempt >= 6) throw new PsyError(res.status === 429 ? 'Лимит запросов провайдера: попробуйте позже.' : 'Провайдер перегружен: попробуйте позже.')
        const ra = Number(res.headers.get('retry-after'))
        await this.wait(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) * 1000 : Math.min(30000, 2000 * 2 ** attempt))
        continue
      }
      throw new PsyError(`${who}: ${res.status} ${msg}`.trim(), false)
    }
  }
}

/** The first JSON value in a model reply, tolerating code fences and chatter around it. */
export function parseJson(text: string): unknown {
  const t = text.replace(/```(?:json)?/gi, '')
  const pairs: [string, string][] = [['{', '}'], ['[', ']']]
  const at = (p: [string, string]) => { const i = t.indexOf(p[0]); return i < 0 ? Infinity : i } // whichever opens first is the outer value
  for (const [open, close] of pairs.sort((x, y) => at(x) - at(y))) {
    const a = t.indexOf(open)
    const b = t.lastIndexOf(close)
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)) } catch {} }
  }
  return null
}

/** A TikTok profile name from what a person pastes: `@name`, `name` or a profile link. */
export function parseHandle(input: string): string | undefined {
  const s = input.trim()
  const m = /^(?:https?:\/\/)?(?:[a-z]+\.)?tiktok\.com\/@([A-Za-z0-9._]{2,40})(?:[/?#].*)?$/i.exec(s) ?? /^@?([A-Za-z0-9._]{2,40})$/.exec(s)
  return m ? m[1] : undefined
}

/** The profile a TikTok page address shows (`/@name`, with an optional language prefix), or undefined for any other page. */
export function profileOf(url: string, devOrigin?: string): string | undefined {
  try {
    const u = new URL(url)
    if (!(u.hostname === 'tiktok.com' || u.hostname.endsWith('.tiktok.com') || (devOrigin && u.origin === devOrigin))) return
    return /^\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?@([A-Za-z0-9._]{2,40})(?:\/|$)/.exec(u.pathname)?.[1]
  } catch {
    return
  }
}

// ───────── stage 1: one note per video ─────────
export const KINDS = ['мем', 'цитата', 'мотивация', 'юмор', 'отношения', 'красота', 'игры', 'музыка', 'новости', 'образование', 'животные', 'еда', 'спорт', 'другое'] as const
export interface Note { i: number; ocr: string; topic: string; tone: string; kind: string; note: string }

const VISION_SYSTEM = `Ты размечаешь ленту репостов TikTok для отчёта о вкусах. Для каждого видео даны номер, автор, подпись и обложка (иногда ещё 1–2 кадра).
Верни ТОЛЬКО JSON-массив, по одному объекту на видео: {"i": номер, "ocr": "текст с обложки и кадров дословно, до 160 символов, пусто если текста нет", "topic": "тема, 2–5 слов", "tone": "настроение, 1–3 слова", "kind": одно из [${KINDS.join(', ')}], "note": "что видно, одно короткое предложение"}.
Описывай только то, что видно и написано. Лиц людей не опознавай и не называй.`

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const oneLine = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ').trim()

function visionContent(items: RepostItem[], shots: (Img[] | null)[], base: number): Block[] {
  const out: Block[] = []
  items.forEach((it, k) => {
    out.push({ type: 'text', text: `Видео ${base + k}: @${it.author || '?'}; подпись: «${clip(oneLine(it.desc), 200)}»; теги: ${it.tags.slice(0, 8).join(', ') || '—'}${shots[k] ? '' : '; (картинки нет)'}` })
    for (const s of shots[k] ?? []) out.push({ type: 'image', source: { type: 'base64', media_type: s.media, data: s.b64 } })
  })
  return out
}

export function parseNotes(text: string): Note[] {
  const j = parseJson(text)
  const arr = Array.isArray(j) ? j : j && typeof j === 'object' && Array.isArray((j as any).items) ? (j as any).items : []
  return arr
    .filter((x: any) => x && typeof x === 'object' && Number.isInteger(Number(x.i)))
    .map((x: any) => ({ i: Number(x.i), ocr: clip(oneLine(x.ocr), 200), topic: clip(oneLine(x.topic), 60), tone: clip(oneLine(x.tone), 40), kind: KINDS.includes(x.kind) ? x.kind : 'другое', note: clip(oneLine(x.note), 160) }))
}

// ───────── stage 2: the profile ─────────
// The text of the portrait request lives in its own file, psycho-prompt.ts: that is the file to edit to change what the model is asked.
export interface Report {
  title: string
  archetype: { name: string; tagline: string; description: string }
  summary: string
  traits: { name: string; score: number; why: string }[]
  interests: { name: string; share: number; note: string }[]
  values: string[]
  onMind: { theme: string; note: string }[]
  romance: string
  motivations: { name: string; note: string }[]
  communication: string
  aesthetic: string
  mood: { dominant: string; note: string; spectrum: { label: string; share: number }[] }
  humor: { style: string; note: string }
  selfImage: string
  relationships: string
  strengths: string[]
  blindspots: string[]
  evidence: { i: number; quote: string; meaning: string }[]
  timeline: { period: string; shift: string }[]
  advice: string[]
  forYou: { who: string; feelings: string; signs: string[]; nextSteps: string[]; avoid: string[] } | null // only when the user said who this person is to them
  caveat: string
}


const str = (v: unknown, n: number) => clip(oneLine(v), n)
const pct = (v: unknown) => Math.min(100, Math.max(0, Math.round(Number(v) || 0)))
const list = (v: unknown, n: number, len = 240) => (Array.isArray(v) ? v.map((x) => str(x, len)).filter(Boolean).slice(0, n) : [])
const arr = (v: unknown): any[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : [])

/** Whatever the model sent, the report always has every field; strings are trimmed, numbers clamped. */
export function sanitizeReport(raw: unknown): Report {
  const r: any = raw && typeof raw === 'object' ? raw : {}
  const a: any = r.archetype && typeof r.archetype === 'object' ? r.archetype : {}
  const m: any = r.mood && typeof r.mood === 'object' ? r.mood : {}
  const h: any = r.humor && typeof r.humor === 'object' ? r.humor : {}
  return {
    title: str(r.title, 90) || 'Портрет по репостам',
    archetype: { name: str(a.name, 50) || '—', tagline: str(a.tagline, 140), description: str(a.description, 1000) },
    summary: str(r.summary, 2400),
    traits: arr(r.traits).slice(0, 6).map((t) => ({ name: str(t.name, 40), score: pct(t.score), why: str(t.why, 300) })).filter((t) => t.name),
    interests: arr(r.interests).slice(0, 8).map((t) => ({ name: str(t.name, 40), share: pct(t.share), note: str(t.note, 240) })).filter((t) => t.name),
    values: list(r.values, 6, 80),
    onMind: arr(r.onMind).slice(0, 8).map((m) => ({ theme: str(m.theme, 60), note: str(m.note, 320) })).filter((m) => m.theme),
    romance: str(r.romance, 1200),
    motivations: arr(r.motivations).slice(0, 6).map((m) => ({ name: str(m.name, 60), note: str(m.note, 300) })).filter((m) => m.name),
    communication: str(r.communication, 900),
    aesthetic: str(r.aesthetic, 700),
    mood: { dominant: str(m.dominant, 60), note: str(m.note, 400), spectrum: arr(m.spectrum).slice(0, 6).map((s) => ({ label: str(s.label, 30), share: pct(s.share) })).filter((s) => s.label) },
    humor: { style: str(h.style, 80), note: str(h.note, 400) },
    selfImage: str(r.selfImage, 1200),
    relationships: str(r.relationships, 1200),
    strengths: list(r.strengths, 6),
    blindspots: list(r.blindspots, 5),
    evidence: arr(r.evidence).slice(0, 10).filter((e) => Number.isInteger(Number(e.i))).map((e) => ({ i: Number(e.i), quote: str(e.quote, 200), meaning: str(e.meaning, 300) })),
    timeline: arr(r.timeline).slice(0, 5).map((t) => ({ period: str(t.period, 40), shift: str(t.shift, 300) })).filter((t) => t.period),
    advice: list(r.advice, 5),
    forYou: r.forYou && typeof r.forYou === 'object' && (r.forYou.feelings || r.forYou.nextSteps)
      ? { who: str(r.forYou.who, 40), feelings: str(r.forYou.feelings, 1500), signs: list(r.forYou.signs, 6, 260), nextSteps: list(r.forYou.nextSteps, 6, 300), avoid: list(r.forYou.avoid, 4, 220) } : null,
    caveat: str(r.caveat, 400) || 'Репосты показывают вкусы, а не человека целиком. Это игра, а не диагноз.'
  }
}

// ───────── numbers the report shows next to the model's words ─────────
export interface Stats {
  total: number
  authors: { name: string; n: number }[]
  tags: { name: string; n: number }[]
  kinds: { name: string; n: number }[]
  months: { name: string; n: number }[] // publish month of the originals
  from?: number
  to?: number
  photos: number
}

const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, c]) => ({ name, n: c }))

export function statsOf(items: RepostItem[], notes: Map<number, Note>): Stats {
  const authors = new Map<string, number>(), tags = new Map<string, number>(), kinds = new Map<string, number>(), months = new Map<string, number>()
  let from = Infinity, to = 0, photos = 0
  items.forEach((it, i) => {
    if (it.author) authors.set(it.author, (authors.get(it.author) ?? 0) + 1)
    for (const t of new Set(it.tags.map((x) => x.toLowerCase()))) tags.set(t, (tags.get(t) ?? 0) + 1)
    const k = notes.get(i + 1)?.kind
    if (k) kinds.set(k, (kinds.get(k) ?? 0) + 1)
    if (it.time > 0) {
      from = Math.min(from, it.time); to = Math.max(to, it.time)
      const mk = new Date(it.time * 1000).toISOString().slice(0, 7)
      months.set(mk, (months.get(mk) ?? 0) + 1)
    }
    if (it.photo) photos++
  })
  return {
    total: items.length, authors: top(authors, 12), tags: top(tags, 20), kinds: top(kinds, 14),
    months: [...months].sort((a, b) => a[0].localeCompare(b[0])).map(([name, n]) => ({ name, n })),
    from: Number.isFinite(from) ? from : undefined, to: to || undefined, photos
  }
}

export function digest(items: RepostItem[], notes: Map<number, Note>, s: Stats): string {
  const head = [
    `Всего репостов: ${s.total}${s.photos ? ` (фото-постов: ${s.photos})` : ''}.`,
    s.from && s.to ? `Оригиналы опубликованы с ${new Date(s.from * 1000).toISOString().slice(0, 10)} по ${new Date(s.to * 1000).toISOString().slice(0, 10)} (когда сделан репост, TikTok не сообщает).` : '',
    `Чаще всего авторы: ${s.authors.map((a) => `@${a.name} ×${a.n}`).join(', ') || '—'}.`,
    `Чаще всего теги: ${s.tags.map((a) => `${a.name} ×${a.n}`).join(', ') || '—'}.`,
    `Типы: ${s.kinds.map((a) => `${a.name} ×${a.n}`).join(', ') || '—'}.`,
    'Строки: номер | дата оригинала | автор | тип | тема | настроение | текст на обложке | подпись'
  ].filter(Boolean)
  const rows = items.map((it, k) => {
    const n = notes.get(k + 1)
    const d = it.time ? new Date(it.time * 1000).toISOString().slice(0, 7) : '?'
    return `${k + 1} | ${d} | @${it.author || '?'} | ${n?.kind ?? '?'} | ${n?.topic ?? ''} | ${n?.tone ?? ''} | ${n?.ocr ?? ''} | ${clip(oneLine(it.desc), 90)}`
  })
  return head.join('\n') + '\n' + rows.join('\n')
}

// ───────── the whole run ─────────
export interface Deps {
  page(cursor: string): Promise<PageReply>
  cover(item: RepostItem): Promise<Cover | null>
  frames?(item: RepostItem): Promise<Img[]>
  vlm: Vlm
  progress(p: Progress): void
  cancelled(): boolean
}

/** What the user knows about the person (all optional, typed by the user): makes the portrait more personal. */
export interface Subject { gender?: 'male' | 'female'; age?: string; relation?: string }
export const subjectNote = (s?: Subject): string => {
  if (!s) return ''
  const l = [s.gender && `Пол: ${s.gender === 'male' ? 'мужской' : 'женский'}`, s.age && `Возраст: ${s.age}`, s.relation && `Кем он(а) приходится тому, для кого пишется портрет: ${s.relation}`].filter(Boolean)
  return l.length ? `Что известно о человеке (со слов заказчика портрета, это важнее догадок по ленте; учти при тоне, обращении и выводах, но не выдумывай фактов):\n${l.join('\n')}\n\n` : ''
}
export interface Opts { limit: number; frames: boolean; visionModel?: string; synthModel?: string; subject?: Subject }
export interface Analysis { items: RepostItem[]; notes: Map<number, Note>; covers: Map<number, Cover>; stats: Stats; report: Report; warnings: string[]; usage: Vlm['usage'] }

/** Pages through the reposts list: through empty pages while TikTok says `hasMore`, stops on a stuck cursor. */
const LIST_STEP = 30

export async function collect(d: Deps, limit: number, warnings: string[]): Promise<RepostItem[]> {
  const seen = new Set<string>()
  const items: RepostItem[] = []
  let cursor = '0', empties = 0, same = 0, first = true
  while (items.length < limit && !d.cancelled()) {
    const r = await d.page(cursor)
    if (r.http === 401 || r.http === 403 || r.http === 429 || [10202, 10214].includes(r.code)) {
      if (first) throw new PsyError(r.http === 429 || r.code === 10202 ? 'TikTok просит подождать (лимит). Попробуйте позже.' : 'TikTok не отдаёт список репостов (проверка или ограничение). Откройте аккаунт на вкладке «Обзор» и повторите.')
      warnings.push('TikTok прервал выгрузку списка: репосты собраны не полностью.')
      break
    }
    if (r.http !== 200 || r.code !== 0) {
      if (first) throw new PsyError(`Не удалось получить список репостов (${r.http || 'нет связи'}${r.msg ? ': ' + r.msg : ''}).`)
      warnings.push('Список репостов оборвался на ошибке: собрано не всё.')
      break
    }
    first = false
    let fresh = 0
    for (const it of r.items) if (it.id && !seen.has(it.id)) { seen.add(it.id); items.push(it); fresh++ }
    d.progress({ phase: 'collect', done: items.length, total: 0, message: `Собираю репосты: ${items.length}` })
    empties = fresh ? 0 : empties + 1
    if (!r.hasMore) {
      // TikTok sometimes says "no more" in the middle of the list, so the next page has to agree.
      const next = String(Number(cursor) + LIST_STEP)
      if (!Number.isFinite(Number(cursor))) break
      const after = await d.page(next)
      if (after.http !== 200 || after.code !== 0 || (!after.hasMore && !after.items.length)) break
      cursor = next
      continue
    }
    same = r.cursor === cursor ? same + 1 : 0
    if (same >= 2 || empties >= 3000) { warnings.push('Список репостов остановился раньше конца (курсор не двигается).'); break }
    cursor = r.cursor
  }
  if (items.length >= limit) warnings.push(`Взяты ${limit} самых свежих репостов, остальные пропущены.`)
  return items.slice(0, limit)
}

export async function analyze(d: Deps, o: Opts): Promise<Analysis> {
  const warnings: string[] = []
  const vision = o.visionModel ?? VISION_MODEL
  const synth = o.synthModel ?? SYNTH_MODEL
  const items = await collect(d, Math.min(o.limit, MAX_ITEMS), warnings)
  if (d.cancelled()) throw new PsyError('Остановлено.', false)
  if (items.length < 5) throw new PsyError(items.length ? `Репостов слишком мало для портрета: ${items.length}.` : 'У аккаунта нет видимых репостов.')

  // stage 1: covers (+ frames) → notes
  const notes = new Map<number, Note>()
  const covers = new Map<number, Cover>()
  const groups: { at: number; list: RepostItem[] }[] = []
  for (let i = 0; i < items.length; i += BATCH) groups.push({ at: i + 1, list: items.slice(i, i + BATCH) })
  let done = 0, textOnly = 0, lost = 0
  const tick = () => d.progress({ phase: 'vision', done, total: items.length, message: `Читаю обложки: ${done} из ${items.length}` })
  tick()
  await pool(groups, VISION_THREADS, async (g) => {
    const shots: (Img[] | null)[] = await Promise.all(g.list.map(async (it, k) => {
      const c = await d.cover(it).catch(() => null)
      if (c) covers.set(g.at + k, c)
      const extra = o.frames && d.frames ? await d.frames(it).catch(() => []) : []
      const all: Img[] = [...(c ? [c] : []), ...extra]
      return all.length ? all : null
    }))
    let got: Note[] = []
    try {
      got = parseNotes(await d.vlm.ask(vision, VISION_SYSTEM, visionContent(g.list, shots, g.at), 5000, d.cancelled))
    } catch (e) {
      if (e instanceof PsyError && e.fatal) throw e
      if (d.cancelled()) throw e
      // a bad picture fails the whole request: once more, text only
      try { got = parseNotes(await d.vlm.ask(vision, VISION_SYSTEM, visionContent(g.list, g.list.map(() => null), g.at), 5000, d.cancelled)); textOnly += g.list.length } catch (e2) { if (e2 instanceof PsyError && e2.fatal) throw e2 }
    }
    for (const n of got) if (n.i >= g.at && n.i < g.at + g.list.length) notes.set(n.i, n)
    lost += g.list.length - got.filter((n) => n.i >= g.at && n.i < g.at + g.list.length).length
    done += g.list.length
    tick()
  }, d.cancelled)
  if (d.cancelled()) throw new PsyError('Остановлено.', false)
  if (textOnly) warnings.push(`У ${textOnly} видео картинки не прошли, разбор только по подписи.`)
  if (lost) warnings.push(`Модель не описала ${lost} видео из ${items.length}: они учтены только по подписи.`)
  if (notes.size < items.length / 4) throw new PsyError('Модель вернула слишком мало разбора обложек. Повторите позже.', false)

  // stage 2: the profile
  d.progress({ phase: 'synth', done: 0, total: 1, message: 'Собираю портрет…' })
  const stats = statsOf(items, notes)
  const text = digest(items, notes, stats)
  let report: Report | null = null
  for (let attempt = 0; attempt < 2 && !report; attempt++) {
    const raw = await d.vlm.ask(synth, SYNTH_SYSTEM, [{ type: 'text', text: subjectNote(o.subject) + text + (attempt ? '\n\nВерни только JSON, без пояснений.' : '') }], 16000, d.cancelled)
    const j = parseJson(raw)
    if (j && typeof j === 'object' && !Array.isArray(j)) report = sanitizeReport(j)
  }
  if (!report) throw new PsyError('Модель не вернула портрет в нужном виде. Повторите позже.', false)
  report.evidence = report.evidence.filter((e) => e.i >= 1 && e.i <= items.length)
  return { items, notes, covers, stats, report, warnings, usage: d.vlm.usage }
}
