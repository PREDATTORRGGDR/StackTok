import { BrowserWindow, app, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { ACCENTS, AccountView, BACKGROUNDS, Bounds, CHAT_TEXT_SIZES, CHAT_WALLPAPERS, ChatExportProgress, cleanRange, GLASS_MATERIALS, HEX, Job, OPEN_IN, PSY_PRESETS, PSY_PRESET_INFO, PsyJob, SWEEP_KINDS, SessionState, Settings, SweepJob, SweepKind, THEMES } from '../shared/types'
import { accountProfile, accountReposts, accountVideos, stopCounting } from './account-stats-run'
import { AVATAR_EVERY, AVATAR_SWEEP, pickAvatar } from './avatars'
import { Browse, HOME_URL, accountPage, configureSession, sessionState, startUrl } from './browse'
import { ChatDump, renderChatHtml } from './chat-export-html'
import { chatInfo, collectChat, embedMedia } from './chat-export'
import { ChatOverlay } from './chat-overlay'
import type { RepostCleaner } from './repost-cleaner'
import { findReposts } from './reposts'
import { Sweeper, cleanChoice, linkOf, pick } from './sweep'
import { findSweep } from './sweep-run'
import { parseHandle, profileOf } from './psycho'
import { KeyBox, runPortrait } from './psycho-run'
import { Downloader } from './downloader'
import { Store } from './store'

const DEV = !app.isPackaged

// Tests may point userData at a temp folder and the home page at a mock site (dev builds only).
if (DEV && process.env.STACKTOK_USER_DATA) app.setPath('userData', process.env.STACKTOK_USER_DATA)

let win: BrowserWindow
let store: Store
let browse: Browse
let overlay: ChatOverlay
let downloader: Downloader
let notice: { id: number; text: string } | null = null // one-off message for the UI, shown as a toast
let chatExport: { progress: ChatExportProgress; cancelled: boolean } | null = null // the running chat export, if any
let reposts: { job: Job; cleaner?: RepostCleaner; stop: boolean } | null = null // at most one repost cleanup at a time
let sweep: { job: SweepJob; sweeper?: Sweeper; stop: boolean } | null = null // at most one cleanup of likes, favorites or following at a time
let psy: { job: PsyJob; stop: boolean } | null = null // at most one repost portrait at a time
let keybox: KeyBox

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
  if (sessions.get(id) !== next) {
    sessions.set(id, next)
    push()
    if (next === 'logged_in') refreshAvatar(id)
  }
}
// One plain page request per account (no rendering), at most every AVATAR_EVERY: at start, on opening the account and once an hour.
const avatarAt = new Map<string, number>()
async function refreshAvatar(id: string | undefined) {
  const acc = store.data.accounts.find((x) => x.id === id)
  if (!acc?.verified || sessions.get(acc.id) !== 'logged_in' || Date.now() - (avatarAt.get(acc.id) ?? 0) < AVATAR_EVERY) return
  avatarAt.set(acc.id, Date.now())
  const avatar = pickAvatar(await accountPage(acc.id), acc.username)
  if (avatar && avatar !== acc.avatar) { acc.avatar = avatar; store.save(); push() }
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
  return { accounts, settings: d.settings, notice, chatExport: chatExport?.progress ?? null, job: reposts?.job ?? null, sweep: sweep?.job ?? null, psy: psy?.job ?? null, hasPsyKey: keybox?.has() ?? false, activeAccountId: d.activeAccountId, maximized: !!win && !win.isDestroyed() && win.isMaximized(), version: app.getVersion(), dataPath: app.getPath('userData') }
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

// "Чистое" background: a see-through window (Windows 11 acrylic) so the glass shows the real desktop behind it.
function applyBackground() {
  if (!win || win.isDestroyed()) return
  const clear = store.data.settings.background === 'clear'
  const light = store.data.settings.theme === 'light' || (store.data.settings.theme === 'system' && !nativeTheme.shouldUseDarkColors)
  win.setBackgroundMaterial(clear ? store.data.settings.glassMaterial : 'none')
  win.setBackgroundColor(clear ? '#00000000' : light ? '#e6ebf7' : '#0a0c16')
}

function select(id: string | undefined) {
  store.data.activeAccountId = id
  browse.show(id)
  store.save()
  push()
  refreshAvatar(id)
}

function stopReposts() {
  if (!reposts) return
  reposts.stop = true
  reposts.cleaner?.stop()
}

function stopSweep() {
  if (!sweep) return
  sweep.stop = true
  sweep.sweeper?.stop()
}

// ---------- IPC ----------
const toBounds = (b: Bounds | null): Bounds | null =>
  b && [b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n))
    ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) }
    : null
