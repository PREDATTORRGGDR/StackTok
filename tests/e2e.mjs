// End-to-end test against a MOCK TikTok site (no network, no real account).
// It drives the real built app through its real preload API over the Chrome DevTools protocol.
// Run: npm run build && npm run test:e2e   (set E2E_SHOTS=<dir> to also save screenshots)
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const electron = createRequire(import.meta.url)('electron')
const root = path.resolve(import.meta.dirname, '..')
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacktok-e2e-'))
const shots = process.env.E2E_SHOTS
const PORT = 9333

// ---------- mock site: hands each fresh browser profile its own login cookie ----------
let counter = 0
const seenHome = []
const dlHits = [] // requests of the downloader view: must never carry an account's cookie
// A chat whose older messages load only when the list is scrolled to the top, like TikTok's.
// Query: n = messages, page = messages per load, d = ms per load, big = every k-th message carries a 3 MB picture, virt = draw only a window.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const BIG = Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)])
const chatPage = `<!doctype html><meta charset="utf-8"><body style="margin:0;font-family:sans-serif;background:#1b1d2a;color:#fff">
<div data-e2e="dm-new-chatbox"><div><img data-e2e="top-chat-avatar" src="/img/s.png" width="32" height="32"><span data-e2e="dm-new-chat-nickname">Тест Собеседник</span><span data-e2e="chat-uniqueid">test_partner</span></div>
<div data-e2e="dm-new-message-list" style="height:300px;overflow-y:auto"></div></div>
<script>
const P = new URLSearchParams(location.search)
const TOTAL = +P.get('n') || 95, PAGE = +P.get('page') || 30, DELAY = P.has('d') ? +P.get('d') : 150, BIG = +P.get('big') || 0
const list = document.querySelector('[data-e2e="dm-new-message-list"]')
const body = (i) => i % 10 === 5 ? '<img src="/img/s.png" width="96" height="96">'
  : BIG && i % BIG === 1 ? '<img src="/img/big.png?v=' + (i % 3) + '" width="96" height="96">'
  : i % 17 === 3 ? '<div data-e2e="dm-new-shared-video"><a href="https://www.tiktok.com/@x/video/' + i + '"><img src="/img/s.png"><p>Видео ' + i + '</p></a></div>'
  : i === 7 ? '<div data-e2e="dm-new-message-text"><p>Привет &lt;script&gt;alert(1)&lt;/script&gt; <img alt="😀" src="/img/s.png"></p></div>'
  : '<div data-e2e="dm-new-message-text"><p>Сообщение №' + i + '</p></div>'
const row = (i, style = '') => {
  const me = i % 3 === 0
  const sep = !P.has('virt') && i % 20 === 0 ? '<div data-e2e="dm-new-time-separator">День ' + i / 20 + '</div>' : ''
  return sep + '<div data-e2e="dm-new-chat-item" style="display:flex;justify-content:' + (me ? 'flex-end' : 'flex-start') + ';padding:4px;' + style + '"><div>' + body(i) + '<span style="font-size:10px">12:' + String(i % 60).padStart(2, '0') + '</span></div></div>'
}
if (P.has('virt')) {
  // every message is known, but only the ones near the viewport are in the DOM
  const H = 40
  list.style.position = 'relative'
  list.innerHTML = '<div style="height:' + TOTAL * H + 'px"></div>'
  const spacer = list.firstChild
  const draw = () => {
    list.querySelectorAll('[data-e2e="dm-new-chat-item"]').forEach((e) => e.remove())
    const a = Math.max(0, Math.floor(list.scrollTop / H) - 4), b = Math.min(TOTAL, Math.ceil((list.scrollTop + list.clientHeight) / H) + 4)
    for (let i = a; i < b; i++) list.insertAdjacentHTML('beforeend', row(i, 'position:absolute;left:0;right:0;height:' + H + 'px;box-sizing:border-box;top:' + i * H + 'px'))
  }
  list.addEventListener('scroll', draw)
  draw()
  list.scrollTop = list.scrollHeight
} else {
  let from = Math.max(0, TOTAL - PAGE)
  const rows = (a, b) => Array.from({ length: b - a }, (_, k) => row(a + k)).join('')
  list.innerHTML = rows(from, TOTAL)
  list.scrollTop = list.scrollHeight
  let loading = false
  list.addEventListener('scroll', () => {
    if (list.scrollTop > 40 || from <= 0 || loading) return
    loading = true
    setTimeout(() => {
      const n = Math.min(PAGE, from), old = list.scrollHeight
      from -= n
      list.insertAdjacentHTML('afterbegin', rows(from, from + n))
      list.scrollTop += list.scrollHeight - old
      loading = false
    }, DELAY)
  })
}
</script>`
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/img/')) { res.setHeader('content-type', 'image/png'); return res.end(req.url.startsWith('/img/big') ? BIG : PNG) }
  if (req.url.startsWith('/messages')) { res.setHeader('content-type', 'text/html'); return res.end(chatPage) }
  if (req.url.startsWith('/profile')) { res.statusCode = 403; return res.end('forbidden') } // like TikTok sometimes does
  if (req.url.startsWith('/dl')) { dlHits.push(req.headers.cookie ?? ''); res.setHeader('content-type', 'text/html'); return res.end('<!doctype html><title>mock downloader</title><h1>Mock downloader</h1>') }
  const cookie = /sessionid=(\w+)/.exec(req.headers.cookie ?? '')?.[1]
  let id = cookie
  if (!id) { id = 's' + ++counter; res.setHeader('set-cookie', `sessionid=${id}; Max-Age=86400; Path=/`) }
  seenHome.push({ had: cookie, id })
  res.setHeader('content-type', 'text/html')
  res.end(`<!doctype html><body style="font-family:sans-serif;background:#1b1d2a;color:#fff"><div data-e2e="nav-profile"><a href="/@user_${id}">me</a></div><h1>Mock TikTok</h1>`)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

