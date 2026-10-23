import { BrowserWindow, app, dialog, ipcMain, net, protocol, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { basename, extname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseTags } from '../shared/logic'
import { AccountView, Bounds, LogEntry, SessionState, Settings, VideoInfo } from '../shared/types'
import { Browse, configureSession, sessionState } from './browse'
import { Queue } from './queue'
import { Store } from './store'
import { uploadVideo } from './uploader'

const VIDEO_EXT = ['.mp4', '.mov', '.webm', '.avi']
const DEV = !app.isPackaged

// Tests may point userData at a temp folder and the uploader at a mock page (dev builds only).
if (DEV && process.env.STACKTOK_USER_DATA) app.setPath('userData', process.env.STACKTOK_USER_DATA)

protocol.registerSchemesAsPrivileged([{ scheme: 'stacktok-media', privileges: { stream: true, supportFetchAPI: true, standard: true, secure: true } }])

let win: BrowserWindow
let store: Store
let queue: Queue
let browse: Browse
const approvedVideos = new Set<string>() // only files the user picked/dropped can be previewed

// ---------- validation ----------
const isStr = (v: unknown, max = 500): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
function need(ok: boolean, msg: string): asserts ok {
  if (!ok) throw new Error(msg)
}

function videoInfo(path: unknown): VideoInfo {
  need(isStr(path, 1000) && isAbsolute(path), 'Некорректный путь к файлу.')
  need(VIDEO_EXT.includes(extname(path).toLowerCase()), `Неподдерживаемый формат. Допустимо: ${VIDEO_EXT.join(', ')}.`)
  let st
  try { st = statSync(path) } catch { throw new Error('Файл не существует или недоступен.') }
  need(st.isFile(), 'Это не файл.')
  need(st.size > 0, 'Файл пуст.')
  approvedVideos.add(path)
  return { path, name: basename(path), size: st.size }
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
  return {
    accounts, presets: d.presets, templates: d.templates, tasks: d.tasks, settings: d.settings,
    activeAccountId: d.activeAccountId, overdue: queue.overdueIds(), summary: queue.summary(),
    logs: queue.logs as LogEntry[], version: app.getVersion(), dataPath: app.getPath('userData')
  }
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
    const acc = { id: randomUUID(), label: a.label.trim(), verified: false, defaultPresetIds: [], createdAt: Date.now() }
    store.data.accounts.push(acc)
    watchSession(acc.id)
    select(acc.id)
    return acc.id
  },
  'account:select': (a: { id: string }) => select(account(a?.id).id),
  'account:rename': (a: { id: string; label: string }) => {
    need(isStr(a?.label, 60), 'Enter a name.')
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
  'account:presets': (a: { id: string; presetIds: string[] }) => {
    account(a?.id).defaultPresetIds = Array.isArray(a.presetIds) ? a.presetIds.filter((x) => typeof x === 'string') : []
    store.save(); push()
  },
  // Removing keeps the stored browser profile unless `wipe` is explicitly set.
  'account:remove': async (a: { id: string; wipe?: boolean }) => {
    const acc = account(a?.id)
    queue.dropAccount(acc.id)
    if (a.wipe === true) await browse.wipe(acc.id)
    else browse.destroy(acc.id)
    store.data.accounts = store.data.accounts.filter((x) => x.id !== acc.id)
    if (store.data.activeAccountId === acc.id) select(store.data.accounts[0]?.id)
    store.save(); push()
  },
  'account:wipe': async (a: { id: string }) => {
    await browse.wipe(account(a?.id).id)
    const acc = account(a.id)
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

  'video:pick': async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Видео', extensions: VIDEO_EXT.map((e) => e.slice(1)) }] })
    return r.canceled ? null : videoInfo(r.filePaths[0])
  },
  'video:info': (a: { path: string }) => videoInfo(a?.path),

  'preset:save': (p: { id?: string; name: string; tags: string[] }) => {
    need(isStr(p?.name, 40) && Array.isArray(p.tags), 'Invalid preset.')
    const tags = parseTags(p.tags.filter((t) => isStr(t, 60)).join(' '))
    const ex = store.data.presets.find((x) => x.id === p.id)
    if (ex) Object.assign(ex, { name: p.name.trim(), tags })
    else store.data.presets.push({ id: randomUUID(), name: p.name.trim(), tags })
    store.save(); push()
  },
  'preset:delete': (a: { id: string }) => {
    store.data.presets = store.data.presets.filter((p) => p.id !== a?.id)
    for (const acc of store.data.accounts) acc.defaultPresetIds = acc.defaultPresetIds.filter((x) => x !== a.id)
    store.data.settings.defaultPresetIds = store.data.settings.defaultPresetIds.filter((x) => x !== a.id)
    store.save(); push()
  },
  'template:save': (t: { id?: string; name: string; text: string }) => {
    need(isStr(t?.name, 40) && typeof t.text === 'string' && t.text.length <= 2200, 'Invalid template.')
    const ex = store.data.templates.find((x) => x.id === t.id)
    if (ex) Object.assign(ex, { name: t.name.trim(), text: t.text })
    else store.data.templates.push({ id: randomUUID(), name: t.name.trim(), text: t.text })
    store.save(); push()
  },
  'template:delete': (a: { id: string }) => {
    store.data.templates = store.data.templates.filter((t) => t.id !== a?.id)
    store.save(); push()
  },

  'task:create': (a: { videoPath: string; items: { accountId: string; caption: string }[]; mode: 'now' | 'schedule' | 'draft'; scheduledAt?: number }) => {
    const v = videoInfo(a?.videoPath)
    need(['now', 'schedule', 'draft'].includes(a.mode), 'Bad mode.')
    need(Array.isArray(a.items) && a.items.length > 0, 'Выберите хотя бы один аккаунт.')
    const items = a.items.map((i) => {
      const acc = account(i.accountId)
      need(typeof i.caption === 'string' && i.caption.length <= 2200, 'Описание слишком длинное (максимум 2200).')
      return { accountId: acc.id, videoPath: v.path, caption: i.caption }
    })
    return queue.create(items, a.mode, a.scheduledAt).map((t) => t.id)
  },
  'task:start': (a: { id: string }) => queue.start(a?.id),
  'task:runNow': (a: { id: string }) => queue.runNow(a?.id),
  'task:cancel': (a: { id: string }) => queue.cancel(a?.id),
  'task:retry': (a: { id: string }) => queue.retry(a?.id),
  'task:markPublished': (a: { id: string }) => queue.markPublished(a?.id),
  'task:clear': () => queue.clearFinished(),

  'settings:set': (s: Partial<Settings>) => {
    const cur = store.data.settings
    if (typeof s?.concurrency === 'number') cur.concurrency = Math.min(3, Math.max(1, Math.round(s.concurrency)))
    if (typeof s?.autoRun === 'boolean') cur.autoRun = s.autoRun
    if (typeof s?.showAutomationWindow === 'boolean') cur.showAutomationWindow = s.showAutomationWindow
    if (Array.isArray(s?.defaultPresetIds)) cur.defaultPresetIds = s.defaultPresetIds.filter((x) => typeof x === 'string')
    store.save(); push()
  },
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
    width: 1280, height: 820, minWidth: 980, minHeight: 600,
    backgroundColor: '#0b0b0d', title: 'StackTok', icon: join(__dirname, '../../build/icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0b0b0d', symbolColor: '#a1a1aa', height: 36 },
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  const wc = win.webContents
  wc.on('will-navigate', (e, url) => { if (!url.startsWith(process.env.ELECTRON_RENDERER_URL ?? 'file://')) e.preventDefault() })
  wc.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' } })
  if (!DEV) {
    wc.session.webRequest.onHeadersReceived((d, cb) => cb({
      responseHeaders: { ...d.responseHeaders, 'Content-Security-Policy': ["default-src 'self'; img-src 'self' data: https:; media-src stacktok-media:; style-src 'self' 'unsafe-inline'"] }
    }))
  }
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
  win.on('closed', () => app.quit())
  browse = new Browse(win)
  wc.once('did-finish-load', () => browse.show(store.data.activeAccountId))
}

app.whenReady().then(() => {
  protocol.handle('stacktok-media', (req) => {
    const p = decodeURIComponent(new URL(req.url).pathname.slice(1))
    if (!approvedVideos.has(p)) return new Response('Forbidden', { status: 403 })
    return net.fetch(pathToFileURL(p).toString(), { headers: req.headers })
  })
  store = new Store(join(app.getPath('userData'), 'stacktok.json'))
  queue = new Queue(
    store,
    (task, hooks) =>
      uploadVideo(task.accountId, task.videoPath, task.caption, {
        ...hooks,
        show: store.data.settings.showAutomationWindow,
        uploadUrl: DEV ? process.env.STACKTOK_UPLOAD_URL : undefined,
        timeoutMs: DEV ? Number(process.env.STACKTOK_UPLOAD_TIMEOUT) || undefined : undefined
      }),
    push
  )
  registerIpc()
  store.data.accounts.forEach((a) => watchSession(a.id))
  createWindow()
  queue.startScheduler(DEV && Number(process.env.STACKTOK_TICK_MS) || undefined)
})

app.on('before-quit', () => { queue?.stopScheduler(); store?.flush() })
app.on('window-all-closed', () => app.quit())
