import { describe, expect, it } from 'vitest'
import { BATCH, parseHandle, profileOf, Deps, PageReply, PsyError, RepostItem, Vlm, analyze, collect, parseJson, parseNotes, pool, sanitizeReport, statsOf } from '../src/main/psycho'
import { esc, renderDeck, safeThumb } from '../src/main/psycho-html'

const item = (n: number, o: Partial<RepostItem> = {}): RepostItem => ({
  id: String(1000 + n), desc: `видео ${n} #тег${n % 3}`, time: 1_700_000_000 + n * 86400 * 9, author: 'a' + (n % 4), nick: '', cover: 'https://x.test/c' + n, cover2: '', dur: 10, music: '', tags: ['тег' + (n % 3)], plays: 1, play: '', photo: false, ...o
})

const noWait = async () => {}
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers })

describe('Vlm', () => {
  it('speaks the Anthropic Messages format and reads usage', async () => {
    let seen: any
    const vlm = new Vlm({ kind: 'anthropic', base: 'https://api.anthropic.com/', key: 'k1' }, (async (url: string, init: any) => {
      seen = { url, headers: init.headers, body: JSON.parse(init.body) }
      return reply({ content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 3 } })
    }) as any, noWait)
    const out = await vlm.ask('claude-haiku-5-5', 'sys', [{ type: 'text', text: 'hi' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' } }], 100)
    expect(out).toBe('ok')
    expect(seen.url).toBe('https://api.anthropic.com/v1/messages')
    expect(seen.headers['x-api-key']).toBe('k1')
    expect(seen.body.system).toBe('sys')
    expect(seen.body.messages[0].content[1].type).toBe('image')
    expect(vlm.usage).toEqual({ inTok: 10, outTok: 3, calls: 1 })
  })

  it('speaks Chat Completions for everything else, images as data URLs', async () => {
    let seen: any
    const vlm = new Vlm({ kind: 'openai', base: 'https://gw.test/v1', key: 'k2' }, (async (url: string, init: any) => {
      seen = { url, headers: init.headers, body: JSON.parse(init.body) }
      return reply({ choices: [{ message: { content: 'ответ' } }], usage: { prompt_tokens: 7, completion_tokens: 2 } })
    }) as any, noWait)
    const out = await vlm.ask('deepseek-v4-flash', 'sys', [{ type: 'text', text: 'hi' }, { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'BBB' } }], 100)
    expect(out).toBe('ответ')
    expect(seen.url).toBe('https://gw.test/v1/chat/completions')
    expect(seen.headers.authorization).toBe('Bearer k2')
    expect(seen.body.messages[0]).toEqual({ role: 'system', content: 'sys' })
    expect(seen.body.messages[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/webp;base64,BBB' } })
    expect(vlm.usage.inTok).toBe(7)
  })

  it('retries 429 and 5xx, honours retry-after, then succeeds', async () => {
    const waits: number[] = []
    let n = 0
    const vlm = new Vlm({ kind: 'anthropic', base: 'https://a.test', key: 'k' }, (async () => {
      n++
      if (n === 1) return reply({ error: { message: 'slow' } }, 429, { 'retry-after': '3' })
      if (n === 2) return reply({}, 529)
      return reply({ content: [{ type: 'text', text: 'ok' }] })
    }) as any, async (ms) => { waits.push(ms) })
    expect(await vlm.ask('m', 's', [], 10)).toBe('ok')
    expect(waits[0]).toBe(3000)
    expect(waits.length).toBe(2)
  })

  it('a bad key, an empty balance and a missing model are fatal with a clear message', async () => {
    const mk = (status: number, error: unknown) => new Vlm({ kind: 'openai', base: 'https://g.test', key: 'k' }, (async () => reply({ error }, status)) as any, noWait)
    await expect(mk(401, { message: 'no' }).ask('m', 's', [], 10)).rejects.toMatchObject({ fatal: true, message: expect.stringContaining('Ключ') })
    await expect(mk(402, 'pay').ask('m', 's', [], 10)).rejects.toMatchObject({ fatal: true, message: expect.stringContaining('средства') })
    await expect(mk(404, { message: 'x' }).ask('mm', 's', [], 10)).rejects.toThrow(/mm/)
  })

  it('stops at once when cancelled', async () => {
    const vlm = new Vlm({ kind: 'anthropic', base: 'https://a.test', key: 'k' }, (async () => { throw new Error('should not be called') }) as any, noWait)
    await expect(vlm.ask('m', 's', [], 10, () => true)).rejects.toThrow('Остановлено')
  })
})

describe('parsing', () => {
  it('finds JSON in fenced or chatty replies', () => {
    expect(parseJson('вот:\n```json\n{"a":1}\n```\nготово')).toEqual({ a: 1 })
    expect(parseJson('[{"i":1}] хвост')).toEqual([{ i: 1 }])
    expect(parseJson('нет json')).toBeNull()
  })

  it('notes: keeps numbered objects, clamps kinds and lengths', () => {
    const notes = parseNotes(JSON.stringify([{ i: 3, ocr: 'x'.repeat(500), topic: 'т', tone: 'т', kind: 'странный', note: 'n' }, { i: 'a' }, null]))
    expect(notes).toHaveLength(1)
    expect(notes[0].kind).toBe('другое')
    expect(notes[0].ocr.length).toBeLessThanOrEqual(200)
  })

  it('report: always complete, numbers clamped, junk dropped', () => {
    const r = sanitizeReport({ title: 7, traits: [{ name: 'Открытость', score: 250, why: 'потому' }, { score: 5 }], evidence: [{ i: '4', quote: 'q' }, { i: 'x' }], values: 'не список' })
    expect(r.title).toBe('7')
    expect(r.traits).toEqual([{ name: 'Открытость', score: 100, why: 'потому' }])
    expect(r.evidence.map((e) => e.i)).toEqual([4])
    expect(r.values).toEqual([])
    expect(r.caveat.length).toBeGreaterThan(10)
    expect(sanitizeReport(null).archetype.name).toBe('—')
  })
})

describe('parseHandle', () => {
  it('takes a name, an @name or a profile link, nothing else', () => {
    expect(parseHandle('@cool_user')).toBe('cool_user')
    expect(parseHandle(' cool.user ')).toBe('cool.user')
    expect(parseHandle('https://www.tiktok.com/@cool_user?lang=ru')).toBe('cool_user')
    expect(parseHandle('tiktok.com/@a.b/video/123')).toBe('a.b')
    expect(parseHandle('https://evil.test/@cool_user')).toBeUndefined()
    expect(parseHandle('a b')).toBeUndefined()
    expect(parseHandle('x')).toBeUndefined()
    expect(parseHandle('')).toBeUndefined()
  })
})

describe('profileOf', () => {
  it('knows a profile page, with or without a language prefix, and nothing else', () => {
    expect(profileOf('https://www.tiktok.com/@cool_user')).toBe('cool_user')
    expect(profileOf('https://www.tiktok.com/@cool.user/video/7123?lang=ru')).toBe('cool.user')
    expect(profileOf('https://www.tiktok.com/ru-RU/@cool_user')).toBe('cool_user')
    expect(profileOf('https://www.tiktok.com/foryou')).toBeUndefined()
    expect(profileOf('https://www.tiktok.com/messages')).toBeUndefined()
    expect(profileOf('https://evil.test/@cool_user')).toBeUndefined()
    expect(profileOf('https://nottiktok.com/@cool_user')).toBeUndefined()
    expect(profileOf('http://127.0.0.1:5000/@dev_user', 'http://127.0.0.1:5000')).toBe('dev_user')
    expect(profileOf('http://127.0.0.1:5000/@dev_user')).toBeUndefined()
    expect(profileOf('')).toBeUndefined()
  })
})

describe('pool', () => {
  it('limits concurrency and keeps order', async () => {
    let now = 0, peak = 0
    const out = await pool([1, 2, 3, 4, 5, 6, 7], 3, async (x) => { now++; peak = Math.max(peak, now); await Promise.resolve(); await Promise.resolve(); now--; return x * 2 })
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14])
    expect(peak).toBe(3)
  })
})

/** A fake list endpoint: `pages` is the items per page; a page may come back empty while hasMore stays true. */
function lister(pages: RepostItem[][], quirk: { stuck?: boolean; http?: number; failAt?: number } = {}) {
  const calls: string[] = []
  const page = async (cursor: string): Promise<PageReply> => {
    calls.push(cursor)
    const at = Number(cursor)
    if (quirk.http && (at === (quirk.failAt ?? 0))) return { http: quirk.http, code: -1, msg: '', items: [], hasMore: false, cursor }
    return { http: 200, code: 0, msg: '', items: pages[at] ?? [], hasMore: at + 1 < pages.length, cursor: quirk.stuck ? cursor : String(at + 1) }
  }
  return { page, calls }
}
const deps = (page: Deps['page'], vlm: Vlm, over: Partial<Deps> = {}): Deps => ({
  page, cover: async () => ({ media: 'image/jpeg', b64: 'QQ==', thumb: 'data:image/jpeg;base64,QQ==' }), vlm, progress: () => {}, cancelled: () => false, ...over
})

describe('collect', () => {
  it('walks through empty pages, drops duplicates and respects the limit', async () => {
    const l = lister([[item(1), item(2)], [], [], [item(2), item(3)], [item(4)]])
    const w: string[] = []
    expect((await collect(deps(l.page, null as any), 100, w)).map((x) => x.id)).toEqual(['1001', '1002', '1003', '1004'])
    const w2: string[] = []
    expect(await collect(deps(l.page, null as any), 3, w2)).toHaveLength(3)
    expect(w2[0]).toContain('3')
  })

  it('a stuck cursor ends the walk with a warning, not a hang', async () => {
    const l = lister([[item(1)], [item(2)]], { stuck: true })
    const w: string[] = []
    const got = await collect(deps(l.page, null as any), 100, w)
    expect(got.length).toBeGreaterThan(0)
    expect(w.join()).toContain('курсор')
    expect(l.calls.length).toBeLessThan(10)
  })

  it('403 on the first page is an error, later it only truncates', async () => {
    await expect(collect(deps(lister([[item(1)]], { http: 403 }).page, null as any), 10, [])).rejects.toBeInstanceOf(PsyError)
    const w: string[] = []
    const got = await collect(deps(lister([[item(1)], [item(2)]], { http: 429, failAt: 1 }).page, null as any), 10, w)
    expect(got).toHaveLength(1)
    expect(w.join()).toContain('не полностью')
  })
})

/** A fake model: step 1 describes every "Видео N" it sees, step 2 returns a report that cites video 2 and a bogus one. */
function model(opts: { failImages?: boolean; skip?: number } = {}) {
  const log = { vision: 0, synth: 0, imagesSeen: 0, textOnlyRetries: 0 }
  const f = (async (_url: string, init: any) => {
    const b = JSON.parse(init.body)
    const content = b.messages[0].content as any[]
    if (String(b.system).includes('размечаешь')) {
      log.vision++
      const imgs = content.filter((c) => c.type === 'image').length
      log.imagesSeen += imgs
      if (opts.failImages && imgs) return reply({ error: { message: 'bad image' } }, 400)
      if (opts.failImages) log.textOnlyRetries++
      const nums = content.filter((c) => c.type === 'text').map((c) => Number(/^Видео (\d+)/.exec(c.text)![1]))
      const out = nums.filter((n) => n !== opts.skip).map((i) => ({ i, ocr: 'текст ' + i, topic: 'тема', tone: 'ирония', kind: i % 2 ? 'мем' : 'юмор', note: 'видно' }))
      return reply({ content: [{ type: 'text', text: JSON.stringify(out) }], usage: { input_tokens: 100, output_tokens: 50 } })
    }
    log.synth++
    return reply({ content: [{ type: 'text', text: '```json\n' + JSON.stringify({ title: 'Портрет', archetype: { name: 'Ироник', tagline: 'т', description: 'д' }, summary: 'с', traits: [{ name: 'Открытость', score: 80, why: 'в' }], evidence: [{ i: 2, quote: 'q', meaning: 'm' }, { i: 9999, quote: 'нет такого', meaning: 'x' }] }) + '\n```' }], usage: { input_tokens: 900, output_tokens: 400 } })
  }) as any
  return { vlm: new Vlm({ kind: 'anthropic', base: 'https://a.test', key: 'k' }, f, noWait), log }
}

describe('analyze', () => {
  const pagesOf = (n: number) => Array.from({ length: Math.ceil(n / 30) }, (_, p) => Array.from({ length: Math.min(30, n - p * 30) }, (_, k) => item(p * 30 + k + 1)))

  it('reads every cover in batches, then writes one portrait', async () => {
    const m = model()
    const seen: string[] = []
    const a = await analyze(deps(lister(pagesOf(70)).page, m.vlm, { progress: (p) => seen.push(p.phase) }), { limit: 500, frames: false })
    expect(a.items).toHaveLength(70)
    expect(m.log.vision).toBe(Math.ceil(70 / BATCH))
    expect(m.log.imagesSeen).toBe(70)
    expect(m.log.synth).toBe(1)
    expect(a.notes.size).toBe(70)
    expect(a.report.title).toBe('Портрет')
    expect(a.report.evidence.map((e) => e.i)).toEqual([2]) // the made-up video number is dropped
    expect(a.stats.total).toBe(70)
    expect(a.stats.kinds.map((k) => k.name).sort()).toEqual(['мем', 'юмор'])
    expect(new Set(seen)).toEqual(new Set(['collect', 'vision', 'synth']))
    expect(a.usage.calls).toBe(m.log.vision + 1)
  })

  it('a rejected picture falls back to text only for that batch, with a warning', async () => {
    const m = model({ failImages: true })
    const a = await analyze(deps(lister(pagesOf(30)).page, m.vlm), { limit: 500, frames: false })
    expect(m.log.textOnlyRetries).toBeGreaterThan(0)
    expect(a.warnings.join()).toContain('только по подписи')
    expect(a.notes.size).toBe(30)
  })

  it('tells about videos the model skipped', async () => {
    const a = await analyze(deps(lister(pagesOf(30)).page, model({ skip: 5 }).vlm), { limit: 500, frames: false })
    expect(a.notes.has(5)).toBe(false)
    expect(a.warnings.join()).toContain('не описала 1')
  })

  it('frames are only fetched when asked', async () => {
    let asked = 0
    const frames = async () => { asked++; return [{ media: 'image/jpeg', b64: 'Rg==' }] }
    await analyze(deps(lister(pagesOf(12)).page, model().vlm, { frames }), { limit: 50, frames: false })
    expect(asked).toBe(0)
    await analyze(deps(lister(pagesOf(12)).page, model().vlm, { frames }), { limit: 50, frames: true })
    expect(asked).toBe(12)
  })

  it('refuses to profile from a handful of reposts, and stops on cancel', async () => {
    await expect(analyze(deps(lister([[item(1), item(2)]]).page, model().vlm), { limit: 50, frames: false })).rejects.toThrow('слишком мало')
    await expect(analyze(deps(lister([[]]).page, model().vlm), { limit: 50, frames: false })).rejects.toThrow('нет видимых')
    let stop = false
    const m = model()
    await expect(analyze(deps(lister(pagesOf(60)).page, m.vlm, { cancelled: () => stop, progress: (p) => { if (p.phase === 'vision') stop = true } }), { limit: 500, frames: false })).rejects.toThrow('Остановлено')
  })

  it('a bad key during the vision stage stops the whole run', async () => {
    const vlm = new Vlm({ kind: 'anthropic', base: 'https://a.test', key: 'bad' }, (async () => reply({ error: { message: 'x' } }, 401)) as any, noWait)
    await expect(analyze(deps(lister(pagesOf(30)).page, vlm), { limit: 500, frames: false })).rejects.toMatchObject({ fatal: true })
  })

  it('counts months and top authors', () => {
    const items = [item(1), item(2), item(3, { author: 'a1', photo: true })]
    const s = statsOf(items, new Map())
    expect(s.total).toBe(3)
    expect(s.authors[0].name).toBe('a1')
    expect(s.photos).toBe(1)
    expect(s.months.length).toBeGreaterThan(0)
  })
})

describe('deck', () => {
  const base = () => ({ owner: { name: 'Я <b>', handle: 'me' }, stats: statsOf([item(1), item(2)], new Map()), items: [item(1), item(2)], thumbs: new Map<number, string>(), warnings: ['w <i>'], generatedAt: 1_760_000_000_000 })

  it('escapes everything the model or TikTok wrote', () => {
    const report = sanitizeReport({ title: '<script>alert(1)</script>', summary: '"><img src=x onerror=1>', archetype: { name: '<b>x</b>' }, evidence: [{ i: 1, quote: '<u>q</u>', meaning: "'m'" }] })
    const html = renderDeck({ ...base(), report })
    expect(html).not.toMatch(/<script>alert/)
    expect(html).not.toContain('<img src=x')
    expect(html).not.toContain('<u>q</u>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain('w &lt;i&gt;')
  })

  it('only data: images of the right type get in', () => {
    expect(safeThumb('data:image/jpeg;base64,QUJD')).not.toBe('')
    expect(safeThumb('https://evil.test/a.png')).toBe('')
    expect(safeThumb('data:image/svg+xml;base64,QUJD')).toBe('')
    expect(safeThumb('data:image/jpeg;base64,QUJD" onerror="x')).toBe('')
    const report = sanitizeReport({ evidence: [{ i: 1, quote: 'q', meaning: 'm' }] })
    const html = renderDeck({ ...base(), report, thumbs: new Map([[1, 'https://evil.test/a.png']]) })
    expect(html).not.toContain('evil.test')
    const ok = renderDeck({ ...base(), report, thumbs: new Map([[1, 'data:image/jpeg;base64,QUJD']]) })
    expect(ok).toContain('<img src="data:image/jpeg;base64,QUJD"')
  })

  it('shows what is on his mind and the romance signals, escaped, without naming anyone', () => {
    const report = sanitizeReport({ onMind: [{ theme: 'Тоска <b>', note: 'видео 3, 7' }], romance: 'Много тоски по расставанию <i>', communication: 'сдержанно', motivations: [{ name: 'Признание', note: 'н' }] })
    expect(report.onMind).toHaveLength(1)
    const html = renderDeck({ ...base(), report })
    expect(html).toContain('slide mind')
    expect(html).toContain('slide romance')
    expect(html).toContain('Тоска &lt;b&gt;')
    expect(html).not.toContain('<i>')
  })

  it('has the slides in order and the navigation script', () => {
    const html = renderDeck({ ...base(), report: sanitizeReport({ title: 'T', traits: [{ name: 'Открытость', score: 70, why: 'w' }] }) })
    expect((html.match(/class="slide /g) ?? []).length).toBeGreaterThanOrEqual(6)
    expect(html.indexOf('slide title')).toBeLessThan(html.indexOf('slide traits'))
    expect(html).toContain('ArrowRight')
    expect(esc(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;')
  })
})
