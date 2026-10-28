import { BrowserWindow, dialog } from 'electron'
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { Settings } from '../shared/types'

const MAX_IMAGE = 2 * 1024 * 1024
const GRADIENTS: Record<string, string> = {
  aurora: 'linear-gradient(135deg,#2f5bff,#8a3dff 55%,#00c2c7)',
  sunset: 'linear-gradient(135deg,#ff5a7a,#ff9a3d 55%,#8d3dff)',
  ocean: 'linear-gradient(135deg,#0a84ff,#00c2c7 55%,#3d5bff)',
  graphite: 'linear-gradient(135deg,#4b5160,#2a2f3b 55%,#646c80)'
}

/** Hides who and what is written until the mouse is over it (handy for screen sharing); styling only, nothing is read. */
const PRIVACY = `
[data-e2e='dm-new-conversation-avatar'], [data-e2e='dm-new-conversation-nickname'], [data-e2e='dm-new-conversation-nickname'] ~ p,
[data-e2e='top-chat-avatar'], [data-e2e='dm-new-chat-nickname'], [data-e2e='chat-uniqueid'],
[data-e2e='chat-avatar'], [data-e2e='dm-new-message-text'], [data-e2e='dm-new-shared-video'] { filter: blur(7px); transition: filter 0.2s; }
[data-e2e='dm-new-conversation-item']:hover [data-e2e='dm-new-conversation-avatar'], [data-e2e='dm-new-conversation-item']:hover [data-e2e='dm-new-conversation-nickname'], [data-e2e='dm-new-conversation-item']:hover [data-e2e='dm-new-conversation-nickname'] ~ p,
[data-e2e='dm-new-chatbox'] > div:first-child:hover *, [data-e2e='dm-new-chat-item']:hover [data-e2e='chat-avatar'], [data-e2e='dm-new-chat-item']:hover [data-e2e='dm-new-message-text'], [data-e2e='dm-new-chat-item']:hover [data-e2e='dm-new-shared-video'] { filter: none; }
`

