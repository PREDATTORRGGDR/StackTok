import { BrowserWindow } from 'electron'
import { statSync } from 'node:fs'
import { configureSession, lockDown, partitionFor, sessionState } from './browse'

export const UPLOAD_URL = 'https://www.tiktok.com/tiktokstudio/upload?from=webapp'

/** Selectors for TikTok Studio's upload page. Isolated here because the layout changes over time. */
export const SELECTORS = {
  fileInput: 'input[type="file"]',
  caption: '.public-DraftEditor-content, [contenteditable="true"]',
  post: 'button[data-e2e="post_video_button"]',
  confirmDialogPost: 'button[data-e2e="confirm_post_button"], .common-modal-footer button',
  challenge: '[id*="captcha" i], [class*="captcha" i], iframe[src*="captcha" i], [class*="verify-bar" i]',
  uploading: '[class*="uploading" i], [role="progressbar"]',
  suggestion: '.hashtag-suggestion-item',
  suggestionTopic: '.hash-tag-topic'
}

export type Outcome =
  | { kind: 'published'; confirmation: string }
  | { kind: 'failed'; error: string }
  | { kind: 'awaiting_user'; reason: string }
  | { kind: 'needs_verification'; reason: string }

interface Hooks {
  log: (msg: string) => void
  markSubmitting: () => void // persist submitted=true BEFORE clicking Post
  show: boolean
  uploadUrl?: string // override for tests against a mock page
  timeoutMs?: number
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const J = JSON.stringify
const CHALLENGE_MSG = 'TikTok запрашивает проверку. Пройдите её в открывшемся окне и продолжите.'

/** Windows left open for the user after a pause, one per account. */
const paused = new Map<string, BrowserWindow>()

/** Polls an observable condition until truthy or timeout. */
async function waitFor<T>(fn: () => Promise<T>, timeoutMs: number, everyMs = 500): Promise<T | undefined> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    const v = await fn().catch(() => undefined)
    if (v) return v
    await sleep(everyMs)
  }
}

