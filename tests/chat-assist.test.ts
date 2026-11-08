import { describe, expect, it } from 'vitest'
import type { ExportEntry, ExportMessage } from '../src/main/chat-export-html'
import { SAVED_CHATS_MAX, TALKS_MAX, applyEvent, chatStats, cleanSaved, cleanTalks, promptWithoutChat, lineOf, styleOf, upsertTalk, parseLooks, pickMedia, questionOf, span, stampOf, streamReply, systemPrompt, transcriptOf } from '../src/main/chat-assist'

const msg = (side: 'me' | 'them', text: string, time: string, extra: Partial<ExportMessage> = {}): ExportMessage =>
  ({ side, text, time, links: [], media: [], reactions: [], rawText: '', outline: '', ...extra })

const chat: ExportEntry[] = [
  { sep: '01.11.2026' },
  msg('me', 'привет)', '10:00:00'),
  msg('them', 'хай', '10:30:00'),
  msg('me', 'как дела?', '10:31:00', { media: [{ kind: 'sticker', src: 'https://p16.tiktokcdn.com/s1.webp', label: 'Котик' }] }),
  { sep: '02.11.2026' },
  msg('them', 'норм', '09:00:00', { reactions: [{ emoji: '❤️', count: 1, who: ['вы'] }], reply: 'как дела?' }),
  msg('them', '', '09:01:00', { video: { text: 'смешное видео', cover: { kind: 'image', src: 'https://p16.tiktokcdn.com/c1.jpg' } } })
]

describe('chat assistant transcript', () => {
  it('formats durations and stamps', () => {
    expect(span(5 * 60000)).toBe('5 мин')
    expect(span(135 * 60000)).toBe('2 ч 15 мин')
    expect(span(3 * 86400000)).toBe('3 дн')
    expect(stampOf('02.11.2026', '09:01:00')).toBe(new Date(2026, 10, 2, 9, 1, 0).getTime())
    expect(stampOf('вчера', '09:01')).toBeUndefined()
  })

  it('writes every message with pauses, pictures, quotes and reactions', () => {
    const looks = new Map([['https://p16.tiktokcdn.com/s1.webp', 'кот машет лапой'], ['https://p16.tiktokcdn.com/c1.jpg', 'девушка смеётся, текст «когда он ответил»']])
    const t = transcriptOf(chat, { name: 'Аня' }, looks)
    const lines = t.text.split('\n')
    expect(lines[0]).toBe('— 01.11.2026 —')
    expect(lines[2]).toBe('[10:30] (+30 мин) Аня: хай')
    expect(lines[3]).toContain('[стикер: кот машет лапой]')
    expect(t.text).toContain('— 02.11.2026 —')
    expect(t.text).toContain('(+22 ч 29 мин) Аня: (ответ на: «как дела?») норм {реакции: ❤️ вы}')
    expect(t.text).toContain('[видео TikTok: «смешное видео»; обложка: девушка смеётся')
    expect(t.messages).toBe(5)
    expect(t.cut).toBe(0)
    expect(t.first).toBe('01.11.2026')
    expect(t.stats).toContain('Аня: 3 сообщ.')
    expect(t.stats).toContain('Последнее сообщение: Аня')
  })

  it('without a description keeps the caption', () => {
    expect(lineOf(chat[3] as ExportMessage, 'Аня')).toContain('[стикер «Котик»]')
  })

  it('drops the oldest messages when the chat is too long and still names the day', () => {
    const t = transcriptOf(chat, { name: 'Аня' }, undefined, 120)
    expect(t.cut).toBeGreaterThan(0)
    expect(t.text.startsWith('— 02.11.2026 —')).toBe(true)
    expect(t.messages + t.cut).toBe(5)
  })

  it('counts reply speed and who starts after a pause', () => {
    const s = chatStats([
      { m: msg('me', 'a', '1'), at: 0 },
      { m: msg('them', 'b?', '1'), at: 10 * 60000 },
      { m: msg('me', 'c 😀', '1'), at: 12 * 60000 },
      { m: msg('them', 'd', '1'), at: 10 * 3600000 }
    ], 'Аня')
    expect(s).toContain('Я: 2 сообщ. (50%)')
    expect(s).toContain('с эмодзи 1')
    expect(s).toMatch(/Аня: .*вопросов 1/)
    expect(s).toMatch(/Аня: .*первым\(ой\) пишет после паузы 6\+ ч: 1/)
  })

  it('picks pictures newest first, each address once', () => {
    const dup: ExportEntry[] = [...chat, msg('me', '', '09:05:00', { media: [{ kind: 'sticker', src: 'https://p16.tiktokcdn.com/s1.webp' }, { kind: 'audio', src: 'https://x.tiktokcdn.com/v.mp4' }] })]
    expect(pickMedia(dup).map((m) => m.src)).toEqual(['https://p16.tiktokcdn.com/s1.webp', 'https://p16.tiktokcdn.com/c1.jpg'])
    expect(pickMedia(dup, 1)).toHaveLength(1)
  })

  it('reads picture descriptions from a sloppy reply', () => {
    const m = parseLooks('Вот:\n```json\n{"1": "кот", "2": "", "x": "y", "3": "сердце"}\n```')
    expect([...m.entries()]).toEqual([[1, 'кот'], [3, 'сердце']])
    expect(parseLooks('нет json').size).toBe(0)
  })

  it('keeps the clock out of the system prompt so it can be cached', () => {
    const t = transcriptOf(chat, { name: 'Аня', handle: 'anya' })
    const p = systemPrompt({ partner: { name: 'Аня', handle: 'anya' }, owner: { name: 'Мой', handle: 'me' }, t, complete: true })
    expect(p).toContain('Собеседник — Аня (@anya)')
    expect(p).toContain('Ниже вся переписка')
    expect(p).toContain('<переписка>')
    expect(systemPrompt({ partner: { name: 'Аня' }, owner: { name: 'Мой' }, t, complete: true })).toContain(t.text)
    expect(questionOf('как ответить?', new Date(2026, 10, 9, 14, 5))).toMatch(/^\[сейчас .*09\.11\.2026.*14:05\]\nкак ответить\?$/)
  })
})

