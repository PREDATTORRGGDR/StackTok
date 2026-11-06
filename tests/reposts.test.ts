import { describe, expect, it } from 'vitest'
import type { Job } from '../src/shared/types'
import { BACKOFF, DeleteReply, ListReply, PAGE, RepostApi, RepostCleaner, judgeDelete, summarize } from '../src/main/repost-cleaner'

interface Quirks {
  hidden?: number[] // list positions TikTok skips (unavailable videos): the page comes back shorter or empty, the cursor still moves
  burst?: number // deletes accepted in a row before TikTok starts dropping them silently (empty 200) until a pause
  slowAs?: 'empty' | 'status0' | '429' // how a dropped delete looks
  stuck?: string[] // ids TikTok never removes (status 0, still listed)
  captchaAfter?: number // the delete number that gets a captcha reply
  always429?: boolean
  stallCursor?: boolean // the server repeats the same cursor
  noDeleteResult?: boolean
  falseEnd?: { at: number; times: number } // this page says "no more" although the list goes on
  comeBack?: number // this many deleted reposts reappear a while after their delete
  dropEvery?: number // every Nth delete is answered as done and not applied, once per repost
  refuseFor?: number // the first list calls get TikTok's quiet refusal: an empty 200
}

/** A fake TikTok: reposts listed newest first, 30 per page, offset cursor; deletes on a virtual clock. */
function tiktok(total: number, q: Quirks = {}) {
  let ids = Array.from({ length: total }, (_, i) => String(9_000_000 + i))
  const hidden = new Set((q.hidden ?? []).map((p) => ids[p]))
  let t = 0
  let inRow = 0
  let lastAt = 0
  let deletes = 0
  let inflight = 0
  const gone: string[] = []
  const dropped = new Set<string>()
  let goneAt = 0
  let peak = 0
  const calls = { list: 0, remove: 0 }
  const clock = { now: () => t, sleep: async (ms: number) => { t += ms; await Promise.resolve() } }
  const api: RepostApi = {
    async list(cursor) {
      calls.list++
      if (q.always429) return { http: 429, code: -1, msg: '', ids: [], hasMore: false, cursor }
      if (q.refuseFor && q.refuseFor-- > 0) return { http: 200, code: -1, msg: '', ids: [], hasMore: false, cursor }
      const at = Number(cursor)
      if (q.comeBack && gone.length && t - goneAt > 10_000) { ids = [...gone.splice(0, q.comeBack), ...ids]; q.comeBack = 0 }
      const page = ids.slice(at, at + PAGE)
      if (q.falseEnd && at === q.falseEnd.at && q.falseEnd.times > 0) {
        q.falseEnd.times--
        return { http: 200, code: 0, msg: '', ids: page, hasMore: false, cursor } satisfies ListReply
      }
      const next = q.stallCursor ? cursor : String(at + PAGE)
      return { http: 200, code: 0, msg: '', ids: page.filter((id) => !hidden.has(id)), hasMore: at + PAGE < ids.length, cursor: next } satisfies ListReply
    },
    async remove(id) {
      calls.remove++
      inflight++
      peak = Math.max(peak, inflight)
      await Promise.resolve()
      inflight--
      deletes++
      if (q.captchaAfter && deletes >= q.captchaAfter) return { http: 200, empty: false, json: true, code: 10214, msg: 'verify' }
      if (t - lastAt >= 10_000) inRow = 0 // a pause lets TikTok accept a new burst
      lastAt = t
      if (q.burst && ++inRow > q.burst) {
        if (q.slowAs === '429') return { http: 429, empty: false, json: false, code: -1, msg: '' }
        if (q.slowAs === 'status0') return { http: 200, empty: false, json: true, code: 0, msg: '', deleted: false }
        return { http: 200, empty: true, json: false, code: -1, msg: '' }
      }
      if (q.dropEvery && deletes % q.dropEvery === 0 && !dropped.has(id)) { dropped.add(id); return { http: 200, empty: false, json: true, code: 0, msg: '', deleted: true } }
      if (q.stuck?.includes(id)) return { http: 200, empty: false, json: true, code: 0, msg: '', deleted: true }
      ids = ids.filter((x) => x !== id)
      gone.push(id)
      goneAt = t
      return { http: 200, empty: false, json: true, code: 0, msg: '', deleted: q.noDeleteResult ? undefined : true } satisfies DeleteReply
    }
  }
  return { api, clock, calls, left: () => ids, peak: () => peak, time: () => t }
}

const job = (): Job => ({ accountId: 'a', status: 'running', phase: 'scan', found: 0, removed: 0, failed: 0, message: '', startedAt: 0 })

