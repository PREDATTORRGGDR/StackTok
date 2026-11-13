import { BrowserWindow, Session, app, clipboard, dialog, session, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { ScItem, ScState } from '../shared/types'
import { ScError, ScTrack, clientIdOf, id3Tag, looksLikeAudio, parseM3u8, parseTrack, qualityOf, scFileName, scLinkOf, scriptsOf } from './dl-soundcloud'

// In-memory guest session: SoundCloud needs no sign-in for public tracks and sees no TikTok account.
const PARTITION = 'soundcloud'
const API = 'https://api-v2.soundcloud.com'
const MAX_ITEMS = 200
const PARALLEL_FILES = 3
const PARALLEL_PARTS = 10

interface Row { pub: ScItem; track?: ScTrack; ac?: AbortController }

/** SoundCloud track downloader: reads the public track through the site's own api-v2, saves the best audio (the author's original when allowed). Started only by the user's link or button. */
export class SoundCloud {
  private rows: Row[] = []
  private dir = join(app.getPath('downloads'), 'StackTok', 'SoundCloud')
  private lastClip = ''
  private lastPush = 0
  private cid = ''
  private cidWait: Promise<string> | null = null
  private queue: Row[] = []
  private running = 0

  constructor(private win: BrowserWindow, private changed: () => void) {
    readFile(this.dirFile(), 'utf8').then((t) => { if (t.trim()) { this.dir = t.trim(); this.changed() } }, () => {})
  }

  private dirFile = () => join(app.getPath('userData'), 'soundcloud-dir.txt')
  view(): ScState { return { items: this.rows.map((r) => r.pub), dir: this.dir } }

  private notify(force = false) {
    const now = Date.now()
    if (!force && now - this.lastPush < 120) return
    this.lastPush = now
    this.changed()
  }

  private ses(): Session {
    const s = session.fromPartition(PARTITION)
    s.setUserAgent(app.userAgentFallback.replace(/\s(Electron|stacktok)\/\S+/gi, ''))
    s.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    s.setPermissionCheckHandler(() => false)
    return s
  }

  /** The id the site's own player uses: found in the scripts of the home page (they are read from the last one, where it lives). */
  private clientId(fresh = false): Promise<string> {
    if (this.cid && !fresh) return Promise.resolve(this.cid)
    if (fresh) this.cid = ''
    this.cidWait ??= (async () => {
      try {
        const html = await (await this.ses().fetch('https://soundcloud.com/', { signal: AbortSignal.timeout(15000) })).text()
        const scripts = scriptsOf(html).reverse()
        const hit = await Promise.any(scripts.map(async (u) => {
          const id = clientIdOf(await (await this.ses().fetch(u, { signal: AbortSignal.timeout(15000) })).text())
          if (!id) throw new Error('no id')
          return id
        })).catch(() => '')
        if (!hit) throw new ScError('Не удалось получить доступ к SoundCloud (сайт изменился или недоступен).')
        return (this.cid = hit)
      } finally { this.cidWait = null }
    })()
    return this.cidWait
  }

  /** GET api-v2 with the client id; a refused id is renewed once. */
  private async api(path: string, query: Record<string, string> = {}): Promise<any> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const id = await this.clientId(attempt > 0)
      const u = new URL(path.startsWith('http') ? path : API + path)
      for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v)
      u.searchParams.set('client_id', id)
      const res = await this.ses().fetch(u.href, { signal: AbortSignal.timeout(20000) })
      if ((res.status === 401 || res.status === 403) && attempt === 0) continue
      if (res.status === 404) throw new ScError('Трек не найден или закрыт автором.')
      if (res.status === 429) throw new ScError('SoundCloud просит подождать (слишком много запросов). Попробуйте через минуту.')
      if (!res.ok) throw new ScError(`SoundCloud ответил ${res.status}.`)
      return res.json()
    }
    throw new ScError('SoundCloud не принял запрос.')
  }

  async clip(): Promise<string | null> {
    const text = await clipboard.readText()
    if (!text || text === this.lastClip) return null
    this.lastClip = text
    return scLinkOf(text)
  }

  add(text: string, start: boolean): void {
    const url = scLinkOf(text)
    if (!url) throw new Error('В тексте нет ссылки на трек SoundCloud.')
    const same = this.rows.find((r) => r.pub.url === url)
    if (same && same.pub.status !== 'error') { if (start && same.pub.status === 'ready') this.start(same.pub.id); return }
    if (same) this.rows = this.rows.filter((r) => r !== same)
    const row: Row = { pub: { id: randomUUID(), url, status: 'loading', received: 0, speed: 0, pct: 0 } }
    this.rows.unshift(row)
    this.rows = this.rows.slice(0, MAX_ITEMS)
    this.notify(true)
    this.load(row, start).catch(() => {})
  }

  private fill(row: Row, t: ScTrack) {
    const orig = t.downloadable
    const best = t.cands[0]
    row.track = t
    Object.assign(row.pub, {
      status: 'ready', title: t.title, artist: t.artist, cover: t.cover || undefined, duration: t.duration, genre: t.genre || undefined, tags: t.tags, createdAt: t.createdAt,
      stats: { plays: t.plays, likes: t.likes, comments: t.comments, reposts: t.reposts }, quality: qualityOf(best, orig),
      warning: !orig && best?.preview ? 'SoundCloud отдаёт только 30-секундный фрагмент этого трека (полная версия закрыта).' : undefined
    })
  }

  private async load(row: Row, start: boolean) {
    try {
      const j = await this.api('/resolve', { url: row.pub.url })
      if (j.kind === 'playlist') {
        let list: any[] = Array.isArray(j.tracks) ? j.tracks : []
        const stubs = list.filter((x) => !x.title).map((x) => x.id)
        if (stubs.length) {
          const got = new Map<number, any>()
          for (let i = 0; i < stubs.length; i += 40) for (const x of await this.api('/tracks', { ids: stubs.slice(i, i + 40).join(',') })) got.set(x.id, x)
          list = list.map((x) => (x.title ? x : got.get(x.id) ?? x))
        }
        const tracks = list.map(parseTrack).filter((x): x is ScTrack => !!x)
        if (!tracks.length) throw new ScError('В подборке нет доступных треков.')
        const at = this.rows.indexOf(row)
        const fresh: Row[] = tracks.filter((t) => !this.rows.some((r) => r.track?.id === t.id)).map((t) => {
          const r: Row = { pub: { id: randomUUID(), url: t.permalink || row.pub.url, status: 'ready', received: 0, speed: 0, pct: 0 } }
          this.fill(r, t)
          return r
        })
        this.rows.splice(at, 1, ...fresh)
        this.rows = this.rows.slice(0, MAX_ITEMS)
        this.notify(true)
        if (start) for (const r of fresh) this.start(r.pub.id)
        return
      }
      if (j.kind !== 'track') throw new ScError('Это не ссылка на трек или подборку. Вставьте ссылку на конкретный трек.')
      const t = parseTrack(j)
      if (!t) throw new ScError('SoundCloud не отдал данные трека.')
      if (this.rows.some((r) => r !== row && r.track?.id === t.id)) { this.rows = this.rows.filter((r) => r !== row); this.notify(true); return }
      if (t.blocked && !t.cands.length) throw new ScError('Трек недоступен в вашем регионе.')
      if (!t.cands.length && !t.downloadable) throw new ScError('У трека нет доступного аудио (закрыт или только для Go+).')
      this.fill(row, t)
      this.notify(true)
      if (start) this.start(row.pub.id)
    } catch (e) {
      Object.assign(row.pub, { status: 'error', error: e instanceof ScError ? e.message : `Не удалось прочитать трек: ${(e as Error).message}` })
      this.notify(true)
    }
  }

  start(id: string) {
    const row = this.rows.find((r) => r.pub.id === id)
    if (!row?.track || !['ready', 'done', 'error'].includes(row.pub.status)) return
    row.ac = new AbortController()
    Object.assign(row.pub, { status: 'downloading', error: undefined, received: 0, speed: 0, pct: -1 })
    this.queue.push(row)
    this.notify(true)
    this.pump()
  }

  startAll() { for (const r of [...this.rows]) if (r.pub.status === 'ready') this.start(r.pub.id) }

  private pump() {
    while (this.running < PARALLEL_FILES && this.queue.length) {
      const row = this.queue.shift()!
      if (row.pub.status !== 'downloading') continue
      this.running++
      this.download(row).catch(() => {}).finally(() => { this.running--; this.pump() })
    }
  }

  /** A fresh address of the audio: the author's original if allowed, else the best stream (links expire, so they are asked at download time). */
  private async source(t: ScTrack, signal: AbortSignal): Promise<{ url: string; hls: boolean; ext: string; original: boolean }> {
    const ses = this.ses()
    if (t.downloadable) {
      try {
        const j = await this.api(`/tracks/${t.id}/download`)
        if (typeof j?.redirectUri === 'string' && /^https:\/\//.test(j.redirectUri)) {
          const ext = (/\.(mp3|wav|flac|aiff?|m4a|ogg)(\?|$)/i.exec(new URL(j.redirectUri).pathname + '?')?.[1] ?? 'mp3').toLowerCase()
          return { url: j.redirectUri, hls: false, ext, original: true }
        }
      } catch { /* no original: the stream below */ }
    }
    let err = ''
    for (const c of t.cands) {
      const id = await this.clientId()
      const u = new URL(c.url)
      u.searchParams.set('client_id', id)
      if (t.auth) u.searchParams.set('track_authorization', t.auth)
      const res = await ses.fetch(u.href, { signal })
      if (!res.ok) { err = `ответ ${res.status}`; continue }
      const j: any = await res.json().catch(() => null)
      if (typeof j?.url === 'string' && /^https:\/\//.test(j.url)) return { url: j.url, hls: c.protocol === 'hls', ext: c.ext, original: false }
    }
    throw new ScError(`SoundCloud не дал адрес файла${err ? ' (' + err + ')' : ''}. Добавьте трек заново.`)
  }

  private async download(row: Row) {
    const t = row.track!, ac = row.ac!, ses = this.ses()
    const fail = (msg: string) => { Object.assign(row.pub, { status: 'error', error: msg, speed: 0 }); this.notify(true) }
    let tmp = ''
    try {
      await mkdir(this.dir, { recursive: true })
      const src = await this.source(t, ac.signal)
      let name = scFileName(t, src.ext), n = 1
      while (existsSync(join(this.dir, name)) || existsSync(join(this.dir, name + '.part'))) name = scFileName(t, src.ext).replace(/(\.\w+)$/, ` (${++n})$1`)
      tmp = join(this.dir, name + '.part')
      const fh = await open(tmp, 'w')
      let got = 0, mark = Date.now(), markAt = 0
      const tick = (bytes: number, pct: number) => {
        got += bytes
        row.pub.received = got
        row.pub.pct = pct
        const now = Date.now()
        if (now - mark >= 500) { row.pub.speed = ((got - markAt) * 1000) / (now - mark); mark = now; markAt = got }
        this.notify()
      }
      try {
        if (src.ext === 'mp3' && !src.original) {
          let cover: Uint8Array | undefined
          if (t.cover) { try { const r = await ses.fetch(t.cover, { signal: AbortSignal.timeout(8000) }); if (r.ok) cover = new Uint8Array(await r.arrayBuffer()) } catch { /* no cover in the tag */ } }
          await fh.write(id3Tag({ title: t.title, artist: t.artist, genre: t.genre, year: t.createdAt }, cover))
        }
        if (!src.hls) {
          const res = await ses.fetch(src.url, { signal: ac.signal })
          if (!res.ok || !res.body) throw new ScError(`SoundCloud не отдал файл (ответ ${res.status}). Добавьте трек заново.`)
          const total = Number(res.headers.get('content-length')) || 0
          row.pub.size = total || undefined
          const reader = res.body.getReader()
          let first = true
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            if (first) { first = false; if (!looksLikeAudio(value)) throw new ScError('Вместо аудио пришла не та страница. Добавьте трек заново.') }
            await fh.write(value)
            tick(value.length, total ? Math.min(100, ((got + 0) / total) * 100) : -1)
          }
          if (total && got < total) throw new ScError(`Файл оборвался (${got} из ${total} байт). Нажмите «Скачать» ещё раз.`)
        } else {
          const pl = await ses.fetch(src.url, { signal: ac.signal })
          if (!pl.ok) throw new ScError(`SoundCloud не отдал список частей (ответ ${pl.status}).`)
          const m = parseM3u8(await pl.text(), src.url)
          if (m.encrypted) throw new ScError('Этот поток зашифрован, его не скачать.')
          if (!m.segs.length) throw new ScError('В потоке нет частей.')
          const urls = m.init ? [m.init, ...m.segs] : m.segs
          const parts: Promise<Uint8Array>[] = []
          let launched = 0, inflight = 0
          const get = async (u: string) => {
            for (let a = 0; a < 3; a++) {
              try {
                const r = await ses.fetch(u, { signal: ac.signal })
                if (r.ok) return new Uint8Array(await r.arrayBuffer())
              } catch (e) { if (ac.signal.aborted) throw e }
            }
            throw new ScError('Часть файла не скачалась. Нажмите «Скачать» ещё раз.')
          }
          const launch = () => {
            while (launched < urls.length && inflight < PARALLEL_PARTS) {
              const i = launched++
              inflight++
              parts[i] = get(urls[i]).finally(() => { inflight--; launch() })
              parts[i].catch(() => {})
            }
          }
          launch()
          let first = true
          for (let i = 0; i < urls.length; i++) {
            const b = await parts[i]
            if (first) { first = false; if (!looksLikeAudio(b)) throw new ScError('Вместо аудио пришла не та страница. Добавьте трек заново.') }
            await fh.write(b)
            tick(b.length, ((i + 1) / urls.length) * 100)
            delete (parts as any)[i]
          }
        }
      } finally { await fh.close() }
      if (!got) throw new ScError('Файл пустой.')
      await rename(tmp, join(this.dir, name))
      Object.assign(row.pub, { status: 'done', file: name, received: got, size: got, speed: 0, pct: 100, quality: qualityOf(t.cands[0], src.original) })
      this.notify(true)
    } catch (e) {
      if (tmp) await rm(tmp, { force: true }).catch(() => {})
      if (ac.signal.aborted) { Object.assign(row.pub, { status: 'ready', received: 0, speed: 0, pct: 0 }); this.notify(true); return }
      fail(e instanceof ScError ? e.message : `Не удалось скачать: ${(e as Error).message}`)
    }
  }

  cancel(id: string) {
    const row = this.rows.find((r) => r.pub.id === id)
    if (!row) return
    this.queue = this.queue.filter((r) => r !== row)
    if (row.pub.status === 'downloading' && !row.ac?.signal.aborted) { row.ac?.abort(); Object.assign(row.pub, { status: 'ready', received: 0, speed: 0, pct: 0 }); this.notify(true) }
  }

  remove(id: string) {
    const row = this.rows.find((r) => r.pub.id === id)
    if (!row) return
    row.ac?.abort()
    this.queue = this.queue.filter((r) => r !== row)
    this.rows = this.rows.filter((r) => r !== row)
    this.notify(true)
  }

  clear() {
    this.rows = this.rows.filter((r) => ['loading', 'downloading', 'ready'].includes(r.pub.status))
    this.notify(true)
  }

  reveal(id?: string) {
    const f = this.rows.find((r) => r.pub.id === id)?.pub.file
    if (f && existsSync(join(this.dir, basename(f)))) shell.showItemInFolder(join(this.dir, basename(f)))
    else mkdir(this.dir, { recursive: true }).then(() => shell.openPath(this.dir)).catch(() => {})
  }

  /** Full path of a saved track for the in-app player (only files this downloader wrote). */
  fileOf(id: string): string | null {
    const f = this.rows.find((r) => r.pub.id === id && r.pub.status === 'done')?.pub.file
    const path = f ? join(this.dir, basename(f)) : ''
    return path && existsSync(path) ? path : null
  }

  async pickDir() {
    const r = await dialog.showOpenDialog(this.win, { title: 'Куда сохранять треки', defaultPath: this.dir, properties: ['openDirectory', 'createDirectory'] })
    const d = r.filePaths[0]
    if (r.canceled || !d) return
    this.dir = d
    await writeFile(this.dirFile(), d, 'utf8').catch(() => {})
    this.notify(true)
  }

  stopAll() { for (const r of this.rows) r.ac?.abort() }
}
