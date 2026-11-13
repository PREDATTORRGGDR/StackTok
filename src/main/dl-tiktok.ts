// Pure part of the video downloader: link detection, reading the video page state, picking the stream. No Electron.

export class DlError extends Error {}

export interface Stream { url: string; bitrate: number; codec: string; width: number; height: number; size: number; watermark: boolean }

export interface VideoInfo {
  id: string
  author: string
  nickname: string
  desc: string
  tags: string[]
  music: string
  duration: number // seconds
  createdAt: number // unix seconds, 0 = unknown
  cover: string
  stats: { plays: number; likes: number; comments: number; shares: number; saves: number }
  stream: Stream
}

const HOST = /^(?:www\.|m\.|vm\.|vt\.)?tiktok\.com$/i

/** The first TikTok video link in a text (clipboard or input): full links, share links vm./vt./tiktok.com/t/. */
export function linkOf(text: string): string | null {
  for (const m of String(text ?? '').matchAll(/https?:\/\/[^\s<>"'«»]+/gi)) {
    let u: URL
    try { u = new URL(m[0].replace(/[)\].,;!?]+$/, '')) } catch { continue }
    if (!HOST.test(u.hostname)) continue
    const p = u.pathname
    if (/^\/@[^/]+\/(video|photo)\/\d+/.test(p) || /^\/(t|v)\/[\w-]+/.test(p) || /^\/video\/\d+/.test(p) || /^\/[\w-]{6,12}\/?$/.test(p) && /^v[mt]\./i.test(u.hostname)) {
      u.hash = ''; u.search = /^v[mt]\./i.test(u.hostname) || /^\/(t|v)\//.test(p) ? '' : u.search
      return u.href
    }
  }
  return null
}

export const videoIdOf = (url: string): string | null => /\/(?:video|photo)\/(\d{8,})/.exec(url)?.[1] ?? null

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' ? (v as Record<string, any>) : {})

/** The state TikTok embeds into the page: the video-detail scope. */
export function scopeOf(html: string): Record<string, any> | null {
  const m = /<script[^>]*id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/.exec(html)
  if (!m) return null
  try { return obj(obj(JSON.parse(m[1])).__DEFAULT_SCOPE__)['webapp.video-detail'] ?? null } catch { return null }
}

const REASON: Record<number, string> = { 10204: 'Видео не найдено или удалено.', 10222: 'Видео приватное.', 10216: 'Видео недоступно в этом регионе.', 10223: 'Видео доступно только по возрасту: нужен вход.', 10225: 'Видео недоступно.' }

/** Best stream without the watermark: the highest bitrate among the web player's renditions (H.264 first: it plays everywhere), then playAddr; the watermarked downloadAddr only as the last resort. */
export function pickStream(video: Record<string, any>): Stream | null {
  const rend: Stream[] = []
  for (const b of Array.isArray(video.bitrateInfo) ? video.bitrateInfo : []) {
    const a = obj(b.PlayAddr)
    const url = (Array.isArray(a.UrlList) ? a.UrlList : []).find((u: unknown) => typeof u === 'string' && /^https:\/\//.test(u))
    if (url) rend.push({ url, bitrate: num(b.Bitrate), codec: str(b.CodecType).toLowerCase().includes('265') || str(b.CodecType).toLowerCase().includes('hvc') ? 'h265' : 'h264', width: num(a.Width), height: num(a.Height), size: num(a.DataSize), watermark: false })
  }
  const best = (l: Stream[]) => l.sort((a, b) => b.bitrate - a.bitrate || b.size - a.size)[0]
  const h264 = rend.filter((r) => r.codec === 'h264')
  const top = best(h264.length ? h264 : rend)
  if (top) return top
  const play = str(video.playAddr)
  if (/^https:\/\//.test(play)) return { url: play, bitrate: num(video.bitrate), codec: 'h264', width: num(video.width), height: num(video.height), size: num(video.size), watermark: false }
  const down = str(video.downloadAddr)
  if (/^https:\/\//.test(down)) return { url: down, bitrate: 0, codec: 'h264', width: num(video.width), height: num(video.height), size: 0, watermark: true }
  return null
}

/** Reads a video page. Throws DlError with a user-facing reason when the page has no video. */
export function parsePage(html: string): VideoInfo {
  const scope = scopeOf(html)
  if (!scope) throw new DlError('TikTok не отдал данные страницы видео (случайный отказ или проверка). Попробуйте ещё раз.')
  const code = num(scope.statusCode)
  const item = obj(obj(scope.itemInfo).itemStruct)
  if (code && !item.id) throw new DlError(REASON[code] ?? `TikTok не показывает это видео (код ${code}).`)
  if (!item.id) throw new DlError('В странице нет видео.')
  if (obj(item.imagePost).images) throw new DlError('Это фото-карусель, а не видео: её загрузчик не берёт.')
  const video = obj(item.video)
  const stream = pickStream(video)
  if (!stream) throw new DlError('У видео нет адреса файла.')
  const tags: string[] = []
  const add = (t: unknown) => { const s = str(t).replace(/^#/, '').trim(); if (s && !tags.some((x) => x.toLowerCase() === s.toLowerCase())) tags.push(s) }
  for (const e of Array.isArray(item.textExtra) ? item.textExtra : []) add(e?.hashtagName)
  for (const c of Array.isArray(item.challenges) ? item.challenges : []) add(c?.title)
  const st = obj(item.statsV2), s0 = obj(item.stats)
  const pick = (k: string) => num(st[k] || s0[k])
  const a = obj(item.author)
  return {
    id: String(item.id), author: str(a.uniqueId) || str(item.author), nickname: str(a.nickname), desc: str(item.desc), tags, music: [str(obj(item.music).title), str(obj(item.music).authorName)].filter(Boolean).join(' — '),
    duration: num(video.duration), createdAt: num(item.createTime), cover: str(video.originCover) || str(video.cover) || str(video.dynamicCover),
    stats: { plays: pick('playCount'), likes: pick('diggCount'), comments: pick('commentCount'), shares: pick('shareCount'), saves: pick('collectCount') },
    stream
  }
}

/** A safe file name «@автор — id.mp4». */
export function fileName(info: Pick<VideoInfo, 'author' | 'id'>): string {
  const clean = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '').slice(0, 60)
  return `${clean(info.author ? '@' + info.author : 'tiktok') || 'tiktok'} - ${clean(info.id)}.mp4`
}

/** «1080×1920 · H.264 · 12,3 Мбит/с» */
export function qualityText(s: Stream): string {
  const parts: string[] = []
  if (s.width && s.height) parts.push(`${s.width}×${s.height}`)
  parts.push(s.codec === 'h265' ? 'H.265' : 'H.264')
  if (s.bitrate) parts.push(`${(s.bitrate / 1e6).toFixed(1).replace('.', ',')} Мбит/с`)
  if (s.watermark) parts.push('с водяным знаком')
  return parts.join(' · ')
}

/** Starts of an MP4/MOV (ftyp box) or WebM: anything else is an error page, not a video. */
export function looksLikeVideo(head: Uint8Array): boolean {
  if (head.length < 8) return false
  const tag = String.fromCharCode(head[4], head[5], head[6], head[7])
  return tag === 'ftyp' || tag === 'moov' || tag === 'mdat' || tag === 'free' || (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3)
}
