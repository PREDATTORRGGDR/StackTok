import { describe, expect, it } from 'vitest'
import { ageText, buildStats, countReposts, pageScope, sumVideos } from '../src/main/account-stats'

const DAY = 86_400_000
const now = new Date(2026, 10, 5).getTime()

describe('ageText', () => {
  it('counts by the calendar in Russian', () => {
    expect(ageText(new Date(2024, 7, 5).getTime(), now)).toBe('2 года 3 месяца')
    expect(ageText(new Date(2021, 10, 5).getTime(), now)).toBe('5 лет')
    expect(ageText(new Date(2025, 9, 5).getTime(), now)).toBe('1 год 1 месяц')
    expect(ageText(now - 3 * DAY, now)).toBe('3 дня')
    expect(ageText(now - 11 * DAY, now)).toBe('11 дней')
  })
})

describe('buildStats', () => {
  const feed = { 'webapp.app-context': { user: { uniqueId: 'Me', nickName: ' Ник ', region: 'RU', isPrivateAccount: false, signature: '', createTime: 0 } } }
  const profile = { 'webapp.user-detail': { userInfo: { user: { uniqueId: 'me' }, stats: { followerCount: 100, followingCount: 50, friendCount: 5, heartCount: 1000, videoCount: 10, diggCount: 365 } } } }
  const base = { username: 'me', ms: 7, now }
  it('joins sources and derives fun numbers', () => {
    const s = buildStats({ ...base, created: (now - 365 * DAY) / 1000, feed, profile, saved: 3 })
    expect(s).toMatchObject({ nickname: 'Ник', region: 'RU', followers: 100, likes: 1000, saved: 3, likesPerVideo: 100, likedPerDay: 1, followRatio: 2, days: 365 })
    expect(s.signature).toBeUndefined()
  })
  it('prefers exact numbers and the profile privacy flag', () => {
    const p = { 'webapp.user-detail': { userInfo: { user: { uniqueId: 'me', privateAccount: false, secret: false }, stats: { followerCount: 100900 }, statsV2: { followerCount: '100934' } } } }
    const f = { 'webapp.app-context': { user: { uniqueId: 'me', isPrivateAccount: true } } }
    expect(buildStats({ ...base, feed: f, profile: p })).toMatchObject({ followers: 100934, privateAccount: false })
  })
  it('leaves missing values empty, not zero', () => {
    const s = buildStats({ ...base, feed: null, profile: null })
    expect(s.followers).toBeUndefined()
    expect(s.createdAt).toBeUndefined()
    expect(s.likesPerVideo).toBeUndefined()
  })
  it('keeps real zeros', () => {
    const p = { 'webapp.user-detail': { userInfo: { user: { uniqueId: 'me' }, stats: { followerCount: 0, followingCount: 0, heartCount: 0, videoCount: 0 } } } }
    const s = buildStats({ ...base, feed: null, profile: p })
    expect(s.followers).toBe(0)
    expect(s.likesPerVideo).toBeUndefined()
    expect(s.followRatio).toBeUndefined()
  })
  it('ignores data of another account', () => {
    const p = { 'webapp.user-detail': { userInfo: { user: { uniqueId: 'other' }, stats: { followerCount: 9 } } } }
    const f = { 'webapp.app-context': { user: { uniqueId: 'other', nickName: 'x', createTime: 5 } } }
    const s = buildStats({ ...base, feed: f, profile: p })
    expect(s.followers).toBeUndefined()
    expect(s.nickname).toBeUndefined()
  })
})

describe('pageScope', () => {
  it('reads embedded state and survives garbage', () => {
    expect(pageScope('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">{"__DEFAULT_SCOPE__":{"a":1}}</script>')).toEqual({ a: 1 })
    expect(pageScope('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{oops</script>')).toBeNull()
    expect(pageScope(null)).toBeNull()
  })
})

describe('countReposts', () => {
  // A list like a real old one: `total` places, every third one a real video.
  const server = (total: number, lies: (o: number, nth: number) => boolean = () => false) => {
    const asked = new Map<number, number>()
    return async (o: number) => {
      const nth = (asked.get(o) ?? 0) + 1
      asked.set(o, nth)
      await Promise.resolve()
      const ids: string[] = []
      for (let i = o; i < Math.min(o + 30, total); i++) if (i % 3 === 0) ids.push('v' + i)
      return lies(o, nth) ? { more: false, ids } : { more: o + 30 < total, ids }
    }
  }
  const real = (total: number) => Math.ceil(total / 3)
  it('counts real videos, not list places', async () => {
    for (const total of [0, 7, 30, 31, 100, 1837, 5000]) {
      const r = await countReposts(server(total))
      expect(r.visible).toBe(real(total))
      expect(r.complete).toBe(true)
    }
  })
  it('does not believe a false end under load', async () => {
    const r = await countReposts(server(1837, (o, nth) => o === 390 && nth === 1))
    expect(r).toMatchObject({ visible: real(1837), complete: true })
    expect(r.entries).toBe(1830)
    const twice = await countReposts(server(1837, (o, nth) => o === 390 && nth <= 2))
    expect(twice.visible).toBe(real(1837))
  })
  it('does not count a video twice', async () => {
    const r = await countReposts(async (o) => ({ more: o < 60, ids: o < 90 ? ['same'] : [] }))
    expect(r.visible).toBe(1)
  })
  it('marks a broken count as incomplete', async () => {
    const r = await countReposts(async (o) => (o >= 300 ? null : { more: true, ids: ['v' + o] }))
    expect(r.complete).toBe(false)
    expect(r.visible).toBeGreaterThan(0)
  })
  it('stops when asked', async () => {
    let stop = false, n = 0
    const r = await countReposts(async (o) => { if (++n > 20) stop = true; return { more: true, ids: ['v' + o] } }, () => stop)
    expect(r.complete).toBe(false)
    expect(n).toBeLessThan(40)
  })
})

describe('sumVideos', () => {
  it('adds exact numbers and skips repeats', () => {
    const a = { id: '1', stats: { playCount: 100 }, statsV2: { playCount: '150', diggCount: '5', commentCount: '2', shareCount: '1', collectCount: '3' } }
    const b = { id: '2', stats: { playCount: 40, diggCount: 1 } }
    expect(sumVideos([a, a, b, {}], true)).toEqual({ count: 2, views: 190, likes: 6, comments: 2, shares: 1, saves: 3, best: 150, complete: true })
  })
})