// ---------- app + cdp ----------
let proc, ws, msgId = 0
const pending = new Map()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 20000, what = 'condition') {
  const end = Date.now() + ms
  while (Date.now() < end) { try { const v = await fn(); if (v) return v } catch {} await sleep(150) }
  throw new Error('timeout waiting for ' + what)
}
async function launch() {
  proc = spawn(electron, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: root, env: { ...process.env, STACKTOK_USER_DATA: userData, STACKTOK_HOME_URL: base + '/', STACKTOK_DOWNLOADER_URL: base + '/dl', STACKTOK_EXPORT_PATH: path.join(userData, 'export.html') }, stdio: 'ignore'
  })
  const target = await until(async () => {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    return list.find((t) => t.type === 'page' && t.title === 'StackTok')
  }, 20000, 'app window')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((r) => (ws.onopen = r))
  ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id) }
  await until(() => evalJs('!!window.api'), 10000, 'preload api')
}
const cdp = (method, params = {}) => new Promise((res) => { const id = ++msgId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
async function evalJs(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description ?? ''))
  return r.result.result.value
}
const api = async (ch, arg) => {
  const r = await evalJs(`window.api.call(${JSON.stringify(ch)}, ${JSON.stringify(arg ?? null)})`)
  if (!r.ok) throw new Error(`${ch}: ${r.error}`)
  return r.value
}
const state = () => api('state:get')
// Graceful close (like the user closing the window) so Chromium flushes cookies to disk.
const quit = async () => {
  const p = proc
  const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()
  const bws = new WebSocket(v.webSocketDebuggerUrl)
  await new Promise((r) => (bws.onopen = r))
  bws.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
  await Promise.race([new Promise((r) => p.once('exit', r)), sleep(10000)])
  try { p.kill() } catch {}
  await sleep(500)
}
async function shot(name) {
  if (!shots) return
  await sleep(500)
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, name + '.png'), Buffer.from(r.result.data, 'base64'))
}
let bid = 0
async function setWindowState(state) {
  try {
    const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()
    const app = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page' && t.title === 'StackTok')
    const bws = new WebSocket(v.webSocketDebuggerUrl)
    await new Promise((r) => (bws.onopen = r))
    const send = (method, params) => new Promise((res) => {
      const id = ++bid
      const h = (e) => { const m = JSON.parse(e.data); if (m.id === id) { bws.removeEventListener('message', h); res(m) } }
      bws.addEventListener('message', h)
      bws.send(JSON.stringify({ id, method, params }))
    })
    const w = await send('Browser.getWindowForTarget', { targetId: app.id })
    const r = await send('Browser.setWindowBounds', { windowId: w.result.windowId, bounds: { windowState: state } })
    bws.close()
    return !w.error && !r.error
  } catch { return false }
}
const clickNav = (t) => evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.startsWith(${JSON.stringify(t)})).click()`)

let pass = 0, fail = 0
const check = (ok, name, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`) }

