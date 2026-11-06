import { session } from 'electron'
import type { AccountStats, RepostCount, VideoTotals } from '../shared/types'
import { buildStats, countReposts, pageScope, sumVideos } from './account-stats'
import { HOME_URL, partitionFor } from './browse'

// All requests go from main with the account's own session: no page is opened, nothing is rendered.
// Passport also holds e-mail, phone and session values; only the id, name and creation date are read from it.

type Who = { secUid: string; username: string; created: unknown }

const get = (id: string, path: string) => session.fromPartition(partitionFor(id)).fetch(new URL(path, HOME_URL).href, { credentials: 'include' })
const html = (id: string, path: string) => get(id, path).then((r) => (r.ok ? r.text() : null)).catch(() => null)
const json = (id: string, path: string) => get(id, path).then((r) => (r.ok ? r.json() : null)).catch(() => null) // TikTok's quiet refusal is an empty body, which lands in catch

const who = new Map<string, Promise<Who | null>>() // both halves of the window start at once and share one answer
function whoIs(id: string) {
  let p = who.get(id)
  if (!p) {
    p = json(id, '/passport/web/account/info/?aid=1988').then((j) => {
      const d = j?.data
      return d?.sec_user_id && d?.username ? { secUid: String(d.sec_user_id), username: String(d.username), created: d.create_time } : null
    })
    who.set(id, p)
    p.finally(() => setTimeout(() => who.delete(id), 5000))
  }
  return p
}

async function me(id: string, expected?: string) {
  const w = await whoIs(id)
  if (!w) throw new Error('TikTok не ответил. Проверьте вход в этот аккаунт и попробуйте позже.')
  if (expected && w.username.toLowerCase() !== expected.toLowerCase()) throw new Error(`В этой сессии вошли как @${w.username}, а не @${expected}.`)
  return w
}

export async function accountProfile(id: string, expected?: string): Promise<AccountStats> {
  const t = Date.now()
  const w = await me(id, expected)
  const name = encodeURIComponent(w.username)
  // TikTok randomly answers one address of a profile with 403 and an empty body, so two forms of it are asked once, side by side.
  const profile = (path: string) => html(id, path).then((h) => {
    const s = pageScope(h)
    if (!s?.['webapp.user-detail']?.userInfo?.stats) throw new Error('no stats')
    return s
  })
  const q = new URLSearchParams({ aid: '1988', count: '1', cursor: '0', secUid: w.secUid })
  const [feed, prof, saved] = await Promise.all([
    html(id, '/foryou').then(pageScope),
    Promise.any([profile(`/@${name}/`), profile(`/@${name}?lang=ru-RU`)]).catch(() => null),
    json(id, '/api/user/collect/item_list/?' + q)
  ])
  return buildStats({ username: w.username, created: w.created, feed, profile: prof, saved: saved?.total, ms: Date.now() - t, now: Date.now() })
}

const running = new Map<string, { stop: boolean }>() // repost counts that are going on; closing the window ends them

export async function accountReposts(id: string, expected?: string): Promise<RepostCount> {
  const w = await me(id, expected)
  const job = { stop: false }
  running.set(id, job)
  try {
    return await countReposts(async (offset) => {
      const q = new URLSearchParams({ aid: '1988', count: '30', coverFormat: '2', cursor: String(offset), needPinnedItemIds: 'true', post_item_list_request_type: '0', secUid: w.secUid })
      const j = await json(id, '/api/repost/item_list/?' + q)
      return j && (j.status_code ?? 0) === 0 && typeof j.hasMore === 'boolean' ? { more: j.hasMore, ids: (j.itemList ?? []).map((x: { id: unknown }) => String(x.id)) } : null
    }, () => job.stop)
  } finally {
    if (running.get(id) === job) running.delete(id)
  }
}

export function stopCounting(id: string) {
  const job = running.get(id)
  if (job) job.stop = true
}

/** Totals over the account's own videos. An empty answer ends the walk, and the result says it is incomplete. */
export async function accountVideos(id: string, expected?: string): Promise<VideoTotals | null> {
  const w = await me(id, expected)
  const items: unknown[] = []
  let cursor = '0', complete = false
  for (let i = 0; i < 100; i++) {
    const q = new URLSearchParams({ aid: '1988', count: '35', coverFormat: '2', cursor, secUid: w.secUid })
    const path = '/api/post/item_list/?' + q
    const j = (await json(id, path)) ?? (await json(id, path))
    if (!j || (j.status_code ?? 0) !== 0) break
    items.push(...(j.itemList ?? []))
    if (!j.hasMore) { complete = true; break }
    cursor = String(j.cursor)
  }
  return items.length || complete ? sumVideos(items as any[], complete) : null
}
