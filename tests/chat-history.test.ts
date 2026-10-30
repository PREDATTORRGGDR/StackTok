import { describe, expect, it } from 'vitest'
import { Field, HistoryPage, ImMessage, decode, encode, get, historyOf, historyRequest, parseHistory, parseRequest, sub, text, vint, bytes } from '../src/main/chat-api'
import { Fatal, PAGE, isHidden, pullHistory, toEntries, toMs } from '../src/main/chat-history'

// A small seeded generator, so the "random" chats are the same on every run.
function rng(seed: number) {
  let s = seed >>> 0
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32 }
}

/** Positions like the server's: a microsecond clock, so large numbers with gaps; `bursts` adds long quiet stretches between busy ones. */
function positions(total: number, seed = 1, bursts = false): bigint[] {
  const r = rng(seed)
  let at = 1_760_000_000_000_000n
  const out: bigint[] = []
  for (let i = 0; i < total; i++) {
    const quiet = bursts && r() < 0.02
    at += BigInt(Math.floor(quiet ? 1e10 + r() * 1e12 : 1000 + r() * 2e7)) + 1n
    out.push(at)
  }
  return out
}

interface Quirks { cap?: number; inclusive?: boolean; hasMoreLies?: boolean; noMoreOnFull?: boolean; ignoreAnchor?: boolean; strayBelowStart?: boolean }

// A fake conversation. `ask(anchor, limit)` gives the newest messages below the anchor (or up to it when `inclusive`), newest first;
// anchor 0 is the newest page. The page size is cut to `cap`, like the real server does.
function server(all: bigint[], o: Quirks = {}) {
  const calls: { anchor: bigint; limit: number }[] = []
  let inflight = 0, peak = 0
  const msg = (index: bigint): Field[] => [text(1, '0:1:11:22'), vint(3, index + 1000n), vint(4, index), vint(6, 7), vint(7, index % 2n ? 11 : 22), text(8, JSON.stringify({ text: 'm' + index })), vint(10, 1700000000000n + (index % 1000n))]
  const ask = async (anchor: bigint, limit: number): Promise<HistoryPage> => {
    calls.push({ anchor, limit })
    inflight++; peak = Math.max(peak, inflight)
    await new Promise((r) => setTimeout(r, 1))
    inflight--
    let below = all.filter((i) => anchor === 0n || o.ignoreAnchor ? true : o.inclusive ? i <= anchor : i < anchor)
    if (o.strayBelowStart && !below.length) below = all // asked below the start: the newest page comes back instead of nothing
    const n = Math.min(limit, o.cap ?? PAGE)
    const page = below.slice(-n).reverse()
    const more = below.length > n
    return { status: 0, error: 'OK', messages: page.map(msg), next: page.length ? page[page.length - 1] : undefined, hasMore: o.hasMoreLies ? true : o.noMoreOnFull && page.length === n ? false : more }
  }
  return { ask, calls, peak: () => peak }
}
const opts = { concurrency: 8, cancelled: () => false }
const idx = (r: { messages: ImMessage[] }) => r.messages.map((m) => m.index)

