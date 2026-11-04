import type { Job } from '../shared/types'

// Removes every repost of an account through TikTok's web endpoints. No Electron here: the requests come in as `RepostApi`,
// so the whole flow is covered by unit tests on a fake server.
// Flow and reply rules from the open "unrepost" tools: github.com/lansixxx/UnRepost (MIT: strict delete confirmation, silent
// throttling, rescan from the start until nothing is left), github.com/Skenls/tiktok-unrepost (MIT: parallel deletes, one shared
// pause on 429, walking past empty list pages) and github.com/yiitxyz/tiktokRepostRemover (scan → delete → verify).

/** One page of /api/repost/item_list/. `http` 0 = no reply at all. */
export interface ListReply { http: number; code: number; msg: string; ids: string[]; hasMore: boolean; cursor: string }
/** Reply of /tiktok/v1/upvote/delete. `deleted` is what `delete_result` says: true, false, or undefined when it is missing. */
export interface DeleteReply { http: number; empty: boolean; json: boolean; code: number; msg: string; deleted?: boolean }
export interface RepostApi {
  list(cursor: string): Promise<ListReply>
  remove(id: string): Promise<DeleteReply>
}
export interface CleanerOptions {
  workers?: number // deletes in flight at once; halved on every slowdown
  clock?: { now(): number; sleep(ms: number): Promise<void> } // tests run on a virtual clock
  settleMs?: number // pause before the verifying rescan (TikTok's list lags behind deletes)
}

export const PAGE = 30
export const WORKERS = 8
export const BACKOFF = [20_000, 40_000, 80_000, 160_000] // shared pause after each slowdown in a row; one more and the job stops
const MAX_PASSES = 8
const RECOVER = 40 // deletes in a row that bring one worker back after a slowdown
const MAX_STALE_PAGES = 200 // list pages in a row with nothing new while TikTok still says "more": the list has really ended
const MAX_PAGES = 20_000

const CAPTCHA = /captcha|verif|unusual|risk|restricted|suspicious/i
const LIMIT = /frequent|too many|rate.?limit|limit|cooldown|busy|slow down/i

/** Captcha, identity check, signed out or banned: the job stops and the user is told. */
export class Fatal extends Error {}
export class Stopped extends Error {}

type Verdict = 'ok' | 'slow' | 'fail'

/** How one delete reply counts (rules from lansixxx/UnRepost `evaluateDeleteResponse`). */
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
  return 'ok' // confirmed, or no delete_result at all: the verifying rescan decides
}

function judgeList(r: ListReply): 'ok' | 'slow' {
  if (r.http === 429 || r.http === 503 || r.code === 10202 || r.code === 429) return 'slow'
  if (r.http === 401 || r.http === 403) throw new Fatal(`TikTok ответил ${r.http}`)
  if (r.code === 10214 || CAPTCHA.test(r.msg)) throw new Fatal(r.msg || 'TikTok просит пройти проверку')
  if (r.http === 200 && r.code === 0) return 'ok'
  if (LIMIT.test(r.msg)) return 'slow'
  throw new Error(`список репостов недоступен (${r.http ? `код ${r.code}` : 'нет ответа'}${r.msg ? ': ' + r.msg : ''})`)
}

const realClock = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) }

export class RepostCleaner {
  private stopped = false
  private workers: number
  private pauseUntil = 0
  private strikes = 0 // slowdowns since the last request that went through
  private okRow = 0 // deletes in a row without a slowdown; enough of them bring a worker back
  private clock: { now(): number; sleep(ms: number): Promise<void> }

