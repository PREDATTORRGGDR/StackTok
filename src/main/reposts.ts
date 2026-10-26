import { BrowserWindow } from 'electron'
import { configureSession, lockDown, partitionFor, sessionState } from './browse'

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

/** Looks for the repost control and reports whether the video is currently reposted by this account. */
const findRepost = () => {
  document.querySelectorAll('[data-stacktok-target]').forEach((e) => e.removeAttribute('data-stacktok-target'))
  const ON = /(удалить|убрать|отменить)\s*репост|remove\s*repost|undo\s*repost|^reposted$|^репостнуто$/i
  const ANY = /репост|repost/i
  let off = false
  for (const el of document.querySelectorAll('[data-e2e*="repost"], button, [role="button"], [role="menuitem"], [role="option"], li')) {
    const label = ((el.getAttribute('aria-label') || (el as HTMLElement).innerText || '') as string).trim()
    if (!label || label.length > 60 || !ANY.test(label)) continue
    const on = ON.test(label) || (el.getAttribute('aria-pressed') === 'true' && ANY.test(label))
    if (on) { el.setAttribute('data-stacktok-target', '1'); return 'on' }
    off = true
  }
  return off ? 'off' : 'none'
}

const clickTarget = () => {
  const t = document.querySelector('[data-stacktok-target]') as HTMLElement | null
  if (!t) return false
  t.click()
  return true
}

const clickShare = () => {
  const s = document.querySelector('[data-e2e="share-icon"]') as HTMLElement | null
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
  const e = document.querySelector('[data-e2e="like-icon"]')
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
  const e = document.querySelector('[data-e2e="like-icon"]')
  const b = (e && (e.closest('button, [role="button"]') || e)) as HTMLElement | null
  if (!b) return false
  b.click()
  return true
}

/** TikTok shows the repost option when the share icon is hovered, so imitate the pointer moving over it. */
const hoverShare = () => {
  const s = document.querySelector('[data-e2e="share-icon"]') as HTMLElement | null
  if (!s) return false
  for (const el of [s, s.parentElement]) {
    for (const t of ['pointerover', 'mouseover', 'pointerenter', 'mouseenter', 'mousemove']) {
      el?.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }))
    }
  }
  return true
}

/** Structure of the page for troubleshooting (markup names only, no personal content). */
const dumpPage = () => {
  const label = (e: Element) => ((e.getAttribute('aria-label') || (e as HTMLElement).innerText || '') as string).trim().slice(0, 60)
  const like = document.querySelector('[data-e2e="like-icon"]')
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

const videoReady = () => !!document.querySelector('[data-e2e="share-icon"], video')

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
  private win?: BrowserWindow
  private stopped = false
  private gate?: () => void

  constructor(
    accountId: string,
    private username: string,
    private base: string,
    private onChange: () => void,
    private like = false, // put a like on each video before removing its repost
    private fast = false
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
    this.win?.destroy()
  }

  resume() {
    if (this.job.status === 'paused') { this.win?.hide(); this.set({ status: 'running', message: 'Продолжаю…' }); this.gate?.() }
  }

  /** Stops the loop and waits for the user, with the window open so they can fix whatever blocked it. */
  private async pause(message: string) {
    this.win?.show()
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
    configureSession(this.job.accountId)
    if ((await sessionState(this.job.accountId)) !== 'logged_in') return this.set({ status: 'stopped', message: 'Аккаунт не авторизован. Войдите на вкладке «Обзор».' })
    const win = (this.win = new BrowserWindow({
      width: 1100, height: 800, show: false, title: 'StackTok: репосты',
      webPreferences: { partition: partitionFor(this.job.accountId), contextIsolation: true, nodeIntegration: false, sandbox: true }
    }))
    lockDown(win.webContents)
    const wc = win.webContents
    const js = <T>(fn: Function, arg?: unknown) => wc.executeJavaScript(call(fn, arg)) as Promise<T>
    const until = async <T>(fn: () => Promise<T>, ms: number): Promise<T | undefined> => {
      const end = Date.now() + (this.fast ? Math.min(ms, 4000) : ms)
      while (Date.now() < end) {
        const v = await fn().catch(() => undefined)
        if (v) return v
        await sleep(this.fast ? 60 : 400)
      }
    }
    const blocked = async () => {
      if (/\/login/i.test(wc.getURL())) return 'TikTok просит войти. Войдите в открытом окне и нажмите «Продолжить».'
      if (await js<boolean>(pageHasChallenge).catch(() => false)) return 'TikTok запрашивает проверку. Пройдите её в открытом окне и нажмите «Продолжить».'
    }

    const tried = new Set<string>()
    let failures = 0
    try {
      for (let i = 0; i < 1000 && !this.stopped; i++) {
        this.set({ message: this.job.removed ? `Удалено: ${this.job.removed}. Ищу следующий репост…` : 'Открываю профиль…' })
        await wc.loadURL(`${this.base}/@${encodeURIComponent(this.username)}`)
        let why = await blocked()
        if (why) { await this.pause(why); if (this.stopped) return; i--; continue }

        if (!(await until(() => js<boolean>(openRepostsTab), 10_000))) {
          await this.pause('Вкладка «Репосты» не найдена. Откройте её в окне вручную или нажмите «Остановить».')
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

        this.set({ message: `Удалено: ${this.job.removed}. Обрабатываю репост…` })
        await wc.loadURL(next)
        why = await blocked()
        if (why) { await this.pause(why); if (this.stopped) return; tried.delete(next); i--; continue }
        await until(() => js<boolean>(videoReady), 10_000)

        // The repost control may sit inside the share menu, so look directly first and open the menu only if needed.
        const locate = async () => {
          let st = await js<string>(findRepost)
          if (st === 'none' && (await js<boolean>(hoverShare))) { await sleep(this.fast ? 80 : 900); st = await js<string>(findRepost) }
          if (st === 'none' && (await js<boolean>(clickShare))) { await sleep(this.fast ? 80 : 900); st = await js<string>(findRepost) }
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
          await sleep(this.fast ? 80 : 900)
          this.set({ removed: this.job.removed + 1, message: `Удалено: ${this.job.removed + 1}${this.like ? ` · лайков: ${this.job.liked}` : ''}` })
          failures = 0
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
    } finally {
      if (!win.isDestroyed()) win.destroy()
    }
  }
}
