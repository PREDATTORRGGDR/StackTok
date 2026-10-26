import type { WebContents } from 'electron'
import { sessionState } from './browse'

export type JobStatus = 'running' | 'paused' | 'done' | 'stopped'
export interface Job { accountId: string; status: JobStatus; removed: number; liked: number; message: string; hasDebug: boolean }

// ───────── code that runs inside the TikTok page ─────────
// These are real functions serialised with toString(), so they must not use anything from the outer scope.
// TikTok's markup changes over time: every selector is a guess backed by a text fallback.

const pageHasChallenge = () => !!document.querySelector('[id*="captcha" i], [class*="captcha" i], iframe[src*="captcha" i]')

const openRepostsTab = () => {
  const tab =
    document.querySelector('[data-e2e="repost-tab"]') ||
    [...document.querySelectorAll('[role="tab"], p, span, a, button')].find((e) => /^(репосты|reposts)$/i.test((e.textContent || '').trim()))
  if (!tab) return false
  ;(tab as HTMLElement).click()
  return true
}

const listRepostLinks = () =>
  [...document.querySelectorAll('[data-e2e="user-post-item"] a[href*="/video/"], [data-e2e="user-repost-item"] a[href*="/video/"]')].map(
    (a) => (a as HTMLAnchorElement).href
  )

/**
 * Finds the repost control: [data-e2e="video-share-repost"] (inline icon next to the video, tooltip only) or
 * [data-e2e="share-repost"] (inside the share dialog). It reads "Удалить репост" when the video is currently reposted by this account.
 */
const findRepost = () => {
  document.querySelectorAll('[data-stacktok-target]').forEach((e) => e.removeAttribute('data-stacktok-target'))
  const el = document.querySelector('[data-e2e="video-share-repost"], [data-e2e="share-repost"]') as HTMLElement | null
  if (!el) return 'none'
  // Inline layout: the icon has no text (its "Удалить репост" is a hover tooltip), but the page says "Вы сделали репост".
  const label = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim()
  const mine = /вы сделали репост|you reposted/i.test(document.querySelector('[data-e2e="repost-tag"]')?.textContent || '')
  const on = /удалить|убрать|отменить|remove|undo/i.test(label) || (!/^(репост|repost)$/i.test(label) && mine)
  if (on) { el.setAttribute('data-stacktok-target', '1'); return 'on' }
  return 'off'
}

const clickTarget = () => {
  const t = document.querySelector('[data-stacktok-target]') as HTMLElement | null
  if (!t) return false
  // Click the innermost element under the control's centre: the handler may sit on a child, not on the wrapper.
  const r = t.getBoundingClientRect()
  const inner = (document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) as HTMLElement | null) || t
  ;(t.contains(inner) ? inner : t).click()
  return true
}

const clickShare = () => {
  const s = document.querySelector('[data-e2e="share-icon"], [data-e2e="share-btn"]') as HTMLElement | null
  if (!s) return false
  s.click()
  return true
}

/** Some accounts get a "remove repost?" confirmation. Only buttons inside a dialog that mentions reposts are pressed. */
const confirmDialog = () => {
  for (const d of document.querySelectorAll('[role="dialog"], [class*="modal" i]')) {
    if (!/репост|repost/i.test((d as HTMLElement).innerText || '')) continue
    const b = [...d.querySelectorAll('button')].find((x) => /^(удалить|убрать|remove|confirm|подтвердить)$/i.test((x.textContent || '').trim()))
    if (b) { b.click(); return true }
  }
  return false
}

/** Reads the like button state without changing anything. */
const likeState = () => {
  const e = document.querySelector('[data-e2e="like-icon"], [data-e2e="browse-like-icon"]')
  const b = e && (e.closest('button, [role="button"]') || e)
  if (!b) return 'none'
  const p = b.getAttribute('aria-pressed')
  if (p === 'true') return 'liked'
  if (p === 'false') return 'unliked'
  const l = (b.getAttribute('aria-label') || '').toLowerCase()
  if (/снять|убрать|unlike|remove like|liked/.test(l)) return 'liked'
  if (/поставить|нравится|^like/.test(l)) return 'unliked'
  return 'unknown'
}

const clickLike = () => {
  const e = document.querySelector('[data-e2e="like-icon"], [data-e2e="browse-like-icon"]')
  const b = (e && (e.closest('button, [role="button"]') || e)) as HTMLElement | null
  if (!b) return false
  b.click()
  return true
}

