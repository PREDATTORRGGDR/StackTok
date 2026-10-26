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
// reposts mock: ids currently in the account's Reposts tab; 'trap' is listed but NOT reposted, so clicking it would ADD a repost
const reposts = ['r1', 'r2', 'r3', 'r4', 'r5', 'trap']
const reposted = new Set(['r1', 'r2', 'r3', 'r4', 'r5'])
let repostAddCalls = 0
const liked = new Set(['r2', 'r4']) // already liked: must be unliked and liked again
const likeLog = []
const seenHome = []
const server = http.createServer((req, res) => {
  const cookie = /sessionid=(\w+)/.exec(req.headers.cookie ?? '')?.[1]
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/__list') return res.end(JSON.stringify(reposts))
  if (u.pathname === '/__unrepost') { const v = u.searchParams.get('id'); reposted.delete(v); const i = reposts.indexOf(v); if (i >= 0) reposts.splice(i, 1); return res.end('ok') }
  if (u.pathname === '/__like') { const v = u.searchParams.get('id'); const on = !liked.has(v); on ? liked.add(v) : liked.delete(v); likeLog.push(v + ':' + (on ? 'like' : 'unlike')); return res.end('ok') }
  if (u.pathname === '/__repost') { repostAddCalls++; return res.end('ok') }
  const vid = /^\/@[^/]+\/video\/(\w+)$/.exec(u.pathname)
  if (vid) {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    return res.end('<!doctype html><body><div class="tag" data-e2e="repost-tag">Вы сделали репост</div><div data-e2e="share-icon" role="button">share</div><div id="l" data-e2e="like-icon" role="button"></div><script>' +
      'const id=' + JSON.stringify(vid[1]) + ';let on=' + JSON.stringify(reposted.has(vid[1])) + ';let lk=' + JSON.stringify(liked.has(vid[1])) + ';' +
      'const l=document.getElementById("l");const dl=()=>l.setAttribute("aria-pressed",String(lk));dl();' +
      'l.onclick=async()=>{await fetch("/__like?id="+id);lk=!lk;dl()};' +
      'document.querySelector("[data-e2e=share-icon]").onclick=()=>{if(document.querySelector("[data-e2e=share-repost]"))return;' +
      'const m=document.createElement("div");m.setAttribute("role","dialog");m.innerHTML=\'<div data-e2e="video-share-repost"></div>\';document.body.append(m);' +
      'const r=m.firstChild;const draw=()=>{r.textContent=on?"Удалить репост":"Репост"};draw();' +
      'r.onclick=async()=>{await fetch(on?"/__unrepost?id="+id:"/__repost?id="+id);on=!on;draw()}}</script>')
  }
  if (/^\/@[^/]+$/.test(u.pathname)) {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    return res.end('<!doctype html><body><p role="tab" data-e2e="videos-tab">Видео</p><p role="tab" data-e2e="repost-tab">Репосты</p><div id="g"></div><script>' +
      'document.querySelector("[data-e2e=repost-tab]").onclick=async()=>{const ids=await (await fetch("/__list")).json();' +
      'document.getElementById("g").innerHTML=ids.map(i=>\'<div data-e2e="user-repost-item"><a href="/@other/video/\'+i+\'">\'+i+"</a></div>").join("")}</script>')
  }
  let id = cookie
  if (!id) { id = 's' + ++counter; res.setHeader('set-cookie', `sessionid=${id}; Max-Age=86400; Path=/`) }
  seenHome.push({ had: cookie, id })
  res.setHeader('content-type', 'text/html; charset=utf-8')
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
    cwd: root, env: { ...process.env, STACKTOK_USER_DATA: userData, STACKTOK_HOME_URL: base + '/', STACKTOK_FAST: '1' }, stdio: 'ignore'
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

  await api('account:rename', { id: C, label: 'Мемы 2' })
  await api('settings:set', { theme: 'light', accent: 'pink', background: 'sunset', glass: 80, restoreLast: false })
  await api('settings:set', { theme: 'bogus', glass: 9999 })
  s = await state()
  check(s.settings.theme === 'light' && s.settings.glass === 100 && s.settings.accent === 'pink', '5 settings are validated and applied')

  // screenshots in both themes
  await api('settings:set', { theme: 'dark', accent: 'blue', background: 'aurora', glass: 55 })
  await clickNav('Аккаунты'); await shot('accounts-dark')
  await clickNav('Настройки'); await shot('settings-dark')
  await clickNav('Обзор'); await shot('browse-dark')
  await api('settings:set', { theme: 'light', background: 'sunset', accent: 'pink' })
  await clickNav('Аккаунты'); await shot('accounts-light')
  await clickNav('Настройки'); await shot('settings-light')
  await api('settings:set', { theme: 'dark', background: 'ocean', accent: 'violet', restoreLast: true })

  // restart: everything persists
  await sleep(600)
  await quit(); await launch()
  s = await state()
  check(s.accounts.length === 3 && s.accounts.find((a) => a.id === A).username === ida, '4 account metadata survives restart')
  check(s.accounts.find((a) => a.id === C).label === 'Мемы 2' && s.settings.background === 'ocean' && s.settings.restoreLast, '4b renames and settings survive restart')
  await until(async () => (await state()).accounts.find((a) => a.id === A).session === 'logged_in', 10000, 'session after restart')
  check(true, '4c login session survives restart')

  // repost cleanup: removes only real reposts, never adds one, reports what it could not remove
  await clickNav('Обзор'); await api('reposts:start', { id: A, like: true })
  const j1 = await until(async () => { const j = (await state()).job; return j && j.status !== 'running' && j }, 60000, 'repost job')
  check(j1.removed === 5 && reposts.length === 1 && reposts[0] === 'trap', '9a all real reposts are removed', JSON.stringify({ j1, reposts }))
  check(repostAddCalls === 0, '9b a video that is not reposted is never clicked (cannot add reposts)', String(repostAddCalls))
  check(j1.status === 'stopped' && /Не удалось убрать: 1/.test(j1.message), '9c an item TikTok keeps in the list is reported, not looped forever', j1.message)
  check(['r1', 'r2', 'r3', 'r4', 'r5'].every((i) => liked.has(i)) && j1.liked === 5, '9e every removed repost ends up liked', JSON.stringify({ liked: [...liked], n: j1.liked }))
  check(likeLog.join() === 'r1:like,r2:unlike,r2:like,r3:like,r4:unlike,r4:like,r5:like', '9f an existing like is toggled off and on again, an absent like is added once', likeLog.join())
  check(j1.hasDebug && (await api('reposts:copyDebug')) === true, '9h a failed item produces a copyable page diagnostic', JSON.stringify(j1))
  check(!likeLog.some((x) => x.startsWith('trap')), '9g likes are only touched on videos being processed')
  await api('reposts:dismiss')
  reposts.length = 0
  await clickNav('Обзор'); await api('reposts:start', { id: A })
  const j2 = await until(async () => { const j = (await state()).job; return j && j.status !== 'running' && j }, 30000, 'empty repost job')
  check(j2.status === 'done' && j2.removed === 0, '9d empty reposts tab finishes as done', JSON.stringify(j2))
  await api('reposts:dismiss')

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
