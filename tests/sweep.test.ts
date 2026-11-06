import { describe, expect, it } from 'vitest'
import type { SweepChoice, SweepItem, SweepJob, SweepKind } from '../src/shared/types'
import { DeleteReply } from '../src/main/repost-cleaner'
import { PAGE, SweepApi, SweepPage, Sweeper, cleanChoice, linkOf, pick, summarize } from '../src/main/sweep'

interface Quirks {
  refuse?: boolean // every action is refused with an error code
  captchaAfter?: number
  burst?: number // actions accepted before TikTok answers 429 until a pause
  drop?: string[] // accepted and not applied, every time
  profiles?: boolean // items can be asked about one by one
  quietAfterRemove?: boolean // the list answers an empty 200 once anything was removed, as following does
  quietFromStart?: boolean
  deadProfile?: string[] // the profile can't tell
  lag?: boolean // the list keeps showing removed items, the item itself knows better
  slowFor?: string[] // always a limit reply for these items, while the others go through
  refuseFor?: string[] // always refused
  dropOnce?: string[] // accepted and not applied the first time
  falseEnd?: number // the page at this number says "no more" once, although the list goes on
  refuseList?: number // the first list calls get an empty 200
  timeCursor?: boolean // the cursor is a time and any time can be asked for, as on the real site
  comeBack?: number // this many removed items reappear a while later
}

/** A fake TikTok: newest first, a time-like cursor that can't be guessed, actions on a virtual clock. */
function tiktok(total: number, q: Quirks = {}) {
  let items: SweepItem[] = Array.from({ length: total }, (_, i) => ({ id: String(5000 + i), author: 'a' + (i % 7), sec: 's' + i, time: 1_700_000_000 - i * 86400, photo: i % 10 === 0 }))
  let t = 0, inRow = 0, lastAt = 0, peak = 0, inflight = 0, listPeak = 0, listing = 0, goneAt = 0
  const gone: SweepItem[] = []
  const stamp = new Map(items.map((x, i) => [x.id, 1_790_000_000_000 - i * 86_400_000]))
  const dropped = new Set<string>()
  const calls = { list: 0, remove: 0, profile: 0 }
  const clock = { now: () => t, sleep: async (ms: number) => { t += ms; await Promise.resolve() } }
  const api: SweepApi = {
    async list(cursor) {
      calls.list++
      if (q.quietFromStart || (q.quietAfterRemove && calls.remove > 0)) return { http: 200, code: -1, msg: '', items: [], hasMore: false, cursor }
      if (q.refuseList && q.refuseList-- > 0) return { http: 200, code: -1, msg: '', items: [], hasMore: false, cursor }
      if (q.comeBack && gone.length && t - goneAt > 10_000) { items = [...gone.splice(0, q.comeBack), ...items]; q.comeBack = 0 }
      listing++
      listPeak = Math.max(listPeak, listing)
      await Promise.resolve()
      listing--
      if (q.timeCursor) {
        const all = q.lag ? [...gone, ...items] : items
        const below = cursor === '0' ? all : all.filter((x) => stamp.get(x.id)! < Number(cursor))
        const page = below.slice(0, PAGE)
        const last = page[page.length - 1]
        return { http: 200, code: 0, msg: '', items: page, hasMore: below.length > PAGE, cursor: last ? String(stamp.get(last.id)) : '0', total: total + 5 } satisfies SweepPage
      }
      const at = cursor === '0' ? 0 : Number(cursor.slice(1))
      const page = items.slice(at, at + PAGE)
      const more = at + PAGE < items.length
      if (q.falseEnd !== undefined && at === q.falseEnd * PAGE) { q.falseEnd = undefined; return { http: 200, code: 0, msg: '', items: page, hasMore: false, cursor } satisfies SweepPage }
      return { http: 200, code: 0, msg: '', items: page, hasMore: more, cursor: 't' + (at + PAGE) } satisfies SweepPage
    },
    async remove(it) {
      calls.remove++
      inflight++
      peak = Math.max(peak, inflight)
      await Promise.resolve()
      inflight--
      if (q.captchaAfter && calls.remove >= q.captchaAfter) return { http: 200, empty: false, json: true, code: 10214, msg: 'verify' }
      if (q.refuse || q.refuseFor?.includes(it.id)) return { http: 200, empty: false, json: true, code: 8, msg: 'not allowed' }
      if (q.slowFor?.includes(it.id)) return { http: 200, empty: true, json: false, code: -1, msg: '' }
      if (t - lastAt >= 10_000) inRow = 0
      lastAt = t
      if (q.burst && ++inRow > q.burst) return { http: 429, empty: false, json: false, code: -1, msg: '' }
      if (q.drop?.includes(it.id)) return { http: 200, empty: false, json: true, code: 0, msg: '' }
      if (q.dropOnce?.includes(it.id) && !dropped.has(it.id)) { dropped.add(it.id); return { http: 200, empty: false, json: true, code: 0, msg: '' } }
      items = items.filter((x) => x.id !== it.id)
      gone.push(it)
      goneAt = t
      return { http: 200, empty: false, json: true, code: 0, msg: '' } satisfies DeleteReply
    }
  }
  if (q.profiles) api.stillThere = async (it) => { calls.profile++; return q.deadProfile?.includes(it.id) ? undefined : items.some((x) => x.id === it.id) }
  return { api, clock, calls, left: () => items, peak: () => peak, listPeak: () => listPeak }
}

