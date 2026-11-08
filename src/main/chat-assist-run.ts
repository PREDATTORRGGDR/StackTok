// Electron part of the chat assistant: downloads the pictures of the loaded chat (stickers, photos, video covers) through the
// account's session and lets the cheap model describe each one once. Descriptions stay in memory; pictures are never saved.
import { nativeImage, safeStorage, type Session } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ExportEntry, ExportMedia } from './chat-export-html'
import { openMedia, publicHttps, secretHeaders, sniff } from './chat-export'
import { LOOK_BATCH, LOOK_SYSTEM, SAVED_CHATS_MAX, SavedChat, Talk, cleanSaved, cleanTalks, parseLooks, pickMedia, upsertTalk } from './chat-assist'
import { Img, PsyError, Vlm, pool } from './psycho'

const EDGE = 384 // enough to read a sticker or a cover, about 200 image tokens
const RAW_MAX = 400_000 // formats Electron cannot redraw (animated WebP, GIF) go as they are, when small

async function download(ses: Session, m: ExportMedia, devOrigin?: string): Promise<Buffer | undefined> {
  for (const s of [{ src: m.src, secret: m.secret }, ...(m.alts ?? [])]) {
    if (!publicHttps(s.src, devOrigin)) continue
    try {
      let res = await ses.fetch(s.src, { credentials: 'omit', headers: secretHeaders(s.secret), signal: AbortSignal.timeout(20000) })
      if (res.status === 403) res = await ses.fetch(s.src, { credentials: 'include', headers: { ...secretHeaders(s.secret), referer: 'https://www.tiktok.com/' }, signal: AbortSignal.timeout(20000) })
      if (!res.ok) continue
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > 15 * 1024 * 1024) continue
      const plain = s.secret ? openMedia(buf, s.secret.key) : buf
      if (plain) return plain
    } catch {}
  }
}

/** A small JPEG for the model, or the file itself when it is a small picture Electron cannot redraw. */
function small(buf: Buffer): Img | undefined {
  const t = sniff(buf)
  if (!t || !t.mime.startsWith('image/')) return // mp4 stickers, Lottie and voice are described by their caption only
  const img = nativeImage.createFromBuffer(buf)
  if (!img.isEmpty()) {
    const { width, height } = img.getSize()
    const k = Math.min(1, EDGE / Math.max(width, height))
    const out = k < 1 ? img.resize({ width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), quality: 'good' }) : img
    return { media: 'image/jpeg', b64: out.toJPEG(70).toString('base64') }
  }
  return /^image\/(png|jpeg|gif|webp)$/.test(t.mime) && buf.length <= RAW_MAX ? { media: t.mime, b64: buf.toString('base64') } : undefined
}

export interface LookArgs { ses: Session; vlm: Vlm; model: string; looks: Map<string, string>; devOrigin?: string; cancelled: () => boolean; progress: (done: number, total: number) => void }

/**
 * Describes the newest pictures of the chat that are not described yet (`looks`, by address). A failed picture or batch only
 * loses its description; a bad key or empty balance stops (fatal PsyError).
 */
export async function lookAt(entries: ExportEntry[], a: LookArgs): Promise<{ described: number; failed: number }> {
  const todo = pickMedia(entries).filter((m) => !a.looks.has(m.src))
  if (!todo.length) return { described: 0, failed: 0 }
  let done = 0
  a.progress(0, todo.length)
  const imgs = await pool(todo, 8, async (m) => {
    const buf = await download(a.ses, m, a.devOrigin)
    a.progress(++done, todo.length)
    return buf ? small(buf) : undefined
  }, a.cancelled)
  const ready = todo.map((m, i) => ({ m, img: imgs[i] })).filter((x): x is { m: ExportMedia; img: Img } => !!x.img)
  const batches: (typeof ready)[] = []
  for (let i = 0; i < ready.length; i += LOOK_BATCH) batches.push(ready.slice(i, i + LOOK_BATCH))
  let described = 0
  await pool(batches, 4, async (b) => {
    const content = b.flatMap((x, i) => [
      { type: 'text' as const, text: `Картинка ${i + 1} (${x.m.kind === 'sticker' ? 'стикер' : x.m.label ? 'обложка видео или фото' : 'фото или обложка видео'}${x.m.label ? `, подпись «${x.m.label.slice(0, 60)}»` : ''}):` },
      { type: 'image' as const, source: { type: 'base64' as const, media_type: x.img.media, data: x.img.b64 } }
    ])
    try {
      const got = parseLooks(await a.vlm.ask(a.model, LOOK_SYSTEM, content, 1500, a.cancelled))
      b.forEach((x, i) => { const d = got.get(i + 1); if (d) { a.looks.set(x.m.src, d); described++ } })
    } catch (e) {
      if (e instanceof PsyError && e.fatal) throw e // the key or the balance: no point going on
    }
  }, a.cancelled)
  return { described, failed: todo.length - described }
}

/** A list kept in one OS-encrypted file (safeStorage). Without OS encryption it lives only in memory: never written in plain text. */
class Sealed<T> {
  list: T[] = []
  readonly saves: boolean
  private timer?: NodeJS.Timeout
  constructor(private file: string, clean: (raw: unknown) => T[]) {
    this.saves = safeStorage.isEncryptionAvailable()
    try { if (this.saves && existsSync(file)) this.list = clean(JSON.parse(safeStorage.decryptString(readFileSync(file)))) } catch { this.list = [] }
  }
  remove(pred: (t: T) => boolean) { const n = this.list.length; this.list = this.list.filter((t) => !pred(t)); if (this.list.length !== n) this.later() }
  protected later() {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 400)
  }
  flush() {
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.saves) return
    try {
      if (!this.list.length) { rmSync(this.file, { force: true }); return }
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file + '.tmp', safeStorage.encryptString(JSON.stringify(this.list)))
      renameSync(this.file + '.tmp', this.file)
    } catch {}
  }
}

/** The assistant's conversations (questions and answers), `userData/assist-history.bin`. */
export class TalkBox extends Sealed<Talk> {
  constructor(file: string) { super(file, cleanTalks) }
  get(id?: string) { return id ? this.list.find((t) => t.id === id) : undefined }
  put(t: Talk) { this.list = upsertTalk(this.list, t); this.later() }
}

/** Copies of the chats the user asked about, `userData/assist-chats.bin`: an old conversation goes on without loading the chat again. */
export class ChatCopies extends Sealed<SavedChat> {
  constructor(file: string) { super(file, cleanSaved) }
  get(chat?: string) { return chat ? this.list.find((c) => c.chat === chat) : undefined }
  put(c: SavedChat) {
    const old = this.get(c.chat)
    if (old && old.at === c.at && old.system === c.system) return
    this.list = [c, ...this.list.filter((x) => x.chat !== c.chat)].slice(0, SAVED_CHATS_MAX)
    this.later()
  }
}
