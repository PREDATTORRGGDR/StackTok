// Electron side of the repost portrait: the API key box, the account page's requests, cover download and frames, saving the deck.
import { nativeImage, safeStorage, type Session, type WebContents } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { PsyJob } from '../shared/types'
import { Cover, Deps, Img, PAGE_SIZE, PageReply, PsyError, RepostItem, Vlm, analyze, pool, type Provider, type Subject } from './psycho'
import { renderDeck } from './psycho-html'
import { js, whoAmI } from './reposts'

/** The API key, encrypted with the OS (DPAPI on Windows) in its own file. It is never written in plain text and never sent to the UI. */
export class KeyBox {
  constructor(private file: string) {}
  has(): boolean { return existsSync(this.file) }
  get(): string | null {
    try { return this.has() && safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(readFileSync(this.file)) : null } catch { return null }
  }
  set(key: string): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Система не даёт зашифровать ключ, поэтому он не сохранён.')
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, safeStorage.encryptString(key))
    renameSync(tmp, this.file)
  }
  clear(): void { rmSync(this.file, { force: true }) }
}

// ───────── code that runs inside the account's TikTok page (serialised with toString: no outer scope) ─────────
const listPage = async ({ secUid, cursor, count }: { secUid: string; cursor: string; count: number }) => {
  const p = new URLSearchParams({ aid: '1988', count: String(count), coverFormat: '2', cursor, needPinnedItemIds: 'true', post_item_list_request_type: '0', secUid })
  try {
    const r = await fetch('/api/repost/item_list/?' + p, { credentials: 'include' })
    const j = await r.json().catch(() => null)
    const str = (v: unknown) => (typeof v === 'string' ? v : '')
    const items = ((j && j.itemList) || []).map((x: any) => {
      const au = x.author && typeof x.author === 'object' ? x.author : {}
      const v = x.video || {}
      return {
        id: String(x.id), desc: str(x.desc), time: Number(x.createTime) || 0,
        author: str(au.uniqueId) || (typeof x.author === 'string' ? x.author : ''), nick: str(au.nickname),
        cover: str(v.originCover) || str(v.cover) || str(x.imagePost?.cover?.imageURL?.urlList?.[0]), cover2: str(v.cover),
        dur: Number(v.duration) || 0, music: str(x.music?.title),
        tags: ((x.textExtra || []) as any[]).filter((e) => e && e.hashtagName).map((e) => String(e.hashtagName)),
        plays: Number(x.stats?.playCount) || 0, play: str(v.playAddr) || str(v.downloadAddr), photo: !!x.imagePost
      }
    })
    return { http: r.status, code: j ? (j.status_code ?? 0) : -1, msg: (j && j.status_msg) || '', items, hasMore: !!(j && j.hasMore), cursor: j && j.cursor != null ? String(j.cursor) : cursor }
  } catch (e) {
    return { http: 0, code: -1, msg: String(e), items: [], hasMore: false, cursor }
  }
}

/** Cuts frames out of a video inside the page: the file comes in as a blob, so the canvas is not tainted. Any failure gives []. */
const grabFrames = async ({ url, marks, maxBytes }: { url: string; marks: number[]; maxBytes: number }) => {
  try {
    const r = await fetch(url, { credentials: 'include' })
    if (!r.ok || Number(r.headers.get('content-length') || 0) > maxBytes) return []
    const blob = await r.blob()
    if (blob.size > maxBytes) return []
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'auto'
    v.src = URL.createObjectURL(blob)
    await new Promise<void>((res, rej) => { v.onloadedmetadata = () => res(); v.onerror = () => rej(new Error('video')); setTimeout(() => rej(new Error('timeout')), 8000) })
    const c = document.createElement('canvas')
    c.width = 360
    c.height = Math.round((360 * (v.videoHeight || 640)) / (v.videoWidth || 360))
    const ctx = c.getContext('2d')!
    const out: string[] = []
    for (const m of marks) {
      v.currentTime = Math.max(0.1, (v.duration || 1) * m)
      await new Promise<void>((res) => { v.onseeked = () => res(); setTimeout(res, 3000) })
      ctx.drawImage(v, 0, 0, c.width, c.height)
      out.push(c.toDataURL('image/jpeg', 0.6).split(',')[1])
    }
    URL.revokeObjectURL(v.src)
    return out
  } catch {
    return []
  }
}

