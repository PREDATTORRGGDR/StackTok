// End-to-end test against a MOCK TikTok site (no network, no real account).
// It drives the real built app through its real preload API over the Chrome DevTools protocol.
// Run: npm run build && npm run test:e2e
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
const VIDEO = path.join(root, 'tests', 'fake.mp4')
const PORT = 9333

// ---------- mock site ----------
let scenario = 'ok' // ok | silent | challenge
let counter = 0
const seen = { posts: [], homeCookies: [], uploadLoads: 0 }
const server = http.createServer((req, res) => {
  const cookie = /sessionid=(\w+)/.exec(req.headers.cookie ?? '')?.[1]
  const url = new URL(req.url, 'http://x')
  const html = (b) => { res.setHeader('content-type', 'text/html'); res.end(`<!doctype html><body>${b}`) }
  if (url.pathname === '/') {
    let id = cookie
    if (!id) { id = 's' + ++counter; res.setHeader('set-cookie', `sessionid=${id}; Max-Age=86400; Path=/`) }
    seen.homeCookies.push({ had: cookie, id })
    return html(`<div data-e2e="nav-profile"><a href="/@user_${id}">me</a></div><h1>Mock home</h1>`)
  }
  if (url.pathname === '/tiktokstudio/content') return html('<h1>Content</h1>')
  if (url.pathname === '/__post') {
    let b = ''; req.on('data', (c) => (b += c)).on('end', () => { seen.posts.push({ ...JSON.parse(b), cookie }); res.end('ok') }); return
  }
  if (url.pathname === '/tiktokstudio/upload') {
    seen.uploadLoads++
    return html(`
      ${scenario === 'challenge' ? '<div id="captcha-box">verify</div>' : ''}
      <input type="file" id="f"><div class="public-DraftEditor-content" contenteditable="true"></div>
      <button data-e2e="post_video_button" disabled>Post</button>
      <script>
        const f = document.getElementById('f'), btn = document.querySelector('button'), ed = document.querySelector('[contenteditable]')
        let tags = 0
        // Mimics TikTok: a typed #word only becomes a real hashtag after its suggestion is clicked.
        ed.addEventListener('input', () => {
          document.querySelectorAll('.hashtag-suggestion-item').forEach((x) => x.remove())
          const m = /#[^ #]+$/.exec(ed.textContent)
          if (!m || m[0] === '#nosuggest') return
          const d = document.createElement('div'); d.className = 'hashtag-suggestion-item'
          const sp = document.createElement('span'); sp.className = 'hash-tag-topic'; sp.textContent = m[0] + ' 1.2M'
          sp.addEventListener('click', () => {
            ed.textContent = ed.textContent.slice(0, -m[0].length)
            const h = document.createElement('span'); h.className = 'ht'; h.textContent = m[0]
            ed.append(h, document.createTextNode(' ')); tags++; d.remove()
          })
          d.append(sp); document.body.append(d)
        })
        f.onchange = () => { ed.innerText = 'fake'; const p = document.createElement('div'); p.className = 'uploading-now'; document.body.append(p); setTimeout(() => { p.remove(); btn.disabled = false }, 500) }
        btn.onclick = async () => {
          await fetch('/__post', { method: 'POST', body: JSON.stringify({ caption: ed.innerText, tags, file: f.files[0] && f.files[0].name }) })
          if (${JSON.stringify(scenario)} !== 'silent') location.href = '/tiktokstudio/content'
        }
      </script>`)
  }
  res.statusCode = 404; res.end()
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
    cwd: root,
    env: { ...process.env, STACKTOK_USER_DATA: userData, STACKTOK_HOME_URL: base + '/', STACKTOK_UPLOAD_URL: base + '/tiktokstudio/upload', STACKTOK_UPLOAD_TIMEOUT: '8000', STACKTOK_TICK_MS: '500' },
    stdio: 'ignore'
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
const quit = async () => { const p = proc; p.kill(); await new Promise((r) => p.once('exit', r)); try { ws.close() } catch {} await sleep(500) }
async function shot(name) {
  if (!shots) return
  const r = await cdp('Page.captureScreenshot', { format: 'png' })
  fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, name + '.png'), Buffer.from(r.result.data, 'base64'))
}
const clickNav = (t) => evalJs(`[...document.querySelectorAll('.nav-item')].find(b => b.textContent.startsWith(${JSON.stringify(t)})).click()`)