const job = (kind: SweepKind = 'likes'): SweepJob => ({ accountId: 'a', kind, status: 'running', phase: 'scan', found: 0, removed: 0, failed: 0, message: '', startedAt: 0 })
const choice = (o: Partial<SweepChoice> = {}): SweepChoice => ({ order: 'new', speed: 'fast', keep: [], years: [], type: 'all', keepFriends: true, keepVerified: true, onlyEmpty: false, ...o })
const engine = (s: ReturnType<typeof tiktok>, kind: SweepKind = 'likes', onChange = () => {}) => new Sweeper(s.api, job(kind), onChange, { clock: s.clock, settleMs: 0 })

describe('the search', () => {
  it('reads the whole list by TikTok\'s cursor and waits for the choice, touching nothing', async () => {
    const s = tiktok(100)
    const c = engine(s)
    const j = await c.find()
    expect(j).toMatchObject({ status: 'ready', found: 100 })
    expect(c.items).toHaveLength(100)
    expect(s.calls.remove).toBe(0)
  })
  it('reads a time cursor in parallel, every item once and in the list\'s order', async () => {
    const s = tiktok(700, { timeCursor: true })
    const c = engine(s)
    const j = await c.find()
    expect(c.items.map((x) => x.id)).toEqual(Array.from({ length: 700 }, (_, i) => String(5000 + i)))
    expect(s.listPeak()).toBeGreaterThan(1)
    expect(s.listPeak()).toBeLessThanOrEqual(6)
    expect(j.summary?.declared).toBe(705)
  })
  it('says so when the list is empty', async () => {
    expect(await engine(tiktok(0)).find()).toMatchObject({ status: 'done', message: 'Здесь пусто: лайков нет.' })
  })
  it('walks past a false end of the list', async () => {
    const c = engine(tiktok(200, { falseEnd: 2 }))
    await c.find()
    expect(c.items).toHaveLength(200)
  })
  it('waits out a quiet refusal instead of calling the list empty', async () => {
    const c = engine(tiktok(40, { refuseList: 1 }))
    expect(await c.find()).toMatchObject({ status: 'ready', found: 40 })
  })
})

