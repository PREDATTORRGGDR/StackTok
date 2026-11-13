import { describe, expect, it } from 'vitest'
import { DlError, fileName, linkOf, looksLikeVideo, parsePage, pickStream, videoIdOf } from '../src/main/dl-tiktok'

const page = (scope: unknown) => `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.video-detail': scope } })}</script></html>`
const item = {
  id: '7300000000000000001', desc: 'смешно #fyp #cat', createTime: '1700000000', author: { uniqueId: 'user.one', nickname: 'Один' },
  video: {
    duration: 15, cover: 'https://c/x.jpg', playAddr: 'https://p/play', downloadAddr: 'https://p/wm',
    bitrateInfo: [
      { Bitrate: 900000, CodecType: 'h264', PlayAddr: { UrlList: ['https://v/lo'], Width: 540, Height: 960, DataSize: 100 } },
      { Bitrate: 4000000, CodecType: 'h264', PlayAddr: { UrlList: ['https://v/hi'], Width: 1080, Height: 1920, DataSize: 500 } },
      { Bitrate: 6000000, CodecType: 'h265_hvc1', PlayAddr: { UrlList: ['https://v/265'], Width: 1080, Height: 1920, DataSize: 400 } }
    ]
  },
  textExtra: [{ hashtagName: 'fyp' }, { hashtagName: 'cat' }, { hashtagName: 'FYP' }], challenges: [{ title: 'dog' }],
  stats: { playCount: 10 }, statsV2: { playCount: '12345', diggCount: '99' }, music: { title: 'Song', authorName: 'Auth' }
}

describe('linkOf', () => {
  it('finds full and short links', () => {
    expect(linkOf('смотри https://www.tiktok.com/@a.b/video/7300000000000000001?is_from_webapp=1 круто')).toContain('/@a.b/video/7300000000000000001')
    expect(linkOf('https://vm.tiktok.com/ZMabc123/')).toBe('https://vm.tiktok.com/ZMabc123/')
    expect(linkOf('https://www.tiktok.com/t/ZTabc/')).toBe('https://www.tiktok.com/t/ZTabc/')
  })
  it('ignores everything else', () => {
    expect(linkOf('https://evil.com/@a/video/7300000000000000001')).toBeNull()
    expect(linkOf('https://www.tiktok.com/@a')).toBeNull()
    expect(linkOf('привет')).toBeNull()
    expect(videoIdOf('https://www.tiktok.com/@a/video/7300000000000000001')).toBe('7300000000000000001')
  })
})

describe('pickStream', () => {
  it('takes the highest bitrate H.264 rendition without the watermark', () => {
    const s = pickStream(item.video)!
    expect(s.url).toBe('https://v/hi')
    expect(s.watermark).toBe(false)
  })
  it('falls back to playAddr, the watermarked file last', () => {
    expect(pickStream({ playAddr: 'https://p/play', downloadAddr: 'https://p/wm' })!.url).toBe('https://p/play')
    const w = pickStream({ downloadAddr: 'https://p/wm' })!
    expect(w.watermark).toBe(true)
    expect(pickStream({})).toBeNull()
  })
  it('uses H.265 only when it is all there is', () => {
    expect(pickStream({ bitrateInfo: [{ Bitrate: 5, CodecType: 'h265_hvc1', PlayAddr: { UrlList: ['https://v/265'] } }] })!.codec).toBe('h265')
  })
})

describe('parsePage', () => {
  it('reads the info, hashtags without duplicates, exact stats', () => {
    const i = parsePage(page({ statusCode: 0, itemInfo: { itemStruct: item } }))
    expect(i.tags).toEqual(['fyp', 'cat', 'dog'])
    expect(i.author).toBe('user.one')
    expect(i.stats.plays).toBe(12345)
    expect(i.music).toBe('Song — Auth')
    expect(i.stream.url).toBe('https://v/hi')
  })
  it('explains missing, private and photo posts', () => {
    expect(() => parsePage(page({ statusCode: 10204 }))).toThrow(/не найдено/)
    expect(() => parsePage(page({ statusCode: 10222 }))).toThrow(/приватное/)
    expect(() => parsePage(page({ itemInfo: { itemStruct: { ...item, imagePost: { images: [1] } } } }))).toThrow(/фото/)
    expect(() => parsePage('<html></html>')).toThrow(DlError)
  })
})

describe('files', () => {
  it('builds a safe name', () => {
    expect(fileName({ author: 'a/b:c', id: '1' })).toBe('@abc - 1.mp4')
    expect(fileName({ author: '', id: '1' })).toBe('tiktok - 1.mp4')
  })
  it('tells a video from an error page', () => {
    expect(looksLikeVideo(new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]))).toBe(true)
    expect(looksLikeVideo(new TextEncoder().encode('<html><body>'))).toBe(false)
  })
})