/**
 * Finds a public profile by its name, signed in or not. Three ways, in order: the data TikTok embedded in the page that is open now
 * (when it is this profile), the same data in the HTML of the profile page, and the detail endpoint. `tried` says what each one gave,
 * so a failure is readable. `priv` = the account is closed (its reposts are not visible).
 */
const userDetail = async (uniqueId: string) => {
  const want = uniqueId.toLowerCase()
  const tried: string[] = []
  type Found = { code: number; uniqueId: string; secUid: string; priv: boolean }
  const read = (json: string): Found | null => {
    try {
      const d = JSON.parse(json).__DEFAULT_SCOPE__?.['webapp.user-detail']
      const u = d?.userInfo?.user
      const code = Number(d?.statusCode ?? 0)
      if (u && u.secUid) return { code, uniqueId: String(u.uniqueId || ''), secUid: String(u.secUid), priv: !!(u.privateAccount || u.secret) || code === 10222 }
      return { code, uniqueId: '', secUid: '', priv: code === 10222 }
    } catch { return null }
  }
  const ok = (f: Found | null) => !!f && !!f.secUid && f.uniqueId.toLowerCase() === want
  const out = (f: Found, via: string) => ({ http: 200, code: f.code, uniqueId: f.uniqueId, secUid: f.secUid, priv: f.priv, via, tried: tried.join(' ') })

  // 1) the page that is open now
  try {
    const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')
    const f = el ? read(el.textContent || '') : null
    tried.push('страница:' + (f ? (ok(f) ? 'есть' : f.uniqueId ? 'другой профиль' : 'без профиля') : 'нет'))
    if (f && ok(f)) return out(f, 'page')
  } catch { tried.push('страница:ошибка') }
  // 2) the HTML of the profile page
  let http = 0
  try {
    const r = await fetch('/@' + encodeURIComponent(uniqueId), { credentials: 'include' })
    http = r.status
    const m = r.ok ? (await r.text()).match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/) : null
    const f = m ? read(m[1]) : null
    tried.push('html:' + r.status + (f ? '/' + f.code : ''))
    if (f && (ok(f) || f.priv)) return out(f, 'html')
  } catch { tried.push('html:ошибка') }
  // 3) the detail endpoint, with the parameters the web client sends
  try {
    const p = new URLSearchParams({
      aid: '1988', app_language: 'ru', app_name: 'tiktok_web', browser_language: navigator.language || 'ru-RU', browser_name: 'Mozilla', browser_online: 'true',
      browser_platform: navigator.platform || 'Win32', channel: 'tiktok_web', cookie_enabled: 'true', device_platform: 'web_pc', from_page: 'user',
      language: 'ru', os: 'windows', screen_height: String(screen.height), screen_width: String(screen.width), uniqueId, webcast_language: 'ru'
    })
    const r = await fetch('/api/user/detail/?' + p, { credentials: 'include' })
    http = r.status
    const j: any = await r.json().catch(() => null)
    const u = j && j.userInfo && j.userInfo.user
    const code = j ? Number(j.statusCode ?? j.status_code ?? 0) : -1
    tried.push('api:' + r.status + '/' + code)
    if (u && u.secUid) return { http: r.status, code, uniqueId: String(u.uniqueId || ''), secUid: String(u.secUid), priv: !!(u.privateAccount || u.secret) || code === 10222, via: 'api', tried: tried.join(' ') }
    return { http: r.status, code, uniqueId: '', secUid: '', priv: code === 10222, via: '', tried: tried.join(' ') }
  } catch {
    tried.push('api:ошибка')
    return { http, code: -1, uniqueId: '', secUid: '', priv: false, via: '', tried: tried.join(' ') }
  }
}

// ───────── covers ─────────
const publicHttps = (u: string, devOrigin?: string) => { try { const h = new URL(u); if (devOrigin && h.origin === devOrigin) return true; return h.protocol === 'https:' && h.hostname.includes('.') && !/^[\d.]+$/.test(h.hostname) && !/(^|\.)localhost$/.test(h.hostname) } catch { return false } }
const isWebp = (b: Buffer) => b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'
const LONG_EDGE = 640 // enough to read text on a cover, about 300 image tokens
const THUMB_H = 150

