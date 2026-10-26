import { BrowserWindow, app, clipboard, ipcMain, nativeTheme, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { ACCENTS, AccountView, BACKGROUNDS, Bounds, SessionState, Settings, THEMES } from '../shared/types'
import { Browse, HOME_URL, configureSession, sessionState } from './browse'
import { RepostCleaner } from './reposts'
import { Store } from './store'

const DEV = !app.isPackaged

// Tests may point userData at a temp folder and the home page at a mock site (dev builds only).
if (DEV && process.env.STACKTOK_USER_DATA) app.setPath('userData', process.env.STACKTOK_USER_DATA)

let win: BrowserWindow
let store: Store
let browse: Browse
let cleaner: RepostCleaner | undefined // at most one repost cleanup at a time

// ---------- validation ----------
const isStr = (v: unknown, max = 500): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max
function need(ok: boolean, msg: string): asserts ok {
  if (!ok) throw new Error(msg)
}

// ---------- state push ----------
// Login state is cached and refreshed the moment a session cookie changes, so every push is synchronous.
const sessions = new Map<string, SessionState>()
const watched = new Set<string>()
async function refreshSession(id: string) {
  const next = await sessionState(id)
  if (sessions.get(id) !== next) { sessions.set(id, next); push() }
}
function watchSession(id: string) {
  if (watched.has(id)) return
  watched.add(id)
  configureSession(id).cookies.on('changed', (_e, c) => { if (c.name === 'sessionid') refreshSession(id) })
  refreshSession(id)
}

function snapshot() {
  const d = store.data
  const accounts: AccountView[] = d.accounts.map((a) => ({ ...a, session: sessions.get(a.id) ?? 'unknown' }))
  return { accounts, job: cleaner?.job ?? null, settings: d.settings, activeAccountId: d.activeAccountId, version: app.getVersion(), dataPath: app.getPath('userData') }
}

let pushing = false
function push() {
  if (pushing || !win || win.isDestroyed()) return
  pushing = true
  queueMicrotask(() => { // coalesces bursts of changes into one immediate update
    pushing = false
    if (!win.isDestroyed()) win.webContents.send('stacktok:state', snapshot())
  })
}

function account(id: unknown) {
  const a = store.data.accounts.find((x) => x.id === id)
  if (!a) throw new Error('Неизвестный аккаунт.')
  return a
}

// Keeps the native window buttons readable on both themes.
function applyOverlay() {
  const dark = store.data.settings.theme === 'system' ? nativeTheme.shouldUseDarkColors : store.data.settings.theme === 'dark'
  if (win && !win.isDestroyed()) win.setTitleBarOverlay({ color: '#00000000', symbolColor: dark ? '#c9cbd6' : '#2a2d3a', height: 44 })
}

// "Чистое" background: a see-through window (Windows 11 acrylic) so the glass shows the real desktop behind it.
function applyBackground() {
  if (!win || win.isDestroyed()) return
  const clear = store.data.settings.background === 'clear'
  win.setBackgroundMaterial(clear ? 'acrylic' : 'none')
  win.setBackgroundColor(clear ? '#00000000' : '#0a0c16')
}

function select(id: string | undefined) {
  store.data.activeAccountId = id
  browse.show(id)
  store.save()
  push()
}

// ---------- IPC ----------
type Handler = (arg: any) => unknown | Promise<unknown>
const handlers: Record<string, Handler> = {
  'state:get': () => snapshot(),

  'account:add': (a: { label: string }) => {
    need(isStr(a?.label, 60), 'Введите название.')
    const acc = { id: randomUUID(), label: a.label.trim(), verified: false, createdAt: Date.now() }
    store.data.accounts.push(acc)
    watchSession(acc.id)
    select(acc.id)
    return acc.id
  },
  'account:select': (a: { id: string }) => select(account(a?.id).id),
  'account:rename': (a: { id: string; label: string }) => {
    need(isStr(a?.label, 60), 'Введите название.')
    account(a.id).label = a.label.trim()
    store.save(); push()
  },
  'account:detect': (a: { id: string }) => browse.detectIdentity(account(a?.id).id),
  // The user confirms which TikTok account this session belongs to; we never assume it.
  'account:confirm': (a: { id: string; username?: string; avatar?: string }) => {
    const acc = account(a?.id)
    acc.username = typeof a.username === 'string' ? a.username.replace(/^@/, '').slice(0, 60) || undefined : undefined
    acc.avatar = typeof a.avatar === 'string' && /^https:\/\//.test(a.avatar) ? a.avatar : acc.avatar
    acc.verified = true
    store.save(); push()
  },
  // Removing keeps the stored browser profile unless `wipe` is explicitly set.
  'account:remove': async (a: { id: string; wipe?: boolean }) => {
    const acc = account(a?.id)
    if (cleaner?.job.accountId === acc.id) cleaner.stop()
    if (a.wipe === true) await browse.wipe(acc.id)
    else browse.destroy(acc.id)
    store.data.accounts = store.data.accounts.filter((x) => x.id !== acc.id)
    if (store.data.activeAccountId === acc.id) select(store.data.accounts[0]?.id)
    store.save(); push()
  },
  'account:wipe': async (a: { id: string }) => {
    const acc = account(a?.id)
    await browse.wipe(acc.id)
    acc.verified = false
    store.save(); push()
  },
  'account:devtools': () => browse.devtools(),

  'browse:bounds': (b: Bounds | null) => {
    const ok = b && [b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n))
    browse.setBounds(ok ? { x: Math.round(b!.x), y: Math.round(b!.y), width: Math.max(0, Math.round(b!.width)), height: Math.max(0, Math.round(b!.height)) } : null)
  },
  'browse:nav': (a: 'back' | 'forward' | 'reload' | 'home') => {
    need(['back', 'forward', 'reload', 'home'].includes(a), 'Bad action.')
    browse.nav(a)
  },
  'browse:external': () => browse.openExternal(),
  'browse:muted': () => browse.isMuted(),
  'browse:toggleMute': () => browse.toggleMute(),

  'settings:set': (s: Partial<Settings>) => {
    const cur = store.data.settings
    if (THEMES.includes(s?.theme as any)) cur.theme = s.theme!
    if (ACCENTS.includes(s?.accent as any)) cur.accent = s.accent!
    if (BACKGROUNDS.includes(s?.background as any)) cur.background = s.background!
    if (typeof s?.glass === 'number' && Number.isFinite(s.glass)) cur.glass = Math.min(100, Math.max(0, Math.round(s.glass)))
    if (typeof s?.restoreLast === 'boolean') cur.restoreLast = s.restoreLast
    if (typeof s?.muteByDefault === 'boolean') cur.muteByDefault = s.muteByDefault
    applyOverlay()
    applyBackground()
    store.save(); push()
  },
  // Removes the account's own reposts through the website. Needs a confirmed username so the right profile is opened.
  'reposts:start': (a: { id: string; like?: boolean }) => {
    const acc = account(a?.id)
    need(!cleaner || cleaner.job.status === 'done' || cleaner.job.status === 'stopped', 'Очистка репостов уже идёт.')
    need(acc.verified && !!acc.username, 'Сначала подтвердите аккаунт на вкладке «Обзор».')
    select(acc.id) // the cleanup runs in the Browse view of this account, the page the user sees
    cleaner = new RepostCleaner(
      acc.id, acc.username!, new URL(HOME_URL).origin, browse.contents(acc.id), () => browse.isOnScreen(acc.id), push,
      a.like === true, DEV && !!process.env.STACKTOK_FAST, DEV && Number(process.env.STACKTOK_MAX_REPOSTS) || undefined
    )
    void cleaner.run()
    push()
  },
  'reposts:stop': () => { cleaner?.stop(); if (cleaner && cleaner.job.status !== 'done') { cleaner.job.status = 'stopped'; cleaner.job.message = 'Остановлено.' } push() },
  'reposts:copyDebug': () => { if (cleaner?.debug) clipboard.writeText(cleaner.debug); return !!cleaner?.debug },
  'reposts:resume': () => cleaner?.resume(),
  'reposts:dismiss': () => { if (cleaner && cleaner.job.status !== 'running' && cleaner.job.status !== 'paused') cleaner = undefined; push() },
  'data:open': () => shell.openPath(app.getPath('userData'))
}

