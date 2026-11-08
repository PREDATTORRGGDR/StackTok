import { BrowserWindow, app, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { ACCENTS, AccountView, AssistState, BACKGROUNDS, Bounds, CHAT_TEXT_SIZES, CHAT_WALLPAPERS, ChatExportProgress, cleanRange, GLASS_MATERIALS, HEX, Job, OPEN_IN, PSY_PRESETS, PSY_PRESET_INFO, PsyJob, API_PROFILES_MAX, ApiCheck, ApiProfile, activeProfile, SWEEP_KINDS, SessionState, Settings, SweepJob, SweepKind, THEMES } from '../shared/types'
import { accountProfile, accountReposts, accountVideos, stopCounting } from './account-stats-run'
import { AVATAR_EVERY, AVATAR_SWEEP, pickAvatar } from './avatars'
import { Browse, HOME_URL, accountPage, configureSession, sessionState, startUrl } from './browse'
import { ChatDump, ExportEntry, Person, renderChatHtml } from './chat-export-html'
import { chatInfo, collectChat, embedMedia } from './chat-export'
import { ChatOverlay } from './chat-overlay'
import { AssistTurn, Transcript, promptWithoutChat, questionOf, streamReply, systemPrompt, titleOf, transcriptOf } from './chat-assist'
import { ChatCopies, TalkBox, lookAt } from './chat-assist-run'
import type { RepostCleaner } from './repost-cleaner'
import { findReposts } from './reposts'
import { Sweeper, cleanChoice, linkOf, pick } from './sweep'
import { findSweep } from './sweep-run'
import { Provider, PsyError, Vlm, parseHandle, profileOf } from './psycho'
import { KeyRing, runPortrait } from './psycho-run'
import { baseOf, checkKey } from './api-check'
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
let keys: KeyRing // API keys by profile id, OS-encrypted
const checks: Record<string, ApiCheck> = {} // last key check per profile (memory only)
// The chat assistant: the loaded conversation stays here (memory only, never on disk); the UI gets only `view`.
const freshAssist = (): AssistState => ({ status: 'idle', messages: 0, cut: 0, complete: false, warnings: [], turns: [], tokens: 0, model: '', pictures: 0, history: [], canAsk: false, historySaved: true })
interface AssistRun { view: AssistState; talkId?: string; accountId?: string; chat?: string; entries?: ExportEntry[]; ctx?: { partner: Person; owner: Person; t: Transcript; complete: boolean }; looks: Map<string, string>; abort?: AbortController; cancelLoad: boolean }
let assist: AssistRun = { view: freshAssist(), looks: new Map(), cancelLoad: false }
let talks: TalkBox // conversations with the assistant, encrypted on disk
let copies: ChatCopies // the chats those conversations are about, encrypted on disk
/** What the UI shows of the assistant: its state plus the list of saved conversations (titles only). */
function assistView(): AssistState {
  const talk = talks?.get(assist.talkId)
  const other = !!talk && talk.chat !== assist.chat // an old conversation about a chat that is not the loaded one
  const copy = other ? copies?.get(talk!.chat) : undefined
  return {
    ...assist.view, talkId: assist.talkId, talkPartner: talk?.partner,
    canAsk: other || (!!assist.ctx && !!assist.chat),
    talkSource: !talk || !other ? (assist.ctx ? 'loaded' : undefined) : copy ? 'saved' : 'none',
    savedAt: copy?.at, savedMessages: copy?.messages, savedFirst: copy?.first,
    historySaved: talks?.saves ?? true,
    history: (talks?.list ?? []).map((t) => ({ id: t.id, title: t.title, partner: t.partner, handle: t.handle, accountId: t.accountId, updatedAt: t.updatedAt, turns: t.turns.length, here: t.chat === assist.chat }))
  }
}
/** Writes the current conversation into the history (a new entry on its first question), with a copy of the chat it is about. */
function saveTalk(run: AssistRun) {
  if (!run.view.turns.some((t) => t.role === 'user')) return
  const old = talks.get(run.talkId)
  if (!old && !run.chat) return
  if (run.ctx && run.chat && (!old || old.chat === run.chat)) {
    copies.put({ chat: run.chat, accountId: run.accountId ?? '', partner: run.view.partner ?? '', handle: run.view.handle, system: systemPrompt(run.ctx), messages: run.ctx.t.messages, first: run.ctx.t.first, last: run.ctx.t.last, at: run.view.loadedAt ?? Date.now() })
  }
  run.talkId ??= randomUUID()
  talks.put({
    id: run.talkId, chat: old?.chat ?? run.chat!, accountId: old?.accountId ?? run.accountId ?? '', partner: old?.partner ?? run.view.partner ?? '', handle: old?.handle ?? run.view.handle,
    title: old?.title ?? titleOf(run.view.turns.find((t) => t.role === 'user')!.text), createdAt: old?.createdAt ?? Date.now(), updatedAt: Date.now(),
    turns: run.view.turns.filter((t) => t.text).map((t) => ({ role: t.role, text: t.text, ...(t.error ? { error: true } : {}) }))
  })
}

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
  return { accounts, settings: d.settings, notice, chatExport: chatExport?.progress ?? null, job: reposts?.job ?? null, sweep: sweep?.job ?? null, psy: psy?.job ?? null, assist: assistView(), hasPsyKey: !!keys && keys.has(activeProfile(d.settings).id), apiKeys: keys?.ids() ?? [], apiUsage: d.apiUsage, apiChecks: checks, activeAccountId: d.activeAccountId, maximized: !!win && !win.isDestroyed() && win.isMaximized(), version: app.getVersion(), dataPath: app.getPath('userData') }
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

function forgetAssist(accountId?: string) {
  if (accountId) { talks.remove((t) => t.accountId === accountId); copies.remove((c) => c.accountId === accountId) } // the account is gone: so is the advice about its chats
  if (accountId && assist.accountId !== accountId) return
  assist.abort?.abort()
  assist.cancelLoad = true
  assist = { view: freshAssist(), looks: new Map(), cancelLoad: false }
}

/** The model API of the active profile in «Настройки» (shared by the portrait and the chat assistant). Throws a user-facing message. */
function modelApi(): { provider: Provider; prof: ApiProfile; vision: string; synth: string; assist: string } {
  const prof = activeProfile(store.data.settings)
  const key = keys.get(prof.id)
  need(!!key, `Сначала сохраните ключ API для «${prof.name}» в «Настройках».`)
  const pre = PSY_PRESET_INFO[prof.preset]
  need(prof.preset !== 'anthropic' || key!.startsWith('sk-ant-'), 'Это не ключ Anthropic (у них он начинается с sk-ant-). Если ключ от шлюза или перепродавца, выберите в «Настройках» «Свой адрес» и впишите адрес из его инструкции.')
  const base = baseOf(prof)
  need(/^https:\/\/[^\s]+$/.test(base) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(base), 'Укажите адрес API (https://…) в «Настройках».')
  const synth = prof.synth || pre.synth
  return { provider: { kind: pre.kind, base, key: key! }, prof, vision: prof.vision || pre.vision, synth, assist: prof.assist || synth }
}

/** Counts what a profile spent through the app (the provider's own numbers from each answer). */
function spend(id: string, inTok: number, outTok: number, requests = 1) {
  if (!inTok && !outTok) return
  const u = store.data.apiUsage[id] ?? { inTok: 0, outTok: 0, requests: 0, since: Date.now() }
  store.data.apiUsage[id] = { ...u, inTok: u.inTok + inTok, outTok: u.outTok + outTok, requests: u.requests + requests }
  store.save()
}

/** Puts the loaded chat (with picture descriptions) into the prompt context. */
function buildContext(run: AssistRun) {
  if (!run.entries || !run.ctx) return
  const t = transcriptOf(run.entries, run.ctx.partner, run.looks)
  run.ctx = { ...run.ctx, t }
  run.view = { ...run.view, messages: t.messages, cut: t.cut, first: t.first, last: t.last, complete: run.ctx.complete && !t.cut }
}

function profile(id: unknown): ApiProfile {
  const p = store.data.settings.apiProfiles.find((x) => x.id === id)
  if (!p) throw new Error('Неизвестный ключ.')
  return p
}
function setKey(id: string, key: unknown) {
  if (key === null) keys.clear(id)
  else { need(isStr(key, 400) && !/\s/.test(key), 'Ключ выглядит неверно.'); keys.set(id, key.trim()) }
  delete checks[id]
  push()
}
/** Changes a profile from untrusted input: only known fields, known presets, bounded strings. */
function editProfile(id: string, patch: Record<string, unknown>) {
  const p = profile(id)
  const s = (v: unknown, n: number) => (typeof v === 'string' && v.length <= n ? v.trim() : undefined)
  const name = s(patch.name, 40)
  if (name) p.name = name
  if (PSY_PRESETS.includes(patch.preset as any)) p.preset = patch.preset as ApiProfile['preset']
  for (const [k, n] of [['base', 200], ['vision', 100], ['synth', 100], ['assist', 100]] as const) { const v = s(patch[k], n); if (v !== undefined) p[k] = v }
  delete checks[id]
  store.save()
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
    forgetAssist(acc.id)
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
    forgetAssist(acc.id)
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
    const old = s as Record<string, unknown> // settings from before profiles: they change the active profile (tests use them)
    if (old?.psyPreset !== undefined || old?.psyBase !== undefined) editProfile(activeProfile(cur).id, { preset: old.psyPreset, base: old.psyBase, vision: old.psyVision, synth: old.psySynth })
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
    need(assist.view.status !== 'loading', 'Дождитесь, пока помощник загрузит переписку.')
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
  // The user pressed «Загрузить» in the assistant: reads the chat open in the active account's view into memory (nothing is saved),
  // then the cheap model describes its newest pictures once (stickers, photos, video covers), so questions carry only words.
  'assist:load': async (a?: { count?: number; pictures?: boolean }) => {
    need(assist.view.status === 'idle', 'Помощник занят.')
    need(!chatExport, 'Дождитесь конца экспорта чата.')
    const count = typeof a?.count === 'number' && Number.isInteger(a.count) && a.count >= 0 ? Math.min(a.count, 1_000_000) : 300
    const acc = account(store.data.activeAccountId)
    need(sessions.get(acc.id) === 'logged_in', 'Сначала войдите в этот аккаунт на вкладке «Обзор».')
    const target = browse.chatTarget(acc.id)
    if (!target) throw new Error('Откройте чат этого аккаунта на вкладке «Обзор».')
    const info = await chatInfo(target.wc)
    const chat = acc.id + '|' + info.name + '|' + info.handle
    const run = assist
    if (run.chat !== chat) run.looks = new Map()
    run.cancelLoad = false
    run.view = { ...run.view, status: 'loading', loading: 'Загружаю переписку…' }
    push()
    target.hold()
    const warnings: string[] = []
    try {
      const got = await collectChat(target.wc, {
        cancelled: () => run.cancelLoad,
        progress: (p) => { run.view.loading = p.phase === 'loading' ? `Загружаю историю: ${p.done} сообщений…` : p.phase === 'reading' ? `Читаю сообщения: ${p.done}${p.total ? ' из ' + p.total : ''}…` : 'Готовлю контекст…'; push() }
      }, count ? { mode: 'last', count } : { mode: 'all' })
      if (run !== assist) return null // forgotten while loading
      const keep = run.talkId ? talks.get(run.talkId)?.chat === chat : run.chat === chat
      if (!keep) run.talkId = undefined
      run.accountId = acc.id
      run.chat = chat
      run.entries = got.entries
      run.ctx = { partner: got.partner, owner: { name: acc.label, handle: acc.username }, t: transcriptOf([], got.partner), complete: got.complete }
      warnings.push(...got.warnings.filter((w) => !/^Файл собран/.test(w)).map((w) => w.replace(/в файл[ае]?|в файле/g, 'в контексте')))
      if (a?.pictures !== false && keys.has(activeProfile(store.data.settings).id)) {
        try {
          const { provider, prof, vision: model } = modelApi()
          const vlm = new Vlm(provider)
          run.view.loading = 'Смотрю стикеры, фото и обложки…'
          push()
          const r = await lookAt(got.entries, {
            ses: target.ses, vlm, model, looks: run.looks, devOrigin: DEV ? new URL(HOME_URL).origin : undefined, cancelled: () => run.cancelLoad,
            progress: (d, t) => { run.view.loading = `Смотрю стикеры, фото и обложки: ${d} из ${t}…`; push() }
          })
          run.view.tokens += vlm.usage.inTok + vlm.usage.outTok
          spend(prof.id, vlm.usage.inTok, vlm.usage.outTok, vlm.usage.calls)
          if (r.failed && r.described === 0) warnings.push('Картинки не удалось разобрать: помощник видит только подписи к ним.')
        } catch (e) {
          warnings.push(`Картинки не разобраны: ${(e as Error).message}`)
        }
      }
      run.view = { ...run.view, status: 'idle', loading: undefined, partner: got.partner.name || info.name, handle: got.partner.handle || info.handle, loadedAt: Date.now(), turns: keep ? run.view.turns : [], pictures: run.looks.size, warnings }
      buildContext(run)
      if (run.view.cut) run.view.warnings.unshift(`Переписка длинная: в контекст вошли последние ${run.view.messages} сообщений, ещё ${run.view.cut} не поместились (так дешевле).`)
      return { messages: run.view.messages }
    } catch (e) {
      if (run === assist) run.view = { ...run.view, status: 'idle', loading: undefined }
      throw new Error(run.cancelLoad ? 'Загрузка остановлена.' : 'Не удалось загрузить переписку: ' + (e as Error).message)
    } finally {
      target.release()
      push()
    }
  },
  // A question to the assistant: the loaded transcript and the last turns go to the model chosen in «Настройки». Nothing is sent to TikTok.
  'assist:ask': (a: { text: string }) => {
    need(isStr(a?.text, 8000), 'Напишите вопрос.')
    need(assist.view.status === 'idle', 'Помощник занят.')
    const open = talks.get(assist.talkId)
    const other = !!open && open.chat !== assist.chat // going on with an old conversation: its saved chat copy is the context
    need(other || !!assist.ctx, 'Сначала загрузите переписку.')
    const system = other ? (copies.get(open!.chat)?.system ?? promptWithoutChat(open!.partner)) : systemPrompt(assist.ctx!)
    const { provider, prof, assist: model } = modelApi()
    need(!!model, 'Укажите модель в «Настройках».')
    const run = assist
    const text = a.text.trim()
    const history: AssistTurn[] = run.view.turns.filter((t) => !t.error && t.text).map((t) => ({ role: t.role, text: t.text }))
    history.push({ role: 'user', text: questionOf(text) })
    const answer: { role: 'assistant'; text: string; error?: boolean } = { role: 'assistant', text: '' }
    run.view = { ...run.view, status: 'thinking', model, turns: [...run.view.turns, { role: 'user', text }, answer] }
    const abort = new AbortController()
    run.abort = abort
    let timer: NodeJS.Timeout | undefined
    const flush = () => { timer = undefined; push() }
    push()
    void streamReply(provider, model, system, history, (t) => {
      answer.text = t
      timer ??= setTimeout(flush, 60) // pieces arrive dozens a second: a few UI updates are enough
    }, abort.signal).then((r) => {
      answer.text = r.text
      run.view.tokens += r.inTok + r.outTok
      spend(prof.id, r.inTok, r.outTok)
    }, (e: unknown) => {
      const msg = (e as Error).message
      if (answer.text && e instanceof PsyError && /Остановлено/.test(msg)) return
      if (answer.text) answer.text += '\n\n— ' + msg
      else { answer.text = msg; answer.error = true }
    }).finally(() => {
      if (timer) clearTimeout(timer)
      if (run === assist) { run.view.status = 'idle'; run.abort = undefined; run.view = { ...run.view, turns: [...run.view.turns] }; saveTalk(run) }
      push()
    })
    return true
  },
  'assist:stop': () => { assist.cancelLoad = true; assist.abort?.abort(); push() },
  // A new conversation about the same chat, or forget the chat entirely.
  'assist:reset': () => { if (assist.view.status === 'idle') { assist.talkId = undefined; assist.view = { ...assist.view, turns: [] }; push() } },
  'assist:forget': () => { forgetAssist(); push() },
  // History: open an earlier conversation (to read it, or to go on if its chat is the loaded one), delete one or all.
  'assist:open': (a: { id: string }) => {
    need(assist.view.status !== 'thinking', 'Дождитесь конца ответа.')
    const t = talks.get(a?.id)
    need(!!t, 'Разговор не найден.')
    assist.talkId = t!.id
    assist.view = { ...assist.view, turns: t!.turns.map((x) => ({ ...x })) }
    push()
    return true
  },
  'assist:delete': (a: { id: string }) => {
    need(typeof a?.id === 'string', 'Bad value.')
    if (assist.talkId === a.id && assist.view.status === 'thinking') throw new Error('Дождитесь конца ответа.')
    talks.remove((t) => t.id === a.id)
    copies.remove((c) => !talks.list.some((t) => t.chat === c.chat)) // a chat copy lives only as long as a conversation about it
    if (assist.talkId === a.id) { assist.talkId = undefined; assist.view = { ...assist.view, turns: [] } }
    push()
  },
  'assist:clearHistory': () => {
    need(assist.view.status !== 'thinking', 'Дождитесь конца ответа.')
    talks.remove(() => true)
    copies.remove(() => true)
    talks.flush()
    copies.flush()
    assist.talkId = undefined
    assist.view = { ...assist.view, turns: [] }
    push()
  },
  // Keys go to an OS-encrypted file in main; the UI only ever learns which profiles have one. `psy:key` = the active profile.
  'psy:key': (a: { key: string | null }) => setKey(activeProfile(store.data.settings).id, a?.key),
  'api:key': (a: { id: string; key: string | null }) => setKey(profile(a?.id).id, a?.key),
  'api:add': () => {
    const list = store.data.settings.apiProfiles
    need(list.length < API_PROFILES_MAX, `Не больше ${API_PROFILES_MAX} ключей.`)
    const id = randomUUID()
    list.push({ id, name: `Ключ ${list.length + 1}`, preset: 'custom', base: '', vision: '', synth: '', assist: '' })
    store.save(); push()
    return id
  },
  'api:update': (a: { id: string; patch: Record<string, unknown> }) => { editProfile(profile(a?.id).id, a?.patch ?? {}); push() },
  'api:remove': (a: { id: string }) => {
    const set = store.data.settings
    const p = profile(a?.id)
    need(set.apiProfiles.length > 1, 'Последний ключ удалить нельзя: уберите сам ключ кнопкой «Убрать».')
    keys.clear(p.id)
    delete store.data.apiUsage[p.id]
    delete checks[p.id]
    set.apiProfiles = set.apiProfiles.filter((x) => x.id !== p.id)
    if (set.apiActive === p.id) set.apiActive = set.apiProfiles[0].id
    store.save(); push()
  },
  'api:use': (a: { id: string }) => { store.data.settings.apiActive = profile(a?.id).id; store.save(); push() },
  // Read-only: the model list says whether the key is taken, a balance page (where the provider has one) what is left. No tokens are spent.
  'api:check': async (a: { id: string }) => {
    const p = profile(a?.id)
    const key = keys.get(p.id)
    need(!!key, 'Сначала сохраните ключ.')
    checks[p.id] = await checkKey(p, key!)
    push()
    return checks[p.id]
  },
  'api:resetUsage': (a: { id: string }) => { delete store.data.apiUsage[profile(a?.id).id]; store.save(); push() },
  // The user pressed «Психопортрет»: reads the account's reposts, lets a vision model look at covers and frames, writes a presentation.
  // `username` = analyse any public profile by name (no sign-in needed; `id` only picks which account's browser view sends the requests).
  'psy:start': async (a: { id: string; username?: string; frames?: boolean; limit?: number; gender?: string; age?: string; relation?: string }) => {
    const acc = account(a?.id)
    need(psy?.job.status !== 'running', 'Портрет уже строится.')
    const other = typeof a.username === 'string' && a.username.trim() ? parseHandle(a.username) : undefined
    need(a.username === undefined || a.username === null || !String(a.username).trim() || !!other, 'Не похоже на имя профиля TikTok. Впишите @имя или ссылку на профиль.')
    need(!!other || sessions.get(acc.id) === 'logged_in', 'Сначала войдите в этот аккаунт на вкладке «Обзор».')
    const { provider, prof, vision, synth } = modelApi()
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
      provider, visionModel: vision, synthModel: synth,
      devOrigin: DEV ? new URL(HOME_URL).origin : undefined, frames: a.frames === true, limit, subject: { gender: a.gender === 'male' || a.gender === 'female' ? a.gender : undefined, age: typeof a.age === 'string' ? a.age.trim().slice(0, 20) || undefined : undefined, relation: typeof a.relation === 'string' ? a.relation.trim().slice(0, 40) || undefined : undefined }, job: run.job, onChange: push, cancelled: () => run.stop, path
    }).then((j) => { if (j.status === 'done' && j.path && !devPath) shell.showItemInFolder(j.path) }).finally(() => { spend(prof.id, run.job.inTok ?? 0, run.job.outTok ?? 0, run.job.calls ?? 0); target?.release(); push() })
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
  keys = new KeyRing(join(app.getPath('userData'), 'api-keys.bin'), { file: join(app.getPath('userData'), 'psy-key.bin'), id: activeProfile(store.data.settings).id })
  talks = new TalkBox(join(app.getPath('userData'), 'assist-history.bin'))
  copies = new ChatCopies(join(app.getPath('userData'), 'assist-chats.bin'))
  registerIpc()
  store.data.accounts.forEach((a) => watchSession(a.id))
  createWindow()
  setInterval(() => store.data.accounts.forEach((a) => refreshAvatar(a.id)), AVATAR_SWEEP)
})

app.on('before-quit', () => { store?.flush(); talks?.flush(); copies?.flush() })
app.on('window-all-closed', () => app.quit())