describe('what a choice picks', () => {
  const v = (id: string, o: Partial<SweepItem> = {}): SweepItem => ({ id, author: 'x', time: 1_700_000_000, ...o })
  const list = [v('1', { author: 'Keep' }), v('2', { photo: true }), v('3', { time: 1_600_000_000 }), v('4')]

  it('takes the newest or the oldest of the list', () => {
    expect(pick(list, choice({ count: 2 }), 'likes').map((x) => x.id)).toEqual(['1', '2'])
    expect(pick(list, choice({ count: 2, order: 'old' }), 'likes').map((x) => x.id)).toEqual(['4', '3'])
  })
  it('filters first and counts after, so the number means what is left', () => {
    expect(pick(list, choice({ count: 2, keep: ['keep'] }), 'likes').map((x) => x.id)).toEqual(['2', '3'])
  })
  it('filters by type and year', () => {
    expect(pick(list, choice({ type: 'photo' }), 'likes').map((x) => x.id)).toEqual(['2'])
    expect(pick(list, choice({ type: 'video' }), 'likes')).toHaveLength(3)
    expect(pick(list, choice({ years: [new Date(1_600_000_000_000).getFullYear()] }), 'likes').map((x) => x.id)).toEqual(['3'])
  })
  it('keeps friends and verified accounts when asked, and can take only empty accounts', () => {
    const users = [v('a', { friend: true, videos: 3 }), v('b', { verified: true, videos: 0 }), v('c', { videos: 0 }), v('d', { videos: 9 })]
    expect(pick(users, choice(), 'following').map((x) => x.id)).toEqual(['c', 'd'])
    expect(pick(users, choice({ keepFriends: false, keepVerified: false }), 'following')).toHaveLength(4)
    expect(pick(users, choice({ onlyEmpty: true }), 'following').map((x) => x.id)).toEqual(['c'])
  })
  it('falls back to the safest values for anything odd from the UI', () => {
    expect(cleanChoice({ speed: 'turbo', order: 'x', count: -5, keep: ['@Bob ', 7, ''], keepFriends: 'no', years: [2020, 'a'] })).toEqual({ count: undefined, order: 'new', speed: 'careful', keep: ['bob'], years: [2020], type: 'all', keepFriends: true, keepVerified: true, onlyEmpty: false })
    expect(cleanChoice(null)).toMatchObject({ speed: 'careful', keepFriends: true })
    expect(cleanChoice({ keepFriends: false }).keepFriends).toBe(false)
  })
  it('sums up what was found', () => {
    const s = summarize([v('1', { friend: true, videos: 0 }), v('2', { photo: true, verified: true }), v('3', { author: 'y', time: 1_600_000_000 })])
    expect(s).toMatchObject({ total: 3, authors: 2, photos: 1, friends: 1, verified: 1, empty: 1 })
    expect(s.top[0]).toEqual({ name: 'x', count: 2 })
    expect(s.years.map((y) => y.count).sort()).toEqual([1, 2])
  })
  it('writes links to videos, photos and profiles', () => {
    expect(linkOf(v('9'), 'likes')).toBe('https://www.tiktok.com/@x/video/9')
    expect(linkOf(v('9', { photo: true }), 'favorites')).toBe('https://www.tiktok.com/@x/photo/9')
    expect(linkOf(v('9'), 'following')).toBe('https://www.tiktok.com/@x')
  })
})

