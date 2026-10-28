import { BrowserWindow, WebContentsView, app, session, shell } from 'electron'
import { Bounds } from '../shared/types'

// Dev builds can point at a mock site for tests; packaged builds always use the real one.
export const DOWNLOADER_URL = (!app.isPackaged && process.env.STACKTOK_DOWNLOADER_URL) || 'https://tikdownloader.io/ru'
// No "persist:": cookies and cache live in memory only and are shared with no TikTok account.
const PARTITION = 'downloader'

const isHttp = (url: string) => /^https?:\/\//i.test(url)

/** The third-party downloader site in its own sandboxed view: no preload, no permissions, no link to any account. */
export class Downloader {
  private view?: WebContentsView

  constructor(private win: BrowserWindow) {}

  private create(): WebContentsView {
    const ses = session.fromPartition(PARTITION)
    ses.setUserAgent(app.userAgentFallback.replace(/\s(Electron|stacktok)\/\S+/gi, ''))
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    ses.setPermissionCheckHandler(() => false)
    const v = new WebContentsView({
      webPreferences: { partition: PARTITION, contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'document-user-activation-required' }
    })
    const wc = v.webContents
    wc.setWindowOpenHandler(() => ({ action: 'deny' })) // ad pop-ups never open
    wc.on('will-navigate', (e, url) => { if (!isHttp(url)) e.preventDefault() })
    v.setBorderRadius(18)
    wc.loadURL(DOWNLOADER_URL).catch(() => {})
    return v
  }

  setBounds(b: Bounds | null) {
    if (!b) {
      if (!this.view) return
      this.win.contentView.removeChildView(this.view)
      this.view.webContents.setAudioMuted(true)
      return
    }
    this.view ??= this.create()
    this.view.webContents.setAudioMuted(false)
    this.win.contentView.addChildView(this.view) // re-adding brings it to front, no-op if already attached
    this.view.setBounds(b)
  }

  nav(action: 'back' | 'forward' | 'reload' | 'home') {
    const wc = this.view?.webContents
    if (!wc) return
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
    else if (action === 'reload') wc.reload()
    else if (action === 'home') wc.loadURL(DOWNLOADER_URL).catch(() => {})
  }

  openExternal() {
    const url = this.view?.webContents.getURL()
    shell.openExternal(url && isHttp(url) ? url : DOWNLOADER_URL)
  }
}
