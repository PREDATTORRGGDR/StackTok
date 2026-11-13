// Pure part of the SoundCloud downloader: link detection, reading api-v2 track objects, picking the stream, HLS playlist, ID3 tag. No Electron.

export class ScError extends Error {}

export interface Cand { url: string; protocol: 'progressive' | 'hls'; ext: string; bitrate: number; codec: string; preview: boolean; premium: boolean }

export interface ScTrack {
  id: number
  title: string
  artist: string
  permalink: string
  duration: number // seconds
  cover: string
  genre: string
  tags: string[]
  createdAt: string
  plays: number
  likes: number
  comments: number
  reposts: number
  downloadable: boolean // the original file can be taken
  auth: string // track_authorization for the stream links
  blocked: boolean
  cands: Cand[]
}

const RESERVED = new Set(['discover', 'search', 'you', 'upload', 'stream', 'charts', 'pages', 'terms-of-use', 'imprint', 'jobs', 'people', 'mobile', 'popular', 'tags', 'settings', 'messages', 'notifications', 'feed', 'creators', 'go', 'download', 'legal', 'press', 'community-guidelines', 'privacy'])

/** The first SoundCloud track or set link in a text: soundcloud.com/artist/track, /artist/sets/name, on.soundcloud.com/xxxx. */
export function scLinkOf(text: string): string | null {
  for (const m of String(text ?? '').matchAll(/https?:\/\/[^\s<>"'«»]+/gi)) {
    let u: URL
    try { u = new URL(m[0].replace(/[)\].,;!?]+$/, '')) } catch { continue }
    const host = u.hostname.toLowerCase()
    const parts = u.pathname.split('/').filter(Boolean)
    if (host === 'on.soundcloud.com' && parts.length >= 1) return `https://on.soundcloud.com/${parts[0]}`
    if (!/^(www\.|m\.)?soundcloud\.com$/.test(host)) continue
    if (parts.length < 2 || RESERVED.has(parts[0].toLowerCase())) continue
    if (['likes', 'reposts', 'tracks', 'albums', 'popular-tracks', 'comments', 'following', 'followers', 'spotlight'].includes(parts[1].toLowerCase()) && parts.length === 2) continue
    if (parts[1].toLowerCase() === 'sets' && parts.length < 3) continue
    return `https://soundcloud.com/${parts.slice(0, parts[1].toLowerCase() === 'sets' ? 4 : 3).map((p) => encodeURIComponent(decodeURIComponent(p))).join('/')}`
  }
  return null
}

/** Script addresses of the site's page (the client id lives in one of them). */
export function scriptsOf(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/<script[^>]+src="(https:\/\/[^"]+\.js)"/g)) out.push(m[1])
  return out
}