describe('pullHistory', () => {
  for (const inclusive of [false, true]) {
    for (const bursts of [false, true]) {
      it(`gets every message once, oldest first (anchor ${inclusive ? 'inclusive' : 'exclusive'}, ${bursts ? 'bursts and quiet stretches' : 'even'})`, async () => {
        const all = positions(3000, 7, bursts)
        const s = server(all, { inclusive })
        const r = await pullHistory(s.ask, opts)
        expect(idx(r)).toEqual(all)
        expect(s.peak()).toBeGreaterThan(1)
        expect(s.peak()).toBeLessThanOrEqual(8)
      })
    }
  }
  it('does not ask for much more than the pages that exist', async () => {
    const all = positions(4000, 3)
    const s = server(all)
    const r = await pullHistory(s.ask, { ...opts, concurrency: 12 })
    expect(idx(r)).toEqual(all)
    expect(s.calls.length).toBeLessThan((4000 / PAGE) * 1.5 + 40)
  })
  it('works for a conversation of one page, a bit more, and none', async () => {
    const few = server(positions(7))
    expect((await pullHistory(few.ask, opts)).messages).toHaveLength(7)
    expect(few.calls).toHaveLength(1)
    expect((await pullHistory(server([]).ask, opts)).messages).toHaveLength(0)
    for (const n of [PAGE, PAGE + 1, 2 * PAGE, 2 * PAGE + 1]) {
      const all = positions(n, 5)
      expect(idx(await pullHistory(server(all).ask, opts))).toEqual(all)
    }
  })
  it('follows a server that gives smaller pages than asked', async () => {
    const all = positions(900, 9)
    expect(idx(await pullHistory(server(all, { cap: 20 }).ask, opts))).toEqual(all)
  })
  it('stops below the start of a conversation that always says "more"', async () => {
    const all = positions(333, 4)
    expect(idx(await pullHistory(server(all, { hasMoreLies: true }).ask, opts))).toEqual(all)
  })
  it('does not stop early when a full page says there is no more', async () => {
    const all = positions(777, 6)
    expect(idx(await pullHistory(server(all, { noMoreOnFull: true }).ask, opts))).toEqual(all)
  })
  it('copes with a server that answers a position below the start with the newest page', async () => {
    const all = positions(1200, 8, true)
    expect(idx(await pullHistory(server(all, { strayBelowStart: true }).ask, opts))).toEqual(all)
  })
  it('gives up on a server that ignores positions instead of looping', async () => {
    const s = server(positions(500), { ignoreAnchor: true })
    await expect(pullHistory(s.ask, opts)).rejects.toThrow('не сдвигается')
    expect(s.calls.length).toBeLessThan(40)
  })
  it('repeats a request that failed once', async () => {
    const all = positions(800, 2)
    const s = server(all)
    let n = 0
    const failed = new Set<string>() // every position fails on its first try only, whatever the other workers are doing
    const flaky = async (a: bigint, l: number) => { if (++n % 3 === 0 && !failed.has(String(a))) { failed.add(String(a)); throw new Error('HTTP 500') } return s.ask(a, l) }
    expect(idx(await pullHistory(flaky, { ...opts, attempts: 3 }))).toEqual(all)
    expect(failed.size).toBeGreaterThan(3)
  })
  it('gives up (and does not return a partial history) when a request keeps failing', async () => {
    const all = positions(800, 2)
    const s = server(all)
    const broken = async (a: bigint, l: number) => { if (a !== 0n && a < all[400]) throw new Error('HTTP 500'); return s.ask(a, l) }
    await expect(pullHistory(broken, { ...opts, attempts: 2 })).rejects.toThrow('HTTP 500')
  })
  it('does not retry when TikTok says stop, at the first request or later', async () => {
    let n = 0
    await expect(pullHistory(async () => { n++; throw new Fatal('HTTP 429') }, opts)).rejects.toBeInstanceOf(Fatal)
    expect(n).toBe(1)
    const s = server(positions(2000, 11))
    let later = 0
    const limited = async (a: bigint, l: number) => { if (a !== 0n && ++later > 6) throw new Fatal('HTTP 429'); return s.ask(a, l) }
    await expect(pullHistory(limited, opts)).rejects.toBeInstanceOf(Fatal)
    expect(s.calls.length).toBeLessThan(40)
  })
  it('can be cancelled', async () => {
    const s = server(positions(500))
    let stop = false
    const ask = async (a: bigint, l: number) => { stop = true; return s.ask(a, l) }
    await expect(pullHistory(ask, { ...opts, cancelled: () => stop })).rejects.toThrow('cancelled')
  })
})

describe('requests built on a request of the page', () => {
  const envelope = (cmd: number, body: Field[]) => encode([vint(1, cmd), vint(2, 10001), text(3, '1.8.4'), text(4, ''), vint(5, 3), vint(6, 0), text(7, 'abc:master'), sub(8, [bytes(cmd, encode(body))]), text(9, 'dev-123'), text(11, 'web'),
    sub(15, [text(1, 'aid'), text(2, '1988')]), sub(15, [text(1, 'Web-Sdk-Ms-Token'), text(2, 'tok')]), vint(18, 1), vint(77, 5)])
  const conv = { id: '0:1:11:22', type: 1n, shortId: 7123456789012345678n }
  const page301 = envelope(301, [text(1, conv.id), vint(2, 1), vint(3, conv.shortId), vint(4, 1), vint(5, 90), vint(6, 20)])

  it('reads the conversation of a history request', () => {
    const a = historyOf(page301)!
    expect(a.conv).toEqual(conv)
    expect([a.direction, a.anchor, a.limit]).toEqual([1n, 90n, 20n])
    expect(historyOf(envelope(203, [vint(1, 0)]))).toBeUndefined()
  })
  it('changes only anchor, size and sequence id', () => {
    const out = historyRequest(page301, { conv, direction: 1n, anchor: 0n, limit: 200n }, 40001)
    const r = parseRequest(out)
    expect(r.cmd).toBe(301)
    expect(historyOf(out)).toMatchObject({ conv, direction: 1n, anchor: 0n, limit: 200n })
    const was = decode(page301), now = decode(out)
    expect(now.map((f) => f.no)).toEqual(was.map((f) => f.no))
    expect(get(now, 2)).toBe(40001n)
    for (const f of was) if (![2, 8].includes(f.no)) expect(now.find((x) => x.no === f.no && x.v.toString() === f.v.toString())).toBeDefined() // headers, device id and unknown fields stay
  })
  it('turns the conversation list request into a history request', () => {
    const list = envelope(203, [vint(1, 0)])
    const out = historyRequest(list, { conv, direction: 1n, anchor: 0n, limit: 50n }, 40002)
    expect(parseRequest(out).cmd).toBe(301)
    expect(historyOf(out)).toMatchObject({ conv, limit: 50n })
    expect(parseRequest(out).headerKeys).toEqual(['aid', 'Web-Sdk-Ms-Token'])
  })
  it('refuses a malformed answer instead of guessing', () => {
    expect(() => decode(Uint8Array.from([0x0a, 0x05, 0x01]))).toThrow()
    expect(() => parseHistory(Uint8Array.from([0xff]))).toThrow()
  })
  it('reads status, messages, cursor and "more" from an answer', () => {
    const m = encode([text(1, conv.id), vint(3, 5), vint(4, 9), vint(6, 7), vint(7, 11), text(8, '{"text":"hi"}'), vint(10, 1700000000)])
    const resp = encode([vint(1, 301), vint(2, 1), vint(3, 0), text(4, 'OK'), sub(6, [sub(301, [bytes(1, m), bytes(1, m), vint(2, 8), vint(3, 1)])])])
    const p = parseHistory(resp)
    expect(p).toMatchObject({ status: 0, error: 'OK', next: 8n, hasMore: true })
    expect(p.messages).toHaveLength(2)
  })
})