type Handler = (arg: any) => unknown | Promise<unknown>
const handlers: Record<string, Handler> = {
  'state:get': () => snapshot(),

  'account:add': (a: { label: string }) => {
    need(isStr(a?.label, 60), 'Введите название.')
    const acc = { id: randomUUID(), label: a.label.trim(), verified: false, openIn: 'studio' as const, createdAt: Date.now() }
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
  // The user opened the statistics window: read-only requests with the account's own session.
  'stats:profile': (a: { id: string }) => {
    const acc = account(a?.id)
    need(sessions.get(acc.id) === 'logged_in', 'Сначала войдите в этот аккаунт на вкладке «Обзор».')
    return accountProfile(acc.id, acc.verified ? acc.username : undefined)
  },
  'stats:reposts': (a: { id: string }) => {
    const acc = account(a?.id)
    need(sessions.get(acc.id) === 'logged_in', 'Сначала войдите в этот аккаунт на вкладке «Обзор».')
    return accountReposts(acc.id, acc.verified ? acc.username : undefined)
  },
  'stats:videos': (a: { id: string }) => {
    const acc = account(a?.id)
    need(sessions.get(acc.id) === 'logged_in', 'Сначала войдите в этот аккаунт на вкладке «Обзор».')
    return accountVideos(acc.id, acc.verified ? acc.username : undefined)
  },
  'stats:stop': (a: { id: string }) => stopCounting(account(a?.id).id),
  'account:detect': (a: { id: string }) => browse.detectIdentity(account(a?.id).id),
  // The user confirms which TikTok account this session belongs to; we never assume it.
  'account:confirm': (a: { id: string; username?: string; avatar?: string }) => {
    const acc = account(a?.id)
    acc.username = typeof a.username === 'string' ? a.username.replace(/^@/, '').slice(0, 60) || undefined : undefined
    acc.avatar = typeof a.avatar === 'string' && /^https:\/\//.test(a.avatar) ? a.avatar : acc.avatar
    acc.verified = true
    store.save(); push()
    refreshAvatar(acc.id)
  },
  // Removing keeps the stored browser profile unless `wipe` is explicitly set.
  'account:remove': async (a: { id: string; wipe?: boolean }) => {
    const acc = account(a?.id)
    if (reposts?.job.accountId === acc.id) stopReposts()
    if (sweep?.job.accountId === acc.id) stopSweep()
    if (psy?.job.accountId === acc.id) psy.stop = true
    if (a.wipe === true) await browse.wipe(acc.id)
    else browse.destroy(acc.id)
    store.data.accounts = store.data.accounts.filter((x) => x.id !== acc.id)
    if (store.data.activeAccountId === acc.id) select(store.data.accounts[0]?.id)
    store.save(); push()
  },
  'account:wipe': async (a: { id: string }) => {
    const acc = account(a?.id)
    if (reposts?.job.accountId === acc.id) stopReposts()
    if (sweep?.job.accountId === acc.id) stopSweep()
    if (psy?.job.accountId === acc.id) psy.stop = true
    await browse.wipe(acc.id)
    acc.verified = false
    store.save(); push()
  },
  'account:devtools': () => browse.devtools(),
  // Opens the account on its own start page (the user chose it on the Accounts page).
  'account:open': (a: { id: string }) => {
    const acc = account(a?.id)
    select(acc.id)
    browse.open(acc.id)
  },
  'account:chats': (a: { id: string }) => {
    const acc = account(a?.id)
    select(acc.id)
    browse.open(acc.id, startUrl('chats'))
  },
  // Toolbar shortcuts of the Browse page: Studio, own profile or messages, whatever the account's start page is.
  'account:page': (a: { id: string; value: string }) => {
    need(OPEN_IN.includes(a?.value as any), 'Bad value.')
    const acc = account(a.id)
    select(acc.id)
    browse.open(acc.id, startUrl(a.value as (typeof OPEN_IN)[number]))
  },
  'account:openIn': (a: { id: string; value: string }) => {
    need(OPEN_IN.includes(a?.value as any), 'Bad value.')
    account(a.id).openIn = a.value as (typeof OPEN_IN)[number]
    store.save(); push()
  },

  'browse:bounds': (b: Bounds | null) => browse.setBounds(toBounds(b)),
  'browse:nav': (a: 'back' | 'forward' | 'reload' | 'home') => {
    need(['back', 'forward', 'reload', 'home'].includes(a), 'Bad action.')
    browse.nav(a)
  },
  'browse:external': () => browse.openExternal(),
  // Which profile is open in the account's view right now (null on any other page): the «Запустить анализ» button works on it.
  'browse:profile': (a: { id: string }) => profileOf(browse.url(account(a?.id).id), DEV ? new URL(HOME_URL).origin : undefined) ?? null,
  'browse:muted': () => browse.isMuted(),
  'browse:toggleMute': () => browse.toggleMute(),

  'downloader:bounds': (b: Bounds | null) => downloader.setBounds(toBounds(b)),
  'downloader:nav': (a: 'back' | 'forward' | 'reload' | 'home') => {
    need(['back', 'forward', 'reload', 'home'].includes(a), 'Bad action.')
    downloader.nav(a)
  },
  'downloader:external': () => downloader.openExternal(),

  'settings:set': (s: Partial<Settings>) => {
    const cur = store.data.settings
    if (THEMES.includes(s?.theme as any)) cur.theme = s.theme!
    if (ACCENTS.includes(s?.accent as any)) cur.accent = s.accent!
    if (typeof s?.accentColor === 'string' && (s.accentColor === '' || HEX.test(s.accentColor))) cur.accentColor = s.accentColor.toLowerCase()
    if (BACKGROUNDS.includes(s?.background as any)) cur.background = s.background!
    if (Array.isArray(s?.bgCustom) && s.bgCustom.length === 3 && s.bgCustom.every((c) => typeof c === 'string' && HEX.test(c))) cur.bgCustom = s.bgCustom.map((c) => c.toLowerCase()) as [string, string, string]
    if (GLASS_MATERIALS.includes(s?.glassMaterial as any)) cur.glassMaterial = s.glassMaterial!
    if (typeof s?.motion === 'boolean') cur.motion = s.motion
    if (typeof s?.glass === 'number' && Number.isFinite(s.glass)) cur.glass = Math.min(100, Math.max(0, Math.round(s.glass)))
    if (typeof s?.panelOpacity === 'number' && Number.isFinite(s.panelOpacity)) cur.panelOpacity = Math.min(100, Math.max(0, Math.round(s.panelOpacity)))
    if (typeof s?.barOpacity === 'number' && Number.isFinite(s.barOpacity)) cur.barOpacity = Math.min(100, Math.max(0, Math.round(s.barOpacity)))
    if (typeof s?.popOpacity === 'number' && Number.isFinite(s.popOpacity)) cur.popOpacity = Math.min(100, Math.max(20, Math.round(s.popOpacity)))
    if (typeof s?.restoreLast === 'boolean') cur.restoreLast = s.restoreLast
    if (typeof s?.muteByDefault === 'boolean') cur.muteByDefault = s.muteByDefault
    if (typeof s?.chatOverlay === 'boolean') cur.chatOverlay = s.chatOverlay
    if (typeof s?.chatPrivacy === 'boolean') cur.chatPrivacy = s.chatPrivacy
    if (typeof s?.chatDim === 'number' && Number.isFinite(s.chatDim)) cur.chatDim = Math.min(100, Math.max(0, Math.round(s.chatDim)))
    if (CHAT_TEXT_SIZES.includes(s?.chatTextSize as any)) cur.chatTextSize = s.chatTextSize!
    if (PSY_PRESETS.includes(s?.psyPreset as any)) cur.psyPreset = s.psyPreset!
    if (typeof s?.psyBase === 'string' && s.psyBase.length <= 200) cur.psyBase = s.psyBase.trim()
    if (typeof s?.psyVision === 'string' && s.psyVision.length <= 100) cur.psyVision = s.psyVision.trim()
    if (typeof s?.psySynth === 'string' && s.psySynth.length <= 100) cur.psySynth = s.psySynth.trim()
    if (CHAT_WALLPAPERS.includes(s?.chatWallpaper as any) && (s.chatWallpaper !== 'custom' || overlay.hasImage())) cur.chatWallpaper = s.chatWallpaper!
    applyBackground()
    overlay.refresh()
    store.save(); push()
  },
  // The picked image is validated and kept in main; the UI only learns that 'custom' is set.
  'chat:wallpaperPick': async () => {
    if (!(await overlay.pick(win))) return false
    store.data.settings.chatWallpaper = 'custom'
    store.save(); push()
    return true
  },
  'chat:wallpaperReset': () => {
    overlay.clearImage()
    store.data.settings.chatWallpaper = 'none'
    store.save(); push()
  },
  // The user asked for this export: reads the chat that is open in the active account's view and writes one HTML file where they choose.
  'chat:export': async (a?: { range?: unknown }) => {
    need(!chatExport, 'Экспорт уже идёт.')
    const range = cleanRange(a?.range)
    const acc = account(store.data.activeAccountId)
    const target = browse.chatTarget(acc.id)
    if (!target) throw new Error('Откройте чат этого аккаунта на вкладке «Обзор».')
    const info = await chatInfo(target.wc)
    const stamp = new Date().toISOString().slice(0, 10)
    const base = `TikTok-чат-${(info.name || info.handle || 'диалог').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 60)}-${stamp}.html`
    const devPath = DEV ? process.env.STACKTOK_EXPORT_PATH : undefined
    const path = devPath || (await dialog.showSaveDialog(win, { title: 'Экспорт чата', defaultPath: join(app.getPath('downloads'), base), filters: [{ name: 'HTML-страница', extensions: ['html'] }] })).filePath
    if (!path) return null
    const job = { progress: { phase: 'loading', done: 0 } as ChatExportProgress, cancelled: false }
    chatExport = job
    let lastPush = 0
    const ctl = {
      cancelled: () => job.cancelled,
      progress: (p: ChatExportProgress) => { // media finish by the thousand: the UI needs a few updates a second, not one per file
        const now = Date.now()
        const changed = p.phase !== job.progress.phase
        job.progress = p
        if (changed || now - lastPush >= 120) { lastPush = now; push() }
      }
    }
    target.hold()
    push()
    try {
      const got = await collectChat(target.wc, ctl, range)
      const dump: ChatDump = {
        ...got, exportedAt: Date.now(), appVersion: app.getVersion(),
        owner: { name: acc.label, handle: acc.username, avatar: acc.avatar ? { kind: 'image', src: acc.avatar } : undefined }
      }
      const folder = `${basename(path).replace(/\.html?$/i, '')}_files`
      const media = await embedMedia(dump, target.ses, ctl, { dir: join(dirname(path), folder), folder, devOrigin: DEV ? new URL(HOME_URL).origin : undefined })
      if (media.files) dump.filesFolder = folder
      if (media.failed) dump.warnings.push(`Не удалось сохранить вложений: ${media.failed}. В файле на их месте стоят пометки и исходные ссылки.`)
      ctl.progress({ phase: 'saving', done: 0 })
      await writeFile(path, renderChatHtml(dump), 'utf8')
      if (!devPath) shell.showItemInFolder(path)
      return { path, messages: dump.entries.filter((e) => !('sep' in e)).length, complete: dump.complete, warnings: dump.warnings }
    } finally {
      target.release()
      chatExport = null
      push()
    }
  },
  'chat:exportCancel': () => { if (chatExport) chatExport.cancelled = true },
  // The user pressed «Удалить все репосты»: removes every repost of the account through TikTok's own web endpoints.
  'reposts:start': (a: { id: string }) => {
    const acc = account(a?.id)
    need(reposts?.job.status !== 'running', 'Очистка репостов уже идёт.')
    need(sessions.get(acc.id) === 'logged_in', 'Сначала войдите в этот аккаунт на вкладке «Обзор».')
    const run: NonNullable<typeof reposts> = {
      job: { accountId: acc.id, status: 'running', phase: 'scan', found: 0, removed: 0, failed: 0, startedAt: Date.now(), message: 'Подключаюсь к TikTok…' },
      stop: false
    }
    reposts = run
    void findReposts(run.job, acc.verified ? acc.username : undefined, new URL(HOME_URL).origin, browse.contents(acc.id), push, (c) => {
      run.cleaner = c
      if (run.stop) c.stop()
    }).finally(push)
    push()
    return true
  },
  // The user looked at what the search found and chose how many to remove; no number = all of them.
  'reposts:delete': (a: { count?: number }) => {
    const run = reposts
    need(run?.job.status === 'ready' && !!run.cleaner, 'Сначала дождитесь конца поиска.')
    const n = a?.count
    need(n === undefined || (Number.isInteger(n) && n > 0), 'Укажите, сколько удалить.')
    void run!.cleaner!.remove(n).finally(push)
    push()
    return true
  },
  'reposts:stop': () => { stopReposts(); push() },
  'reposts:dismiss': () => { if (reposts && reposts.job.status !== 'running') reposts = null; push() },
  // The user chose a list to clean: this only reads it. Nothing changes until `sweep:run`.
  'sweep:start': (a: { id: string; kind: SweepKind }) => {
    const acc = account(a?.id)
    need(SWEEP_KINDS.includes(a?.kind), 'Неизвестный список.')
    need(sweep?.job.status !== 'running' && sweep?.job.status !== 'ready', 'Чистка уже идёт.')
    need(!(reposts?.job.status === 'running' && reposts.job.accountId === acc.id), 'Дождитесь конца удаления репостов.')
    need(sessions.get(acc.id) === 'logged_in', 'Сначала войдите в этот аккаунт на вкладке «Обзор».')
    const run: NonNullable<typeof sweep> = {
      job: { accountId: acc.id, kind: a.kind, status: 'running', phase: 'scan', found: 0, removed: 0, failed: 0, startedAt: Date.now(), message: 'Подключаюсь к TikTok…' },
      stop: false
    }
    sweep = run
    void findSweep(run.job, acc.verified ? acc.username : undefined, new URL(HOME_URL).origin, browse.contents(acc.id), push, (s) => {
      run.sweeper = s
      if (run.stop) s.stop()
    }).finally(push)
    push()
    return true
  },
  // What a choice would touch, for the screen. Nothing but the first few goes to the UI.
  'sweep:preview': (a: unknown) => {
    const run = sweep
    if (!run?.sweeper) return { matched: 0, sample: [] }
    const list = pick(run.sweeper.items, cleanChoice(a), run.job.kind)
    return { matched: list.length, sample: list.slice(0, run.job.kind === 'following' ? 12 : 18) }
  },
  // The user looked at the preview and confirmed: only here does anything change on the account.
  'sweep:run': (a: unknown) => {
    const run = sweep
    need(run?.job.status === 'ready' && !!run.sweeper, 'Сначала дождитесь конца поиска.')
    void run!.sweeper!.remove(cleanChoice(a)).finally(push)
    push()
    return true
  },
  'sweep:stop': () => { stopSweep(); push() },
  'sweep:dismiss': () => { if (sweep && sweep.job.status !== 'running') sweep = null; push() },
  // A list of what was removed, to a file the user picks: there is no undo button on TikTok's side.
  'sweep:saveList': async () => {
    const run = sweep
    need(!!run?.sweeper?.gone.length, 'Список пуст.')
    const r = await dialog.showSaveDialog(win, { title: 'Сохранить список', defaultPath: `tiktok-${run!.job.kind}-${new Date().toISOString().slice(0, 10)}.txt`, filters: [{ name: 'Текст', extensions: ['txt'] }] })
    if (r.canceled || !r.filePath) return null
    await writeFile(r.filePath, run!.sweeper!.gone.map((x) => linkOf(x, run!.job.kind)).join('\r\n') + '\r\n', 'utf8')
    return run!.sweeper!.gone.length
  },
  // The key goes to an OS-encrypted file in main; the UI only ever learns whether one is saved.
  'psy:key': (a: { key: string | null }) => {
    if (a?.key === null) keybox.clear()
    else { need(isStr(a?.key, 400) && !/\s/.test(a.key), 'Ключ выглядит неверно.'); keybox.set(a.key.trim()) }
    push()
  },
  // The user pressed «Психопортрет»: reads the account's reposts, lets a vision model look at covers and frames, writes a presentation.
  // `username` = analyse any public profile by name (no sign-in needed; `id` only picks which account's browser view sends the requests).
  'psy:start': async (a: { id: string; username?: string; frames?: boolean; limit?: number; gender?: string; age?: string; relation?: string }) => {
    const acc = account(a?.id)
    need(psy?.job.status !== 'running', 'Портрет уже строится.')
    const other = typeof a.username === 'string' && a.username.trim() ? parseHandle(a.username) : undefined
    need(a.username === undefined || a.username === null || !String(a.username).trim() || !!other, 'Не похоже на имя профиля TikTok. Впишите @имя или ссылку на профиль.')
    need(!!other || sessions.get(acc.id) === 'logged_in', 'Сначала войдите в этот аккаунт на вкладке «Обзор».')
    const key = keybox.get()
    need(!!key, 'Сначала сохраните ключ API в «Настройках».')
    const set = store.data.settings
    const pre = PSY_PRESET_INFO[set.psyPreset]
    need(set.psyPreset !== 'anthropic' || key!.startsWith('sk-ant-'), 'Это не ключ Anthropic (у них он начинается с sk-ant-). Если ключ от шлюза или перепродавца, выберите в «Настройках» «Свой адрес» и впишите адрес из его инструкции.')
    const base = (set.psyPreset === 'custom' ? set.psyBase : pre.base).trim()
    need(/^https:\/\/[^\s]+$/.test(base) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(base), 'Укажите адрес API (https://…) в «Настройках».')
    const vision = set.psyVision || pre.vision
    const synth = set.psySynth || pre.synth
    need(!!vision && !!synth, 'Укажите модели в «Настройках».')
    const devPath = DEV ? process.env.STACKTOK_PSY_PATH : undefined
    const stamp = new Date().toISOString().slice(0, 10)
    const name = `Психопортрет-${(other || acc.username || acc.label).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 40)}-${stamp}.html`
    const path = devPath || (await dialog.showSaveDialog(win, { title: 'Психопортрет: куда сохранить презентацию', defaultPath: join(app.getPath('downloads'), name), filters: [{ name: 'HTML-презентация', extensions: ['html'] }] })).filePath
    if (!path) return null
    const limit = typeof a.limit === 'number' && Number.isFinite(a.limit) ? Math.min(10000, Math.max(10, Math.round(a.limit))) : 500
    const run = { job: { accountId: acc.id, status: 'running', phase: 'collect', done: 0, total: 0, message: 'Подключаюсь к TikTok…', startedAt: Date.now(), tokens: 0, target: other } as PsyJob, stop: false }
    psy = run
    const target = browse.chatTarget(acc.id) ?? (browse.contents(acc.id), browse.chatTarget(acc.id))
    target?.hold() // the page keeps working with the window covered or minimised, same as in the chat export
    void runPortrait({
      wc: browse.contents(acc.id), ses: browse.contents(acc.id).session, base: new URL(HOME_URL).origin,
      username: !other && acc.verified ? acc.username : undefined, target: other, owner: other ? { name: '@' + other, handle: other } : { name: acc.label, handle: acc.username },
      provider: { kind: pre.kind, base, key: key! }, visionModel: vision, synthModel: synth,
      devOrigin: DEV ? new URL(HOME_URL).origin : undefined, frames: a.frames === true, limit, subject: { gender: a.gender === 'male' || a.gender === 'female' ? a.gender : undefined, age: typeof a.age === 'string' ? a.age.trim().slice(0, 20) || undefined : undefined, relation: typeof a.relation === 'string' ? a.relation.trim().slice(0, 40) || undefined : undefined }, job: run.job, onChange: push, cancelled: () => run.stop, path
    }).then((j) => { if (j.status === 'done' && j.path && !devPath) shell.showItemInFolder(j.path) }).finally(() => { target?.release(); push() })
    push()
    return true
  },
  'psy:stop': () => { if (psy) psy.stop = true; push() },
  'psy:dismiss': () => { if (psy && psy.job.status !== 'running') psy = null; push() },
  'psy:open': () => { if (psy?.job.path) return shell.openPath(psy.job.path) },
  'win:min': () => win.minimize(),
  'win:max': () => { if (win.isMaximized()) win.unmaximize(); else win.maximize() },
  'win:close': () => win.close(),
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
  downloader = new Downloader(win)
  browse = new Browse(win, () => store.data.settings.muteByDefault, (wc) => overlay.attach(wc), (id) => store.data.accounts.find((x) => x.id === id)?.openIn ?? 'studio', (id) => {
    notice = { id: (notice?.id ?? 0) + 1, text: `«${store.data.accounts.find((x) => x.id === id)?.label ?? 'Аккаунт'}»: TikTok не отдал страницу (403). Открыт Studio, попробуйте «Домой» позже.` }
    push()
  })
  wc.once('did-finish-load', () => { browse.show(store.data.activeAccountId); applyBackground(); push() })
  nativeTheme.on('updated', applyBackground)
  win.on('maximize', push)
  win.on('unmaximize', push)
}

app.whenReady().then(() => {
  store = new Store(join(app.getPath('userData'), 'stacktok.json'))
  overlay = new ChatOverlay(() => store.data.settings, join(app.getPath('userData'), 'chat-wallpaper.txt'), DEV ? new URL(HOME_URL).origin : undefined)
  keybox = new KeyBox(join(app.getPath('userData'), 'psy-key.bin'))
  registerIpc()
  store.data.accounts.forEach((a) => watchSession(a.id))
  createWindow()
  setInterval(() => store.data.accounts.forEach((a) => refreshAvatar(a.id)), AVATAR_SWEEP)
})

app.on('before-quit', () => store?.flush())
app.on('window-all-closed', () => app.quit())
