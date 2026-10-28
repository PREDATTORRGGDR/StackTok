import { BrowserWindow, WebContentsView, app, session, shell } from 'electron'
import { Bounds, OpenIn, SessionState } from '../shared/types'

// Dev builds can point at a mock site for tests; packaged builds always use TikTok.
export const HOME_URL = (!app.isPackaged && process.env.STACKTOK_HOME_URL) || 'https://www.tiktok.com/tiktokstudio/content'
/** Start page for an account. /profile is TikTok's own redirect to the signed-in user's profile. */
export const startUrl = (openIn: OpenIn) =>
  openIn === 'chats' ? new URL('/messages', HOME_URL).href : openIn === 'profile' ? new URL('/profile', HOME_URL).href : HOME_URL
export const partitionFor = (accountId: string) => `persist:acct-${accountId}`

const isHttp = (url: string) => /^https?:\/\//i.test(url)

/** The page's own site only (the dev mock host counts too); iframes and redirects to other sites are not trusted. */
function isTikTok(url: string) {
  try {
    const h = new URL(url).hostname
    return h === 'tiktok.com' || h.endsWith('.tiktok.com') || h === new URL(HOME_URL).hostname
  } catch {
    return false
  }
}

/** Chromium UA without the Electron/app tokens, so the site sees an ordinary Chromium build. */
function configureSession(accountId: string) {
  const ses = session.fromPartition(partitionFor(accountId))
  ses.setUserAgent(app.userAgentFallback.replace(/\s(Electron|stacktok)\/\S+/gi, ''))
  // TikTok pages may use the permissions they ask for (copy link, notifications, camera for uploads...); any other origin gets nothing.
  ses.setPermissionRequestHandler((_wc, _perm, cb, details) => cb(isTikTok(details.requestingUrl)))
  ses.setPermissionCheckHandler((_wc, _perm, origin) => isTikTok(origin))
  return ses
}

/** Reads only whether a login cookie exists; cookie values never leave the main process. */
export async function sessionState(accountId: string): Promise<SessionState> {
  const cookies = await session.fromPartition(partitionFor(accountId)).cookies.get({ name: 'sessionid' })
  return cookies.length ? 'logged_in' : 'logged_out'
}

/** Applies hardened navigation rules to any TikTok-facing webContents. */
export function lockDown(wc: Electron.WebContents) {
  wc.setWindowOpenHandler(({ url }) => {
    if (isHttp(url)) wc.loadURL(url) // popups (e.g. social login) stay inside the same isolated session
    return { action: 'deny' }
  })
  wc.on('will-navigate', (e, url) => {
    if (!isHttp(url)) e.preventDefault()
  })
}

export class Browse {
  private views = new Map<string, WebContentsView>()
  private current?: string
  private bounds: Bounds | null = null

  private userMuted = new Map<string, boolean>() // what the user chose per account

  constructor(private win: BrowserWindow, private muteByDefault: () => boolean, private onView: (wc: Electron.WebContents) => void, private openIn: (accountId: string) => OpenIn, private onBlocked: (accountId: string) => void) {}

  private view(accountId: string): WebContentsView {
    let v = this.views.get(accountId)
    if (!v) {
      configureSession(accountId)
      v = new WebContentsView({
        webPreferences: {
          partition: partitionFor(accountId),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          autoplayPolicy: 'document-user-activation-required' // no video starts until the user clicks
        }
      })
      lockDown(v.webContents)
      // TikTok sometimes answers a profile or chat page with 403 and an empty body. Don't retry it: show Studio and tell the user.
      const wc = v.webContents
      wc.on('did-navigate', (_e, url, code) => {
        if (code === 403 && isHttp(url) && new URL(url).pathname !== new URL(HOME_URL).pathname) {
          wc.loadURL(HOME_URL).catch(() => {})
          this.onBlocked(accountId)
        }
      })
      this.onView(v.webContents)
      this.userMuted.set(accountId, this.muteByDefault())
      v.webContents.setAudioMuted(true) // silent until the view is actually on screen
      v.setBorderRadius(18) // matches the glass frame around it
      v.webContents.loadURL(startUrl(this.openIn(accountId))).catch(() => {})
      this.views.set(accountId, v)
    }
    return v
  }

