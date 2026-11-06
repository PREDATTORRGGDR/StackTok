import type { Job, RepostSummary } from '../shared/types'

// Removes reposts of an account through TikTok's web endpoints. No Electron here: the requests come in as `RepostApi`,
// so the whole flow is covered by unit tests on a fake server.
// Flow and reply rules from the open "unrepost" tools: github.com/lansixxx/UnRepost (MIT: silent throttling, rescan from the start
// until nothing is left), github.com/Skenls/tiktok-unrepost (MIT: parallel deletes, one shared pause on 429, walking past empty list
// pages) and github.com/yiitxyz/tiktokRepostRemover (scan → delete → verify).
// The delete reply proves nothing: TikTok answers delete_video_status 1 even for an id that does not exist (checked live 2026-11-05).
// Only the list tells what is gone, so `removed` grows from list checks, never from delete replies.

export interface RepostItem { id: string; author?: string; time?: number; photo?: boolean }
/** One page of /api/repost/item_list/. `http` 0 = no reply at all. `items` carries details for the ids when known. */
export interface ListReply { http: number; code: number; msg: string; ids: string[]; items?: RepostItem[]; hasMore: boolean; cursor: string }
/** Reply of /tiktok/v1/upvote/delete. `deleted` is what `delete_result` says: true, false, or undefined when it is missing. */
export interface DeleteReply { http: number; empty: boolean; json: boolean; code: number; msg: string; deleted?: boolean }
export interface RepostApi {
  list(cursor: string): Promise<ListReply>
  remove(id: string): Promise<DeleteReply>
}
export interface CleanerOptions {
  workers?: number // deletes in flight at the start; grows while list checks stay clean, halves when they don't
  clock?: { now(): number; sleep(ms: number): Promise<void> } // tests run on a virtual clock
  settleMs?: number // pause before the verifying rescan (TikTok's list lags behind deletes)
  recheckMs?: number // pause before the last rescan: deleted reposts can come back a little later
}

export const PAGE = 30
export const WORKERS = 8 // most deletes in flight
export const SCAN_THREADS = 8 // list pages in flight: 16 made TikTok falsely say "no more" (2026-11-05)
export const BACKOFF = [20_000, 40_000, 80_000, 160_000] // shared pause after each slowdown in a row; one more and the job stops
const START_WORKERS = 4
const CHUNK = 60 // deletes between two list checks
const CHECK_PAGES = 6 // list pages read by one check
const CHECK_MS = 2000 // how long TikTok gets before a check
const RETRIES = 2 // times one repost goes back to the queue after a check still sees it
const MAX_PASSES = 8
const RECOVER = 40 // deletes in a row that bring one worker back after a slowdown
const MAX_STALE_PAGES = 3000 // list pages in a row with nothing new while TikTok still says "more". Old lists have long empty stretches
const END_CHECK_MS = 1000
const MAX_PAGES = 20_000

const CAPTCHA = /captcha|verif|unusual|risk|restricted|suspicious/i
const LIMIT = /frequent|too many|rate.?limit|limit|cooldown|busy|slow down/i

/** Captcha, identity check, signed out or banned: the job stops and the user is told. */
export class Fatal extends Error {}
export class Stopped extends Error {}

type Verdict = 'ok' | 'slow' | 'fail'
type Hit = RepostItem & { at: number } // `at` = list offset of its page

/** How one delete reply counts. 'ok' only means TikTok took the request; the list decides whether the repost is gone. */
export function judgeDelete(r: DeleteReply): Verdict {
  if (r.http === 429 || r.http === 503) return 'slow'
  if (r.http === 401 || r.http === 403) throw new Fatal(`TikTok ответил ${r.http}`)
  if (r.http !== 200) return 'fail'
  if (r.empty) return 'slow' // TikTok drops bursts silently with an empty 200; never a success
  if (!r.json) return 'fail'
  if (r.code === 10214 || CAPTCHA.test(r.msg)) throw new Fatal(r.msg || 'TikTok просит пройти проверку')
  if (r.code === 10202 || r.code === 429 || (r.code !== 0 && LIMIT.test(r.msg))) return 'slow'
  if (r.code !== 0) return 'fail'
  if (r.deleted === false) return 'slow' // status 0 but delete_video_status 0: accepted and not applied
  return 'ok'
}

