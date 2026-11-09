import type { WebContents } from 'electron'
import type { SweepItem, SweepJob, SweepKind } from '../shared/types'
import type { DeleteReply } from './repost-cleaner'
import { js, whoAmI } from './reposts'
import { PAGE, SweepApi, SweepPage, Sweeper } from './sweep'

// ───────── code that runs inside the TikTok page ─────────
// Requests go from the account's own page, so they carry that account's cookies. Addresses and fields are the ones the site itself uses
// (its web bundle, read 2026-11-06): likes /api/favorite/item_list + /api/commit/item/digg (type 0 = undo), favorites
// /api/user/collect/item_list + /api/item/collect (action 2 = cancel), following /api/user/list + /api/commit/follow/user (type 0).
// /api/user/list answers an empty 200 to anything but the site's full signature (X-Gnarly, X-Dynosaur), so requests go through the site's own
// client, found among the page's loaded modules; a plain signed fetch is the fallback for when TikTok moves it.
// This is a real function serialised with toString(), so it must not use anything from the outer scope.

interface Ask { op: 'ready' | 'list' | 'undo' | 'state' | 'feed' | 'count'; kind?: string; secUid?: string; cursor?: string; count?: number; id?: string; sec?: string; name?: string }

const site = async (a: Ask) => {
  const w = window as any
  const client = () => {
    if (w.__stackClient) return w.__stackClient
    const g = w.__LOADABLE_LOADED_CHUNKS__
    if (!g || !g.push) return null
    let req: any
    g.push([[Symbol('stacktok')], {}, (r: any) => { req = r }])
    if (!req || !req.m) return null
    for (const [id, fn] of Object.entries(req.m)) {
      const src = Function.prototype.toString.call(fn)
      if (!src.includes('csrfToken') || !/\.post|post\(/.test(src)) continue
      let e: any
      try { e = req(id) } catch { continue }
      for (const k of Object.keys(e ?? {})) {
        let v: any
        try { v = e[k] } catch { continue }
        if (v && typeof v === 'object' && typeof v.get === 'function' && typeof v.post === 'function' && 'csrfToken' in v) return (w.__stackClient = v)
      }
    }
    return null
  }
  const c = (() => { try { return client() } catch { return null } })()
  if (a.op === 'ready') return !!c
  const WWW = 2 // the client's "www.tiktok.com" address
  const web = () => ({ app_name: 'tiktok_web', channel: 'tiktok_web', device_platform: 'web_pc', msToken: document.cookie.match(/(?:^|; )msToken=([^;]+)/)?.[1] ?? '' })
  const sign = async (path: string, p: URLSearchParams) => {
    try {
      const s = await w.byted_acrawler?.frontierSign?.({ url: location.origin + path + '?' + p })
      for (const k of Object.keys(s ?? {})) p.set(k, s[k])
    } catch {}
    return path + '?' + p
  }

  // The client throws the reply itself when the body is not JSON: an empty 200 is TikTok's quiet refusal.
  const plain = (e: unknown) => (e instanceof Response ? e.status : 0)

  if (a.op === 'state') { // is the like, favorite or follow still there? null = could not tell
    try {
      if (a.kind === 'following') {
        const r = await c.get('/api/user/detail/', { query: { secUid: a.sec, uniqueId: a.name }, baseUrlType: WWW })
        const v = r?.userInfo?.user?.relation // 1 = following, 2 = mutual
        return typeof v === 'number' ? v === 1 || v === 2 : null
      }
      const s = (await c.get('/api/item/detail/', { query: { itemId: a.id }, baseUrlType: WWW }))?.itemInfo?.itemStruct
      const v = a.kind === 'likes' ? s?.digged : s?.collected
      return typeof v === 'boolean' ? v : null
    } catch { return null }
  }

  if (a.op === 'count') { // how many the account follows
    try { const r = await c.get('/api/user/detail/', { query: { secUid: a.secUid }, baseUrlType: WWW }); return r?.userInfo?.stats?.followingCount ?? r?.userInfo?.statsV2?.followingCount ?? null } catch { return null }
  }

  if (a.op === 'feed') { // the Following feed; cursor, level and pull type travel together
    const [cursor, level, pull] = (a.cursor ?? '0').split('|')
    try {
      if (!c) return { http: 200, code: -1, msg: '', items: [], hasMore: false, cursor: a.cursor }
      const j = await c.get('/api/following/item_list/', { query: { aid: 1988, count: 30, language: navigator.language.slice(0, 2), cursor, pullType: pull ?? 1, level: level ?? 1, isResetCounterUsed: true, isNonPersonalized: false, coverFormat: 2 }, baseUrlType: WWW })
      const items = ((j && j.itemList) || []).filter((x: any) => x.author?.id && (x.author.relation === 1 || x.author.relation === 2)).map((x: any) => ({
        id: String(x.author.id), sec: String(x.author.secUid ?? ''), author: String(x.author.uniqueId ?? ''), title: String(x.author.nickname ?? ''), cover: x.author.avatarThumb || x.author.avatarMedium || '',
        friend: x.author.relation === 2, verified: !!x.author.verified, videos: x.authorStats?.videoCount, followers: x.authorStats?.followerCount
      }))
      return { http: 200, code: j?.status_code ?? j?.statusCode ?? 0, msg: j?.status_msg || '', items, hasMore: !!j?.hasMore, cursor: [j?.cursor ?? cursor, j?.level ?? level ?? 1, 2].join('|') }
    } catch (e) {
      return { http: plain(e) || 0, code: -1, msg: String(e).slice(0, 120), items: [], hasMore: false, cursor: a.cursor }
    }
  }

  if (a.op === 'list') {
    const kind = a.kind
    const cursor = a.cursor ?? '0'
    const follow = kind === 'following'
    const path = follow ? '/api/user/list/' : kind === 'likes' ? '/api/favorite/item_list/' : '/api/user/collect/item_list/'
    const q: Record<string, string> = follow
      ? { count: String(a.count), maxCursor: '0', minCursor: cursor, scene: '21', secUid: a.secUid ?? '' }
      : { count: String(a.count), coverFormat: '2', cursor, secUid: a.secUid ?? '' }
    try {
      let j: any = null, http = 200
      let told = false
      if (c) { try { j = await c.get(path, { query: q, baseUrlType: WWW }) } catch (e) { j = null; http = plain(e) || 200; told = plain(e) > 0 } }
      if (!j && !told) {
        const r = await fetch(await sign(path, new URLSearchParams({ aid: '1988', ...q, ...web() })), { credentials: 'include' })
        http = r.status
        try { j = JSON.parse(await r.text()) } catch { j = null }
      }
      const items = follow
        ? ((j && j.userList) || []).map((x: any) => ({
            id: String(x.user?.id ?? ''), sec: String(x.user?.secUid ?? ''), author: String(x.user?.uniqueId ?? ''), title: String(x.user?.nickname ?? ''), cover: x.user?.avatarThumb || x.user?.avatarMedium || '',
            friend: x.user?.relation === 2, verified: !!x.user?.verified, videos: x.stats?.videoCount ?? x.statsV2?.videoCount, followers: x.stats?.followerCount
          }))
        : ((j && j.itemList) || []).map((x: any) => ({
            id: String(x.id), sec: String(x.author?.secUid ?? ''), author: String(x.author?.uniqueId ?? (typeof x.author === 'string' ? x.author : '')), title: String(x.desc ?? '').slice(0, 120),
            cover: x.video?.cover || x.video?.originCover || x.imagePost?.cover?.imageURL?.urlList?.[0] || '', time: Number(x.createTime) || 0, photo: !!x.imagePost
          }))
      return {
        http,
        code: j ? (j.status_code ?? j.statusCode ?? 0) : -1,
        msg: (j && (j.status_msg || j.statusMsg)) || '',
        items: items.filter((x: { id: string }) => x.id),
        hasMore: !!(j && j.hasMore),
        total: j && typeof j.total === 'number' ? j.total : undefined,
        cursor: follow ? String(j?.minCursor ?? cursor) : j && j.cursor != null ? String(j.cursor) : cursor
      }
    } catch (e) {
      return { http: 0, code: -1, msg: String(e), items: [], hasMore: false, cursor }
    }
  }

  // Undoes one like, favorite or follow: the request the site's own button sends.
  const { kind, id = '', sec = '' } = a
  const path = kind === 'likes' ? '/api/commit/item/digg/' : kind === 'favorites' ? '/api/item/collect/' : '/api/commit/follow/user/'
  const what: Record<string, string> = kind === 'likes'
    ? { aweme_id: id, type: '0' }
    : kind === 'favorites'
      ? { aid: '1988', itemId: id, action: '2', secUid: sec }
      : { user_id: id, sec_user_id: sec, type: '0', action_type: '0', from: '18', from_pre: '0', channel_id: '0', fromWeb: '1' }
  const reply = (http: number, empty: boolean, j: any) => ({
    http, empty, json: !!j && typeof j === 'object',
    code: j ? (j.status_code ?? j.statusCode ?? 0) : -1, msg: (j && (j.status_msg || j.statusMsg)) || '',
    deleted: undefined // the reply proves nothing: only the list does. follow_status is not 0 after every unfollow
  })
  try {
    if (c) {
      // No plain fetch after this: without the site's signature it gets an empty 200, which would read as a limit.
      try { return reply(200, false, await c.post(path, { query: what, baseUrlType: WWW, headers: { 'tt-csrf-token': c.csrfToken } })) } catch (e) {
        return plain(e) ? reply(plain(e), true, null) : { http: 0, empty: false, json: false, code: -1, msg: String(e).slice(0, 120) }
      }
    }
    const csrf = document.cookie.match(/(?:^|;\s*)(?:tt_csrf_token|csrf_session_id)=([^;]+)/)?.[1]
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
    if (csrf) headers['tt-csrf-token'] = csrf
    const r = await fetch(await sign(path, new URLSearchParams({ aid: '1988', ...what, ...web() })), { method: 'POST', credentials: 'include', headers, body: '' })
    const text = await r.text()
    let j: any = null
    try { j = JSON.parse(text) } catch {}
    return reply(r.status, !text.trim(), j)
  } catch (e) {
    return { http: 0, empty: true, json: false, code: -1, msg: String(e) }
  }
}

/**
 * Searches a list of the account from its own TikTok page, after checking that the session belongs to the confirmed username.
 * `onSweeper` gets the engine as soon as it exists: the caller can stop it, and later call `remove` with the user's choice.
 */
export async function findSweep(
  job: SweepJob, username: string | undefined, base: string, wc: WebContents, onChange: () => void, onSweeper: (c: Sweeper) => void
): Promise<SweepJob> {
  const fail = (message: string) => { Object.assign(job, { status: 'stopped', message, finishedAt: Date.now() }); onChange(); return job }
  try {
    // The site's client lives on the main site, not in TikTok Studio; the page needs a moment to load it.
    if (!wc.getURL().startsWith(base) || !(await js<boolean>(wc, site, { op: 'ready' }).catch(() => false))) {
      await wc.loadURL(base + '/foryou').catch(() => {})
      for (let i = 0; i < 20 && !(await js<boolean>(wc, site, { op: 'ready' }).catch(() => false)); i++) await new Promise((r) => setTimeout(r, 500))
    }
    const me = await js<{ uniqueId: string; secUid: string } | null>(wc, whoAmI)
    if (!me) return fail('Не удалось определить аккаунт TikTok. Откройте «Обзор», убедитесь, что вход выполнен, и попробуйте снова.')
    if (username && me.uniqueId.toLowerCase() !== username.toLowerCase()) return fail(`В этой сессии вошли как @${me.uniqueId}, а не @${username}. Ничего не изменено. Если имя указано неверно: «Аккаунты» → меню аккаунта (…) → «Подтвердить заново».`)
    const kind: SweepKind = job.kind
    const api: SweepApi = {
      list: (cursor) => js<SweepPage>(wc, site, { op: 'list', kind, secUid: me.secUid, cursor, count: PAGE }),
      remove: (it: SweepItem) => js<DeleteReply>(wc, site, { op: 'undo', kind, id: it.id, sec: it.sec ?? '' }),
      feed: kind === 'following' ? (cursor) => js<SweepPage>(wc, site, { op: 'feed', cursor }) : undefined,
      followingCount: async () => (await js<number | null>(wc, site, { op: 'count', secUid: me.secUid })) ?? undefined,
      stillThere: async (it: SweepItem) => {
        if (kind === 'following' && !it.sec) return undefined
        return (await js<boolean | null>(wc, site, { op: 'state', kind, id: it.id, sec: it.sec ?? '', name: it.author ?? '' })) ?? undefined
      }
    }
    const s = new Sweeper(api, job, onChange)
    onSweeper(s)
    return await s.find()
  } catch (e) {
    return fail(`Ошибка: ${(e as Error).message}`)
  }
}
