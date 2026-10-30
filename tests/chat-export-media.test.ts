import { describe, expect, it } from 'vitest'
import { appendWindow, sniff } from '../src/main/chat-export'
import { ChatDump, ExportEntry, ExportMessage, renderChatHtml } from '../src/main/chat-export-html'

const msg = (o: Partial<ExportMessage> = {}): ExportMessage => ({ side: 'them', text: '', links: [], media: [], reactions: [], rawText: '', outline: 'div', ...o })
const dump = (entries: ExportEntry[], o: Partial<ChatDump> = {}): ChatDump => ({
  partner: { name: 'Аня' }, owner: { name: 'Личный' }, entries, complete: true, warnings: [], exportedAt: 0, appVersion: '0.1.0', ...o
})
const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc(16)])
const ascii = (s: string, at = 0) => { const b = Buffer.alloc(16); b.write(s, at, 'latin1'); return b }

describe('file type detection', () => {
  it('recognises what a browser can show by its first bytes', () => {
    expect(sniff(pad(Buffer.from('89504e470d0a1a0a', 'hex')))?.mime).toBe('image/png')
    expect(sniff(pad(Buffer.from('ffd8ffe0', 'hex')))?.mime).toBe('image/jpeg')
    expect(sniff(ascii('GIF89a'))?.mime).toBe('image/gif')
    expect(sniff(Buffer.from('RIFF....WEBPVP8 ', 'latin1'))?.mime).toBe('image/webp')
    expect(sniff(Buffer.from('....ftypisom....', 'latin1'))?.mime).toBe('video/mp4')
    expect(sniff(Buffer.from('....ftypavif....', 'latin1'))?.mime).toBe('image/avif')
    expect(sniff(Buffer.from('....ftypM4A ....', 'latin1'))?.mime).toBe('audio/mp4')
    expect(sniff(pad(Buffer.from('1a45dfa3', 'hex')))?.mime).toBe('video/webm')
    expect(sniff(ascii('ID3'))?.mime).toBe('audio/mpeg')
  })

  it('refuses everything else, whatever the server claimed', () => {
    expect(sniff(Buffer.from('<!doctype html><script>alert(1)</script>', 'latin1'))).toBeUndefined()
    expect(sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>', 'latin1'))).toBeUndefined()
    expect(sniff(Buffer.from('short'))).toBeUndefined()
  })
})

describe('joining windows of a virtualized list', () => {
  const t = (s: string): ExportEntry => msg({ text: s })
  const texts = (a: ExportEntry[]) => a.map((e) => ('sep' in e ? '|' + e.sep : e.text)).join('')

  it('skips what repeats the end of the list', () => {
    const acc = [t('a'), t('b'), t('c'), t('d')]
    expect(appendWindow(acc, [t('c'), t('d'), t('e'), t('f')])).toEqual({ added: 2, gap: false })
    expect(texts(acc)).toBe('abcdef')
  })

  it('adds nothing for a window already seen, and everything for the first one', () => {
    const acc = [t('a'), t('b'), t('c')]
    expect(appendWindow(acc, [t('b'), t('c')])).toEqual({ added: 0, gap: false })
    const first: ExportEntry[] = []
    expect(appendWindow(first, [t('x'), { sep: 'день' }, t('y')])).toEqual({ added: 3, gap: false })
    expect(texts(first)).toBe('x|деньy')
  })

  it('reports a gap when the windows do not overlap, but still keeps the new messages', () => {
    const acc = [t('a'), t('b')]
    expect(appendWindow(acc, [t('x'), t('y')])).toEqual({ added: 2, gap: true })
    expect(texts(acc)).toBe('abxy')
  })

  it('tells messages apart by author, time and attachments, not only by text', () => {
    const acc = [msg({ text: 'ok', side: 'me', time: '10:00' })]
    expect(appendWindow(acc, [msg({ text: 'ok', side: 'me', time: '10:01' })]).added).toBe(1)
  })
})

describe('files saved next to the page', () => {
  const FILE = 'a'.repeat(40) + '.png'

  it('links a checked file in the folder and embeds nothing for it', () => {
    const html = renderChatHtml(dump([msg({ media: [{ kind: 'image', src: '', file: 'chat_files/' + FILE }] })], { filesFolder: 'chat_files' }))
    expect(html).toContain(`src="chat_files/${FILE}"`)
    expect(html).toContain('лежат в папке «chat_files»')
    expect(html).toContain('Вложений сохранено')
  })

  it('url-encodes the folder name', () => {
    const html = renderChatHtml(dump([msg({ media: [{ kind: 'image', src: '', file: 'чат files/' + FILE }] })]))
    expect(html).toContain(`src="${encodeURIComponent('чат files')}/${FILE}"`)
  })

  it('refuses paths that could leave the folder or break the attribute', () => {
    for (const file of ['../x/y.png', 'a/b/c.png', '/etc/passwd', 'x/..%2f.png', '.hid/a.png', 'a"b/c.png', 'a/b.png"onerror="x', 'back' + String.fromCharCode(92) + 'slash/a.png', 'x/y']) {
      const html = renderChatHtml(dump([msg({ media: [{ kind: 'image', src: '', file }] })]))
      expect(html, file).toContain('файл не сохранён')
      expect(html, file).not.toMatch(/src="[^"]*(\.\.|onerror|passwd)/)
    }
  })

  it('plays animated stickers and GIFs that arrived as video on a loop, and shows other video with controls', () => {
    const data = 'data:video/mp4;base64,AAAA'
    const html = renderChatHtml(dump([
      msg({ media: [{ kind: 'video', animated: true, src: '', data }] }),
      msg({ media: [{ kind: 'video', src: '', data }] })
    ]))
    expect(html).toMatch(/<video class="media sticker[^>]* autoplay loop muted playsinline/)
    expect(html).toMatch(/<video class="media [^>]*controls/)
  })

  it('lets the page read files from its own folder, nothing else', () => {
    const html = renderChatHtml(dump([msg({ text: 'x' })]))
    expect(html).toContain("img-src data: file:")
    expect(html).toContain("default-src 'none'")
    expect(html).not.toMatch(/connect-src|frame-src|img-src [^;]*https/)
  })
})