  constructor(private api: RepostApi, public job: Job, private onChange: () => void, private opt: CleanerOptions = {}) {
    this.workers = opt.workers ?? WORKERS
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

  /** Every repost id the list gives, walking through empty pages (TikTok skips unavailable videos but moves the cursor). */
  async scan(onPage: (n: number) => void): Promise<string[]> {
    const ids = new Set<string>()
    const seen = new Set<string>()
    let cursor = '0'
    let stale = 0
    for (let pages = 0; pages < MAX_PAGES; pages++) {
      this.check()
      seen.add(cursor)
      const r = await this.api.list(cursor)
      if (judgeList(r) === 'slow') { await this.slowDown(); pages--; continue }
      this.strikes = 0
      const before = ids.size
      r.ids.forEach((id) => ids.add(id))
      onPage(ids.size)
      if (!r.hasMore) break
      stale = ids.size > before ? 0 : stale + 1
      if (stale >= MAX_STALE_PAGES) break
      let next = r.cursor
      if (seen.has(next) || !(Number(next) > Number(cursor))) { // cursor did not move: step past this page ourselves (Skenls)
        const n = Number(cursor)
        if (!Number.isFinite(n)) break
        next = String(n + PAGE)
        if (seen.has(next)) break
      }
      cursor = next
    }
    return [...ids]
  }

  /** Deletes the ids with several requests in flight; returns those TikTok did not take. */
  private async deleteAll(ids: string[], onDone: () => void): Promise<Set<string>> {
    const queue = [...ids]
    const failed = new Set<string>()
    let abort: unknown // the first fatal error stops every worker before its next request
    const worker = async (k: number) => {
      try {
        while (!abort && queue.length) {
          this.check()
          const now = this.clock.now()
          if (now < this.pauseUntil) { await this.wait(this.pauseUntil - now); continue }
          if (k >= this.workers) { await this.wait(500); continue } // parked after a slowdown until TikTok takes more again
          const id = queue.shift()!
          let verdict: Verdict
          try { verdict = judgeDelete(await this.api.remove(id)) } catch (e) {
            if (e instanceof Fatal) throw e
            verdict = 'fail'
          }
          if (abort) return
          if (verdict === 'slow') { queue.unshift(id); await this.slowDown(); continue }
          this.strikes = 0
          if (++this.okRow >= RECOVER && this.workers < WORKERS) { this.workers++; this.okRow = 0 }
          if (verdict === 'ok') { failed.delete(id); onDone() } else failed.add(id)
        }
      } catch (e) { abort ??= e }
    }
    // A worker leaves when the queue is empty; an id another worker puts back after a slowdown is picked up by the next round.
    while (queue.length && !abort) await Promise.all(Array.from({ length: WORKERS }, (_, k) => worker(k)))
    if (abort) throw abort
    return failed
  }

  async run(): Promise<Job> {
    try {
      this.set({ phase: 'scan', message: 'Ищу репосты…' })
      const all = new Set<string>()
      let left = await this.scan((n) => this.set({ found: n, message: `Ищу репосты… найдено ${n}` }))
      left.forEach((id) => all.add(id))
      if (!left.length) return this.finish('done', 'Репостов нет — удалять нечего.')
      this.set({ found: all.size, removed: 0, failed: 0 })

      // Delete what is listed, then rescan from the very start; whatever is still there gets another pass.
      for (let pass = 1; pass <= MAX_PASSES && left.length; pass++) {
        const base = all.size - left.length
        let done = 0
        this.set({ phase: 'delete', pass, deleteStartedAt: this.job.deleteStartedAt ?? Date.now(), message: pass > 1 ? `Проход ${pass}: удаляю оставшиеся ${left.length}…` : 'Удаляю репосты…' })
        const failed = await this.deleteAll(left, () => this.set({ removed: Math.min(all.size, base + ++done) }))
        this.set({ phase: 'verify', failed: failed.size, message: 'Проверяю, что всё удалено…' })
        await this.wait(this.opt.settleMs ?? 3000)
        const prev = new Set(left)
        left = await this.scan(() => {})
        left.forEach((id) => all.add(id))
        this.set({ found: all.size, removed: all.size - left.length, failed: left.length })
        // Nothing moved since the last pass: TikTok keeps these, another pass would only repeat the same requests.
        if (left.length && left.every((id) => prev.has(id)) && left.length === prev.size) break
      }

      const j = this.job
      if (!left.length) return this.finish('done', `Готово: удалено ${j.removed} из ${j.found}. Проверено повторным поиском — репостов не осталось.`)
      return this.finish('done', `Удалено ${j.removed} из ${j.found}. TikTok не дал убрать ${left.length} — запустите ещё раз позже.`)
    } catch (e) {
      const j = this.job
      if (e instanceof Stopped) return this.finish('stopped', `Остановлено. Удалено ${j.removed} из ${j.found}.`)
      const why = e instanceof Fatal ? 'TikTok ограничил действия или просит проверку, очистка остановлена: ' : 'Ошибка: '
      return this.finish('stopped', `${why}${(e as Error).message}. Удалено ${j.removed} из ${j.found}. Запустите снова позже — продолжит с оставшихся.`)
    }
  }

  private finish(status: 'done' | 'stopped', message: string) {
    this.set({ status, message, finishedAt: Date.now() })
    return this.job
  }
}