export async function uploadVideo(accountId: string, videoPath: string, caption: string, h: Hooks): Promise<Outcome> {
  try {
    if (!statSync(videoPath).isFile()) return { kind: 'failed', error: 'Путь к видео не является файлом.' }
  } catch {
    return { kind: 'failed', error: 'Видеофайл не найден или недоступен.' }
  }
  if ((await sessionState(accountId)) !== 'logged_in')
    return { kind: 'awaiting_user', reason: 'Сессия истекла. Войдите на вкладке «Обзор» и продолжите.' }

  paused.get(accountId)?.destroy()
  paused.delete(accountId)
  configureSession(accountId)
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    show: h.show,
    title: 'StackTok upload',
    webPreferences: { partition: partitionFor(accountId), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  lockDown(win.webContents)
  const wc = win.webContents
  let keepOpen = false

  const pause = (reason: string): Outcome => {
    keepOpen = true // visible so the user can handle login, challenges, or layout changes
    win.show()
    paused.set(accountId, win)
    h.log(reason)
    return { kind: 'awaiting_user', reason }
  }

  try {
    wc.debugger.attach('1.3')
    const cdp = (m: string, p?: object) => wc.debugger.sendCommand(m, p) as Promise<any>
    const evalJs = async (expr: string) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true })).result?.value
    const exists = (sel: string) => evalJs(`!!document.querySelector(${J(sel)})`)
    const pageText = () => evalJs('document.body ? document.body.innerText : ""') as Promise<string>

    h.log('Открываю страницу загрузки')
    await wc.loadURL(h.uploadUrl ?? UPLOAD_URL)
    if (/\/login/i.test(wc.getURL())) return pause('Перенаправление на вход. Войдите на вкладке «Обзор» и продолжите.')

    if (!(await waitFor(() => exists(SELECTORS.fileInput), Math.min(60_000, h.timeoutMs ?? 60_000))))
      return pause((await exists(SELECTORS.challenge)) ? CHALLENGE_MSG : 'Страница загрузки выглядит иначе, чем ожидалось. Завершите вручную или повторите позже.')

    h.log('Выбираю видео')
    const doc = await cdp('DOM.getDocument', { depth: 0 })
    const { nodeId } = await cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector: SELECTORS.fileInput })
    if (!nodeId) return pause('Поле выбора файла пропало. Продолжите, чтобы повторить.')
    await cdp('DOM.setFileInputFiles', { nodeId, files: [videoPath] })

    h.log('Жду окончания загрузки видео')
    const ready = await waitFor(async () => {
      if (await exists(SELECTORS.challenge)) return 'challenge'
      const enabled = await evalJs(
        `(() => { const b = document.querySelector(${J(SELECTORS.post)}); return !!b && !(b.disabled || b.getAttribute('aria-disabled') === 'true') })()`
      )
      return enabled && !(await exists(SELECTORS.uploading)) ? 'ready' : undefined
    }, h.timeoutMs ?? 15 * 60_000, 1000)
    if (ready === 'challenge') return pause(CHALLENGE_MSG)
    if (!ready) return pause('Загрузка не завершилась вовремя. Проверьте открытое окно.')

    h.log('Заполняю описание и хэштеги')
    const text = () => evalJs(`(() => { const e = document.querySelector(${J(SELECTORS.caption)}); return e ? e.innerText.replace(/\\s+/g, '') : null })()`)
    const focus = () => evalJs(`(() => { const e = document.querySelector(${J(SELECTORS.caption)}); if (!e) return false; e.focus(); return true })()`)
    const press = async (key: string, code: string, vk: number, extra: object = {}) => {
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, ...extra })
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk })
    }
    if (!(await focus())) return pause('Поле описания не найдено.')
    // TikTok pre-fills the field with the video file name: select everything and delete it.
    await press('a', 'KeyA', 65, { modifiers: 2, commands: ['selectAll'] })
    await press('Backspace', 'Backspace', 8)
    if (await text()) {
      await evalJs(`(() => { const e = document.querySelector(${J(SELECTORS.caption)}); e.focus(); document.execCommand('selectAll'); document.execCommand('delete') })()`)
      if (await text()) return pause('Не удалось очистить поле описания. Заполните его вручную и продолжите.')
    }

    // Plain text goes in as-is. Each hashtag is typed letter by letter, then its suggestion is clicked:
    // only a chosen suggestion becomes a real (highlighted) hashtag in TikTok's editor.
    const caret = () => evalJs(`(() => { const e = document.querySelector(${J(SELECTORS.caption)}); if (!e) return false; e.focus(); const s = getSelection(); s.selectAllChildren(e); s.collapseToEnd(); return true })()`)
    const typeChar = (ch: string) => evalJs(`document.execCommand('insertText', false, ${J(ch)})`)
    const pickSuggestion = (tag: string) =>
      evalJs(`(() => {
        const item = [...document.querySelectorAll(${J(SELECTORS.suggestion)})].find((e) => e.textContent.trim().toLowerCase().startsWith(${J(tag.toLowerCase())}))
        if (!item) return false
        const el = item.querySelector(${J(SELECTORS.suggestionTopic)}) || item
        const o = { bubbles: true, cancelable: true, view: window }
        for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t, o))
        return true
      })()`)
    const has = (s: string) => evalJs(`(() => { const e = document.querySelector(${J(SELECTORS.caption)}); return !!e && e.innerText.includes(${J(s)}) })()`)
    const missed: string[] = []
    async function addTag(tag: string) {
      await caret()
      await sleep(150)
      for (const ch of tag) { await typeChar(ch); await sleep(20) }
      const picked = await waitFor(async () => (await pickSuggestion(tag)) && (await sleep(300), true), Math.min(10_000, h.timeoutMs ?? 10_000), 250)
      if (picked) return
      await caret() // no suggestion: remove what was typed instead of leaving a plain-text tag
      for (let i = 0; i < tag.length; i++) { await evalJs(`document.execCommand('delete')`); await sleep(40) }
      missed.push(tag)
    }

    for (const part of caption.split(/(#[\p{L}\p{N}_]+)/u)) {
      if (/^#[\p{L}\p{N}_]+$/u.test(part)) { await addTag(part); continue }
      const lines = part.split('\n')
      for (let i = 0; i < lines.length; i++) {
        await caret()
        await sleep(120) // let the editor register the new selection before typing
        if (i) await press('Enter', 'Enter', 13, { text: '\r' })
        if (lines[i]) {
          // Same insertion path as the hashtag letters; fall back to CDP text input if the editor ignored it.
          await evalJs(`document.execCommand('insertText', false, ${J(lines[i])})`)
          const tail = lines[i].trim().slice(-12)
          if (tail && !(await has(tail))) await cdp('Input.insertText', { text: lines[i] })
        }
      }
    }
    if (missed.length) h.log(`Нет подсказки TikTok, хэштеги пропущены: ${missed.join(' ')}`)
    // Never post with the description missing: check the editor really holds the caption text.
    const plain = caption.replace(/#[\p{L}\p{N}_]+/gu, '').trim().split('\n')[0].trim()
    if (plain && !(await has(plain.slice(0, 12))))
      return pause('Описание не попало в поле. Введите его вручную в открытом окне и продолжите.')
    await sleep(500)

    h.log('Публикую')
    h.markSubmitting() // from here an automatic retry could double-post, so it is disabled
    const clicked = await evalJs(
      `(() => { const b = document.querySelector(${J(SELECTORS.post)}); if (!b || b.disabled) return false; b.click(); return true })()`
    )
    if (!clicked) return { kind: 'needs_verification', reason: 'Не удалось нажать «Опубликовать»; проверьте аккаунт вручную.' }

    // Some accounts get a "Post now?" dialog after clicking.
    await waitFor(
      () =>
        evalJs(
          `(() => { const b = document.querySelector(${J(SELECTORS.confirmDialogPost)}); if (b && /post now/i.test(b.innerText)) { b.click(); return true } return false })()`
        ),
      4000
    )

    const confirmed = await waitFor(async () => {
      if (/\/tiktokstudio\/content/.test(wc.getURL())) return 'Переход в менеджер контента'
      const m = (await pageText()).match(/video (has been )?(published|uploaded)|your video is (now )?(published|being uploaded)/i)
      return m ? `Page message: "${m[0]}"` : undefined
    }, Math.min(90_000, h.timeoutMs ?? 90_000), 1000)
    if (confirmed) return { kind: 'published', confirmation: confirmed }
    return { kind: 'needs_verification', reason: 'Подтверждение публикации не получено. Проверьте аккаунт перед повтором.' }
  } catch (e) {
    return { kind: 'failed', error: (e as Error).message }
  } finally {
    try { wc.debugger.detach() } catch { /* already detached */ }
    if (!keepOpen && !win.isDestroyed()) win.destroy()
  }
}
