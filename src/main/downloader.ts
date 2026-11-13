import { BrowserWindow, Session, app, clipboard, dialog, session, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { DlItem, DlState } from '../shared/types'
import { DlError, Stream, fileName, linkOf, looksLikeVideo, parsePage, qualityText, videoIdOf } from './dl-tiktok'

// No "persist:": the guest session lives in memory only and is shared with no TikTok account.
const PARTITION = 'downloader'
const MAX_ITEMS = 100
const REFERER = 'https://www.tiktok.com/'

interface Row { pub: DlItem; stream?: Stream; ses?: Session; ac?: AbortController; infoId?: string }

/** Our own TikTok video downloader: reads the public video page, takes the best stream without the watermark and saves it as is. Started only by the user's click or a link they copied. */
export class Downloader {
  private rows: Row[] = []
  private dir = join(app.getPath('downloads'), 'StackTok')
  private lastClip = ''
  private lastPush = 0

  constructor(private win: BrowserWindow, private changed: () => void, private accountSessions: () => Session[]) {
    readFile(this.dirFile(), 'utf8').then((t) => { if (t.trim()) { this.dir = t.trim(); this.changed() } }, () => {})
  }

  private dirFile = () => join(app.getPath('userData'), 'downloader-dir.txt')

  view(): DlState {
    return { items: this.rows.map((r) => r.pub), dir: this.dir }
  }

  private notify(force = false) {
    const now = Date.now()
    if (!force && now - this.lastPush < 120) return
    this.lastPush = now
    this.changed()
  }

  private guest(): Session {
    const ses = session.fromPartition(PARTITION)
    ses.setUserAgent(app.userAgentFallback.replace(/\s(Electron|stacktok)\/\S+/gi, ''))
    ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
    ses.setPermissionCheckHandler(() => false)
    return ses
  }

  /** The link in the clipboard if it is new since the last look (the same text is offered once). */
  async clip(): Promise<string | null> {
    const text = await clipboard.readText()
    if (!text || text === this.lastClip) return null
    this.lastClip = text
    return linkOf(text)
  }

  /** Adds a video by a link found in the text; with `start` the file is also downloaded as soon as the page is read. */
  add(text: string, start: boolean): void {
    const url = linkOf(text)
    if (!url) throw new Error('В тексте нет ссылки на видео TikTok.')
    const vid = videoIdOf(url)
    const same = this.rows.find((r) => r.pub.url === url || (vid && r.infoId === vid))
    if (same && same.pub.status !== 'error') { if (start && same.pub.status === 'ready') this.start(same.pub.id); return }
    if (same) this.rows = this.rows.filter((r) => r !== same)
    const row: Row = { pub: { id: randomUUID(), url, status: 'loading', received: 0, speed: 0 } }
    this.rows.unshift(row)
    this.rows = this.rows.slice(0, MAX_ITEMS)
    this.notify(true)
    this.load(row, start)
  }

  private async load(row: Row, start: boolean) {
    try {
      let err: Error | undefined
      for (const ses of [this.guest(), ...this.accountSessions()]) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await ses.fetch(row.pub.url, { credentials: 'include', headers: { 'accept-language': 'en-US,en;q=0.9' }, signal: AbortSignal.timeout(20000) })
            if (!res.ok) throw new DlError(`TikTok ответил ${res.status}.`)
            const info = parsePage(await res.text())
            const dup = this.rows.find((r) => r !== row && r.infoId === info.id)
            if (dup) { this.rows = this.rows.filter((r) => r !== row); this.notify(true); if (start && dup.pub.status === 'ready') this.start(dup.pub.id); return }
            row.infoId = info.id
            row.stream = info.stream
            row.ses = ses
            Object.assign(row.pub, {
              status: 'ready', author: info.author, nickname: info.nickname, desc: info.desc, tags: info.tags, music: info.music, duration: info.duration, createdAt: info.createdAt,
              cover: /^https:\/\//.test(info.cover) ? info.cover : undefined, stats: info.stats, quality: qualityText(info.stream), size: info.stream.size,
              warning: info.stream.watermark ? 'Файл без водяного знака не нашёлся, будет версия с водяным знаком.' : undefined
            })
            this.notify(true)
            if (start) this.start(row.pub.id)
            return
          } catch (e) {
            const dead = e instanceof DlError && !/данные страницы|ответил/.test(e.message) // «не найдено», «приватное»: повтор не поможет
            if (!err || !(e instanceof DlError && /данные страницы|ответил/.test(e.message))) err = e as Error
            if (dead) break
          }
        }
      }
      throw err ?? new DlError('Не удалось прочитать страницу видео.')
    } catch (e) {
      Object.assign(row.pub, { status: 'error', error: (e as Error).message || 'Не удалось прочитать страницу видео.' })
      this.notify(true)
    }
  }

  start(id: string) {
    const row = this.rows.find((r) => r.pub.id === id)
    if (!row?.stream || !row.ses || (row.pub.status !== 'ready' && row.pub.status !== 'done' && row.pub.status !== 'error')) return
    row.ac = new AbortController()
    Object.assign(row.pub, { status: 'downloading', error: undefined, received: 0, speed: 0 })
    this.notify(true)
    this.download(row).catch(() => {})
  }

  startAll() {
    for (const r of [...this.rows]) if (r.pub.status === 'ready') this.start(r.pub.id)
  }

  private async download(row: Row) {
    const { stream, ses, ac } = row
    const fail = (msg: string) => { Object.assign(row.pub, { status: 'error', error: msg, speed: 0 }); this.notify(true) }
    let tmp = ''
    try {
      await mkdir(this.dir, { recursive: true })
      let name = fileName({ author: row.pub.author ?? '', id: row.infoId ?? row.pub.id }), n = 1
      while (existsSync(join(this.dir, name)) || existsSync(join(this.dir, name + '.part'))) name = fileName({ author: row.pub.author ?? '', id: row.infoId ?? row.pub.id }).replace(/\.mp4$/, ` (${++n}).mp4`)
      tmp = join(this.dir, name + '.part')
      const res = await ses!.fetch(stream!.url, { credentials: 'include', headers: { referer: REFERER }, signal: ac!.signal })
      if (!res.ok || !res.body) return fail(`TikTok не отдал файл (ответ ${res.status}). Ссылка могла устареть: добавьте видео заново.`)
      const total = Number(res.headers.get('content-length')) || 0
      row.pub.size = total || row.pub.size
      const fh = await open(tmp, 'w')
      let got = 0, first = true, mark = Date.now(), markAt = 0
      try {
        const reader = res.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (first) { first = false; if (!looksLikeVideo(value)) throw new DlError('Вместо видео пришла не та страница. Добавьте видео заново.') }
          await fh.write(value)
          got += value.length
          row.pub.received = got
          const now = Date.now()
          if (now - mark >= 500) { row.pub.speed = ((got - markAt) * 1000) / (now - mark); mark = now; markAt = got }
          this.notify()
        }
      } finally { await fh.close() }
      if (total && got < total) throw new DlError(`Файл оборвался (${got} из ${total} байт). Нажмите «Скачать» ещё раз.`)
      if (!got) throw new DlError('Файл пустой.')
      await rename(tmp, join(this.dir, name))
      Object.assign(row.pub, { status: 'done', file: name, received: got, size: got, speed: 0 })
      this.notify(true)
    } catch (e) {
      if (tmp) await rm(tmp, { force: true }).catch(() => {})
      if (ac?.signal.aborted) { Object.assign(row.pub, { status: 'ready', received: 0, speed: 0 }); this.notify(true); return }
      fail(e instanceof DlError ? e.message : `Не удалось скачать: ${(e as Error).message}`)
    }
  }

  cancel(id: string) {
    this.rows.find((r) => r.pub.id === id)?.ac?.abort()
  }

  remove(id: string) {
    const row = this.rows.find((r) => r.pub.id === id)
    if (!row) return
    row.ac?.abort()
    this.rows = this.rows.filter((r) => r !== row)
    this.notify(true)
  }

  /** Drops finished and failed items from the list (the files stay). */
  clear() {
    this.rows = this.rows.filter((r) => r.pub.status === 'loading' || r.pub.status === 'downloading' || r.pub.status === 'ready')
    this.notify(true)
  }

  reveal(id?: string) {
    const f = this.rows.find((r) => r.pub.id === id)?.pub.file
    if (f && existsSync(join(this.dir, f))) shell.showItemInFolder(join(this.dir, f))
    else { mkdir(this.dir, { recursive: true }).then(() => shell.openPath(this.dir)).catch(() => {}) }
  }

  /** Opens the file in the default player; if the system has none for this type (or refuses), shows it in the folder and says so. */
  async play(id: string) {
    const f = this.rows.find((r) => r.pub.id === id)?.pub.file
    const path = f ? join(this.dir, basename(f)) : ''
    if (!path || !existsSync(path)) throw new Error('Файл не найден: его могли переместить или удалить.')
    const err = await shell.openPath(path)
    if (err) { shell.showItemInFolder(path); throw new Error('Не нашлось программы для этого файла, показываю его в папке.') }
  }

  async pickDir() {
    const r = await dialog.showOpenDialog(this.win, { title: 'Куда сохранять видео', defaultPath: this.dir, properties: ['openDirectory', 'createDirectory'] })
    const d = r.filePaths[0]
    if (r.canceled || !d) return
    this.dir = d
    await writeFile(this.dirFile(), d, 'utf8').catch(() => {})
    this.notify(true)
  }

  stopAll() {
    for (const r of this.rows) r.ac?.abort()
  }
}
