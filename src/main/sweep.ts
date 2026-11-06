import { SWEEP_SPEEDS, SweepChoice, SweepItem, SweepJob, SweepKind, SweepSummary } from '../shared/types'
import { BACKOFF, DeleteReply, Fatal, Stopped, judgeDelete, judgeList } from './repost-cleaner'

// Clears likes, favorites and followed accounts through TikTok's web endpoints. No Electron here: the requests come in as `SweepApi`,
// so the whole flow is covered by unit tests on a fake server. The judging of replies is shared with the repost cleaner.
// The cursor of these lists is a time (seen live 2026-11-06: likes in ms, favorites and following in seconds) and any time can be asked for,
// so the list is cut into stretches of time that are read side by side; a server with another kind of cursor gets a plain walk.
// A reply proves nothing, as with reposts: `removed` grows only from list checks. Actions go in chunks, each chunk is checked while the next
// one is sent, what stays goes back to the queue, and a clean list is read again later, since removed items can come back.

export interface SweepPage { http: number; code: number; msg: string; items: SweepItem[]; hasMore: boolean; cursor: string; total?: number }
export interface SweepApi {
  list(cursor: string): Promise<SweepPage>
  remove(item: SweepItem): Promise<DeleteReply>
  /** Asks about one item directly: the profile or the video. After unfollows TikTok stops giving the following list for a while (empty 200, seen live 2026-11-06), these still answer. Nothing = unknown. */
  stillThere?(item: SweepItem): Promise<boolean | undefined>
  /** The Following feed: authors of recent videos of followed accounts. What is left when TikTok gives an empty answer to the following list, even to the site itself (seen live 2026-11-06). */
  feed?(cursor: string): Promise<SweepPage>
  /** How many the account follows, from its profile. */
  followingCount?(): Promise<number | undefined>
}
export interface SweepOptions {
  clock?: { now(): number; sleep(ms: number): Promise<void> } // tests run on a virtual clock
  settleMs?: number // pause before the verifying rescan: TikTok's list lags behind
  recheckMs?: number[] // pauses before the later rescans of a clean list: removed items can come back
}

export const PAGE = 30

/** Requests in flight at the start and at most, pause after each one, and a longer rest every `batch` actions (0 = no rest). "Обычно" is the pace of the repost cleanup. */
export const PACE: Record<SweepChoice['speed'], { start: number; max: number; gap: [number, number]; batch: number; rest: [number, number] }> = {
  careful: { start: 1, max: 2, gap: [800, 2000], batch: 50, rest: [20_000, 40_000] },
  normal: { start: 4, max: 8, gap: [50, 200], batch: 0, rest: [0, 0] },
  fast: { start: 8, max: 12, gap: [20, 80], batch: 0, rest: [0, 0] }
}

const MAX_PASSES = 8
const MAX_PAGES = 5000
const MAX_STALE = 200 // pages in a row with nothing new while TikTok still says "more"
const END_CHECK_MS = 1000
const SCAN_THREADS = 6 // list pages in flight: 16 made TikTok falsely say "no more" on reposts (2026-11-05)
const STRETCHES = 24 // pieces of time the list is cut into; more pieces than threads, so busy stretches even out
const FIRST_DAY = 1_472_688_000 // 2016-09: nothing on TikTok is older (seconds)
const CHUNK = 60 // actions between two list checks
const CHECK_PAGES = 6 // list pages read by one check
const CHECK_MS = 2000 // how long TikTok gets before a check
const RETRIES = 2 // times one item goes back to the queue after a check still sees it
const QUIET_TRIES = 3 // empty answers in a row before a list counts as withheld
const CONFIRM_MAX = 100 // what the list still shows is asked about directly up to this many: the list can lag behind
const QUIET_MS = 1000
const PROBE_SAMPLE = 12 // profiles read by one chunk check: the full look comes after the pass
const FEED_PAGES = 40 // feed pages at most, about 40 s: enough for a few hundred accounts, the next search after a cleanup brings more
const FEED_STALE = 15 // feed pages in a row without a new account
const SLOW_TRIES = 2 // limit replies to one item before it is set aside: one bad item must not stop the whole job
/** Pauses before reading a clean list again: 3 and 5 s for a handful, up to 15 and 30 s for hundreds, whose removals take TikTok longer to settle. */
const rechecks = (n: number) => { const k = Math.min(1, n / 300); return [3000 + 12_000 * k, 5000 + 25_000 * k] }
const RECOVER = 40 // actions in a row that bring one worker back after a slowdown
const REFUSED_ROW = 15 // refusals in a row with nothing accepted: something is wrong, more requests won't help