describe('chat assistant model client', () => {
  const sse = (lines: string[], type = 'text/event-stream') => {
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(c) { for (const l of lines) c.enqueue(enc.encode(l)); c.close() }
    })
    return new Response(body, { status: 200, headers: { 'content-type': type } })
  }

  it('reads Anthropic events, usage included, and caches the system prompt', async () => {
    let sent: any
    const f = (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body))
      return sse([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10,"cache_read_input_tokens":900}}}\n\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"При"}}\n',
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"вет"}}\n\n',
        'data: {"type":"message_delta","usage":{"output_tokens":5}}\n\n'
      ])
    }) as unknown as typeof fetch
    const seen: string[] = []
    const r = await streamReply({ kind: 'anthropic', base: 'https://api.anthropic.com', key: 'sk-ant-x' }, 'm', 'SYS', [{ role: 'assistant', text: 'old' }, { role: 'user', text: 'q' }], (t) => seen.push(t), undefined, f)
    expect(r).toEqual({ text: 'Привет', inTok: 910, outTok: 5 })
    expect(seen).toEqual(['При', 'Привет'])
    expect(sent.stream).toBe(true)
    expect(sent.system[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(sent.messages).toEqual([{ role: 'user', content: 'q' }]) // must start with the user
  })

  it('reads OpenAI-style chunks split anywhere', async () => {
    const f = (async () => sse(['data: {"choices":[{"delta":{"content":"А"}}]}\n\ndata: {"choi', 'ces":[{"delta":{"content":"Б"}}]}\n\n', 'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\ndata: [DONE]\n\n'])) as unknown as typeof fetch
    const r = await streamReply({ kind: 'openai', base: 'https://x.test/v1', key: 'k' }, 'm', 'S', [{ role: 'user', text: 'q' }], () => {}, undefined, f)
    expect(r).toEqual({ text: 'АБ', inTok: 7, outTok: 2 })
  })

  it('takes a whole answer from a server that ignores streaming', async () => {
    const f = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'целиком' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const r = await streamReply({ kind: 'openai', base: 'https://x.test/v1', key: 'k' }, 'm', 'S', [{ role: 'user', text: 'q' }], () => {}, undefined, f)
    expect(r.text).toBe('целиком')
  })

  it('retries 429 and stops on a bad key', async () => {
    let n = 0
    const f = (async () => (++n === 1 ? new Response('{}', { status: 429 }) : sse(['data: {"choices":[{"delta":{"content":"ok"}}]}\n']))) as unknown as typeof fetch
    const r = await streamReply({ kind: 'openai', base: 'https://x.test/v1', key: 'k' }, 'm', 'S', [{ role: 'user', text: 'q' }], () => {}, undefined, f, async () => {})
    expect(r.text).toBe('ok')
    expect(n).toBe(2)
    const bad = (async () => new Response('{"error":{"message":"no"}}', { status: 401 })) as unknown as typeof fetch
    await expect(streamReply({ kind: 'openai', base: 'https://x.test/v1', key: 'k' }, 'm', 'S', [{ role: 'user', text: 'q' }], () => {}, undefined, bad)).rejects.toThrow('Ключ API не принят')
  })

  it('an error event ends the answer with a message', () => {
    expect(() => applyEvent('anthropic', '{"type":"error","error":{"message":"overloaded"}}', { text: '', inTok: 0, outTok: 0 })).toThrow('overloaded')
  })

  it('stopping before the first piece says so', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(streamReply({ kind: 'openai', base: 'https://x.test/v1', key: 'k' }, 'm', 'S', [{ role: 'user', text: 'q' }], () => {}, ac.signal, (async () => sse([])) as unknown as typeof fetch)).rejects.toThrow('Остановлено')
  })
})