function registerIpc() {
  for (const [name, fn] of Object.entries(handlers)) {
    ipcMain.handle('stacktok:' + name, async (e, arg) => {
      if (e.sender !== win.webContents) throw new Error('Forbidden sender.') // only our own UI may call
      try { return { ok: true, value: await fn(arg) } } catch (err) { return { ok: false, error: (err as Error).message } }
    })
  }
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 980, minHeight: 620,
    backgroundColor: store.data.settings.background === 'clear' ? '#00000000' : '#0a0c16', title: 'StackTok', icon: join(__dirname, '../../build/icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#c9cbd6', height: 44 },
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  const wc = win.webContents
  wc.on('will-navigate', (e, url) => { if (!url.startsWith(process.env.ELECTRON_RENDERER_URL ?? 'file://')) e.preventDefault() })
  wc.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' } })
  if (!DEV) {
    wc.session.webRequest.onHeadersReceived((d, cb) => cb({
      responseHeaders: { ...d.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'"] }
    }))
  }
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  win.on('closed', () => app.quit())
  browse = new Browse(win, () => store.data.settings.muteByDefault)
  wc.once('did-finish-load', () => { browse.show(store.data.activeAccountId); applyOverlay(); applyBackground() })
  nativeTheme.on('updated', applyOverlay)
}

app.whenReady().then(() => {
  store = new Store(join(app.getPath('userData'), 'stacktok.json'))
  registerIpc()
  store.data.accounts.forEach((a) => watchSession(a.id))
  createWindow()
})

app.on('before-quit', () => store?.flush())
app.on('window-all-closed', () => app.quit())