export const NOUN: Record<SweepKind, { many: string; list: string; verb: string; done: string; search: string }> = {
  likes: { many: 'лайков', list: 'лайков', verb: 'Снимаю лайки', done: 'снято лайков', search: 'Ищу лайки' },
  favorites: { many: 'видео в избранном', list: 'избранного', verb: 'Убираю из избранного', done: 'убрано из избранного', search: 'Ищу избранное' },
  following: { many: 'подписок', list: 'подписок', verb: 'Отписываюсь', done: 'отписок', search: 'Ищу подписки' }
}

const norm = (s: string) => s.trim().replace(/^@/, '').toLowerCase()

/** Checks a choice that came over IPC. Anything odd falls back to the safest value. */
export function cleanChoice(a: unknown): SweepChoice {
  const c = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>
  const whole = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : undefined)
  return {
    count: whole(c.count),
    order: c.order === 'old' ? 'old' : 'new',
    speed: SWEEP_SPEEDS.includes(c.speed as SweepChoice['speed']) ? (c.speed as SweepChoice['speed']) : 'careful',
    keep: Array.isArray(c.keep) ? c.keep.filter((x): x is string => typeof x === 'string').map(norm).filter(Boolean).slice(0, 500) : [],
    years: Array.isArray(c.years) ? c.years.filter((x): x is number => Number.isInteger(x)).slice(0, 40) : [],
    type: c.type === 'video' || c.type === 'photo' ? c.type : 'all',
    keepFriends: c.keepFriends !== false,
    keepVerified: c.keepVerified !== false,
    onlyEmpty: c.onlyEmpty === true
  }
}

/** What a choice touches: filters first, then the order, then the number. The list comes newest first. */
export function pick(items: SweepItem[], c: SweepChoice, kind: SweepKind): SweepItem[] {
  const keep = new Set(c.keep)
  const years = new Set(c.years)
  const left = items.filter((it) => {
    if (it.author && keep.has(it.author.toLowerCase())) return false
    if (kind === 'following') return !(c.keepFriends && it.friend) && !(c.keepVerified && it.verified) && !(c.onlyEmpty && it.videos !== 0)
    if (c.type === 'video' && it.photo) return false
    if (c.type === 'photo' && !it.photo) return false
    return !years.size || (!!it.time && years.has(new Date(it.time * 1000).getFullYear()))
  })
  const ordered = c.order === 'old' ? [...left].reverse() : left
  return c.count ? ordered.slice(0, c.count) : ordered
}

/** What the first screen shows about the found items. */
export function summarize(items: SweepItem[]): SweepSummary {
  const by = new Map<string, number>(), years = new Map<number, number>()
  let newest: number | undefined, oldest: number | undefined
  const s: SweepSummary = { total: items.length, authors: 0, photos: 0, friends: 0, verified: 0, empty: 0, top: [], years: [] }
  for (const it of items) {
    if (it.author) by.set(it.author, (by.get(it.author) ?? 0) + 1)
    if (it.photo) s.photos++
    if (it.friend) s.friends++
    if (it.verified) s.verified++
    if (it.videos === 0) s.empty++
    if (it.time) {
      const ms = it.time * 1000
      newest = Math.max(newest ?? 0, ms)
      oldest = Math.min(oldest ?? Infinity, ms)
      const y = new Date(ms).getFullYear()
      years.set(y, (years.get(y) ?? 0) + 1)
    }
  }
  return {
    ...s, authors: by.size, newest, oldest,
    top: [...by].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count })),
    years: [...years].sort((a, b) => b[0] - a[0]).map(([year, count]) => ({ year, count }))
  }
}

