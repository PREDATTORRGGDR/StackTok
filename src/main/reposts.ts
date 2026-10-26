import type { WebContents } from 'electron'
import { sessionState } from './browse'
import type { Job } from '../shared/types'

// ───────── code that runs inside the TikTok page ─────────
// Same endpoints and flow as github.com/yiitxyz/tiktokRepostRemover (scan → delete → verify) and github.com/Skenls/tiktok-unrepost.
// Requests go from the account's own page, so they carry that account's cookies; nothing leaves tiktok.com.
// These are real functions serialised with toString(), so they must not use anything from the outer scope.

/** The signed-in account, read from the data TikTok embeds in its own HTML. */
const whoAmI = async () => {
  const html = await (await fetch('/', { credentials: 'include' })).text()
  const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/)
  const u = m ? JSON.parse(m[1]).__DEFAULT_SCOPE__?.['webapp.app-context']?.user : null
  return u && u.secUid ? { uniqueId: String(u.uniqueId || ''), secUid: String(u.secUid) } : null
}

/** One page of the account's reposts. */
const listReposts = async ({ secUid, cursor }: { secUid: string; cursor: string }) => {
  const p = new URLSearchParams({ aid: '1988', count: '30', coverFormat: '2', cursor, needPinnedItemIds: 'true', post_item_list_request_type: '0', secUid })
  const r = await fetch('/api/repost/item_list/?' + p, { credentials: 'include' })
  const j = await r.json().catch(() => null)
  return {
    http: r.status,
    code: j ? j.status_code : -1,
    msg: (j && j.status_msg) || '',
    ids: ((j && j.itemList) || []).map((x: any) => String(x.id)),
    hasMore: !!(j && j.hasMore),
    cursor: j && j.cursor != null ? String(j.cursor) : cursor
  }
}