describe('the cleanup', () => {
  const run = async (s: ReturnType<typeof tiktok>, c: Partial<SweepChoice> = {}, kind: SweepKind = 'likes') => { const e = engine(s, kind); await e.find(); await e.remove(choice(c)); return e }

  it('removes everything, and only counts what the list no longer shows', async () => {
    const s = tiktok(150)
    const e = await run(s)
    expect(s.left()).toHaveLength(0)
    expect(e.job).toMatchObject({ status: 'done', removed: 150, failed: 0, sent: 150 })
    expect(e.gone).toHaveLength(150)
  })
  it('leaves everything the choice does not pick', async () => {
    const s = tiktok(100)
    const e = await run(s, { count: 10, keep: ['a0'] })
    expect(s.left()).toHaveLength(90)
    expect(e.job.removed).toBe(10)
    expect(s.left().filter((x) => x.author === 'a0').length).toBe(15)
  })
  it('starts from the old end when asked', async () => {
    const s = tiktok(60)
    await run(s, { count: 5, order: 'old' })
    expect(s.left().map((x) => x.id)).toEqual(Array.from({ length: 55 }, (_, i) => String(5000 + i)))
  })
  it('works through a time cursor as well, leaving what was not picked', async () => {
    const s = tiktok(400, { timeCursor: true })
    const e = await run(s, { count: 100 })
    expect(s.left().map((x) => x.id)).toEqual(Array.from({ length: 300 }, (_, i) => String(5100 + i)))
    expect(e.job).toMatchObject({ removed: 100, failed: 0 })
  })
  it('reads a clean list twice more, later, and takes back what came back', async () => {
    const s = tiktok(100, { timeCursor: true, comeBack: 7 })
    const e = await run(s)
    expect(s.left()).toHaveLength(0)
    expect(e.job).toMatchObject({ status: 'done', removed: 100, failed: 0 })
    expect(e.job.pass).toBe(2)
    expect(e.job.message).toContain('три раза')
  })
  it('catches a dropped action in the check of its chunk, before the end', async () => {
    const s = tiktok(200, { timeCursor: true, dropOnce: ['5003', '5004', '5005'] })
    const e = await run(s)
    expect(s.left()).toHaveLength(0)
    expect(e.job.returned).toBe(3)
    expect(e.job.pass).toBe(1)
  })
  it('sends an item again when the list still shows it after a reply that looked fine', async () => {
    const s = tiktok(50, { dropOnce: ['5003', '5020'] })
    const e = await run(s)
    expect(s.left()).toHaveLength(0)
    expect(e.job.removed).toBe(50)
  })
  it('does not fall over one account TikTok answers oddly: the rest is done, in seconds, and the job ends normally', async () => {
    const s = tiktok(5, { timeCursor: true, slowFor: ['5002'] })
    const e = engine(s, 'following')
    e.job.kind = 'following'
    await e.find()
    const t0 = s.clock.now()
    await e.remove(choice({ count: 5, keepFriends: false, keepVerified: false }))
    expect(e.job).toMatchObject({ status: 'done', removed: 4, failed: 1 })
    expect(s.left().map((x) => x.id)).toEqual(['5002'])
    expect(s.calls.remove).toBeLessThanOrEqual(7)
    expect(s.clock.now() - t0).toBeLessThan(15_000)
    expect(e.job.message).toContain('TikTok оставил 1')
  })
  it('says what TikTok answered about an item it refused, and stops asking', async () => {
    const s = tiktok(5, { timeCursor: true, refuseFor: ['5001'] })
    const e = await run(s, { speed: 'careful' })
    expect(e.job).toMatchObject({ status: 'done', removed: 4, failed: 1 })
    expect(e.job.message).toContain('not allowed')
    expect(s.calls.remove).toBeLessThanOrEqual(6)
  })
  it('names an account that has no name left as deleted or blocked', async () => {
    const s = tiktok(3, { timeCursor: true, drop: ['5001'] })
    const e = engine(s, 'following')
    await e.find()
    e.items[1].author = ''
    await e.remove(choice({ keepFriends: false, keepVerified: false }))
    expect(e.job.message).toContain('удалён или заблокирован')
  })
  it('checks a handful quickly: only their page, seconds and not minutes', async () => {
    const s = tiktok(500, { timeCursor: true })
    const e = new Sweeper(s.api, job(), () => {}, { clock: s.clock })
    await e.find()
    const lists = s.calls.list, t0 = s.clock.now()
    await e.remove(choice({ count: 5, speed: 'careful' }))
    expect(s.left()).toHaveLength(495)
    expect(s.calls.list - lists).toBeLessThanOrEqual(5)
    expect(s.clock.now() - t0).toBeLessThan(30_000)
  })
  it('still pauses and stops when every item gets a limit reply', async () => {
    const s = tiktok(40, { timeCursor: true, slowFor: Array.from({ length: 40 }, (_, i) => String(5000 + i)) })
    const e = await run(s)
    expect(e.job.status).toBe('stopped')
    expect(e.job.message).toContain('лимит')
  })
  it('finishes unfollows when TikTok withholds the list right after them: profiles tell what happened', async () => {
    const s = tiktok(30, { timeCursor: true, profiles: true, quietAfterRemove: true })
    const e = engine(s, 'following')
    await e.find()
    const t0 = s.clock.now()
    await e.remove(choice({ count: 5, keepFriends: false, keepVerified: false, speed: 'careful' }))
    expect(e.job).toMatchObject({ status: 'done', removed: 5, failed: 0 })
    expect(s.left()).toHaveLength(25)
    expect(s.clock.now() - t0).toBeLessThan(30_000)
  })
  it('does not call an unfollow done when the profile can\'t tell', async () => {
    const s = tiktok(3, { timeCursor: true, profiles: true, deadProfile: ['5001'] })
    const e = engine(s, 'following')
    await e.find()
    await e.remove(choice({ keepFriends: false, keepVerified: false }))
    expect(e.job).toMatchObject({ status: 'done', removed: 2, failed: 1 })
    expect(e.job.message).toContain('не удалось проверить')
  })
  for (const kind of ['likes', 'favorites'] as const) {
    it(`finishes ${kind} when TikTok withholds the list after the first actions, checking video by video`, async () => {
      const s = tiktok(30, { timeCursor: true, profiles: true, quietAfterRemove: true })
      const e = engine(s, kind)
      await e.find()
      const t0 = s.clock.now()
      await e.remove(choice({ count: 5, speed: 'careful' }))
      expect(e.job).toMatchObject({ status: 'done', removed: 5, failed: 0 })
      expect(s.calls.remove).toBe(5)
      expect(s.clock.now() - t0).toBeLessThan(45_000)
    })
    it(`is not fooled by a list that lags behind on ${kind}: nothing is sent twice, nothing is reported as left`, async () => {
      const s = tiktok(30, { timeCursor: true, profiles: true, lag: true })
      const e = engine(s, kind)
      await e.find()
      await e.remove(choice({ count: 5 }))
      expect(e.job).toMatchObject({ status: 'done', removed: 5, failed: 0, returned: 0 })
      expect(s.calls.remove).toBe(5)
    })
    it(`gets past one video that answers oddly on ${kind}`, async () => {
      const s = tiktok(5, { timeCursor: true, profiles: true, slowFor: ['5002'] })
      const e = engine(s, kind)
      await e.find()
      const t0 = s.clock.now()
      await e.remove(choice({ speed: 'careful' }))
      expect(e.job).toMatchObject({ status: 'done', removed: 4, failed: 1 })
      expect(s.clock.now() - t0).toBeLessThan(30_000)
    })
  }
  it('stops with a message, not after minutes, when a list is withheld and nothing can be asked directly', async () => {
    const s = tiktok(30, { timeCursor: true, quietAfterRemove: true })
    const e = engine(s)
    await e.find()
    await e.remove(choice({ count: 5 }))
    expect(e.job.status).toBe('stopped')
    expect(e.job.message).toContain('не отдаёт список лайков')
    expect(s.clock.now()).toBeLessThan(60_000)
  })
  describe('the Following feed, when the list is not given', () => {
    const feedOf = (s: ReturnType<typeof tiktok>, pages: SweepItem[][]) => {
      s.api.feed = async (cursor) => { const i = Number(cursor); return { http: 200, code: 0, msg: '', items: pages[i] ?? [], hasMore: i + 1 < pages.length, cursor: String(i + 1) } }
      s.api.followingCount = async () => 500
      return s
    }
    const u = (id: string, o: Partial<SweepItem> = {}): SweepItem => ({ id, author: 'u' + id, sec: 's' + id, ...o })

    it('gathers accounts from the feed, once each, and says the result is partial', async () => {
      const s = feedOf(tiktok(0, { quietFromStart: true }), [[u('1'), u('2', { friend: true })], [u('1'), u('3')]])
      const e = engine(s, 'following')
      const j = await e.find()
      expect(j.status).toBe('ready')
      expect(e.items.map((x) => x.id)).toEqual(['1', '2', '3'])
      expect(j.summary).toMatchObject({ partial: true, declared: 500, friends: 1 })
    })
    it('does not believe an empty list either', async () => {
      const s = feedOf(tiktok(0), [[u('1')]])
      expect((await engine(s, 'following').find()).summary?.partial).toBe(true)
    })
    it('stops reading a feed that brings no one new', async () => {
      const s = feedOf(tiktok(0, { quietFromStart: true }), Array.from({ length: 100 }, () => [u('1')]))
      let reads = 0
      const feed = s.api.feed!
      s.api.feed = (c) => { reads++; return feed(c) }
      await engine(s, 'following').find()
      expect(reads).toBeLessThanOrEqual(17)
    })
    it('does not touch the feed while the list works', async () => {
      const s = feedOf(tiktok(40), [[u('1')]])
      const e = engine(s, 'following')
      const j = await e.find()
      expect(j.found).toBe(40)
      expect(j.summary?.partial).toBe(false)
    })
    it('unfollows what the feed found, and checks by profile', async () => {
      const s = feedOf(tiktok(3, { quietFromStart: true, profiles: true }), [[{ id: '5000', author: 'a', sec: 's' }, { id: '5001', author: 'b', sec: 's' }]])
      const e = engine(s, 'following')
      await e.find()
      await e.remove(choice({ keepFriends: false, keepVerified: false }))
      expect(e.job).toMatchObject({ status: 'done', removed: 2, failed: 0 })
      expect(s.left().map((x) => x.id)).toEqual(['5002'])
    })
  })
  it('says at once when the following list is withheld, instead of minutes of pauses', async () => {
    const s = tiktok(30, { quietFromStart: true })
    const e = engine(s, 'following')
    await e.find()
    expect(e.job.status).toBe('stopped')
    expect(e.job.message).toContain('не отдаёт список подписок')
    expect(s.clock.now()).toBeLessThan(10_000)
  })
  it('reports what TikTok keeps and stops repeating it', async () => {
    const s = tiktok(40, { drop: ['5001'] })
    const e = await run(s)
    expect(e.job).toMatchObject({ status: 'done', removed: 39, failed: 1 })
    expect(s.calls.remove).toBeLessThanOrEqual(42) // 39 once, the kept one three times
    expect(e.job.message).toContain('TikTok оставил 1')
  })
  it('keeps to the number of requests in flight of each speed', async () => {
    for (const [speed, most] of [['careful', 2], ['normal', 8], ['fast', 12]] as const) {
      const s = tiktok(120)
      await run(s, { speed })
      expect(s.peak(), speed).toBeLessThanOrEqual(most)
      if (speed !== 'careful') expect(s.peak(), speed).toBeGreaterThan(1)
      expect(s.left(), speed).toHaveLength(0)
    }
  })
  it('waits out a limit and goes on', async () => {
    const s = tiktok(80, { burst: 30 })
    const e = await run(s)
    expect(s.left()).toHaveLength(0)
    expect(e.job.status).toBe('done')
  })
  it('stops on a captcha and sends nothing after it', async () => {
    const s = tiktok(100, { captchaAfter: 20 })
    const e = await run(s)
    expect(e.job.status).toBe('stopped')
    expect(e.job.message).toContain('проверку')
    expect(s.calls.remove).toBeLessThanOrEqual(32)
  })
  it('stops when TikTok refuses request after request', async () => {
    const s = tiktok(100, { refuse: true })
    const e = await run(s)
    expect(e.job.status).toBe('stopped')
    expect(e.job.message).toContain('not allowed')
    expect(s.calls.remove).toBeLessThanOrEqual(28)
  })
  it('stops when the user asks', async () => {
    const s = tiktok(100)
    const e = new Sweeper(s.api, job(), () => { if ((e.job.sent ?? 0) >= 5) e.stop() }, { clock: s.clock, settleMs: 0 })
    await e.find()
    await e.remove(choice())
    expect(e.job.status).toBe('stopped')
    expect(s.left().length).toBeGreaterThan(80)
  })
})