/** A link for the list the user can keep after a cleanup: nothing here can be undone in one click. */
export const linkOf = (it: SweepItem, kind: SweepKind) => (kind === 'following' ? `https://www.tiktok.com/@${it.author}` : `https://www.tiktok.com/@${it.author ?? ''}/${it.photo ? 'photo' : 'video'}/${it.id}`)

type Hit = SweepItem & { at: string } // `at` = the cursor of the page it was found on: still valid after removals, the cursor is a time

/** TikTok answers this list with an empty 200 for now. Pauses of minutes don't bring it back; items can still be asked about one by one. */
class Withheld extends Fatal {}

const realClock = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) }

export class Sweeper {
  private stopped = false
  private workers = 1
  private pauseUntil = 0
  private strikes = 0
  private okRow = 0
  private refused = 0 // refusals since the last request TikTok took
  private actions = 0 // sent so far, for the rests
  private quiet = 0 // empty answers in a row to the list
  private direct = false // items are checked one by one, not by the list
  private slowBy = new Map<string, number>() // limit replies per item
  private why = new Map<string, string>() // what TikTok said about items it would not take
  private clock: { now(): number; sleep(ms: number): Promise<void> }
  items: Hit[] = [] // what the search found, in the list's order
  gone: SweepItem[] = [] // what the list no longer shows
  private declared?: number // how many TikTok says the list has

  constructor(private api: SweepApi, public job: SweepJob, private onChange: () => void, private opt: SweepOptions = {}) {
    this.clock = opt.clock ?? realClock
    this.direct = job.kind === 'following' && !!api.stillThere // the list goes quiet right after unfollows
  }

  stop() { this.stopped = true }

  private set(patch: Partial<SweepJob>) {
    Object.assign(this.job, patch)
    this.onChange()
  }

  private check() { if (this.stopped) throw new Stopped() }

  private async wait(ms: number) {
    const end = this.clock.now() + ms
    for (;;) {
      this.check()
      const left = end - this.clock.now()
      if (left <= 0) return
      await this.clock.sleep(Math.min(250, left))
    }
  }

  private spread([a, b]: [number, number]) { return a + Math.random() * (b - a) }

  /** One shared pause for all workers; each slowdown in a row doubles it and halves the workers. */
  private async slowDown() {
    const now = this.clock.now()
    if (now < this.pauseUntil) return this.wait(this.pauseUntil - now)
    if (this.strikes >= BACKOFF.length) throw new Fatal('TikTok не принимает запросы даже после пауз (лимит)')
    const ms = BACKOFF[this.strikes++]
    this.okRow = 0
    this.workers = Math.max(1, Math.floor(this.workers / 2))
    this.pauseUntil = now + ms
    const msg = this.job.message
    this.set({ message: `TikTok просит притормозить, жду ${Math.round(ms / 1000)} с…` })
    await this.wait(ms)
    this.set({ message: msg })
  }

  private async page(cursor: string): Promise<SweepPage> {
    for (;;) {
      this.check()
      const r = await this.api.list(cursor)
      if (r.http === 200 && r.code === -1) {
        if (++this.quiet >= QUIET_TRIES) { this.quiet = 0; throw new Withheld(`сейчас он не отдаёт список ${NOUN[this.job.kind].list}. Так бывает после массовых действий, запустите чистку позже`) }
        await this.wait(QUIET_MS)
        continue
      }
      if (judgeList(r) === 'ok') { this.strikes = 0; this.quiet = 0; return r }
      await this.slowDown()
    }
  }

