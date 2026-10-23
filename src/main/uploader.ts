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
  uploading: '[class*="uploading" i], [role="progressbar"]'
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

    h.log('Opening upload page')
    await wc.loadURL(h.uploadUrl ?? UPLOAD_URL)
    if (/\/login/i.test(wc.getURL())) return pause('Перенаправление на вход. Войдите на вкладке «Обзор» и продолжите.')

    if (!(await waitFor(() => exists(SELECTORS.fileInput), Math.min(60_000, h.timeoutMs ?? 60_000))))
      return pause((await exists(SELECTORS.challenge)) ? CHALLENGE_MSG : 'Страница загрузки выглядит иначе, чем ожидалось. Завершите вручную или повторите позже.')

    h.log('Selecting video')
    const doc = await cdp('DOM.getDocument', { depth: 0 })
    const { nodeId } = await cdp('DOM.querySelector', { nodeId: doc.root.nodeId, selector: SELECTORS.fileInput })
    if (!nodeId) return pause('Поле выбора файла пропало. Продолжите, чтобы повторить.')
    await cdp('DOM.setFileInputFiles', { nodeId, files: [videoPath] })

    h.log('Waiting for upload to finish')
    const ready = await waitFor(async () => {
      if (await exists(SELECTORS.challenge)) return 'challenge'
      const enabled = await evalJs(
        `(() => { const b = document.querySelector(${J(SELECTORS.post)}); return !!b && !(b.disabled || b.getAttribute('aria-disabled') === 'true') })()`
      )
      return enabled && !(await exists(SELECTORS.uploading)) ? 'ready' : undefined
    }, h.timeoutMs ?? 15 * 60_000, 1000)
    if (ready === 'challenge') return pause(CHALLENGE_MSG)
    if (!ready) return pause('Загрузка не завершилась вовремя. Проверьте открытое окно.')

    h.log('Filling caption')
    const focused = await evalJs(
      `(() => { const e = document.querySelector(${J(SELECTORS.caption)}); if (!e) return false; e.focus(); document.execCommand('selectAll'); return true })()`
    )
    if (!focused) return pause('Поле описания не найдено.')
    const lines = caption.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (i) {
        const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }
        await cdp('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...key })
        await cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
      }
      if (lines[i]) await cdp('Input.insertText', { text: lines[i] })
    }
    await sleep(500)

    h.log('Submitting')
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