/** Structure of the page for troubleshooting (markup names only, no personal content). */
const dumpPage = () => {
  const label = (e: Element) => ((e.getAttribute('aria-label') || (e as HTMLElement).innerText || '') as string).trim().slice(0, 60)
  const like = document.querySelector('[data-e2e="like-icon"], [data-e2e="browse-like-icon"]')
  return {
    url: location.href,
    title: document.title,
    dataE2e: [...new Set([...document.querySelectorAll('[data-e2e]')].map((e) => e.getAttribute('data-e2e')))].slice(0, 80),
    repostLike: [...document.querySelectorAll('[data-e2e], button, [role="button"], [role="menuitem"], li')]
      .filter((e) => /репост|repost/i.test(label(e) + ' ' + (e.getAttribute('data-e2e') || '')))
      .slice(0, 12)
      .map((e) => e.outerHTML.replace(/\s+/g, ' ').slice(0, 300)),
    like: like ? like.outerHTML.replace(/\s+/g, ' ').slice(0, 300) : null
  }
}

/** Opens a repost the way a person does: clicks its tile in the Reposts tab (the video opens over the profile). */
const clickRepostLink = (href: string) => {
  const a = [...document.querySelectorAll('[data-e2e="user-repost-item"] a[href*="/video/"], [data-e2e="user-post-item"] a[href*="/video/"]')].find(
    (x) => (x as HTMLAnchorElement).href === href
  ) as HTMLElement | undefined
  if (!a) return false
  a.click()
  return true
}

const videoReady = () => !!document.querySelector('[data-e2e="video-share-repost"], [data-e2e="share-repost"], [data-e2e="share-icon"], [data-e2e="share-btn"]')

// ───────── the job ─────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const call = (fn: Function, arg?: unknown) => `(${fn})(${JSON.stringify(arg)})`

/**
 * Removes the account's own reposts one by one through the normal TikTok website.
 * Safety: a control is clicked only when the page says the video is currently reposted, so it can never add a repost.
 */
export class RepostCleaner {
  job: Job
  debug = '' // page structure captured when a repost could not be handled
  private stopped = false
  private gate?: () => void

  /**
   * Works inside the app's own Browse view (the page the user sees), so the layout is exactly what they use by hand.
   * `ready` tells whether that view is currently on screen with a real size.
   */
  constructor(
    accountId: string,
    private username: string,
    private base: string,
    private wc: WebContents,
    private ready: () => boolean,
    private onChange: () => void,
    private like = false, // put a like on each video before removing its repost
    private fast = false,
    private limit = 1000 // stop after this many removals (used for supervised test runs)
  ) {
    this.job = { accountId, status: 'running', removed: 0, liked: 0, message: 'Запуск…', hasDebug: false }
  }

  private set(patch: Partial<Job>) {
    Object.assign(this.job, patch)
    this.onChange()
  }

  stop() {
    this.stopped = true
    this.gate?.()
  }

  resume() {
    if (this.job.status === 'paused') { this.set({ status: 'running', message: 'Продолжаю…' }); this.gate?.() }
  }

  /** Waits for the user; the page they must act on is the Browse view right in front of them. */
  private async pause(message: string) {
    this.set({ status: 'paused', message })
    await new Promise<void>((r) => (this.gate = r))
    this.gate = undefined
  }

  /**
   * Makes sure the video ends up liked. Already liked: unlike and like again (a fresh like).
   * If the state of the button cannot be read, nothing is clicked: guessing could remove an existing like.
   */
  private async ensureLiked(js: <T>(fn: Function, arg?: unknown) => Promise<T>): Promise<boolean> {
    const wait = () => sleep(this.fast ? 80 : 900)
    const state = () => js<string>(likeState)
    let s = await state()
    if (s === 'liked') {
      await js<boolean>(clickLike); await wait()
      s = await state()
      if (s !== 'unliked') return false // unlike did not register; leave the existing like alone
    }
    if (s === 'unliked') {
      await js<boolean>(clickLike); await wait()
      return (await state()) === 'liked'
    }
    return false
  }