  /** Reads on from `cursor` until the list ends or the cursor passes `low`. */
  private async chain(cursor: string, low: number, keep: (at: string, r: SweepPage) => void, first?: SweepPage) {
    let stale = 0
    for (let n = 0; n < MAX_PAGES; n++) {
      const given = n === 0 ? first : undefined
      let r = given ?? await this.page(cursor)
      if (!given) keep(cursor, r)
      if (!r.hasMore) {
        if (!r.items.length) return // nothing older: a false "no more" comes with a full page
        await this.wait(END_CHECK_MS) // "no more" can be false in the middle of a long list: the same page has to say it again
        r = await this.page(cursor)
        keep(cursor, r)
        if (!r.hasMore) return
      }
      stale = r.items.length ? 0 : stale + 1
      if (stale >= MAX_STALE || r.cursor === cursor) return
      if (Number.isFinite(low) && Number(r.cursor) < low) return
      cursor = r.cursor
    }
  }

  /** Everything the list gives, in its order. When the cursor is a time, stretches of time are read side by side; they overlap by a page at most, items are counted once. */
  private async scan(onPage: (n: number) => void): Promise<Hit[]> {
    const parts: Map<string, Hit>[] = [new Map()]
    const seen = new Set<string>()
    const keepIn = (part: Map<string, Hit>) => (at: string, r: SweepPage) => {
      for (const it of r.items) { seen.add(it.id); if (!part.has(it.id)) part.set(it.id, { ...it, at }) }
      onPage(seen.size)
    }
    const first = await this.page('0')
    this.declared = first.total ?? this.declared
    keepIn(parts[0])('0', first)
    const top = Number(first.cursor)
    if (!(top > FIRST_DAY) || !first.hasMore) await this.chain('0', -Infinity, keepIn(parts[0]), first)
    else {
      const floor = Math.min(top, FIRST_DAY * (top > 1e11 ? 1000 : 1))
      const step = Math.max(1, Math.ceil((top - floor) / STRETCHES))
      const jobs = Array.from({ length: STRETCHES }, (_, i) => ({ high: top - i * step, low: top - (i + 1) * step, part: new Map<string, Hit>() }))
      jobs[jobs.length - 1].low = -Infinity // the last one reads on to the end of the list, whatever its date
      parts.push(...jobs.map((j) => j.part))
      let next = 0
      let abort: unknown
      const worker = async () => {
        try {
          while (!abort && next < jobs.length) {
            const j = jobs[next++]
            await this.chain(String(j.high), j.low, keepIn(j.part))
          }
        } catch (e) { abort ??= e }
      }
      await Promise.all(Array.from({ length: SCAN_THREADS }, worker))
      if (abort) throw abort
    }
    const out = new Map<string, Hit>()
    for (const p of parts) for (const [id, it] of p) if (!out.has(id)) out.set(id, it)
    return [...out.values()]
  }

  /** Accounts from the Following feed, one page at a time, until it ends or stops bringing new ones. */
  private async walkFeed(onPage: (n: number) => void): Promise<Hit[]> {
    const found = new Map<string, Hit>()
    let cursor = '0', stale = 0
    for (let n = 0; n < FEED_PAGES; n++) {
      this.check()
      const r = await this.api.feed!(cursor)
      if (r.code === -1 && r.http === 200) break
      if (judgeList(r) !== 'ok') { await this.slowDown(); continue }
      const before = found.size
      for (const it of r.items) if (!found.has(it.id)) found.set(it.id, { ...it, at: 'feed' })
      onPage(found.size)
      stale = found.size > before ? 0 : stale + 1
      if (!r.hasMore || stale >= FEED_STALE || r.cursor === cursor) break
      cursor = r.cursor
    }
    return [...found.values()]
  }

