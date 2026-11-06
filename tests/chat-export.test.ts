import { describe, expect, it } from 'vitest'
import { ChatDump, ExportMessage, kindsOf, renderChatHtml } from '../src/main/chat-export-html'

const PNG = 'data:image/png;base64,iVBORw0KGgo='
const msg = (o: Partial<ExportMessage> = {}): ExportMessage => ({ side: 'them', text: '', links: [], media: [], reactions: [], rawText: '', outline: 'div', ...o })
const dump = (entries: ChatDump['entries'], o: Partial<ChatDump> = {}): ChatDump => ({
  partner: { name: 'Аня', handle: '@anya' }, owner: { name: 'Личный', handle: 'me' }, entries, complete: true, warnings: [], exportedAt: 0, appVersion: '0.1.0', ...o
})

describe('chat export page', () => {
  it('keeps every message, date separator and kind of content', () => {
    const html = renderChatHtml(dump([
      { sep: '28 окт.' },
      msg({ side: 'me', text: 'привет', time: '12:30' }),
      msg({ media: [{ kind: 'sticker', src: 'https://cdn.example.com/s.png', data: PNG }] }),
      msg({ video: { href: 'https://www.tiktok.com/@a/video/1', text: 'смешное видео', cover: { kind: 'image', src: '', data: PNG } } }),
      msg({ media: [{ kind: 'image', src: 'https://cdn.example.com/p.jpg', note: 'ответ 403' }] }),
      msg({ rawText: 'что-то новое' })
    ]))
    expect(html.match(/<article class="msg /g)).toHaveLength(5)
    expect(html).toContain('28 окт.')
    expect(html).toContain('12:30')
    expect(html).toContain('смешное видео')
    expect(html).toContain('https://www.tiktok.com/@a/video/1')
    expect(html).toContain(`src="${PNG}"`)
    expect(html).toContain('файл не сохранён (ответ 403)')
    expect(html).toContain('Содержимое не распознано: что-то новое')
    expect(html).toContain('Переписка загружена с самого начала')
  })

  it('classifies messages for the filters', () => {
    expect(kindsOf(msg({ text: 'a', media: [{ kind: 'sticker', src: '' }] }))).toEqual(['text', 'sticker'])
    expect(kindsOf(msg())).toEqual(['other'])
    expect(kindsOf(msg({ video: { text: '' } }))).toEqual(['shared'])
  })

  it('classifies stickers, reactions, deleted and service lines', () => {
    expect(kindsOf(msg({ media: [{ kind: 'audio', src: '' }], reactions: [{ emoji: '💔', count: 1, who: ['вы'] }] }))).toEqual(['audio', 'reaction'])
    expect(kindsOf(msg({ text: 'Сообщение удалено', deleted: true }))).toEqual(['deleted'])
    expect(kindsOf(msg({ text: 'Вы теперь друзья', service: true }))).toEqual(['service'])
    expect(kindsOf(msg({ unknown: true, rawText: '{}' }))).toEqual(['unknown'])
  })

  it('writes reactions as emoji, count and who, once each', () => {
    const html = renderChatHtml(dump([msg({ text: 'a', reactions: [{ emoji: '💔', count: 1, who: ['собеседник'] }, { emoji: '😂', count: 2, who: ['вы', 'собеседник'] }, { emoji: '🏷️', code: 'e:new', count: 1, who: ['вы'] }] })]))
    const box = /<div class="reactions">.*?<\/div>/s.exec(html)![0]
    expect(box.match(/class="rx"/g)).toHaveLength(3)
    expect(box).toContain('<b>💔</b> · собеседник')
    expect(box).toContain('<b>😂</b><i>×2</i> · вы, собеседник')
    expect(box).toContain('<code>e:new</code>')
  })

  it('marks an unknown type, shows a count of them and keeps the raw data in the details', () => {
    const html = renderChatHtml(dump([msg({ unknown: true, tag: 'Неизвестный тип · тип 42', rawText: '{"foo":"bar"}' })]))
    expect(html).toContain('Неизвестный тип · тип 42')
    expect(html).toContain('Неизвестных типов сообщений: 1')
    expect(html).toContain('<summary>Подробности</summary>')
    expect(html).toContain('&quot;foo&quot;')
  })

  it('links a reply to the quoted message and escapes the quote', () => {
    const html = renderChatHtml(dump([msg({ text: 'a' }), msg({ text: 'b', reply: '<i>a</i>', replyWho: 'Ответ: вы', replyTo: 1 })]))
    expect(html).toContain('href="#m1"')
    expect(html).toContain('id="m1"')
    expect(html).not.toContain('<i>a</i>')
  })

  it('never writes the key of an encrypted file, in the page or in the JSON', () => {
    const key = 'ab'.repeat(32)
    const html = renderChatHtml(dump([msg({ media: [{ kind: 'image', src: 'https://c.example/p', secret: { key, user: 'cd'.repeat(16), mint: true }, alts: [{ src: 'https://c.example/q', secret: { key } }], note: 'x' }] })]))
    expect(html).not.toContain(key)
    expect(html).not.toContain('cd'.repeat(16))
    expect(html).toContain('https://c.example/q')
  })

  it('groups the messages of one person: one avatar, on the last one', () => {
    const html = renderChatHtml(dump([msg({ text: 'a' }), msg({ text: 'b' }), msg({ side: 'me', text: 'c' })]))
    expect(html.match(/<div class="av them none"/g)).toHaveLength(1)
    expect(html.match(/<div class="av them"/g)).toHaveLength(1)
    expect(html).toContain('data-i="А"')
  })

  it('shows a warning when the history is incomplete', () => {
    const html = renderChatHtml(dump([msg({ text: 'x' })], { complete: false, warnings: ['Файл неполный.'] }))
    expect(html).toContain('Файл неполный.')
    expect(html).not.toContain('Переписка загружена с самого начала')
  })

  it('escapes hostile content and refuses unsafe addresses', () => {
    const html = renderChatHtml(dump([
      msg({
        text: '<img src=x onerror=alert(1)> </script><script>alert(2)</script> https://ok.example/a?b=1.',
        reply: '<b>x</b>', rawText: '"><svg onload=alert(3)>', outline: '<x>',
        links: [{ href: 'javascript:alert(4)', text: '<i>' }],
        media: [{ kind: 'image', src: 'javascript:alert(5)', data: 'data:text/html;base64,PHNjcmlwdD4=' }],
        video: { href: 'javascript:alert(6)', text: '<u>', cover: { kind: 'image', src: 'file:///c:/secret', data: 'data:image/svg+xml;base64,PHN2Zz4=' } }
      })
    ], { partner: { name: '<script>alert(7)</script>' } }))
    expect(html).not.toMatch(/<script>alert|<img src=x|<svg onload|<b>x<\/b>|<u>/)
    expect(html).not.toMatch(/href="javascript:|src="javascript:|src="file:|data:text\/html|data:image\/svg/)
    expect(html).toContain('<a href="https://ok.example/a?b=1" target="_blank" rel="noopener noreferrer">https://ok.example/a?b=1</a>.')
    expect(html.match(/<script/g)).toHaveLength(2) // the data block and the page script, nothing from messages
    expect(html).toContain("default-src 'none'")
  })

  it('embeds the data as JSON without the files and keeps it parseable', () => {
    const html = renderChatHtml(dump([msg({ text: 'a</script>b', media: [{ kind: 'sticker', src: 'https://c.example/s.png', data: PNG }] })]))
    const json = /<script type="application\/json" id="export-data">(.*?)<\/script>/s.exec(html)![1]
    const parsed = JSON.parse(json)
    expect(parsed.entries[0].text).toBe('a</script>b')
    expect(parsed.entries[0].media[0]).toMatchObject({ src: 'https://c.example/s.png', embedded: true })
    expect(json).not.toContain('base64')
  })

  it('handles a large chat', () => {
    const entries = Array.from({ length: 20000 }, (_, i) => msg({ side: i % 2 ? 'me' : 'them', text: 'сообщение ' + i }))
    const html = renderChatHtml(dump(entries))
    expect(html.match(/<article class="msg /g)).toHaveLength(20000)
  })
})
