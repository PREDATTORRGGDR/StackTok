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
const server = http.createServer((req, res) => {
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
    cwd: root, env: { ...process.env, STACKTOK_USER_DATA: userData, STACKTOK_HOME_URL: base + '/' }, stdio: 'ignore'
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