  /** Searches the list. The job ends up `ready` for the user's choice, or `done` when there is nothing. */
  async find(): Promise<SweepJob> {
    return this.guard(async () => {
      const noun = NOUN[this.job.kind]
      this.set({ phase: 'scan', message: `${noun.search}…` })
      const onPage = (n: number) => this.set({ found: n, message: `${noun.search}… найдено ${n}` })
      let partial = false
      try { this.items = await this.scan(onPage) } catch (e) {
        if (!(e instanceof Withheld) || !this.api.feed) throw e
      }
      if (!this.items.length && this.api.feed) { // an empty list is not proof here: it may be withheld too
        this.set({ message: 'Список TikTok не отдаёт, собираю аккаунты из ленты «Подписки»…' })
        this.items = await this.walkFeed(onPage)
        partial = this.items.length > 0
        this.declared = await this.api.followingCount?.().catch(() => undefined)
      }
      if (!this.items.length) return this.finish('done', `Здесь пусто: ${noun.many} нет.`)
      this.set({ status: 'ready', found: this.items.length, summary: { ...summarize(this.items), declared: this.declared, partial }, message: 'Поиск закончен.' })
      return this.job
    })
  }

  private setAside(it: Hit, tries: Map<string, number>, why: string) {
    this.why.set(it.id, why)
    tries.set(it.id, RETRIES + 1)
  }

  /** Sends one chunk with several requests in flight; returns what TikTok took. */
  private async send(chunk: Hit[], c: SweepChoice, tries: Map<string, number>): Promise<Hit[]> {
    const pace = PACE[c.speed]
    const queue = [...chunk]
    const taken: Hit[] = []
    let abort: unknown // the first fatal error stops every worker before its next request
    const worker = async (k: number) => {
      try {
        while (!abort && queue.length) {
          this.check()
          const now = this.clock.now()
          if (now < this.pauseUntil) { await this.wait(this.pauseUntil - now); continue }
          if (k >= this.workers) { await this.wait(500); continue } // parked until TikTok takes more again
          const it = queue.shift()!
          let verdict: 'ok' | 'slow' | 'fail'
          let why = ''
          try {
            const r = await this.api.remove(it)
            why = r.msg || (r.code ? `код ${r.code}` : r.http !== 200 ? `HTTP ${r.http}` : '')
            verdict = judgeDelete(r)
          } catch (e) {
            if (e instanceof Fatal) throw e
            verdict = 'fail'
          }
          if (abort) return
          if (verdict === 'slow') {
            // The request before went through: this looks like the item, not a limit. Only a run of them means TikTok wants a pause.
            const n = (this.slowBy.get(it.id) ?? 0) + 1
            this.slowBy.set(it.id, n)
            if (n >= SLOW_TRIES) { this.setAside(it, tries, why); continue }
            const alone = this.okRow > 0
            this.okRow = 0
            queue.push(it)
            if (alone) await this.wait(CHECK_MS); else await this.slowDown()
            continue
          }
          if (verdict === 'fail') {
            if (++this.refused >= REFUSED_ROW) throw new Fatal(`TikTok отклоняет запросы${why ? ` (${why})` : ''}`)
            this.why.set(it.id, why)
            tries.set(it.id, (tries.get(it.id) ?? 0) + RETRIES) // a second refusal ends the tries, no more passes for it
          } else {
            this.refused = 0
            this.strikes = 0
            taken.push(it)
            this.set({ sent: (this.job.sent ?? 0) + 1 })
            if (++this.okRow >= RECOVER && this.workers < pace.max) { this.workers++; this.okRow = 0 }
          }
          await this.wait(this.spread(pace.gap)) // an even machine-gun rhythm is what TikTok drops first
          if (pace.batch && ++this.actions % pace.batch === 0 && queue.length) {
            const msg = this.job.message
            const ms = this.spread(pace.rest)
            this.pauseUntil = Math.max(this.pauseUntil, this.clock.now() + ms)
            this.set({ message: `Небольшой перерыв, ${Math.round(ms / 1000)} с: так TikTok реже ограничивает…` })
            await this.wait(ms)
            this.set({ message: msg })
          }
        }
      } catch (e) { abort ??= e }
    }
    while (queue.length && !abort) await Promise.all(Array.from({ length: pace.max }, (_, k) => worker(k)))
    if (abort) throw abort
    return taken
  }