/** Shrinks a downloaded cover to something cheap for the model plus a small thumbnail for the report. WebP is passed on as it is when small. */
export function shrink(buf: Buffer): Cover | null {
  const img = nativeImage.createFromBuffer(buf)
  if (!img.isEmpty()) {
    const { width, height } = img.getSize()
    const k = Math.min(1, LONG_EDGE / Math.max(width, height))
    const small = k < 1 ? img.resize({ width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), quality: 'good' }) : img
    const th = img.resize({ height: Math.min(THUMB_H, height), quality: 'good' }).toJPEG(60)
    return { media: 'image/jpeg', b64: small.toJPEG(72).toString('base64'), thumb: 'data:image/jpeg;base64,' + th.toString('base64') }
  }
  return isWebp(buf) && buf.length <= 400_000 ? { media: 'image/webp', b64: buf.toString('base64') } : null
}

async function fetchCover(ses: Session, it: RepostItem, devOrigin?: string): Promise<Cover | null> {
  for (const url of new Set([it.cover2, it.cover])) {
    if (!url || !publicHttps(url, devOrigin)) continue
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let r = await ses.fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(30000) })
        if (r.status === 403) r = await ses.fetch(url, { credentials: 'include', headers: { referer: 'https://www.tiktok.com/' }, signal: AbortSignal.timeout(30000) }) // some covers want the page as referrer
        if (!r.ok) break
        const buf = Buffer.from(await r.arrayBuffer())
        if (buf.length > 0 && buf.length < 8_000_000) { const c = shrink(buf); if (c) return c }
        break
      } catch { /* one more try */ }
    }
  }
  return null
}

// ───────── the run ─────────
export interface RunArgs {
  wc: WebContents
  ses: Session
  base: string // https://www.tiktok.com
  username?: string // own-account mode: confirmed account name; the session must belong to it
  target?: string // any public profile by its name; no sign-in needed
  owner: { name: string; handle?: string }
  provider: Provider
  visionModel: string
  synthModel: string
  frames: boolean
  limit: number
  subject?: Subject
  job: PsyJob
  onChange: () => void
  cancelled: () => boolean
  path: string // where the presentation is written (chosen by the user before the run starts)
  fetchFn?: typeof fetch
  devOrigin?: string // dev builds only: the mock site whose covers are allowed
}

const FRAME_VIDEOS = 48 // frames are heavy (a whole video each): only for this many
const FRAME_THREADS = 4
const FRAME_MAX_BYTES = 9_000_000