function judgeList(r: ListReply): 'ok' | 'slow' {
  if (r.http === 429 || r.http === 503 || r.code === 10202 || r.code === 429) return 'slow'
  if (r.http === 401 || r.http === 403) throw new Fatal(`TikTok ответил ${r.http}`)
  if (r.code === 10214 || CAPTCHA.test(r.msg)) throw new Fatal(r.msg || 'TikTok просит пройти проверку')
  if (r.http === 200 && r.code === 0) return 'ok'
  if (r.http === 200 && r.code === -1) return 'slow' // an empty 200 is TikTok's quiet refusal: the list is not empty, it is withheld
  if (LIMIT.test(r.msg)) return 'slow'
  throw new Error(`список репостов недоступен (${r.http ? `код ${r.code}` : 'нет ответа'}${r.msg ? ': ' + r.msg : ''})`)
}

/** What the first screen shows about the found reposts. */
export function summarize(items: RepostItem[], entries: number): RepostSummary {
  const by = new Map<string, number>(), years = new Map<number, number>()
  let newest: number | undefined, oldest: number | undefined, photos = 0
  for (const it of items) {
    if (it.author) by.set(it.author, (by.get(it.author) ?? 0) + 1)
    if (it.photo) photos++
    if (it.time) {
      const ms = it.time * 1000
      newest = Math.max(newest ?? 0, ms)
      oldest = Math.min(oldest ?? Infinity, ms)
      const y = new Date(ms).getFullYear()
      years.set(y, (years.get(y) ?? 0) + 1)
    }
  }
  return {
    total: items.length, entries: Math.max(entries, items.length), authors: by.size, photos, newest, oldest,
    top: [...by].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count })),
    years: [...years].sort((a, b) => b[0] - a[0]).map(([year, count]) => ({ year, count }))
  }
}

const realClock = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) }
const itemsOf = (r: ListReply): RepostItem[] => r.items ?? r.ids.map((id) => ({ id }))

export class RepostCleaner {
  private stopped = false
  private workers: number
  private pauseUntil = 0
  private strikes = 0 // slowdowns since the last request that went through
  private okRow = 0 // deletes in a row without a slowdown; enough of them bring a worker back
  private clock: { now(): number; sleep(ms: number): Promise<void> }
  private hits: Hit[] = [] // what the search found, newest first
  private entries = 0 // places in the list, unavailable videos included

  constructor(private api: RepostApi, public job: Job, private onChange: () => void, private opt: CleanerOptions = {}) {
    this.workers = opt.workers ?? START_WORKERS
    this.clock = opt.clock ?? realClock
  }

  stop() { this.stopped = true }

