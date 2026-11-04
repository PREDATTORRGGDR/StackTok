import type { WebContents } from 'electron'
import type { Job } from '../shared/types'
import { DeleteReply, ListReply, PAGE, RepostApi, RepostCleaner } from './repost-cleaner'

// ───────── code that runs inside the TikTok page ─────────
// Requests go from the account's own page, so they carry that account's cookies; nothing leaves tiktok.com.
// Endpoints as in github.com/lansixxx/UnRepost and github.com/Skenls/tiktok-unrepost (both MIT).
// These are real functions serialised with toString(), so they must not use anything from the outer scope.

/**
 * The signed-in account. First TikTok's own account JSON (passport: sec_user_id and username, checked on live accounts to equal
 * secUid and uniqueId of the page data), then the data TikTok embeds in its pages. Some accounts get 403 with an empty body on `/`
 * (seen 2026-11-03) while /foryou works, so every source is tried.
 */
export const whoAmI = async () => {
  try {
    const j = await (await fetch('/passport/web/account/info/?aid=1988', { credentials: 'include' })).json()
    const d = j && j.data
    if (d && d.sec_user_id && d.username) return { uniqueId: String(d.username), secUid: String(d.sec_user_id) }
  } catch {}
  for (const path of ['/foryou', '/', '/explore']) {
    try {
      const r = await fetch(path, { credentials: 'include' })
      if (!r.ok) continue
      const m = (await r.text()).match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/)
      const u = m ? JSON.parse(m[1]).__DEFAULT_SCOPE__?.['webapp.app-context']?.user : null
      if (u && u.secUid) return { uniqueId: String(u.uniqueId || ''), secUid: String(u.secUid) }
    } catch {}
  }
  return null
}

/** One page of the account's reposts. */
const listReposts = async ({ secUid, cursor, count }: { secUid: string; cursor: string; count: number }) => {
  const p = new URLSearchParams({ aid: '1988', count: String(count), coverFormat: '2', cursor, needPinnedItemIds: 'true', post_item_list_request_type: '0', secUid })
  try {
    const r = await fetch('/api/repost/item_list/?' + p, { credentials: 'include' })
    const j = await r.json().catch(() => null)
    return {
      http: r.status,
      code: j ? (j.status_code ?? 0) : -1,
      msg: (j && j.status_msg) || '',
      ids: ((j && j.itemList) || []).map((x: any) => String(x.id)),
      hasMore: !!(j && j.hasMore),
      cursor: j && j.cursor != null ? String(j.cursor) : cursor
    }
  } catch (e) {
    return { http: 0, code: -1, msg: String(e), ids: [], hasMore: false, cursor }
  }
}

const unrepost = async (id: string) => {
  try {
    const r = await fetch(`/tiktok/v1/upvote/delete?aid=1988&item_id=${encodeURIComponent(id)}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' })
    const text = await r.text()
    let j: any = null
    try { j = JSON.parse(text) } catch {}
    const d = j && j.delete_result
    return {
      http: r.status, empty: !text.trim(), json: !!j && typeof j === 'object',
      code: j ? (j.status_code ?? 0) : -1, msg: (j && j.status_msg) || '',
      deleted: d ? d.delete_video_status === 1 || d.sync_delete_video === true : undefined
    }
  } catch (e) {
    return { http: 0, empty: true, json: false, code: -1, msg: String(e) }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const call = (fn: Function, arg?: unknown) => `(${fn})(${JSON.stringify(arg)})`

export async function js<T>(wc: WebContents, fn: Function, arg?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return (await wc.executeJavaScript(call(fn, arg))) as T } catch (e) {
      if (attempt >= 2 || wc.isDestroyed()) throw new Error((e as Error).message)
      await sleep(1500) // the page may be mid-navigation
    }
  }
}

/**
 * Removes all reposts of an account from its own TikTok page. Checks first that the session belongs to the confirmed username.
 * `cleaner` is set as soon as the job starts, so the caller can stop it.
 */
export async function cleanAccount(
  job: Job, username: string | undefined, base: string, wc: WebContents, onChange: () => void, onCleaner: (c: RepostCleaner) => void
): Promise<Job> {
  const fail = (message: string) => { Object.assign(job, { status: 'stopped', message, finishedAt: Date.now() }); onChange(); return job }
  try {
    // API calls must come from a TikTok page of this account.
    if (!wc.getURL().startsWith(base)) await wc.loadURL(base + '/').catch(() => {})
    const me = await js<{ uniqueId: string; secUid: string } | null>(wc, whoAmI)
    if (!me) return fail('Не удалось определить аккаунт TikTok. Откройте «Обзор», убедитесь, что вход выполнен, и попробуйте снова.')
    if (username && me.uniqueId.toLowerCase() !== username.toLowerCase()) return fail(`В этой сессии вошли как @${me.uniqueId}, а не @${username}. Ничего не удалено.`)
    const api: RepostApi = {
      list: (cursor) => js<ListReply>(wc, listReposts, { secUid: me.secUid, cursor, count: PAGE }),
      remove: (id) => js<DeleteReply>(wc, unrepost, id)
    }
    const cleaner = new RepostCleaner(api, job, onChange)
    onCleaner(cleaner)
    return await cleaner.run()
  } catch (e) {
    return fail(`Ошибка: ${(e as Error).message}`)
  }
}
