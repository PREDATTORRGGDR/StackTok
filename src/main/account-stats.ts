import type { AccountStats, RepostCount, VideoTotals } from '../shared/types'

// Account statistics: reads TikTok's replies, no Electron here. Requests live in account-stats-run.ts.

const STATE = /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
const num = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const same = (a: unknown, b: string) => String(a ?? '').toLowerCase() === b.toLowerCase()
const round1 = (n: number) => Math.round(n * 10) / 10

/** The state TikTok embeds in its pages, or null. */
export function pageScope(html: string | null): Record<string, any> | null {
  const m = html?.match(STATE)
  if (!m) return null
  try {
    return JSON.parse(m[1]).__DEFAULT_SCOPE__ ?? null
  } catch {
    return null
  }
}

const plural = (n: number, one: string, few: string, many: string) => {
  const a = n % 100, b = n % 10
  return `${n} ${a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many}`
}

/** «2 года 3 месяца», counted by the calendar. */
export function ageText(from: number, now: number): string {
  const a = new Date(from), b = new Date(now)
  let months = (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth()
  if (b.getDate() < a.getDate()) months--
  if (months < 1) return plural(Math.max(0, Math.floor((now - from) / 86_400_000)), 'день', 'дня', 'дней')
  const y = Math.floor(months / 12), m = months % 12
  return [y ? plural(y, 'год', 'года', 'лет') : '', m ? plural(m, 'месяц', 'месяца', 'месяцев') : ''].filter(Boolean).join(' ')
}

/** Joins what each source gave. Anything missing stays empty: the window shows a dash, never a made-up zero. */
export function buildStats(a: { username: string; created?: unknown; feed: Record<string, any> | null; profile: Record<string, any> | null; saved?: unknown; ms: number; now: number }): AccountStats {
  const me = a.feed?.['webapp.app-context']?.user
  const u = me && same(me.uniqueId, a.username) ? me : undefined
  const info = a.profile?.['webapp.user-detail']?.userInfo
  const ok = info?.user && same(info.user.uniqueId, a.username)
  const st = ok ? { ...info.stats, ...info.statsV2 } : undefined // statsV2 holds exact numbers as strings, stats is rounded (100900)
  const seconds = num(a.created) || num(u?.createTime) || num(ok ? info.user.createTime : undefined)
  const createdAt = seconds ? seconds * 1000 : undefined
  const days = createdAt ? Math.max(1, Math.floor((a.now - createdAt) / 86_400_000)) : undefined
  const followers = num(st?.followerCount), following = num(st?.followingCount), videos = num(st?.videoCount)
  const likes = num(st?.heartCount ?? st?.heart), liked = num(st?.diggCount)
  return {
    username: a.username,
    nickname: text(u?.nickName) ?? text(ok ? info.user.nickname : undefined),
    signature: text(u?.signature) ?? text(ok ? info.user.signature : undefined),
    region: text(u?.region),
    privateAccount: ok ? !!(info.user.privateAccount || info.user.secret) : undefined, // the feed's isPrivateAccount is true on open accounts too
    createdAt, days, age: createdAt ? ageText(createdAt, a.now) : undefined,
    followers, following, friends: num(st?.friendCount), likes, videos, liked, saved: num(a.saved),
    likesPerVideo: likes !== undefined && videos ? Math.round(likes / videos) : undefined,
    likedPerDay: liked !== undefined && days ? round1(liked / days) : undefined,
    followRatio: followers !== undefined && following ? round1(followers / following) : undefined,
    verified: ok ? !!info.user.verified : undefined,
    favoritesOpen: ok && typeof info.user.openFavorite === 'boolean' ? info.user.openFavorite : undefined,
    organization: ok ? !!info.user.isOrganization : undefined,
    seller: ok ? !!info.user.ttSeller : undefined,
    language: text(ok ? info.user.language : undefined),
    nameChangedAt: ok && num(info.user.uniqueIdModifyTime) ? num(info.user.uniqueIdModifyTime)! * 1000 : undefined,
    nickChangedAt: ok && num(info.user.nickNameModifyTime) ? num(info.user.nickNameModifyTime)! * 1000 : undefined,
    ms: a.ms
  }
}

const PAGE = 30
const MAX_OFFSET = 90_000

/** One page of the repost list: `more` = TikTok says entries follow; null = no usable answer. */
export type RepostPage = (offset: number) => Promise<{ more: boolean; ids: string[] } | null>

/**
 * Counts real videos in the repost list. The cursor is a plain offset, so pages are read side by side, but most entries of an old
 * list are unavailable videos TikTok leaves out, so only ids are counted, never the list length. Under load TikTok sometimes says
 * `more: false` far before the end (seen live 2026-11-05: 390 instead of 1830), so an end only counts once the page and the one
 * after it confirm it when asked again. A failed page is asked once more, then the count stops and is marked incomplete.
 */
export async function countReposts(page: RepostPage, stopped: () => boolean = () => false, threads = 8): Promise<RepostCount> {
  const ids = new Set<string>()
  let next = 0, end = Infinity, broken = false
  const ask = async (o: number) => {
    const r = (await page(o)) ?? (await page(o))
    if (!r) broken = true
    else r.ids.forEach((id) => ids.add(id))
    return r
  }
  const worker = async () => {
    while (!broken && !stopped() && next < end && next < MAX_OFFSET) {
      const o = next
      next += PAGE
      const r = await ask(o)
      if (!r || r.more || o >= end) continue
      const again = await ask(o)
      const after = again && !again.more ? await ask(o + PAGE) : null
      if (after && !after.more && !after.ids.length) end = Math.min(end, o)
    }
  }
  await Promise.all(Array.from({ length: threads }, worker))
  return { visible: ids.size, entries: Number.isFinite(end) ? end : next, complete: Number.isFinite(end) && !broken && !stopped() }
}

const big = (s: any, v2: any, key: string) => num(v2?.[key]) ?? num(s?.[key]) ?? 0

/** Sums what the account's own videos collected. */
export function sumVideos(items: any[], complete: boolean): VideoTotals {
  const t: VideoTotals = { count: 0, views: 0, likes: 0, comments: 0, shares: 0, saves: 0, best: 0, complete }
  const seen = new Set<string>()
  for (const it of items) {
    const id = String(it?.id ?? '')
    if (!id || seen.has(id)) continue
    seen.add(id)
    const views = big(it.stats, it.statsV2, 'playCount')
    t.count++
    t.views += views
    t.likes += big(it.stats, it.statsV2, 'diggCount')
    t.comments += big(it.stats, it.statsV2, 'commentCount')
    t.shares += big(it.stats, it.statsV2, 'shareCount')
    t.saves += big(it.stats, it.statsV2, 'collectCount')
    t.best = Math.max(t.best, views)
  }
  return t
}