export function clientIdOf(js: string): string | null {
  return /[,{]client_id\s*:\s*"([a-zA-Z0-9]{32})"/.exec(js)?.[1] ?? /client_id["']?\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/.exec(js)?.[1] ?? null
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' ? (v as Record<string, any>) : {})

/** Audio formats the track offers. DRM ones (ctr-, cbc-) are skipped; 30-second previews are marked. */
export function candsOf(track: Record<string, any>): Cand[] {
  const out: Cand[] = []
  for (const t of Array.isArray(obj(track.media).transcodings) ? obj(track.media).transcodings : []) {
    const url = str(t?.url)
    if (!/^https:\/\//.test(url)) continue
    const f = obj(t.format), proto = str(f.protocol)
    if (/^(ctr|cbc)-/.test(proto)) continue
    const hls = proto.includes('hls') || /\/hls(\?|$)/.test(url)
    if (proto.includes('encrypted')) continue
    const mime = str(f.mime_type).toLowerCase(), preset = str(t.preset).toLowerCase()
    if (preset.startsWith('abr') || mime.includes('mpegurl')) continue // adaptive master playlist, not audio
    const codec = /opus/.test(mime) || preset.startsWith('opus') ? 'opus' : /mp4a|aac/.test(mime) || preset.startsWith('aac') ? 'aac' : 'mp3'
    const k = /(\d+)k/.exec(preset)?.[1]
    const bitrate = k ? Number(k) : codec === 'opus' ? 64 : codec === 'mp3' ? 128 : 0
    out.push({ url, protocol: hls ? 'hls' : 'progressive', ext: codec === 'opus' ? 'opus' : codec === 'aac' ? 'm4a' : 'mp3', bitrate, codec, preview: !!t.snipped || /\/preview\b|\/0\/30\//.test(url), premium: str(t.quality) === 'hq' })
  }
  // full tracks before previews, then the highest bitrate, a plain file before a playlist of pieces
  return out.sort((a, b) => Number(a.preview) - Number(b.preview) || b.bitrate - a.bitrate || Number(a.protocol === 'hls') - Number(b.protocol === 'hls'))
}

export function tagsOf(list: string): string[] {
  const out: string[] = []
  for (const m of String(list ?? '').matchAll(/"([^"]+)"|(\S+)/g)) { const t = (m[1] ?? m[2]).trim(); if (t && !out.includes(t)) out.push(t) }
  return out
}

/** Reads a track object of api-v2. Returns null for a stub that has only the id (playlists carry such). */
export function parseTrack(j: unknown): ScTrack | null {
  const t = obj(j)
  if (!t.id || !t.title) return null
  const cover = str(t.artwork_url) || str(obj(t.user).avatar_url)
  return {
    id: num(t.id), title: str(t.title), artist: str(obj(t.user).username), permalink: str(t.permalink_url), duration: Math.round(num(t.full_duration || t.duration) / 1000),
    cover: /^https:\/\//.test(cover) ? cover.replace(/-(large|t\d+x\d+)\./, '-t500x500.') : '', genre: str(t.genre), tags: tagsOf(str(t.tag_list)), createdAt: str(t.created_at),
    plays: num(t.playback_count), likes: num(t.likes_count || t.favoritings_count), comments: num(t.comment_count), reposts: num(t.reposts_count),
    downloadable: !!t.downloadable && t.has_downloads_left !== false, auth: str(t.track_authorization), blocked: str(t.policy) === 'BLOCK', cands: candsOf(t)
  }
}

export const qualityOf = (c: Cand | undefined, original: boolean): string =>
  original ? 'Оригинал (файл автора)' : c ? `${c.ext.toUpperCase()}${c.bitrate ? ' · ' + c.bitrate + ' кбит/с' : ''}${c.preview ? ' · только 30 с' : ''}` : ''

/** «Артист - Название.mp3», safe for Windows. */
export function scFileName(t: Pick<ScTrack, 'artist' | 'title' | 'id'>, ext: string): string {
  const clean = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/[. ]+$/, '').trim().slice(0, 80)
  const name = [clean(t.artist), clean(t.title)].filter(Boolean).join(' - ') || String(t.id)
  return `${name}.${ext.replace(/[^a-z0-9]/gi, '') || 'mp3'}`
}

/** Pieces of an HLS playlist (and the init segment of fragmented mp4), addresses made absolute. */
export function parseM3u8(text: string, base: string): { init?: string; segs: string[]; encrypted: boolean } {
  const segs: string[] = []
  let init: string | undefined, encrypted = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      if (/^#EXT-X-KEY:/.test(line) && !/METHOD=NONE/.test(line)) encrypted = true
      const m = /^#EXT-X-MAP:.*URI="([^"]+)"/.exec(line)
      if (m) init = new URL(m[1], base).href
      continue
    }
    segs.push(new URL(line, base).href)
  }
  return { init, segs, encrypted }
}

/** Starts of mp3 (ID3 or frame sync), ogg, mp4/m4a, flac, wav: anything else is an error page. */
export function looksLikeAudio(h: Uint8Array): boolean {
  if (h.length < 4) return false
  const s = String.fromCharCode(h[0], h[1], h[2], h[3])
  if (s === 'ID3' + '\x03' || s.startsWith('ID3') || s === 'OggS' || s === 'fLaC' || s === 'RIFF') return true
  if (h[0] === 0xff && (h[1] & 0xe0) === 0xe0) return true
  return h.length >= 8 && ['ftyp', 'styp', 'moov', 'moof'].includes(String.fromCharCode(h[4], h[5], h[6], h[7]))
}

const utf16 = (s: string): number[] => { const o = [0xff, 0xfe]; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); o.push(c & 255, c >> 8) } o.push(0, 0); return o }

/** ID3v2.3 tag (title, artist, genre, year, cover) to put before an mp3 stream. */
export function id3Tag(t: { title: string; artist: string; genre?: string; year?: string }, cover?: Uint8Array): Uint8Array {
  const frames: number[][] = []
  const frame = (id: string, body: number[]) => {
    const n = body.length
    frames.push([...id].map((c) => c.charCodeAt(0)).concat([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255, 0, 0], body))
  }
  const text = (id: string, v: string) => { if (v) frame(id, [1, ...utf16(v)]) }
  text('TIT2', t.title); text('TPE1', t.artist); text('TCON', t.genre ?? ''); text('TYER', /^\d{4}/.test(t.year ?? '') ? t.year!.slice(0, 4) : '')
  if (cover && cover.length > 4) {
    const png = cover[0] === 0x89
    frame('APIC', [0, ...[...(png ? 'image/png' : 'image/jpeg')].map((c) => c.charCodeAt(0)), 0, 3, 0, ...cover])
  }
  const size = frames.reduce((a, f) => a + f.length, 0)
  const out = new Uint8Array(10 + size)
  out.set([0x49, 0x44, 0x33, 3, 0, 0, (size >>> 21) & 127, (size >>> 14) & 127, (size >>> 7) & 127, size & 127])
  let p = 10
  for (const f of frames) { out.set(f, p); p += f.length }
  return out
}
