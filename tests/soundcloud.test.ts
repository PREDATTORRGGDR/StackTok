import { describe, expect, it } from 'vitest'
import { candsOf, clientIdOf, id3Tag, looksLikeAudio, parseM3u8, parseTrack, scFileName, scLinkOf, scriptsOf, tagsOf } from '../src/main/dl-soundcloud'

describe('scLinkOf', () => {
  it('finds track, set and short links', () => {
    expect(scLinkOf('смотри https://soundcloud.com/artist/track-name?si=abc')).toBe('https://soundcloud.com/artist/track-name')
    expect(scLinkOf('https://m.soundcloud.com/artist/sets/mix')).toBe('https://soundcloud.com/artist/sets/mix')
    expect(scLinkOf('https://on.soundcloud.com/AbC123')).toBe('https://on.soundcloud.com/AbC123')
    expect(scLinkOf('https://soundcloud.com/artist/track/s-SecretTok')).toBe('https://soundcloud.com/artist/track/s-SecretTok')
  })
  it('skips profiles, service pages and other sites', () => {
    for (const t of ['https://soundcloud.com/artist', 'https://soundcloud.com/artist/likes', 'https://soundcloud.com/discover/sets', 'https://example.com/a/b', 'нет ссылки']) expect(scLinkOf(t)).toBeNull()
  })
})

describe('client id', () => {
  it('reads script addresses and the id', () => {
    expect(scriptsOf('<script crossorigin src="https://a-v2.sndcdn.com/assets/0-abc.js"></script><script>x</script>')).toEqual(['https://a-v2.sndcdn.com/assets/0-abc.js'])
    expect(clientIdOf('a,client_id:"' + 'aB3'.repeat(10) + 'xy",b')).toBe('aB3'.repeat(10) + 'xy')
    expect(clientIdOf('nothing here')).toBeNull()
  })
})

const track = (tr: unknown[], extra: Record<string, unknown> = {}) => ({ id: 7, title: 'Song', user: { username: 'Art' }, media: { transcodings: tr }, artwork_url: 'https://i1.sndcdn.com/artworks-x-large.jpg', tag_list: 'house "deep house" chill', ...extra })
const tc = (url: string, protocol: string, mime: string, preset: string, more: Record<string, unknown> = {}) => ({ url, preset, format: { protocol, mime_type: mime }, ...more })

describe('candsOf / parseTrack', () => {
  it('prefers full, high bitrate, plain files; skips DRM and previews go last', () => {
    const c = candsOf(track([
      tc('https://api/p/hls', 'hls', 'audio/ogg; codecs="opus"', 'opus_0_0'),
      tc('https://api/p/progressive', 'progressive', 'audio/mpeg', 'mp3_1_0'),
      tc('https://api/p/hls2', 'hls', 'audio/mpeg', 'mp3_1_0'),
      tc('https://api/p/ctr', 'ctr-encrypted-hls', 'audio/mp4; codecs="mp4a.40.2"', 'aac_160k'),
      tc('https://api/p/snip', 'progressive', 'audio/mpeg', 'mp3_1_0', { snipped: true })
    ]))
    expect(c.map((x) => x.url)).toEqual(['https://api/p/progressive', 'https://api/p/hls2', 'https://api/p/hls', 'https://api/p/snip'])
    expect(c[3].preview).toBe(true)
  })
  it('parses track fields, cover size and tags', () => {
    const t = parseTrack(track([tc('https://api/p/progressive', 'progressive', 'audio/mpeg', 'mp3_1_0')], { duration: 185000, playback_count: 10, downloadable: true, has_downloads_left: true, track_authorization: 'tok', policy: 'ALLOW' }))!
    expect(t.cover).toContain('t500x500')
    expect(t.tags).toEqual(['house', 'deep house', 'chill'])
    expect(t.duration).toBe(185)
    expect(t.downloadable).toBe(true)
    expect(t.auth).toBe('tok')
    expect(parseTrack({ id: 1 })).toBeNull()
    expect(tagsOf('')).toEqual([])
  })
})

describe('files', () => {
  it('names safely', () => {
    expect(scFileName({ artist: 'A/B', title: 'Who? "me"', id: 1 }, 'mp3')).toBe('AB - Who me.mp3')
    expect(scFileName({ artist: '', title: '', id: 5 }, 'x!')).toBe('5.x')
  })
  it('parses an HLS playlist with relative parts and init segment', () => {
    const m = parseM3u8('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:10,\nseg1.m4s\n#EXTINF:10,\nhttps://other/seg2.m4s\n#EXT-X-ENDLIST', 'https://cf.example/a/list.m3u8')
    expect(m).toEqual({ init: 'https://cf.example/a/init.mp4', segs: ['https://cf.example/a/seg1.m4s', 'https://other/seg2.m4s'], encrypted: false })
    expect(parseM3u8('#EXT-X-KEY:METHOD=AES-128,URI="k"\nx.ts', 'https://a/b.m3u8').encrypted).toBe(true)
  })
  it('recognises audio starts', () => {
    expect(looksLikeAudio(new Uint8Array([0x49, 0x44, 0x33, 4, 0]))).toBe(true)
    expect(looksLikeAudio(new Uint8Array([0xff, 0xfb, 0x90, 0]))).toBe(true)
    expect(looksLikeAudio(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]))).toBe(true)
    expect(looksLikeAudio(new TextEncoder().encode('<html>'))).toBe(false)
  })
  it('builds an ID3 tag with a size that matches', () => {
    const tag = id3Tag({ title: 'Песня', artist: 'Art', genre: 'House', year: '2024-01-02' }, new Uint8Array([0xff, 0xd8, 1, 2, 3, 4]))
    expect(String.fromCharCode(...tag.slice(0, 3))).toBe('ID3')
    const size = (tag[6] << 21) | (tag[7] << 14) | (tag[8] << 7) | tag[9]
    expect(tag.length).toBe(10 + size)
    expect(new TextDecoder('latin1').decode(tag)).toContain('APIC')
  })
})