  /**
   * Reads the list where a sent chunk was. What is still there goes back to the queue and slows the job down; clean checks speed it up.
   * This is how the job finds its pace: a reply can't tell an applied action from a dropped one.
   */
  private async inspect(sent: Hit[], queue: Hit[], tries: Map<string, number>, c: SweepChoice) {
    if (!sent.length) return
    await this.wait(CHECK_MS)
    let seen: Set<string>
    const byList = async () => {
      const cursors = [...new Set(sent.map((h) => h.at))].slice(0, CHECK_PAGES)
      const pages = await Promise.all(cursors.map((at) => this.page(at)))
      return new Set(pages.flatMap((p) => p.items.map((x) => x.id)))
    }
    seen = await this.orDirect(byList, sent.slice(0, PROBE_SAMPLE))
    if (seen.size && this.api.stillThere && !this.direct) { // the list may just be behind: the item itself has the last word
      const asked = await this.probe(sent.filter((h) => seen.has(h.id)).slice(0, PROBE_SAMPLE))
      seen = asked
    }
    const still = sent.filter((h) => seen.has(h.id))
    this.set({ removed: Math.min(this.job.found, this.job.removed + sent.length - still.length), returned: (this.job.returned ?? 0) + still.length })
    for (const h of still) {
      const n = tries.get(h.id) ?? 0
      tries.set(h.id, n + 1)
      if (n < RETRIES) queue.push(h)
    }
    if (still.length > sent.length * 0.1) {
      this.workers = Math.max(1, Math.floor(this.workers / 2))
      this.okRow = 0
      this.set({ message: `TikTok не применил ${still.length} из ${sent.length}, сбавляю скорость и повторяю…` })
      await this.wait(CHECK_MS)
    } else if (this.workers < PACE[c.speed].max) this.workers = Math.min(PACE[c.speed].max, this.workers + 2)
  }

  /** Acts in chunks; each chunk is checked against the list while the next one is being sent. */
  private async deleteAll(hits: Hit[], c: SweepChoice, tries: Map<string, number>) {
    const queue = [...hits]
    let abort: unknown
    let checking: Promise<void> | undefined
    while ((queue.length || checking) && !abort) {
      const sent = queue.length ? await this.send(queue.splice(0, CHUNK), c, tries) : []
      await checking
      checking = sent.length ? this.inspect(sent, queue, tries, c).catch((e) => { abort ??= e }) : undefined
    }
    await checking
    if (abort) throw abort
  }

  /** Acts on what the choice picks. What the list still shows goes through another pass; a clean list is read twice more, later. */
  async remove(choice: SweepChoice): Promise<SweepJob> {
    return this.guard(async () => {
      const noun = NOUN[this.job.kind]
      const picked = pick(this.items, choice, this.job.kind) as Hit[]
      const tries = new Map<string, number>()
      const reread = async () => {
        const seen = await this.look(picked)
        const left = picked.filter((x) => seen.has(x.id))
        this.gone = picked.filter((x) => !seen.has(x.id))
        this.set({ removed: picked.length - left.length, failed: left.length })
        return left
      }
      this.workers = PACE[choice.speed].start
      this.strikes = 0
      this.set({ status: 'running', phase: 'delete', target: picked.length, found: picked.length, removed: 0, failed: 0, returned: 0, sent: 0, deleteStartedAt: Date.now(), message: `${noun.verb}…` })
      let left = picked
      for (let pass = 1; pass <= MAX_PASSES && left.length; pass++) {
        this.set({ phase: 'delete', pass, message: pass > 1 ? `Проход ${pass}: осталось ${left.length}…` : `${noun.verb}…` })
        await this.deleteAll(left, choice, tries)
        this.set({ phase: 'verify', message: 'Проверяю, что всё применилось…' })
        await this.wait(this.opt.settleMs ?? (picked.length < 100 ? 1000 : 3000))
        left = await reread()
        if (!left.length) {
          for (const [i, ms] of (this.opt.recheckMs ?? rechecks(picked.length)).entries()) {
            this.set({ message: `Всё применилось. Проверка ${i + 2}: смотрю, не откатилось ли что-то…` })
            await this.wait(ms)
            left = await reread()
            if (left.length) break
          }
        }
        left = left.filter((x) => (tries.get(x.id) ?? 0) <= RETRIES) // what used up its tries stays: another pass would only repeat the same requests
      }
      const j = this.job
      if (!j.failed) return this.finish('done', `Готово: ${noun.done} ${j.removed} из ${j.found}. Проверено три раза, ничего не вернулось.`)
      const kept = picked.filter((x) => !this.gone.includes(x))
      const reason = this.job.kind === 'following' && kept.some((x) => !x.author) ? ' Похоже, аккаунт удалён или заблокирован: TikTok не даёт от него отписаться.' : kept.map((x) => this.why.get(x.id)).find(Boolean) ? ` Причина: ${kept.map((x) => this.why.get(x.id)).find(Boolean)}.` : ' Попробуйте ещё раз позже.'
      return this.finish('done', `Готово ${j.removed} из ${j.found}. TikTok оставил ${j.failed}.${reason}`)
    })
  }