async function clean(s: ReturnType<typeof tiktok>, stopAt?: (j: Job) => boolean) {
  let c: RepostCleaner
  c = new RepostCleaner(s.api, job(), () => { if (stopAt?.(c.job)) c.stop() }, { clock: s.clock })
  return c.run()
}

describe('repost search and choice', () => {
  const start = (s: ReturnType<typeof tiktok>) => new RepostCleaner(s.api, job(), () => {}, { clock: s.clock })
  it('stops after the search and waits for the choice', async () => {
    const s = tiktok(100)
    const c = start(s)
    const j = await c.find()
    expect(j).toMatchObject({ status: 'ready', found: 100 })
    expect(j.summary?.total).toBe(100)
    expect(s.calls.remove).toBe(0)
  })
  it('says so when there is nothing', async () => {
    const j = await start(tiktok(0)).find()
    expect(j.status).toBe('done')
  })
  it('removes only the newest N and leaves the rest', async () => {
    const s = tiktok(500)
    const c = start(s)
    await c.find()
    const newest = s.left().slice(0, 100)
    const j = await c.remove(100)
    expect(j).toMatchObject({ status: 'done', found: 100, removed: 100, failed: 0 })
    expect(s.left()).toHaveLength(400)
    expect(s.left().some((id) => newest.includes(id))).toBe(false)
  })
  it('never trusts the reply: a delete TikTok dropped is found in the list and sent again', async () => {
    const s = tiktok(300, { dropEvery: 5 })
    const c = start(s)
    await c.find()
    const j = await c.remove()
    expect(s.left()).toHaveLength(0)
    expect(j).toMatchObject({ status: 'done', removed: 300, failed: 0 })
  })
  it('counts dropped deletes as rollbacks and slows down', async () => {
    const left = Array.from({ length: 200 }, (_, i) => String(i))
    let applied = 0
    const api: RepostApi = {
      async list(cursor) { const at = Number(cursor); return { http: 200, code: 0, msg: '', ids: left.slice(at, at + PAGE), hasMore: at + PAGE < left.length, cursor: String(at + PAGE) } },
      async remove(id) { if (++applied % 2) { const i = left.indexOf(id); if (i >= 0) left[i] = 'x' + id } return { http: 200, empty: false, json: true, code: 0, msg: '', deleted: true } }
    }
    let now = 0
    const c = new RepostCleaner(api, job(), () => {}, { clock: { now: () => now, sleep: async (ms) => { now += ms; await Promise.resolve() } } })
    await c.find()
    const j = await c.remove(60)
    expect(j.returned).toBeGreaterThan(0)
  })
  it('waits out a quiet refusal instead of calling the list empty', async () => {
    const s = tiktok(70, { refuseFor: 3 })
    const j = await start(s).find()
    expect(j).toMatchObject({ status: 'ready', found: 70 })
    expect(s.time()).toBeGreaterThanOrEqual(BACKOFF[0])
  })
  it('stops with a message when TikTok keeps refusing', async () => {
    const s = tiktok(70, { refuseFor: 1000 })
    const j = await start(s).find()
    expect(j.status).toBe('stopped')
    expect(j.message).toMatch(/TikTok/)
  })
  it('sums up what was found', () => {
    const y = (d: string) => new Date(d).getTime() / 1000
    const r = summarize([{ id: '1', author: 'a', time: y('2024-05-01'), photo: true }, { id: '2', author: 'a', time: y('2025-05-01') }, { id: '3', author: 'b' }], 90)
    expect(r).toMatchObject({ total: 3, entries: 90, authors: 2, photos: 1 })
    expect(r.top[0]).toEqual({ name: 'a', count: 2 })
    expect(r.years).toEqual([{ year: 2025, count: 1 }, { year: 2024, count: 1 }])
  })
})