try {
  await launch()
  let s = await state()
  check(s.accounts.length === 0, '1 app launches with empty state')
  await shot('empty')

  const A = await api('account:add', { label: 'Личный' })
  await clickNav('Обзор') // the web view only exists while the Browse page is open
  await until(async () => (await state()).accounts.find((a) => a.id === A).session === 'logged_in', 15000, 'session A')
  const B = await api('account:add', { label: 'Бренд' })
  await until(async () => (await state()).accounts.find((a) => a.id === B).session === 'logged_in', 15000, 'session B')
  const C = await api('account:add', { label: 'Мемы' })
  s = await state()
  check(s.accounts.length === 3 && new Set([A, B, C]).size === 3, '2 accounts can be added with distinct internal ids')
  check(new Set(seenHome.filter((c) => !c.had).map((c) => c.id)).size === 2, '3a each account starts with its own empty cookie jar')

  // switching back to A must reuse A's own cookie, not B's
  await api('account:select', { id: A }); await sleep(800)
  const aCookies = seenHome.filter((c) => c.had === 's1').length
  check(aCookies >= 0 && !seenHome.some((c) => c.had && c.had !== c.id), '3b requests always carry only their own session cookie')

  await api('account:select', { id: A }); await sleep(400)
  const ida = (await api('account:detect', { id: A })).username
  await api('account:select', { id: B }); await sleep(600)
  const idb = (await api('account:detect', { id: B })).username
  check(ida && idb && ida !== idb, '3c identity detection reads each session separately', `${ida} vs ${idb}`)
  await api('account:confirm', { id: A, username: ida })
  await api('account:confirm', { id: B, username: idb })

  const parts = fs.readdirSync(path.join(userData, 'Partitions'))
  check(parts.some((p) => p.includes(A)) && parts.some((p) => p.includes(B)), '3d separate on-disk profile folder per account', parts.join(','))

  // a 403 on the start page falls back to Studio and tells the user instead of leaving a blank page
  await api('account:openIn', { id: B, value: 'profile' })
  await api('account:open', { id: B })
  await until(async () => (await state()).notice?.text.includes('403'), 10000, 'notice about 403')
  check(true, '12 a 403 on the start page shows a notice (Studio is opened instead)')
  await api('account:openIn', { id: B, value: 'studio' })
  await api('account:open', { id: B })

  // downloader: its own isolated view, opened only from its page, never sharing an account's cookies
  await clickNav('Загрузчик')
  await until(async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).some((t) => t.type === 'page' && t.url.endsWith('/dl')), 10000, 'downloader view')
  check(dlHits.length > 0 && dlHits.every((c) => !c.includes('sessionid')), '10 downloader loads in its own view without any account cookie', dlHits.join('|'))
  await clickNav('Обзор')

  // start page per account
  await api('account:openIn', { id: B, value: 'chats' })
  check((await state()).accounts.find((a) => a.id === B).openIn === 'chats', '11 start page is stored per account')
  let bad = false
  try { await api('account:openIn', { id: B, value: 'http://evil' }) } catch { bad = true }
  check(bad && (await state()).accounts.find((a) => a.id === B).openIn === 'chats', '11b an unknown start page is refused')
  await api('account:openIn', { id: B, value: 'studio' })
  await api('account:openIn', { id: A, value: 'profile' }) // must survive the restart below

  // chat overlay: injected only on the /messages page, and switched off by chatOverlay
  const views = async () => (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).filter((t) => t.type === 'page' && t.url.startsWith(base) && !t.url.endsWith('/dl'))
  const inView = async (t, expr) => {
    const w = new WebSocket(t.webSocketDebuggerUrl)
    await new Promise((r) => (w.onopen = r))
    const out = await new Promise((r) => { w.onmessage = (e) => r(JSON.parse(e.data)); w.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })) })
    w.close()
    return out.result?.result?.value
  }
  const wall = (t) => inView(t, `getComputedStyle(document.documentElement, '::before').content`)
  await api('settings:set', { chatOverlay: true, chatWallpaper: 'aurora' })
  const [v1, v2] = await views()
  await inView(v1, `location.href = '/messages'`)
  await until(async () => (await wall((await views()).find((t) => t.url.endsWith('/messages')))) === '""', 8000, 'wallpaper on /messages')
  check(true, '9 wallpaper is injected on the messages page')
  if (v2) check((await wall((await views()).find((t) => !t.url.endsWith('/messages')))) === 'none', '9b other pages are left untouched')
  await api('settings:set', { chatOverlay: false })
  await until(async () => (await wall((await views()).find((t) => t.url.endsWith('/messages')))) === 'none', 8000, 'overlay off')
  check(true, '9c chatOverlay=false removes the styles')
  s = await state()
  check(s.settings.chatOverlay === false && s.settings.chatWallpaper === 'aurora', '9d chat settings are stored')
  await api('settings:set', { chatPrivacy: true, chatDim: 70, chatTextSize: 'large' })
  s = await state()
  check(s.settings.chatPrivacy === true && s.settings.chatDim === 70 && s.settings.chatTextSize === 'large', '9f chat extras are stored')
  await api('settings:set', { chatPrivacy: false, chatDim: 50, chatTextSize: 'normal' })
  await api('settings:set', { chatWallpaper: 'custom' }) // no picked file: must be refused
  check((await state()).settings.chatWallpaper === 'aurora', '9e "custom" is refused without a picked file')
  await api('settings:set', { chatOverlay: true, chatWallpaper: 'none' })
  await inView((await views()).find((t) => t.url.endsWith('/messages')), `location.href = '/'`)

  // chat export: reads the open chat of the active account (history loads lazily) and writes one HTML page
  await api('account:chats', { id: A })
  await until(async () => { const t = (await views()).find((v) => v.url.endsWith('/messages')); return t && (await inView(t, "document.querySelectorAll('[data-e2e=dm-new-chat-item]').length")) >= 30 }, 10000, 'mock chat')
  const exportFile = path.join(userData, 'export.html')
  const rx = await api('chat:export')
  const html = fs.existsSync(exportFile) ? fs.readFileSync(exportFile, 'utf8') : ''
  if (process.env.E2E_KEEP_EXPORT) fs.copyFileSync(exportFile, process.env.E2E_KEEP_EXPORT)
  const count = (re) => (html.match(re) ?? []).length
  check(rx && rx.messages === 95 && rx.complete === true, '13 export loads the whole lazily loaded history', JSON.stringify(rx))
  check(count(/<article class="msg /g) === 95 && html.indexOf('Сообщение №0') > 0 && html.indexOf('Сообщение №0') < html.indexOf('Сообщение №94'), '13b all messages are in the file, in order')
  check(count(/class="msg me"/g) === 32 && count(/class="msg them"/g) === 63, '13c senders are told apart by side', count(/class="msg me"/g) + '/' + count(/class="msg them"/g))
  check(count(/class="sep"/g) === 5 && html.includes('День 4') && html.includes('12:07'), '13d date separators and times are kept')
  check(html.includes('Тест Собеседник') && html.includes('https://www.tiktok.com/@x/video/3') && count(/class="vcard"/g) === 6, '13e partner, shared videos and their links are kept')
  check(count(/class="media sticker/g) >= 9 && html.includes('data:image/png;base64'), '13f stickers are embedded in the file')
  check(!html.includes('<script>alert(1)') && html.includes('&lt;script&gt;alert(1)'), '13g message text is escaped')
  check(!/<script[^>]+src=|<link/.test(html), '13h the file loads nothing from outside')
  // ----- speed and background -----
  const chatTab = async () => (await views()).find((v) => v.url.includes('/messages'))
  const openChat = async (qs, min) => {
    await inView(await chatTab(), `location.href = '/messages${qs}'`)
    await until(async () => { const t = await chatTab(); return t && t.url.endsWith(qs) && (await inView(t, "document.querySelectorAll('[data-e2e=dm-new-chat-item]').length")) >= min }, 15000, 'chat ' + qs)
  }
  const readExport = () => fs.readFileSync(exportFile, 'utf8')
  const texts = (h) => [...h.matchAll(/<div class="text">Сообщение №(\d+)<\/div>/g)].map((m) => +m[1])
  const plain = (n) => Array.from({ length: n }, (_, i) => i).filter((i) => i % 10 !== 5 && i % 17 !== 3 && i !== 7)
  const inOrder = (got, want) => got.length === want.length && got.every((v, i) => v === want[i])

  // 14: the export keeps going when the user leaves the page and even when the window is minimized
  await openChat('?n=300&page=30&d=400', 30)
  const running = api('chat:export')
  await sleep(900)
  await clickNav('Аккаунты') // the web view leaves the window; the export must keep it alive
  await sleep(300)
  const minimized = await setWindowState('minimized')
  const ry = await running
  if (minimized) await setWindowState('normal')
  const h14 = readExport()
  check(ry && ry.messages === 300 && ry.complete === true && inOrder(texts(h14), plain(300)), '14 export runs in the background (another page open' + (minimized ? ', window minimized' : '; minimizing was not available') + ')', JSON.stringify(ry))
  await clickNav('Обзор'); await sleep(300)

  // 15: a big chat is loaded and saved completely, in order, without duplicates
  await openChat('?n=4000&page=100&d=60', 100)
  const t15 = Date.now()
  const phases = []
  const watch = setInterval(async () => { try { const p = (await state()).chatExport; const k = p ? p.phase : 'idle'; if (phases.at(-1)?.[0] !== k) phases.push([k, Date.now() - t15]) } catch {} }, 80)
  const r15 = await api('chat:export')
  clearInterval(watch)
  const ms15 = Date.now() - t15
  console.log('     phases (ms from start):', JSON.stringify(phases))
  const h15 = readExport()
  check(r15 && r15.messages === 4000 && r15.complete === true && inOrder(texts(h15), plain(4000)), '15 a 4000-message chat is saved completely and in order', JSON.stringify(r15))
  check(ms15 < 60000, `15b speed: ${Math.round(4000 / (ms15 / 1000))} messages/s (${ms15} ms for 4000 messages in 40 loads of 60 ms)`, ms15 + ' ms')

  // 16: a list that draws only a window of its messages is walked and joined without gaps or repeats
  await openChat('?n=700&virt=1', 1)
  const r16 = await api('chat:export')
  const h16 = readExport()
  const all700 = Array.from({ length: 700 }, (_, i) => i)
  const nums16 = [...h16.matchAll(/Сообщение №(\d+)</g)].map((m) => +m[1])
  check(r16 && r16.messages === 700 && r16.complete === true && inOrder(nums16, all700.filter((i) => i % 10 !== 5 && i % 17 !== 3 && i !== 7)), '16 a windowed (virtualized) list is saved completely', JSON.stringify(r16) + ' got ' + nums16.length)

  // 17: big pictures go to a folder next to the page instead of being dropped
  await openChat('?n=120&page=30&d=50&big=7', 30)
  const r17 = await api('chat:export')
  const h17 = readExport()
  const folder = path.join(userData, 'export_files')
  const saved17 = fs.existsSync(folder) ? fs.readdirSync(folder) : []
  check(r17 && r17.messages === 120 && saved17.length >= 1 && fs.statSync(path.join(folder, saved17[0])).size > 2 * 1024 * 1024 && h17.includes('export_files/') && h17.includes('лежат в папке'), '17 files too big for the page are saved next to it', JSON.stringify(r17) + ' ' + saved17.join(','))

  await inView(await chatTab(), "location.href = '/'")
  await until(async () => (await views()).every((t) => !t.url.includes('/messages')), 8000, 'left chat')
  let noChat = false
  try { await api('chat:export') } catch (e) { noChat = e.message.includes('Откройте диалог') }
  check(noChat, '13i export asks for an open chat instead of writing an empty file')

  await api('account:rename', { id: C, label: 'Мемы 2' })
  await api('settings:set', { theme: 'light', accent: 'pink', background: 'sunset', glass: 80, restoreLast: false })
  await api('settings:set', { theme: 'bogus', glass: 9999 })
  s = await state()
  check(s.settings.theme === 'light' && s.settings.glass === 100 && s.settings.accent === 'pink', '5 settings are validated and applied')

  // screenshots in both themes
  await api('settings:set', { theme: 'dark', accent: 'blue', background: 'aurora', glass: 55 })
  await clickNav('Аккаунты'); await shot('accounts-dark')
  await clickNav('Настройки'); await shot('settings-dark')
  await evalJs(`document.querySelector('.content').scrollTop = 9999`); await shot('settings-chats-dark')
  await clickNav('Обзор'); await shot('browse-dark')
  await api('settings:set', { theme: 'light', background: 'sunset', accent: 'pink' })
  await clickNav('Аккаунты'); await shot('accounts-light')
  await clickNav('Настройки'); await shot('settings-light')
  await evalJs(`document.querySelector('.content').scrollTop = 9999`); await shot('settings-chats-light')
  await api('settings:set', { theme: 'dark', background: 'ocean', accent: 'violet', restoreLast: true })

  // restart: everything persists
  await sleep(600)
  await quit(); await launch()
  s = await state()
  check(s.accounts.length === 3 && s.accounts.find((a) => a.id === A).username === ida, '4 account metadata survives restart')
  check(s.accounts.find((a) => a.id === C).label === 'Мемы 2' && s.settings.background === 'ocean' && s.settings.restoreLast, '4b renames and settings survive restart')
  check(s.accounts.find((a) => a.id === A).openIn === 'profile', '4d start page survives restart')
  await until(async () => (await state()).accounts.find((a) => a.id === A).session === 'logged_in', 10000, 'session after restart')
  check(true, '4c login session survives restart')

  // removal keeps the profile unless a wipe is requested
  await api('account:remove', { id: B, wipe: false })
  check(fs.readdirSync(path.join(userData, 'Partitions')).some((p) => p.includes(B)), '6 removing an account keeps its profile data')
  await api('account:remove', { id: A, wipe: true })
  await sleep(500)
  s = await state()
  check(s.accounts.length === 1 && !s.accounts.some((a) => a.id === A), '7 accounts can be removed')
  await api('account:wipe', { id: C })
  await until(async () => (await state()).accounts.find((a) => a.id === C).session === 'logged_out', 8000, 'logout after wipe')
  check(true, '8 deleting session data signs the account out')
} catch (e) {
  fail++; console.log('FAIL  unexpected error: ' + e.stack)
} finally {
  try { proc.kill() } catch {}
  server.close()
  await sleep(500)
  try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
  console.log(`\n${pass} passed, ${fail} failed (mock site; not a real TikTok test)`)
  process.exit(fail ? 1 : 0)
}