  show(accountId: string | undefined) {
    if (this.current && this.current !== accountId) this.detach(this.current)
    this.current = accountId
    this.layout()
  }

  setBounds(b: Bounds | null) {
    this.bounds = b
    this.layout()
  }

  private detach(id: string) {
    const v = this.views.get(id)
    if (!v) return
    this.win.contentView.removeChildView(v)
    // A hidden view must never keep playing: silence it and pause any video.
    v.webContents.setAudioMuted(true)
    v.webContents.executeJavaScript("document.querySelectorAll('video, audio').forEach((m) => m.pause())").catch(() => {})
  }

  private layout() {
    if (!this.current) return
    if (!this.bounds) return this.detach(this.current)
    const v = this.view(this.current)
    this.win.contentView.addChildView(v) // re-adding brings it to front, no-op if already attached
    v.setBounds(this.bounds)
    v.webContents.setAudioMuted(this.userMuted.get(this.current) ?? true)
  }

  isMuted(): boolean {
    return this.current ? (this.userMuted.get(this.current) ?? true) : true
  }

  toggleMute(): boolean {
    if (!this.current) return true
    const next = !this.isMuted()
    this.userMuted.set(this.current, next)
    this.views.get(this.current)?.webContents.setAudioMuted(next)
    return next
  }

  /** Loads a page in the account's view (created on demand); a view created just now already starts on the account's own page. */
  open(accountId: string, url = startUrl(this.openIn(accountId))) {
    this.view(accountId).webContents.loadURL(url).catch(() => {})
  }

  nav(action: 'back' | 'forward' | 'reload' | 'home') {
    const wc = this.current && this.views.get(this.current)?.webContents
    if (!wc) return
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    else if (action === 'reload') wc.reload()
    else if (action === 'home' && this.current) wc.loadURL(startUrl(this.openIn(this.current)))
  }

  openExternal() {
    const url = this.current && this.views.get(this.current)?.webContents.getURL()
    shell.openExternal(url && isHttp(url) ? url : HOME_URL)
  }

  devtools() {
    if (this.current) this.views.get(this.current)?.webContents.openDevTools({ mode: 'detach' })
  }

  /** Best-effort read of the logged-in profile link from the page DOM (no private API, no tokens). */
  async detectIdentity(accountId: string): Promise<{ username?: string; avatar?: string }> {
    const wc = this.views.get(accountId)?.webContents
    if (!wc) return {}
    try {
      return await wc.executeJavaScript(`(() => {
        const a = document.querySelector('[data-e2e="nav-profile"] a[href^="/@"], a[data-e2e="nav-profile"][href^="/@"], [data-e2e="profile-icon"]')
        const link = a && a.closest ? (a.closest('a[href^="/@"]') || a) : null
        const href = link && link.getAttribute && link.getAttribute('href')
        const m = href && href.match(/^\\/@([^/?#]+)/)
        const img = document.querySelector('[data-e2e="profile-icon"] img, [data-e2e="nav-profile"] img')
        return { username: m ? decodeURIComponent(m[1]) : undefined, avatar: img && /^https:/.test(img.src) ? img.src : undefined }
      })()`)
    } catch {
      return {}
    }
  }

  destroy(accountId: string) {
    const v = this.views.get(accountId)
    if (!v) return
    this.detach(accountId)
    v.webContents.close()
    this.views.delete(accountId)
    if (this.current === accountId) this.current = undefined
  }

  /** Explicit, user-requested wipe of one account's cookies, storage, and cache. */
  async wipe(accountId: string) {
    this.destroy(accountId)
    const ses = session.fromPartition(partitionFor(accountId))
    await ses.clearStorageData()
    await ses.clearCache()
  }
}

export { configureSession }