describe('repost cleanup', () => {
  it('walks past a false end of the list', async () => {
    const s = tiktok(1000, { falseEnd: { at: 390, times: 1 } })
    const j = await clean(s)
    expect(s.left()).toHaveLength(0)
    expect(j.found).toBe(1000)
  })
  it('survives the same false end on every scan', async () => {
    const s = tiktok(1000, { falseEnd: { at: 90, times: 2 } })
    await clean(s)
    expect(s.left()).toHaveLength(0)
  })
  it('walks through a very long empty stretch', async () => {
    const hidden = Array.from({ length: 9000 }, (_, i) => i)
    const s = tiktok(9050, { hidden })
    const j = await clean(s)
    expect(j.found).toBe(50)
  })
  it('deletes reposts that came back after the first clean pass', async () => {
    const s = tiktok(100, { comeBack: 7 })
    const j = await clean(s)
    expect(s.left()).toHaveLength(0)
    expect(j.message).toContain('в нём нет')
  })
  it('removes every repost of a large account, in parallel', async () => {
    const s = tiktok(1000)
    const j = await clean(s)
    expect(s.left()).toEqual([])
    expect(j).toMatchObject({ status: 'done', found: 1000, removed: 1000, failed: 0 })
    expect(s.peak()).toBeGreaterThan(1)
  })

  it('walks through pages TikTok returns empty (unavailable videos) and still reaches the oldest reposts', async () => {
    const hidden = Array.from({ length: 200 }, (_, i) => 100 + i) // ~7 empty pages in the middle
    const s = tiktok(400, { hidden })
    const j = await clean(s)
    expect(s.left().length).toBe(200) // only the ones TikTok never lists
    expect(j.removed).toBe(200)
    expect(s.left()).not.toContain(String(9_000_000 + 399)) // the oldest one, behind the empty pages, is gone
  })

  it('steps past a cursor that does not move', async () => {
    const s = tiktok(95, { stallCursor: true })
    await clean(s)
    expect(s.left()).toEqual([])
  })

  it.each(['empty', 'status0', '429'] as const)('slows down and still removes everything when TikTok drops bursts (%s)', async (slowAs) => {
    const s = tiktok(300, { burst: 20, slowAs })
    const j = await clean(s)
    expect(s.left()).toEqual([])
    expect(j).toMatchObject({ status: 'done', removed: 300 })
    expect(s.time()).toBeGreaterThanOrEqual(BACKOFF[0]) // it really paused
  })

  it('counts a delete without delete_result only after the rescan confirms it', async () => {
    const s = tiktok(50, { noDeleteResult: true })
    const j = await clean(s)
    expect(j).toMatchObject({ status: 'done', removed: 50, failed: 0 })
  })

  it('reports reposts TikTok keeps and stops repeating them', async () => {
    const s = tiktok(80, { stuck: ['9000003', '9000070'] })
    const j = await clean(s)
    expect(j).toMatchObject({ status: 'done', found: 80, removed: 78, failed: 2 })
    expect(j.message).toMatch(/не дал убрать 2/)
    expect(s.calls.remove).toBeLessThan(80 + 2 * 6) // a few tries each, then it gives up
  })

  it('stops on a captcha and sends nothing after it', async () => {
    const s = tiktok(200, { captchaAfter: 30 })
    const j = await clean(s)
    expect(j.status).toBe('stopped')
    expect(j.message).toMatch(/проверку/)
    const sent = s.calls.remove
    await s.clock.sleep(60_000)
    expect(s.calls.remove).toBe(sent)
    expect(sent).toBeLessThan(30 + 8)
  })

  it('stops after a few growing pauses when TikTok keeps refusing', async () => {
    const s = tiktok(40, { always429: true })
    const j = await clean(s)
    expect(j.status).toBe('stopped')
    expect(s.calls.list).toBe(BACKOFF.length + 1)
    expect(s.time()).toBeGreaterThanOrEqual(BACKOFF.reduce((a, b) => a + b, 0))
  })

  it('stops when the user asks', async () => {
    const s = tiktok(500)
    const j = await clean(s, (x) => x.removed >= 100)
    expect(j.status).toBe('stopped')
    expect(s.left().length).toBeGreaterThan(300)
  })

  it('finishes at once on an account without reposts', async () => {
    const j = await clean(tiktok(0))
    expect(j).toMatchObject({ status: 'done', found: 0 })
  })
})

describe('delete replies', () => {
  const r = (p: Partial<DeleteReply>): DeleteReply => ({ http: 200, empty: false, json: true, code: 0, msg: '', ...p })
  it('never takes an empty or unconfirmed reply as a success', () => {
    expect(judgeDelete(r({ deleted: true }))).toBe('ok')
    expect(judgeDelete(r({ empty: true, json: false }))).toBe('slow')
    expect(judgeDelete(r({ deleted: false }))).toBe('slow')
    expect(judgeDelete(r({ code: 10202 }))).toBe('slow')
    expect(judgeDelete(r({ http: 429, json: false }))).toBe('slow')
    expect(judgeDelete(r({ code: 8, msg: 'item not found' }))).toBe('fail')
    expect(() => judgeDelete(r({ code: 10214 }))).toThrow()
    expect(() => judgeDelete(r({ http: 403 }))).toThrow()
  })
})