/** Image type by file signature, not by name. */
function sniff(b: Buffer): string | undefined {
  if (b.length > 12 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'image/png'
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp'
}

/**
 * Glass styling and wallpaper for TikTok's messages page, injected with insertCSS only (no scripts, no preload).
 * Selectors: data-e2e hooks of the messages page plus their position (see «Справочник DOM чатов TikTok» in AGENTS.md).
 * If TikTok changes the markup a rule just stops matching; the page keeps working.
 */
export class ChatOverlay {
  private views = new Set<Electron.WebContents>()
  private keys = new Map<Electron.WebContents, string>()
  private queue = new WeakMap<Electron.WebContents, Promise<void>>()
  private image?: string // data: URL of the picked file, read lazily

  constructor(private settings: () => Settings, private file: string, private devOrigin?: string) {}

  attach(wc: Electron.WebContents) {
    this.views.add(wc)
    const run = () => this.apply(wc)
    wc.on('dom-ready', run)
    wc.on('did-navigate', run)
    wc.on('did-navigate-in-page', run) // TikTok is a single-page app: moving to /messages is not a full load
    wc.once('destroyed', () => { this.views.delete(wc); this.keys.delete(wc) })
  }

  refresh() {
    this.views.forEach((wc) => this.apply(wc))
  }

  hasImage(): boolean {
    return existsSync(this.file)
  }

  clearImage() {
    this.image = undefined
    rmSync(this.file, { force: true })
    this.refresh()
  }

  /** Asks for a file, checks its type and size, keeps it in userData. Returns false if the user cancelled. */
  async pick(win: BrowserWindow): Promise<boolean> {
    const r = await dialog.showOpenDialog(win, {
      title: 'Обои чатов', properties: ['openFile'], filters: [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    })
    const path = r.filePaths[0]
    if (r.canceled || !path) return false
    const size = statSync(path).size
    if (size === 0 || size > MAX_IMAGE) throw new Error('Картинка должна быть не больше 2 МБ.')
    const buf = readFileSync(path)
    const mime = sniff(buf)
    if (!mime) throw new Error('Подойдут только PNG, JPG и WebP.')
    this.image = `data:${mime};base64,${buf.toString('base64')}`
    writeFileSync(this.file, this.image)
    this.refresh()
    return true
  }

  private onMessages(url: string): boolean {
    try {
      const u = new URL(url)
      const host = u.hostname === 'tiktok.com' || u.hostname.endsWith('.tiktok.com')
      if (!(u.protocol === 'https:' && host) && u.origin !== this.devOrigin) return false
      return /^\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?messages(?:\/|$)/.test(u.pathname)
    } catch {
      return false
    }
  }

  private wallpaper(): string | undefined {
    const w = this.settings().chatWallpaper
    if (w === 'custom') {
      this.image ??= existsSync(this.file) ? readFileSync(this.file, 'utf8') : undefined
      return this.image && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(this.image) ? `url("${this.image}")` : undefined
    }
    return GRADIENTS[w]
  }

  private css(): string {
    const wp = this.wallpaper()
    const st = this.settings()
    // Panels are told apart by their position relative to the data-e2e hooks (checked on a real account, 2026-10-28).
    // A backdrop-filter must never sit on the fixed side-nav container: it would trap the fixed drawer inside it.
    const nav = ":is(div):has(> div > div > [data-e2e='nav-search'])"
    const drawer = ":is(div):has(> div > div > div > div > div > [data-e2e='dm-new-conversation-list'])"
    const blur = '-webkit-backdrop-filter: blur(26px) saturate(170%); backdrop-filter: blur(26px) saturate(170%);'
    return `
html { --so-dim: ${(st.chatDim / 100).toFixed(2)}; --so-scrim: rgba(6, 8, 16, var(--so-dim)); --so-base: #0b0d17; --so-glass: rgba(14, 16, 28, 0.4); --so-line: rgba(255, 255, 255, 0.14); --so-hover: rgba(255, 255, 255, 0.1); }
html[data-theme='light'] { --so-scrim: rgba(255, 255, 255, var(--so-dim)); --so-base: #eef0f8; --so-glass: rgba(255, 255, 255, 0.5); --so-line: rgba(20, 22, 31, 0.12); --so-hover: rgba(20, 22, 31, 0.07); }
html::before { content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none; background: linear-gradient(var(--so-scrim), var(--so-scrim)), ${wp ? wp + ' center / cover no-repeat' : 'var(--so-base)'}; }
body, #app, #main-content-messages, div:has(> #main-content-messages), div:has([data-e2e='nav-search']), div:has([data-e2e='dm-new-conversation-list']), [data-e2e='dm-new-conversation-list'] { background: transparent !important; }
${nav} > div:empty { background: transparent !important; }
${nav} { background: var(--so-glass) !important; }
${drawer}, [data-e2e='dm-new-chatbox'] { background: var(--so-glass) !important; ${blur} }
${drawer} { border-right: 1px solid var(--so-line) !important; }
${drawer} div:has(> div > h2) { background-image: none !important; }
[data-e2e='dm-new-conversation-item'] { border-radius: 16px; transition: background 0.2s; }
[data-e2e='dm-new-conversation-item']:hover { background: var(--so-hover) !important; }
[data-e2e='dm-new-chatbox'] *, [data-e2e='dm-new-conversation-list'] * { font-family: 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif !important; }
[data-e2e='dm-new-chatbox'] > div:first-child { border-bottom: 1px solid var(--so-line); }
[data-e2e='dm-new-chat-bottom'] { border-top: 1px solid var(--so-line); }
[data-e2e='dm-new-message-text'] { border-radius: 18px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.18); }
[data-e2e='dm-new-shared-video'] { border-radius: 16px; overflow: hidden; }
[data-e2e='message-input-area'] { border-radius: 22px; border: 1px solid var(--so-line); -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px); }
${st.chatTextSize === 'normal' ? '' : `[data-e2e='dm-new-message-text'] p { font-size: ${st.chatTextSize === 'small' ? 12 : 16}px !important; }`}
${st.chatPrivacy ? PRIVACY : ''}
`
  }

  /** Serialised per view: removes what was injected before and injects again only on the messages page. */
  private apply(wc: Electron.WebContents) {
    const run = async () => {
      if (wc.isDestroyed()) return
      const old = this.keys.get(wc)
      if (old) { this.keys.delete(wc); await wc.removeInsertedCSS(old).catch(() => {}) }
      if (!this.settings().chatOverlay || !this.onMessages(wc.getURL())) return
      try { this.keys.set(wc, await wc.insertCSS(this.css())) } catch { /* page went away */ }
    }
    this.queue.set(wc, (this.queue.get(wc) ?? Promise.resolve()).then(run))
  }
}