  /** Which of these items are still there, asked one by one. What can't be told counts as there, with a note: it must not read as done. */
  private async probe(items: Hit[]): Promise<Set<string>> {
    const queue = [...items]
    const seen = new Set<string>()
    let abort: unknown
    const worker = async () => {
      try {
        for (let it = queue.shift(); it && !abort; it = queue.shift()) {
          this.check()
          const r = await this.api.stillThere!(it)
          if (r !== false) seen.add(it.id)
          if (r === undefined) this.why.set(it.id, 'не удалось проверить')
          else this.why.delete(it.id)
        }
      } catch (e) { abort ??= e }
    }
    await Promise.all(Array.from({ length: SCAN_THREADS }, worker))
    if (abort) throw abort
    return seen
  }

  /** Which of these items the list still shows. A time cursor stays valid after removals, so only their pages are read, side by side. */
  private async look(items: Hit[]): Promise<Set<string>> {
    const byList = async () => {
      const cursors = [...new Set(items.map((x) => x.at))]
      if (!cursors.every((c) => c === '0' || Number(c) > FIRST_DAY)) return new Set((await this.scan(() => {})).map((x) => x.id))
      const seen = new Set<string>()
      let abort: unknown
      const worker = async () => {
        try {
          for (let c = cursors.shift(); c !== undefined && !abort; c = cursors.shift()) for (const it of (await this.page(c)).items) seen.add(it.id)
        } catch (e) { abort ??= e }
      }
      await Promise.all(Array.from({ length: SCAN_THREADS }, worker))
      if (abort) throw abort
      return seen
    }
    const seen = await this.orDirect(byList, items)
    const shown = items.filter((x) => seen.has(x.id))
    if (this.direct || !this.api.stillThere || !shown.length || shown.length > CONFIRM_MAX) return seen
    return this.probe(shown) // the list can lag behind: what it still shows is asked about directly
  }

  /** The list, or the items one by one once the list is withheld. */
  private async orDirect(byList: () => Promise<Set<string>>, items: Hit[]): Promise<Set<string>> {
    if (this.direct) return this.probe(items)
    try { return await byList() } catch (e) {
      if (!(e instanceof Withheld) || !this.api.stillThere) throw e
      this.direct = true
      return this.probe(items)
    }
  }

  private async guard(work: () => Promise<SweepJob>): Promise<SweepJob> {
    try {
      return await work()
    } catch (e) {
      const j = this.job
      const sent = j.sent ? ` Отправлено ${j.sent}, по списку подтверждено ${j.removed}.` : ''
      if (e instanceof Stopped) return this.finish('stopped', `Остановлено.${sent}`)
      const why = e instanceof Fatal ? 'TikTok ограничил действия или просит проверку, работа остановлена: ' : 'Ошибка: '
      return this.finish('stopped', `${why}${(e as Error).message}.${sent} Запустите снова позже.`)
    }
  }

  private finish(status: 'done' | 'stopped', message: string) {
    this.set({ status, message, finishedAt: Date.now() })
    return this.job
  }
}