  private set(patch: Partial<Job>) {
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

  /** One shared pause for all workers; each slowdown in a row doubles it and halves the workers (they come back as deletes go through). */
  private async slowDown() {
    const now = this.clock.now()
    if (now < this.pauseUntil) return this.wait(this.pauseUntil - now) // another worker already paused everyone
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

  /** A list page, waiting out slowdowns. */
  private async page(cursor: string): Promise<ListReply> {
    for (;;) {
      this.check()
      const r = await this.api.list(cursor)
      if (judgeList(r) === 'ok') { this.strikes = 0; return r }
      await this.slowDown()
    }
  }

  /**
   * TikTok sometimes says "no more" in the middle of the list (seen live 2026-11-05: 390 of 1830), and believing it would report
   * a clean account with reposts left. So the end counts only if the same page and the next one confirm it a moment later.
   */
  private async reallyEnded(offset: number, keep: (at: number, r: ListReply) => void): Promise<boolean> {
    await this.wait(END_CHECK_MS)
    for (const at of [offset, offset + PAGE]) {
      const r = await this.page(String(at))
      keep(at, r)
      if (r.hasMore || (at !== offset && r.ids.length)) return false
    }
    return true
  }

  /**
   * Every repost the list gives, newest first. The cursor is a plain offset, so pages are read side by side; a server that does not
   * step by offset gets the walk below. `until` stops at that offset, for checks that only care about the top of the list.
   */
  async scan(onPage: (n: number) => void, until = Infinity): Promise<Hit[]> {
    const first = await this.page('0')
    const pages = new Map<number, RepostItem[]>([[0, itemsOf(first)]])
    const keep = (at: number, r: ListReply) => {
      pages.set(at, itemsOf(r))
      onPage(new Set([...pages.values()].flat().map((x) => x.id)).size)
    }
    keep(0, first)
    let end = Infinity
    if (!first.hasMore && await this.reallyEnded(0, keep)) end = 0
    else if (first.cursor !== String(PAGE)) return this.walk(first, onPage)
    let next = PAGE
    let abort: unknown
    const worker = async () => {
      try {
        while (!abort && next < end && next <= until && next < MAX_PAGES * PAGE) {
          const o = next
          next += PAGE
          const r = await this.page(String(o))
          keep(o, r)
          if (!r.hasMore && o < end && await this.reallyEnded(o, keep)) end = Math.min(end, o)
        }
      } catch (e) { abort ??= e }
    }
    await Promise.all(Array.from({ length: SCAN_THREADS }, worker))
    if (abort) throw abort
    this.entries = Number.isFinite(end) ? end + PAGE : next
    const seen = new Set<string>()
    const hits: Hit[] = []
    for (const at of [...pages.keys()].sort((a, b) => a - b)) {
      if (at > end + PAGE) continue
      for (const it of pages.get(at)!) if (!seen.has(it.id)) { seen.add(it.id); hits.push({ ...it, at }) }
    }
    return hits
  }

  /** The list one page at a time, following TikTok's cursor. */
  private async walk(first: ListReply, onPage: (n: number) => void): Promise<Hit[]> {
    const hits = new Map<string, Hit>()
    const seen = new Set<string>()
    let cursor = '0', r = first, stale = 0
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      seen.add(cursor)
      const before = hits.size
      const add = (at: number, x: ListReply) => { for (const it of itemsOf(x)) if (!hits.has(it.id)) hits.set(it.id, { ...it, at }) }
      add(Number(cursor) || 0, r)
      onPage(hits.size)
      if (!r.hasMore && (!Number.isFinite(Number(cursor)) || await this.reallyEnded(Number(cursor), add))) break
      stale = hits.size > before ? 0 : stale + 1
      if (stale >= MAX_STALE_PAGES) break
      let next = r.cursor
      if (seen.has(next) || !(Number(next) > Number(cursor))) { // cursor did not move: step past this page ourselves (Skenls)
        const n = Number(cursor)
        if (!Number.isFinite(n)) break
        next = String(n + PAGE)
        if (seen.has(next)) break
      }
      cursor = next
      r = await this.page(cursor)
    }
    this.entries = Math.max(Number(cursor) || 0, hits.size)
    return [...hits.values()]
  }

  /** Sends deletes with several requests in flight; returns the reposts TikTok took. */
  private async send(chunk: Hit[], failed: Set<string>): Promise<Hit[]> {
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
          const hit = queue.shift()!
          let verdict: Verdict
          try { verdict = judgeDelete(await this.api.remove(hit.id)) } catch (e) {
            if (e instanceof Fatal) throw e
            verdict = 'fail'
          }
          if (abort) return
          if (verdict === 'slow') { queue.unshift(hit); await this.slowDown(); continue }
          this.strikes = 0
          if (++this.okRow >= RECOVER && this.workers < WORKERS) { this.workers++; this.okRow = 0 }
          if (verdict === 'ok') { failed.delete(hit.id); taken.push(hit) } else failed.add(hit.id)
          await this.wait(50 + Math.random() * 150) // an even machine-gun rhythm is what TikTok drops first (Skenls)
        }
      } catch (e) { abort ??= e }
    }
    // A worker leaves when the queue is empty; a repost another worker puts back after a slowdown is picked up by the next round.
    while (queue.length && !abort) await Promise.all(Array.from({ length: WORKERS }, (_, k) => worker(k)))
    if (abort) throw abort
    return taken
  }

  /**
   * Reads the list where a sent chunk was. What is still there goes back to the queue and slows the job down; clean checks speed it
   * up. This is how the job finds its pace: TikTok's own reply can't tell an applied delete from a dropped one.
   */
  private async inspect(sent: Hit[], queue: Hit[], tries: Map<string, number>) {
    if (!sent.length) return
    await this.wait(CHECK_MS)
    const offsets = [...new Set(sent.map((h) => h.at))].slice(0, CHECK_PAGES)
    const pages = await Promise.all(offsets.map((at) => this.page(String(at))))
    const seen = new Set(pages.flatMap((p) => p.ids))
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
    } else if (this.workers < WORKERS) this.workers = Math.min(WORKERS, this.workers + 2)
  }

  /** Deletes in chunks; each chunk is checked against the list while the next one is being sent. */
  private async deleteAll(hits: Hit[]): Promise<Set<string>> {
    const queue = [...hits]
    const failed = new Set<string>()
    const tries = new Map<string, number>()
    let abort: unknown
    let checking: Promise<void> | undefined
    while ((queue.length || checking) && !abort) {
      const sent = queue.length ? await this.send(queue.splice(0, CHUNK), failed) : []
      await checking
      checking = sent.length ? this.inspect(sent, queue, tries).catch((e) => { abort ??= e }) : undefined
    }
    await checking
    if (abort) throw abort
    return failed
  }

  /** Searches the list. The job ends up `ready` for the user to choose how many to remove, or `done` when there is nothing. */
  async find(): Promise<Job> {
    return this.guard(async () => {
      this.set({ phase: 'scan', message: 'Ищу репосты…' })
      this.hits = await this.scan((n) => this.set({ found: n, message: `Ищу репосты… найдено ${n}` }))
      if (!this.hits.length) return this.finish('done', 'Репостов нет, удалять нечего.')
      this.set({ status: 'ready', found: this.hits.length, summary: summarize(this.hits, this.entries), message: 'Поиск закончен.' })
      return this.job
    })
  }

  /** Removes the newest `count` found reposts, or all of them. Whatever the list still shows goes through another pass. */
  async remove(count?: number): Promise<Job> {
    return this.guard(async () => {
      const picked = count ? this.hits.slice(0, count) : this.hits
      const all = new Set(picked.map((h) => h.id)) // grows only when everything was asked for: a rescan can show more
      const until = count ? Math.max(...picked.map((h) => h.at)) + PAGE : Infinity
      const rescan = async () => {
        const list = await this.scan(() => {}, until)
        if (!count) list.forEach((h) => all.add(h.id))
        return list.filter((h) => all.has(h.id))
      }
      this.workers = this.opt.workers ?? START_WORKERS
      this.strikes = 0
      this.set({ status: 'running', target: picked.length, found: picked.length, removed: 0, failed: 0, returned: 0 })
      let left: Hit[] = picked
      for (let pass = 1; pass <= MAX_PASSES && left.length; pass++) {
        this.set({ phase: 'delete', pass, deleteStartedAt: this.job.deleteStartedAt ?? Date.now(), message: pass > 1 ? `Проход ${pass}: удаляю оставшиеся ${left.length}…` : 'Удаляю репосты…' })
        await this.deleteAll(left)
        this.set({ phase: 'verify', message: 'Проверяю по списку, что всё удалено…' })
        await this.wait(this.opt.settleMs ?? 3000)
        const prev = new Set(left.map((h) => h.id))
        left = await rescan()
        this.set({ found: all.size, removed: all.size - left.length, failed: left.length })
        // The list looks clean: look once more a bit later, since deleted reposts can come back. Those go through another pass.
        let back = false
        if (!left.length) {
          this.set({ message: 'Проверяю ещё раз, что старые репосты не вернулись…' })
          await this.wait(this.opt.recheckMs ?? 15_000)
          left = await rescan()
          back = left.length > 0
          this.set({ found: all.size, removed: all.size - left.length, failed: left.length })
        }
        // Nothing moved since the last pass: TikTok keeps these, another pass would only repeat the same requests.
        if (!back && left.length && left.every((h) => prev.has(h.id)) && left.length === prev.size) break
      }
      const j = this.job
      if (!left.length) return this.finish('done', `Готово: удалено ${j.removed} из ${j.found}. Проверено по списку, выбранных репостов в нём нет.`)
      return this.finish('done', `Удалено ${j.removed} из ${j.found}. TikTok не дал убрать ${left.length}, запустите ещё раз позже.`)
    })
  }

  /** Search and removal of everything in one go. */
  async run(): Promise<Job> {
    await this.find()
    return this.job.status === 'ready' ? this.remove() : this.job
  }

  private async guard(work: () => Promise<Job>): Promise<Job> {
    try {
      return await work()
    } catch (e) {
      const j = this.job
      if (e instanceof Stopped) return this.finish('stopped', `Остановлено. Удалено ${j.removed} из ${j.found}.`)
      const why = e instanceof Fatal ? 'TikTok ограничил действия или просит проверку, работа остановлена: ' : 'Ошибка: '
      return this.finish('stopped', `${why}${(e as Error).message}. Удалено ${j.removed} из ${j.found}. Запустите снова позже.`)
    }
  }

  private finish(status: 'done' | 'stopped', message: string) {
    this.set({ status, message, finishedAt: Date.now() })
    return this.job
  }
}