const unrepost = async (id: string) => {
  const r = await fetch(`/tiktok/v1/upvote/delete?aid=1988&item_id=${id}`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' })
  const j = await r.json().catch(() => null)
  return { http: r.status, code: j ? j.status_code : -1, msg: (j && j.status_msg) || '' }
}

// ───────── the job ─────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const jitter = (a: number, b: number) => a + Math.random() * (b - a)
const call = (fn: Function, arg?: unknown) => `(${fn})(${JSON.stringify(arg)})`
const SAFETY = /captcha|verify|too many|too frequent|rate.?limit|risk|restricted|unusual|slow down/i

type Reply = { http: number; code: number; msg: string }
class SafetyStop extends Error {}
class Stopped extends Error {}

/** Removes all of the account's reposts through TikTok's web endpoints: scan the whole list, delete, then re-scan to confirm. */
export class RepostCleaner {
  job: Job
  private stopped = false

  constructor(
    accountId: string,
    private username: string | undefined, // confirmed username; the session must belong to it
    private base: string,
    private wc: WebContents,
    private onChange: () => void,
    private fast = false,
    private limit = Infinity // delete at most this many (used for supervised test runs)
  ) {
    this.job = { accountId, status: 'running', phase: 'scan', found: 0, removed: 0, failed: 0, startedAt: Date.now(), message: 'Подключаюсь к TikTok…' }
  }

  private set(patch: Partial<Job>) {
    Object.assign(this.job, patch)
    this.onChange()
  }

  stop() {
    this.stopped = true
  }

  private async wait(a: number, b: number) {
    const end = Date.now() + (this.fast ? 20 : jitter(a, b))
    while (Date.now() < end) {
      if (this.stopped) throw new Stopped()
      await sleep(Math.min(250, end - Date.now()))
    }
  }

  private async js<T>(fn: Function, arg?: unknown): Promise<T> {
    if (this.stopped) throw new Stopped()
    for (let attempt = 0; ; attempt++) {
      try { return (await this.wc.executeJavaScript(call(fn, arg))) as T } catch (e) {
        if (attempt >= 2) throw new Error((e as Error).message)
        await sleep(1500) // the page may be mid-navigation
      }
    }
  }

  /**
   * Sends a request, backing off on 429 like Skenls/tiktok-unrepost does (30 s, then 60 s).
   * Login problems or anti-abuse replies stop the whole job.
   */
  private async request<T extends Reply>(fn: Function, arg: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const r = await this.js<T>(fn, arg)
      if (r.http === 429 && attempt < 2) {
        const msg = this.job.message
        this.set({ message: `TikTok просит притормозить, жду ${30 * (attempt + 1)} с…` })
        await this.wait(30_000 * (attempt + 1), 30_000 * (attempt + 1))
        this.set({ message: msg })
        continue
      }
      if ([401, 403, 429].includes(r.http) || SAFETY.test(r.msg)) throw new SafetyStop(r.msg || `TikTok ответил ${r.http}`)
      return r
    }
  }

  /** Every repost id currently on the profile. */
  private async scanAll(secUid: string, onPage: (n: number) => void): Promise<string[]> {
    const ids = new Set<string>()
    const seen = new Set<string>()
    let cursor = '0'
    for (;;) {
      if (seen.has(cursor)) break // TikTok repeated a cursor: stop instead of looping
      seen.add(cursor)
      const page = await this.request<Reply & { ids: string[]; hasMore: boolean; cursor: string }>(listReposts, { secUid, cursor })
      if (page.http !== 200 || page.code !== 0) throw new Error(`список репостов недоступен (${page.code}${page.msg ? ': ' + page.msg : ''})`)
      page.ids.forEach((id) => ids.add(id))
      onPage(ids.size)
      if (!page.hasMore || page.cursor === cursor) break
      cursor = page.cursor
      await this.wait(1200, 2500)
    }
    return [...ids]
  }

  /** Deletes the given reposts, pausing a few seconds after every 35–45 of them. */
  private async deleteAll(ids: string[], failed: Set<string>) {
    let inGroup = 0
    let groupSize = Math.round(jitter(35, 45))
    for (const id of ids) {
      if (this.job.removed >= this.limit) return
      const r = await this.request<Reply>(unrepost, id)
      if (r.http === 200 && r.code === 0) { failed.delete(id); this.set({ removed: this.job.removed + 1 }) }
      else failed.add(id)
      this.set({ failed: failed.size })
      if (++inGroup >= groupSize) {
        this.set({ message: 'Короткая пауза, чтобы не злить TikTok…' })
        await this.wait(4000, 7000)
        this.set({ message: 'Удаляю репосты…' })
        inGroup = 0
        groupSize = Math.round(jitter(35, 45))
      } else await this.wait(400, 900)
    }
  }

  async run() {
    try {
      if ((await sessionState(this.job.accountId)) !== 'logged_in') return this.finish('stopped', 'Аккаунт не авторизован. Войдите на вкладке «Обзор».')
      // API calls must come from a TikTok page of this account.
      if (!this.wc.getURL().startsWith(this.base)) await this.wc.loadURL(this.base + '/').catch(() => {})
      const me = await this.js<{ uniqueId: string; secUid: string } | null>(whoAmI)
      if (!me) return this.finish('stopped', 'Не удалось определить аккаунт TikTok. Откройте «Обзор», убедитесь, что вход выполнен, и попробуйте снова.')
      if (this.username && me.uniqueId.toLowerCase() !== this.username.toLowerCase()) {
        return this.finish('stopped', `В этой сессии вошли как @${me.uniqueId}, а не @${this.username}. Ничего не удалено.`)
      }

      this.set({ phase: 'scan', message: 'Ищу репосты…' })
      let ids = await this.scanAll(me.secUid, (n) => this.set({ found: n, message: `Ищу репосты… найдено ${n}` }))
      if (!ids.length) return this.finish('done', 'Репостов нет — удалять нечего.')
      this.set({ found: ids.length })

      // Delete, then re-scan: anything still listed gets one more try.
      const failed = new Set<string>()
      for (let pass = 0; pass < 2; pass++) {
        this.set({ phase: 'delete', deleteStartedAt: this.job.deleteStartedAt ?? Date.now(), message: pass ? 'Повторяю для оставшихся…' : 'Удаляю репосты…' })
        await this.deleteAll(ids.slice(0, Math.max(0, this.limit - this.job.removed)), failed)
        if (this.job.removed >= this.limit) break
        this.set({ phase: 'verify', message: 'Проверяю, что всё удалено…' })
        await this.wait(2000, 3000)
        const left = await this.scanAll(me.secUid, () => {})
        const leftSet = new Set(left)
        // Counted as removed but still listed: TikTok did not apply it.
        const notApplied = ids.filter((id) => leftSet.has(id) && !failed.has(id)).length
        if (notApplied) this.set({ removed: this.job.removed - notApplied })
        ids = left
        this.set({ found: Math.max(this.job.found, this.job.removed + left.length) })
        left.forEach((id) => failed.add(id))
        this.set({ failed: failed.size })
        if (!left.length) break
      }

      const j = this.job
      if (!j.failed) return this.finish('done', `Готово: удалено ${j.removed} из ${j.found}.`)
      this.finish('done', `Удалено ${j.removed} из ${j.found}. Не удалось убрать: ${j.failed} — TikTok не дал их удалить (видео могло быть удалено автором). Можно запустить ещё раз.`)
    } catch (e) {
      const j = this.job
      if (e instanceof Stopped) return this.finish('stopped', `Остановлено. Удалено ${j.removed} из ${j.found}.`)
      const why = e instanceof SafetyStop ? 'TikTok ограничил действия, очистка остановлена ради безопасности аккаунта: ' : 'Ошибка: '
      this.finish('stopped', `${why}${(e as Error).message}. Удалено ${j.removed} из ${j.found}. Подождите немного и запустите снова.`)
    }
  }

  private finish(status: 'done' | 'stopped', message: string) {
    this.set({ status, message, finishedAt: Date.now() })
  }
}