describe('toEntries', () => {
  const m = (index: number, sender: number, content: string, o: { time?: number; ext?: Record<string, string>; type?: number; other?: Field[] } = {}): ImMessage =>
    ({ conversationId: 'c', serverId: BigInt(index), index: BigInt(index), type: BigInt(o.type ?? 7), sender: BigInt(sender), content, time: BigInt(o.time ?? 1700000000 + index), ext: o.ext ?? {}, other: o.other ?? [] })
  const msgs = (e: ReturnType<typeof toEntries>) => e.flatMap((x) => ('sep' in x ? [] : [x]))

  it('puts a date separator wherever the day changes and picks the side from the own id', () => {
    const day = 86400
    const e = toEntries([m(1, 11, '{"text":"a"}', { time: 1700000000 }), m(2, 22, '{"text":"b"}', { time: 1700000010 }), m(3, 11, '{"text":"c"}', { time: 1700000000 + 3 * day })], { own: '11' })
    expect(e.filter((x) => 'sep' in x)).toHaveLength(2)
    expect(msgs(e).map((x) => x.side)).toEqual(['me', 'them', 'me'])
    expect(msgs(e).map((x) => x.text)).toEqual(['a', 'b', 'c'])
  })
  it('uses the sides worked out from the page when the own id is unknown', () => {
    const e = toEntries([m(1, 11, '{"text":"a"}'), m(2, 22, '{"text":"b"}')], { sides: new Map([['11', 'them'], ['22', 'me']]) })
    expect(msgs(e).map((x) => x.side)).toEqual(['them', 'me'])
    expect(msgs(toEntries([m(1, 11, '{"text":"a"}')], {})).map((x) => x.side)).toEqual(['unknown'])
  })
  it('shows a shared video with its cover, once, and keeps the full content in the details', () => {
    const video = JSON.stringify({
      aweType: 800, itemId: '7300000000000000001', content_title: 'Title', content_name: 'Name', uid: '5', cover_width: 540, cover_height: 960,
      content_thumb: { url_list: ['https://p16.example.com/t.jpg'] },
      cover_url: { url_list: ['https://p16.example.com/c.heic', 'https://p16.example.com/c.jpg'] },
      author_avatar: { url_list: ['https://p16.example.com/a.jpg'] }
    })
    const [v] = msgs(toEntries([m(1, 11, video, { type: 8 })], { own: '11' }))
    expect(v.video).toMatchObject({ href: 'https://www.tiktok.com/@/video/7300000000000000001', text: 'Title', cover: { kind: 'image', src: 'https://p16.example.com/c.jpg', width: 540, height: 960 } })
    expect(v.text).toBe('')
    expect(v.media).toHaveLength(0) // neither the thumbnail (a second copy of the cover) nor the avatar is a picture of the message
    expect(v.rawText).toContain('7300000000000000001')
  })
  it('reads addresses of pictures that arrive as JSON text', () => {
    const video = JSON.stringify({ itemId: '1', cover_url: JSON.stringify({ url_list: ['https://p16.example.com/c.jpg'] }) })
    expect(msgs(toEntries([m(1, 11, video, { type: 8 })], { own: '11' }))[0].video?.cover?.src).toBe('https://p16.example.com/c.jpg')
  })
  it('shows a shared comment as a card with the comment and the video it is under', () => {
    const c = JSON.stringify({ aweType: 3500, author_id: '9', author_name: 'Ann', avatar_url: { url_list: ['https://p16.example.com/a.jpg'] }, aweme_id: '7400000000000000002', comment: 'nice', cover_url: { url_list: ['https://p16.example.com/v.jpg'] } })
    const [x] = msgs(toEntries([m(1, 22, c, { type: 40 })], { own: '11' }))
    expect(x.video).toMatchObject({ href: 'https://www.tiktok.com/@/video/7400000000000000002', text: 'Комментарий Ann: nice', cover: { src: 'https://p16.example.com/v.jpg' } })
    expect(x.side).toBe('them')
  })
  it('shows system notices from TikTok, and leaves out the hidden markers', () => {
    const e = toEntries([m(1, 0, '{"template":"You are now friends","tips":[]}', { type: 1 }), m(2, 11, '{"hack":"x"}', { type: 1805 }), m(3, 11, '{"text":"hi"}')], { own: '11' })
    const x = msgs(e)
    expect(x).toHaveLength(2)
    expect(x[0]).toMatchObject({ side: 'unknown', author: 'TikTok', text: 'You are now friends' })
    expect(isHidden(m(2, 11, '{}', { type: 1805 }))).toBe(true)
    expect(isHidden(m(3, 11, '{}'))).toBe(false)
  })
  it('keeps what it does not know in the details, and does not repeat what every message has', () => {
    const boring = { 's:mode': '0', 'im_callback_status_code': '0', 's:client_message_id': 'x', source_aid: '1988', 'a:entrance_type': '1' }
    const [plain] = msgs(toEntries([m(1, 11, '{"aweType":700,"text":"hi"}', { ext: boring, other: [vint(2, 1), vint(12, 7), vint(14, 0)] })], { own: '11' }))
    expect(plain.rawText).toBe('')
    const [odd] = msgs(toEntries([m(2, 11, '{"aweType":1234,"foo":"bar"}', { ext: { ...boring, new_key: 'v' }, other: [text(18, 'hello'), vint(24, 5)] })], { own: '11' }))
    expect(odd.rawText).toContain('foo')
    expect(odd.rawText).toContain('new_key')
    expect(odd.rawText).toContain('hello')
    expect(odd.outline).toContain('18,24')
  })
  it('shows reactions from field 15 with who reacted, and keeps them out of the details', () => {
    const react = (who: number) => bytes(15, encode([text(1, 'e:love'), sub(2, [sub(1, [vint(1, who), vint(2, 1700000000)])])]))
    const c = { ...m(1, 11, '{"text":"hi"}', { other: [react(22), react(11)] }), conversationId: '0:1:11:22' }
    const [x] = msgs(toEntries([c], { own: '11' }))
    expect(x.reactions).toEqual(['❤️ · собеседник', '❤️ · вы'])
    expect(x.rawText).toBe('')
  })
  it('fills the slots of a system notice and links the post it names', () => {
    const n = JSON.stringify({ tips: 'Ann liked {{1}} you shared', template: [{ key: 1, name: 'the post', extra: { item_id: '7696232449176505618' } }] })
    const [x] = msgs(toEntries([m(1, 0, n, { type: 1 })], { own: '11' }))
    expect(x.text).toBe('Ann liked the post you shared')
    expect(x.video?.href).toBe('https://www.tiktok.com/@/video/7696232449176505618')
  })
  it('shows a shared profile, a recalled message, and hides single-value markers', () => {
    const card = JSON.stringify({ uid: '5', secUID: 'x', name: 'Bob', desc: 'bob_1', avatar: { url_list: ['https://p16.example.com/a.jpg'] } })
    const [c] = msgs(toEntries([m(1, 11, card, { type: 25 })], { own: '11' }))
    expect(c.text).toBe('Профиль: Bob (@bob_1)')
    expect(c.media[0]).toMatchObject({ kind: 'image', src: 'https://p16.example.com/a.jpg' })
    const [r] = msgs(toEntries([m(2, 22, '', { ext: { 's:is_recalled': '1' } })], { own: '11' }))
    expect(r.text).toBe('Сообщение удалено')
    expect(isHidden(m(3, 11, '{"hack":"1"}', { type: 1813 }))).toBe(true)
  })
  it('reads seconds, milliseconds and microseconds', () => {
    expect(toMs(1700000000n)).toBe(1700000000000)
    expect(toMs(1700000000123n)).toBe(1700000000123)
    expect(toMs(1700000000123456n)).toBe(1700000000123.456)
  })
})
