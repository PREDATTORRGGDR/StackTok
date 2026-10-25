import { BrowserWindow, WebContentsView, app, session, shell } from 'electron'
import { Bounds, SessionState } from '../shared/types'

// Dev builds can point at a mock site for tests; packaged builds always use TikTok.
export const HOME_URL = (!app.isPackaged && process.env.STACKTOK_HOME_URL) || 'https://www.tiktok.com/'
export const partitionFor = (accountId: string) => `persist:acct-${accountId}`

const isHttp = (url: string) => /^https?:\/\//i.test(url)

/** Chromium UA without the Electron/app tokens, so the site sees an ordinary Chromium build. */
function configureSession(accountId: string) {
  const ses = session.fromPartition(partitionFor(accountId))
  ses.setUserAgent(app.userAgentFallback.replace(/\s(Electron|stacktok)\/\S+/gi, ''))
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
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

  constructor(private win: BrowserWindow) {}

  private view(accountId: string): WebContentsView {
    let v = this.views.get(accountId)
    if (!v) {
      configureSession(accountId)
      v = new WebContentsView({
        webPreferences: {
          partition: partitionFor(accountId),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true
        }
      })
      lockDown(v.webContents)
      v.setBorderRadius(18) // matches the glass frame around it
      v.webContents.loadURL(HOME_URL).catch(() => {})
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
    if (v) this.win.contentView.removeChildView(v)
  }

  private layout() {
    if (!this.current) return
    if (!this.bounds) return this.detach(this.current)
    const v = this.view(this.current)
    this.win.contentView.addChildView(v) // re-adding brings it to front, no-op if already attached
    v.setBounds(this.bounds)
  }

  nav(action: 'back' | 'forward' | 'reload' | 'home') {
    const wc = this.current && this.views.get(this.current)?.webContents
    if (!wc) return
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    else if (action === 'reload') wc.reload()
    else if (action === 'home') wc.loadURL(HOME_URL)
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