// ---------- tiny test harness ----------
let pass = 0, fail = 0
const check = (ok, name, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + extra}`) }
const task = async (id) => (await state()).tasks.find((t) => t.id === id)
const settle = (id, statuses, ms = 30000) => until(async () => { const t = await task(id); return statuses.includes(t.status) && t }, ms, `task -> ${statuses}`)

try {
  // 1. launch + accounts
  await launch()
  let s = await state()
  check(s.accounts.length === 0, '1 app launches with empty state')
  const A = await api('account:add', { label: 'Alpha' })
  const B = await api('account:add', { label: 'Beta' })
  s = await state()
  check(s.accounts.length === 2 && A !== B, '2 accounts can be added, with distinct internal ids')

  // 3. isolation: each account's first request to the site has no cookie, and later requests carry only its own
  for (const id of [A, B]) { await api('account:select', { id }); await until(async () => (await state()).accounts.find((a) => a.id === id).session === 'logged_in', 15000, 'session logged in') }
  const firsts = seen.homeCookies.filter((c) => !c.had)
  check(new Set(firsts.map((c) => c.id)).size === 2, '3a each account gets its own cookie jar (two fresh sessions)')
  await api('account:select', { id: A })
  await sleep(300)
  const ida = (await api('account:detect', { id: A })).username
  await api('account:select', { id: B })
  await sleep(300)
  const idb = (await api('account:detect', { id: B })).username
  check(ida && idb && ida !== idb, '3b identity detection differs per session', `${ida} vs ${idb}`)
  await api('account:confirm', { id: A, username: ida })
  await api('account:confirm', { id: B, username: idb })
  const parts = fs.readdirSync(path.join(userData, 'Partitions'))
  check(parts.some((p) => p.includes(A)) && parts.some((p) => p.includes(B)), '3c separate on-disk profile folder per account', parts.join(','))

  // 5. presets + templates
  await api('preset:save', { name: 'General', tags: ['#fyp', 'viral!', '#FYP'] })
  await api('template:save', { name: 'Intro', text: 'Hello world' })
  check((await state()).presets.length === 1, '5 hashtag preset saved')

  // 6/7. multi-account publish now: separate tasks, each with its own caption
  const ids = await api('task:create', {
    videoPath: VIDEO, mode: 'now',
    items: [{ accountId: A, caption: 'Caption for A #fyp' }, { accountId: B, caption: 'Caption for B\nsecond line' }]
  })
  check(ids.length === 2 && new Set(ids).size === 2, '7 multiple accounts produce separate tasks')
  const [ta, tb] = await Promise.all(ids.map((i) => settle(i, ['published', 'failed', 'needs_verification', 'awaiting_user'])))
  check(ta.status === 'published' && tb.status === 'published', '6a mock publish succeeds for both accounts', `${ta.status}/${tb.status} ${ta.error ?? ''} ${tb.error ?? ''}`)
  check(!!ta.confirmation && ta.submitted, '10a published carries a confirmation')
  const pa = seen.posts.find((p) => p.caption.includes('Caption for A'))
  const pb = seen.posts.find((p) => p.caption.includes('second line'))
  check(!!pa && !!pb && pa.cookie !== pb.cookie && pa.file === 'fake.mp4', '6b each post used its own account session and caption', JSON.stringify(seen.posts))
  check(pa.caption.trim() === 'Caption for A #fyp' && !/fake/.test(pa.caption), '6d pre-filled file name is removed from the caption', JSON.stringify(pa.caption))
  check(pa.tags === 1, '6e hashtag is typed key by key and committed with a space', String(pa.tags))
  check(pb?.caption.includes('Caption for B') && pb.caption.includes('second line'), '6c multi-line caption entered')

  // 9/10b. unconfirmed outcome -> needs_verification, never auto-resubmitted
  scenario = 'silent'
  const before = seen.posts.length
  const [sid] = await api('task:create', { videoPath: VIDEO, mode: 'now', items: [{ accountId: A, caption: 'silent' }] })
  const ts = await settle(sid, ['published', 'failed', 'needs_verification'], 40000)
  check(ts.status === 'needs_verification', '10b no confirmation => needs verification, not published', ts.status)
  await api('task:retry', { id: sid })
  await sleep(1500)
  check((await task(sid)).status === 'needs_verification' && seen.posts.length === before + 1, '9 retry is refused after Post was clicked; exactly one post made')

  // challenge -> pause for user, then resume
  scenario = 'challenge'
  const [cid] = await api('task:create', { videoPath: VIDEO, mode: 'now', items: [{ accountId: B, caption: 'challenge' }] })
  const tc = await settle(cid, ['awaiting_user', 'published', 'failed'])
  check(tc.status === 'awaiting_user' && !tc.submitted, '11a verification challenge pauses automation for the user', tc.status)
  scenario = 'ok'
  await api('task:retry', { id: cid })
  check((await settle(cid, ['published', 'failed', 'awaiting_user'])).status === 'published', '11b resume after user clears challenge publishes')

  // session expiry (wipe B) pauses safely without even opening the upload page
  await api('account:wipe', { id: B })
  const loads = seen.uploadLoads
  const [xid] = await api('task:create', { videoPath: VIDEO, mode: 'now', items: [{ accountId: B, caption: 'expired' }] })
  const tx = await settle(xid, ['awaiting_user', 'published', 'failed'])
  check(tx.status === 'awaiting_user' && seen.uploadLoads === loads, '11c expired session pauses; upload page never opened', tx.status)

  // 8. scheduling in local time
  const when = Date.now() + 2500
  const [schId] = await api('task:create', { videoPath: VIDEO, mode: 'schedule', scheduledAt: when, items: [{ accountId: A, caption: 'scheduled #nosuggest' }] })
  const sch = await task(schId)
  check(sch.status === 'scheduled' && sch.scheduledAt === when, '8a scheduled task stores exact epoch time')
  check((await settle(schId, ['published', 'failed', 'needs_verification'], 60000)).status === 'published', '8b scheduler runs it when due')
  const ps = seen.posts.find((p) => p.caption.includes('scheduled'))
  check(ps && !ps.caption.includes('#nosuggest') && ps.tags === 0, '6f a tag without a suggestion is removed, not left as plain text', JSON.stringify(ps))
  const pastErr = await evalJs(`window.api.call('task:create', ${JSON.stringify({ videoPath: VIDEO, mode: 'schedule', scheduledAt: Date.now() - 1000, items: [{ accountId: A, caption: 'x' }] })})`)
  check(!pastErr.ok, '8c past schedule time rejected')

  // screenshots of UI
  await clickNav('Публикация'); await sleep(300); await shot('publish')
  await clickNav('Активность'); await sleep(300); await shot('activity')
  await clickNav('Настройки'); await sleep(300); await shot('settings')

  // 4/6d/overdue persistence across restart
  await api('settings:set', { autoRun: false })
  const [dueId] = await api('task:create', { videoPath: VIDEO, mode: 'schedule', scheduledAt: Date.now() + 1500, items: [{ accountId: A, caption: 'due while closed' }] })
  const [draftId] = await api('task:create', { videoPath: VIDEO, mode: 'draft', items: [{ accountId: A, caption: 'draft' }] })
  const taskCount = (await state()).tasks.length
  await sleep(600) // let the debounced save land before the hard kill
  await quit()
  await sleep(2000)
  await launch()
  s = await state()
  check(s.accounts.length === 2 && s.accounts.some((a) => a.label === 'Alpha' && a.username === ida), '4 account metadata survives restart')
  check(s.accounts.find((a) => a.id === A).session === 'logged_in', '4b login session survives restart')
  check(s.presets.length === 1 && s.presets[0].tags.join() === '#fyp,#viral', '5b presets survive restart; tags normalised and de-duplicated', JSON.stringify(s.presets))
  check(s.tasks.length === taskCount && s.tasks.find((t) => t.id === draftId)?.status === 'draft', '6d queue survives restart')
  check(s.overdue.includes(dueId), '8d task due while closed is reported as overdue')
  await api('settings:set', { autoRun: true })
  await sleep(2000)
  check((await task(dueId)).status === 'scheduled', '8e overdue task does not auto-publish on launch')
  await api('task:runNow', { id: dueId })
  check((await settle(dueId, ['published', 'failed', 'needs_verification'])).status === 'published', '8f overdue task runs after explicit go-ahead')
  await sleep(500)
  await api('account:remove', { id: B, wipe: false })
  check(fs.readdirSync(path.join(userData, 'Partitions')).some((p) => p.includes(A)), '2b remove account keeps profile data unless wipe is requested')
  await api('account:remove', { id: A, wipe: true })
  check((await state()).accounts.length === 0, '2 accounts can be removed')
} catch (e) {
  fail++; console.log('FAIL  unexpected error: ' + e.stack)
} finally {
  try { proc.kill() } catch {}
  server.close()
  try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
  console.log(`\n${pass} passed, ${fail} failed (mock site; not a real TikTok test)`)
  process.exit(fail ? 1 : 0)
}