describe('how the user writes', () => {
  it('counts case, full stops, brackets and keeps the own words, typos included', () => {
    const all = [
      msg('me', 'щас приду)', '1'), msg('them', 'Ок.', '1'), msg('me', 'норм вроде', '1'), msg('me', 'ты где была вчера чё', '1'),
      msg('me', 'Ладно.', '1'), msg('me', 'https://www.tiktok.com/@x/video/1', '1')
    ]
    const s = styleOf(all)
    expect(s).toContain('с маленькой буквы: 75%')
    expect(s).toContain('точка в конце: 25%')
    expect(s).toContain('скобочки-смайлы «)» в конце: 25%')
    expect(s).toContain('«ты где была вчера чё»')
    expect(s).not.toContain('tiktok.com') // a bare link says nothing about style
    expect(s).toContain('сообщений подряд за раз: в среднем 2.5')
    expect(styleOf([msg('me', 'а', '1')])).toBe('')
  })
  it('the prompt tells the model to copy that style, not to correct it', () => {
    const t = transcriptOf([{ sep: '01.11.2026' }, msg('me', 'привет', '10:00:00'), msg('me', 'как ты', '10:00:05'), msg('me', 'щас', '10:00:09')], { name: 'Аня' })
    const p = systemPrompt({ partner: { name: 'Аня' }, owner: { name: 'Я' }, t, complete: true })
    expect(p).toContain('Никогда не делай текст грамотнее')
    expect(p).toContain('Как пишет «Я»')
  })
})

describe('assistant history', () => {
  const talk = (id: string, at: number) => ({ id, chat: 'acc|Аня|anya', accountId: 'acc', partner: 'Аня', title: 'Как ответить?', createdAt: at, updatedAt: at, turns: [{ role: 'user' as const, text: 'Как ответить?' }, { role: 'assistant' as const, text: '«привет»' }] })
  it('reads back only sane talks, newest first', () => {
    const list = cleanTalks([talk('a', 1), talk('b', 5), { id: 'c' }, { ...talk('d', 3), turns: [{ role: 'system', text: 'x' }] }, null])
    expect(list.map((t) => t.id)).toEqual(['b', 'a'])
    expect(cleanTalks('junk')).toEqual([])
  })
  it('puts the updated talk first and keeps the limit', () => {
    let list = Array.from({ length: TALKS_MAX }, (_, i) => talk('t' + i, i))
    list = upsertTalk(list, talk('new', 999))
    expect(list[0].id).toBe('new')
    expect(list).toHaveLength(TALKS_MAX)
    list = upsertTalk(list, { ...talk('t5', 1000), title: 'changed' })
    expect(list[0]).toMatchObject({ id: 't5', title: 'changed' })
    expect(list.filter((t) => t.id === 't5')).toHaveLength(1)
  })
})

describe('saved chat copies', () => {
  const copy = (chat: string, at: number) => ({ chat, accountId: 'acc', partner: 'Аня', system: 'SYS ' + chat, messages: 300, first: '01.11.2026', at })
  it('reads back only copies with a chat and a prompt, newest first, within the limit', () => {
    const list = cleanSaved([copy('a', 1), copy('b', 9), { chat: 'c' }, { system: 'x' }, null, ...Array.from({ length: SAVED_CHATS_MAX }, (_, i) => copy('z' + i, 2))])
    expect(list[0].chat).toBe('b')
    expect(list).toHaveLength(SAVED_CHATS_MAX)
    expect(list.some((c) => c.chat === 'c')).toBe(false)
  })
  it('a conversation without a copy still gets a prompt that says so', () => {
    const p = promptWithoutChat('Аня')
    expect(p).toContain('Аня')
    expect(p).toContain('Самой переписки сейчас нет')
    expect(p).toContain('не грамотнее')
  })
})