export async function runPortrait(a: RunArgs): Promise<PsyJob> {
  const { job } = a
  const set = (p: Partial<PsyJob>) => { Object.assign(job, p); a.onChange() }
  const vlm = new Vlm(a.provider, a.fetchFn)
  const tok = (): Partial<PsyJob> => ({ tokens: vlm.usage.inTok + vlm.usage.outTok, inTok: vlm.usage.inTok, outTok: vlm.usage.outTok, calls: vlm.usage.calls }) // the app's usage counter reads the split
  const fail = (message: string) => { set({ status: 'stopped', message, finishedAt: Date.now(), ...tok() }); return job }
  try {
    if (!a.wc.getURL().startsWith(a.base)) await a.wc.loadURL(a.base + '/').catch(() => {})
    let me: { uniqueId: string; secUid: string } | null
    if (a.target) {
      const d = await js<{ http: number; code: number; uniqueId: string; secUid: string; priv: boolean; via: string; tried: string }>(a.wc, userDetail, a.target)
      if (d.http === 403 || d.http === 429 || [10202, 10214].includes(d.code)) return fail('TikTok просит проверку или притормозить. Откройте TikTok на вкладке «Обзор», пройдите проверку и повторите позже.')
      if (!d.secUid && !d.priv) return fail(`Профиль @${a.target} не найден (или TikTok не отдал его без входа). Что ответил TikTok: ${d.tried || 'ничего'}. Если имя верное, откройте этот профиль в «Обзоре» (или войдите в аккаунт) и повторите.`)
      if (d.priv) return fail(`Профиль @${d.uniqueId || a.target} закрытый: его репосты не видны. Ничего не отправлено. Если имя указано неверно: «Аккаунты» → меню аккаунта (…) → «Подтвердить заново».`)
      me = { uniqueId: d.uniqueId || a.target, secUid: d.secUid }
    } else {
      me = await js<{ uniqueId: string; secUid: string } | null>(a.wc, whoAmI)
      if (!me) return fail('Не удалось определить аккаунт TikTok. Откройте «Обзор», убедитесь, что вход выполнен, и попробуйте снова.')
      if (a.username && me.uniqueId.toLowerCase() !== a.username.toLowerCase()) return fail(`В этой сессии вошли как @${me.uniqueId}, а не @${a.username}. Ничего не отправлено.`)
    }

    let framesLeft = a.frames ? FRAME_VIDEOS : 0
    let active = 0
    const waiters: (() => void)[] = []
    const slot = async () => { while (active >= FRAME_THREADS) await new Promise<void>((r) => waiters.push(r)); active++ }
    const free = () => { active--; waiters.shift()?.() }

    const deps: Deps = {
      page: (cursor) => js<PageReply>(a.wc, listPage, { secUid: me.secUid, cursor, count: PAGE_SIZE }),
      cover: (it) => fetchCover(a.ses, it, a.devOrigin),
      frames: a.frames ? async (it): Promise<Img[]> => {
        if (framesLeft <= 0 || !it.play || it.photo || !publicHttps(it.play)) return []
        framesLeft--
        await slot()
        try { return (await js<string[]>(a.wc, grabFrames, { url: it.play, marks: [0.35, 0.7], maxBytes: FRAME_MAX_BYTES })).map((b64) => ({ media: 'image/jpeg', b64 })) } finally { free() }
      } : undefined,
      vlm,
      progress: (p) => set({ phase: p.phase, done: p.done, total: p.total, message: p.message, ...tok() }),
      cancelled: a.cancelled
    }
    const res = await analyze(deps, { limit: a.limit, frames: a.frames, visionModel: a.visionModel, synthModel: a.synthModel, subject: a.subject })

    set({ phase: 'save', message: 'Собираю презентацию…', ...tok() })
    const thumbs = new Map<number, string>()
    const want = new Set(res.report.evidence.map((e) => e.i))
    for (const [i, c] of res.covers) if (c.thumb && (want.has(i) || thumbs.size < 60)) thumbs.set(i, c.thumb)
    const html = renderDeck({ owner: a.owner, report: res.report, stats: res.stats, items: res.items, thumbs, warnings: res.warnings, generatedAt: Date.now() })
    const path = a.path
    await writeFile(path, html, 'utf8')
    set({ status: 'done', message: res.warnings.length ? res.warnings.join(' ') : 'Презентация готова.', path, finishedAt: Date.now(), ...tok() })
    return job
  } catch (e) {
    return fail(e instanceof PsyError ? e.message : `Ошибка: ${(e as Error).message}`)
  }
}

/**
 * Several API keys, one per profile id, in one OS-encrypted file. The key saved before profiles existed
 * (`psy-key.bin`) moves into the profile `legacyId` once. Without OS encryption nothing is saved.
 */
export class KeyRing {
  private keys: Record<string, string> = {}
  constructor(private file: string, legacy?: { file: string; id: string }) {
    try { if (existsSync(file) && safeStorage.isEncryptionAvailable()) this.keys = JSON.parse(safeStorage.decryptString(readFileSync(file))) ?? {} } catch { this.keys = {} }
    if (legacy && existsSync(legacy.file)) {
      const old = new KeyBox(legacy.file).get()
      if (old && !this.keys[legacy.id]) { try { this.set(legacy.id, old) } catch { return } }
      if (this.keys[legacy.id] === old) rmSync(legacy.file, { force: true })
    }
  }
  has(id: string): boolean { return typeof this.keys[id] === 'string' && !!this.keys[id] }
  get(id: string): string | null { return this.has(id) ? this.keys[id] : null }
  ids(): string[] { return Object.keys(this.keys).filter((k) => this.has(k)) }
  set(id: string, key: string): void {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Система не даёт зашифровать ключ, поэтому он не сохранён.')
    this.keys = { ...this.keys, [id]: key }
    this.write()
  }
  clear(id: string): void { const { [id]: _, ...rest } = this.keys; this.keys = rest; this.write() }
  private write() {
    if (!Object.keys(this.keys).length) { rmSync(this.file, { force: true }); return }
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file + '.tmp', safeStorage.encryptString(JSON.stringify(this.keys)))
    renameSync(this.file + '.tmp', this.file)
  }
}