  async run() {
    const wc = this.wc
    if ((await sessionState(this.job.accountId)) !== 'logged_in') return this.set({ status: 'stopped', message: 'Аккаунт не авторизован. Войдите на вкладке «Обзор».' })
    const js = async <T>(fn: Function, arg?: unknown): Promise<T> => {
      for (let attempt = 0; ; attempt++) {
        try { return (await wc.executeJavaScript(call(fn, arg))) as T } catch (e) {
          if (attempt >= 2) throw new Error(`${fn.name || 'script'}: ${(e as Error).message}`)
          await sleep(600) // the page may be mid-navigation
        }
      }
    }
    const until = async <T>(fn: () => Promise<T>, ms: number): Promise<T | undefined> => {
      const end = Date.now() + (this.fast ? Math.min(ms, 4000) : ms)
      while (Date.now() < end && !this.stopped) {
        const v = await fn().catch(() => undefined)
        if (v) return v
        await sleep(this.fast ? 60 : 400)
      }
    }
    const goto = async (url: string) => {
      await wc.loadURL(url).catch(() => {}) // a superseded navigation reports ERR_ABORTED; the page state below is what matters
      await until(async () => !wc.isLoading(), 20_000)
    }
    const blocked = async () => {
      if (/\/login/i.test(wc.getURL())) return 'TikTok просит войти. Войдите на этой странице и нажмите «Продолжить».'
      if (await js<boolean>(pageHasChallenge).catch(() => false)) return 'TikTok запрашивает проверку. Пройдите её на этой странице и нажмите «Продолжить».'
    }

    const tried = new Set<string>()
    let failures = 0
    try {
      for (let i = 0; i < 1000 && !this.stopped && this.job.removed < this.limit; i++) {
        if (!(await until(async () => this.ready(), 20_000))) {
          await this.pause('Откройте вкладку «Обзор», чтобы страница TikTok была на экране, и нажмите «Продолжить».')
          if (this.stopped) return
          i--; continue
        }
        this.set({ message: this.job.removed ? `Удалено: ${this.job.removed}. Ищу следующий репост…` : 'Открываю профиль…' })
        await goto(`${this.base}/@${encodeURIComponent(this.username)}`)
        let why = await blocked()
        if (why) { await this.pause(why); if (this.stopped) return; i--; continue }

        if (!(await until(() => js<boolean>(openRepostsTab), 10_000))) {
          await this.pause('Вкладка «Репосты» не найдена. Откройте её вручную на странице и нажмите «Продолжить».')
          if (this.stopped) return
          i--; continue
        }
        const links = (await until(async () => { const l = await js<string[]>(listRepostLinks); return l.length ? l : undefined }, 9_000)) ?? []
        if (!links.length) return this.set({ status: 'done', message: this.job.removed ? `Готово. Удалено репостов: ${this.job.removed}.` : 'Репостов не найдено.' })

        const next = links.find((l) => !tried.has(l))
        if (!next) {
          return this.set({ status: 'stopped', message: `Удалено: ${this.job.removed}. Не удалось убрать: ${links.length}. Страница видео выглядит не так, как ожидалось — нажмите «Скопировать диагностику».` })
        }
        tried.add(next)

        // Open the video the way a person does: click it in the Reposts tab.
        this.set({ message: `Удалено: ${this.job.removed}. Открываю репост…` })
        await js<boolean>(clickRepostLink, next)
        why = await blocked()
        if (why) { await this.pause(why); if (this.stopped) return; tried.delete(next); i--; continue }
        await until(() => js<boolean>(videoReady), 12_000)

        // The repost control may sit inside the share menu, so look directly first and open the menu only if needed.
        const locate = async () => {
          // The video view renders late and in two layouts: repost icon inline, or inside the share dialog.
          const seek = async (ms: number) => (await until(async () => ((await js<string>(findRepost)) !== 'none' ? true : undefined), ms)) ? js<string>(findRepost) : 'none'
          let st = await seek(7_000)
          if (st === 'none' && (await js<boolean>(clickShare))) st = await seek(5_000)
          return st
        }
        let state = await locate()
        // Only a video that is really reposted gets a like, so stray items in the list are never touched.
        if (state === 'on' && this.like) {
          if (await this.ensureLiked(js)) this.set({ liked: this.job.liked + 1 })
          state = await locate() // the like click may have closed the share menu
        }
        if (state === 'on' && (await js<boolean>(clickTarget))) {
          await sleep(this.fast ? 80 : 900)
          await js<boolean>(confirmDialog)
          // Count it only once the page confirms: the repost control no longer says "reposted".
          const gone = await until(async () => ((await js<string>(findRepost)) !== 'on' ? true : undefined), 5_000)
          if (gone) {
            this.set({ removed: this.job.removed + 1, message: `Удалено: ${this.job.removed + 1}${this.like ? ` · лайков: ${this.job.liked}` : ''}` })
            failures = 0
          } else {
            this.debug ||= JSON.stringify(await js<object>(dumpPage), null, 1).slice(0, 8000)
            this.set({ hasDebug: true })
            failures++
          }
        } else {
          if (!this.debug) {
            this.debug = JSON.stringify(await js<object>(dumpPage), null, 1).slice(0, 8000)
            this.set({ hasDebug: true })
          }
          failures++
        }
        if (failures >= 3) {
          await this.pause('Не получается распознать кнопку репоста на странице видео. Страница TikTok изменилась или видео недоступно.')
          if (this.stopped) return
          failures = 0
        }
        await sleep(this.fast ? 80 : 2200 + Math.random() * 1500) // be gentle with TikTok
      }
      this.set({ status: 'stopped', message: `Остановлено. Удалено: ${this.job.removed}.` })
    } catch (e) {
      if (!this.stopped) this.set({ status: 'stopped', message: 'Ошибка: ' + (e as Error).message })
    }
  }
}
