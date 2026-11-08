// Chat assistant: a small chat with a language model that knows the open TikTok conversation.
// Pure: no Electron, no files. The transcript lives only in memory of the main process; the model gets it with every question.
// Kept cheap on purpose: compact lines, pictures described once by the cheap model (not resent), a system prompt that does not
// change between questions (so providers can cache it), and only the last few turns of the assistant conversation.
import type { ExportEntry, ExportMedia, ExportMessage, Person } from './chat-export-html'
import { PsyError, Provider, sleepMs } from './psycho'

export interface AssistTurn { role: 'user' | 'assistant'; text: string }
export interface Transcript { text: string; messages: number; cut: number; first?: string; last?: string; stats: string; style: string }

/** About 30 thousand tokens of Russian text: enough for hundreds of messages, cheap to send with every question. */
export const MAX_CHARS = 90_000
export const MAX_TURNS = 12 // assistant conversation kept for the model (older turns drop out)
export const ANSWER_TOKENS = 6000 // a cap, not a cost: gateway models «think» inside this budget too
export const LOOK_MAX = 48 // pictures described per load (newest first, each address once)
export const LOOK_BATCH = 12

const isMsg = (e: ExportEntry): e is ExportMessage => !('sep' in e)
const oneLine = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t }
const MEDIA: Record<string, string> = { image: 'фото', sticker: 'стикер', video: 'видео', audio: 'голосовое', file: 'файл' }

/** `5 мин`, `2 ч 10 мин`, `3 дн` */
export function span(ms: number): string {
  const m = Math.round(ms / 60000)
  if (m < 60) return `${Math.max(1, m)} мин`
  if (m < 48 * 60) return `${Math.floor(m / 60)} ч${m % 60 ? ` ${m % 60} мин` : ''}`
  return `${Math.round(m / 1440)} дн`
}

/** ms of a message from its day separator (дд.мм.гггг) and time (чч:мм[:сс]); undefined when either is not in that form. */
export function stampOf(day: string, time?: string): number | undefined {
  const d = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(day)
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(time ?? '')
  if (!d || !t) return
  return new Date(+d[3], +d[2] - 1, +d[1], +t[1], +t[2], +(t[3] ?? 0)).getTime()
}

/** Pictures worth a look, newest first, one per address: stickers, photos and covers of shared videos. */
export function pickMedia(entries: ExportEntry[], max = LOOK_MAX): ExportMedia[] {
  const out: ExportMedia[] = []
  const seen = new Set<string>()
  for (let i = entries.length - 1; i >= 0 && out.length < max; i--) {
    const e = entries[i]
    if (!isMsg(e)) continue
    for (const m of [...e.media, e.video?.cover]) {
      if (!m?.src || (m.kind !== 'image' && m.kind !== 'sticker') || seen.has(m.src)) continue
      seen.add(m.src)
      out.push(m)
      if (out.length >= max) break
    }
  }
  return out
}

export const LOOK_SYSTEM = 'Ты описываешь картинки из личной переписки, чтобы другой помощник понял их смысл без самих картинок. Для каждой картинки по номеру: что изображено, какая эмоция или намёк, весь текст на картинке дословно. Не больше 20 слов на картинку. Ответ — только JSON-объект {"1":"…","2":"…"} без пояснений.'

/** {"1":"…"} → descriptions by number; anything else is skipped. */
export function parseLooks(text: string): Map<number, string> {
  const out = new Map<number, string>()
  const t = text.replace(/```(?:json)?/gi, '')
  const a = t.indexOf('{'), b = t.lastIndexOf('}')
  if (a < 0 || b <= a) return out
  try {
    const j = JSON.parse(t.slice(a, b + 1)) as Record<string, unknown>
    for (const [k, v] of Object.entries(j)) if (/^\d+$/.test(k) && typeof v === 'string' && v.trim()) out.set(+k, oneLine(v, 200))
  } catch {}
  return out
}

/** One message as a line the model reads: `[12:03] Я: текст [стикер: описание] (ответ на: «…») {❤️ собеседник} (+2 ч)`. */
export function lineOf(m: ExportMessage, partner: string, looks?: Map<string, string>, gap?: number): string {
  const who = m.service ? 'TikTok' : m.side === 'me' ? 'Я' : m.side === 'them' ? (m.author && m.author !== partner ? m.author : partner) : (m.author ?? '?')
  const look = (x?: ExportMedia) => (x?.src ? looks?.get(x.src) : undefined)
  const parts: string[] = []
  if (m.reply) parts.push(`(ответ на: «${oneLine(m.reply, 100)}»)`)
  if (m.deleted) parts.push('[удалено]')
  if (m.text) parts.push(m.text.trim())
  if (m.video) {
    const cover = look(m.video.cover)
    parts.push(`[видео TikTok${m.video.text ? `: «${oneLine(m.video.text, 140)}»` : ''}${cover ? `; обложка: ${cover}` : ''}]`)
  }
  for (const x of m.media) {
    const l = look(x)
    parts.push(`[${MEDIA[x.kind] ?? 'файл'}${l ? `: ${l}` : x.label ? ` «${oneLine(x.label, 60)}»` : ''}]`)
  }
  if (!parts.length) parts.push(`[${m.tag ?? 'сообщение'}]`)
  else if (m.tag && !m.text && !m.media.length && !m.video) parts.push(`[${m.tag}]`)
  const r = m.reactions.map((x) => `${x.emoji}${x.who.length ? ' ' + x.who.join(', ') : x.count > 1 ? ' ×' + x.count : ''}`)
  return `[${(m.time ?? '').slice(0, 5)}]${gap ? ` (+${span(gap)})` : ''} ${who}: ${parts.join(' ')}${r.length ? ` {реакции: ${r.join('; ')}}` : ''}`
}

const EMOJI = /\p{Extended_Pictographic}/u
const median = (a: number[]) => { if (!a.length) return undefined; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }

interface Side { n: number; chars: number; stickers: number; emoji: number; questions: number; replies: number[]; starts: number; reacted: number }

/** Numbers the model would otherwise have to count by hand: who writes more, how fast each side answers, who starts again after a pause. */
export function chatStats(msgs: { m: ExportMessage; at?: number }[], partner: string): string {
  const s: Record<'me' | 'them', Side> = {
    me: { n: 0, chars: 0, stickers: 0, emoji: 0, questions: 0, replies: [], starts: 0, reacted: 0 },
    them: { n: 0, chars: 0, stickers: 0, emoji: 0, questions: 0, replies: [], starts: 0, reacted: 0 }
  }
  const people = msgs.filter((x) => !x.m.service && x.m.side !== 'unknown')
  let prev: { m: ExportMessage; at?: number } | undefined
  const half = Math.floor(people.length / 2)
  const early: number[] = [], late: number[] = []
  people.forEach((x, i) => {
    const side = s[x.m.side as 'me' | 'them']
    side.n++
    side.chars += x.m.text.length
    side.stickers += x.m.media.filter((y) => y.kind === 'sticker').length
    if (EMOJI.test(x.m.text)) side.emoji++
    if (x.m.text.includes('?')) side.questions++
    for (const r of x.m.reactions) for (const w of r.who) { if (w === 'вы') s.me.reacted++; else s.them.reacted++ }
    const gap = prev?.at !== undefined && x.at !== undefined ? x.at - prev.at : undefined
    if (prev && prev.m.side !== x.m.side && gap !== undefined && gap < 2 * 86400000) {
      side.replies.push(gap)
      if (x.m.side === 'them') (i < half ? early : late).push(gap)
    }
    if (!prev || (gap !== undefined && gap >= 6 * 3600000)) side.starts++
    prev = x
  })
  if (!people.length) return ''
  const row = (name: string, x: Side) => {
    const med = median(x.replies)
    return `- ${name}: ${x.n} сообщ. (${Math.round((100 * x.n) / people.length)}%), в среднем ${x.n ? Math.round(x.chars / x.n) : 0} знаков, с эмодзи ${x.emoji}, стикеров ${x.stickers}, вопросов ${x.questions}, реакций поставил(а) ${x.reacted}, обычно отвечает через ${med === undefined ? '?' : span(med)}, первым(ой) пишет после паузы 6+ ч: ${x.starts} раз`
  }
  const lines = ['Сводка по загруженной части (посчитано программой):', row('Я', s.me), row(partner, s.them)]
  const e = median(early), l = median(late)
  if (e !== undefined && l !== undefined && early.length >= 5 && late.length >= 5) lines.push(`- Скорость ответов собеседника: в первой половине обычно ${span(e)}, во второй ${span(l)}.`)
  const last = people[people.length - 1]
  lines.push(`- Последнее сообщение: ${last.m.side === 'me' ? 'Я' : partner}${last.at ? `, ${new Date(last.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}.`)
  return lines.join('\n')
}

const pct = (n: number, of: number) => `${Math.round((100 * n) / Math.max(1, of))}%`

/**
 * How the user really writes: case, full stops, commas, brackets-smileys, emoji, length, several short messages in a row,
 * plus their own latest messages word for word. Suggested replies must copy this, mistakes and all, not school grammar.
 */
export function styleOf(all: ExportMessage[]): string {
  const mine = all.filter((m) => m.side === 'me' && !m.service && !m.deleted && /\p{L}/u.test(m.text) && !/^https?:\/\/\S+$/.test(m.text.trim()))
  if (mine.length < 3) return ''
  const texts = mine.map((m) => m.text.trim())
  const letters = texts.map((t) => /\p{L}/u.exec(t)?.[0] ?? '')
  const lower = letters.filter((c) => c && c === c.toLowerCase() && c !== c.toUpperCase()).length
  const dot = texts.filter((t) => /[^.]\.$/.test(t)).length
  const bare = texts.filter((t) => /[\p{L}\d]$/u.test(t)).length
  const longer = texts.filter((t) => t.length > 25)
  const comma = longer.filter((t) => t.includes(',')).length
  const brackets = texts.filter((t) => /\){1,}$|\({2,}$/.test(t)).length
  const caps = texts.filter((t) => t.length > 3 && /\p{Lu}{4,}/u.test(t) && t === t.toUpperCase()).length
  const yo = texts.filter((t) => /ё/i.test(t)).length
  const emo = new Map<string, number>()
  for (const t of texts) for (const e of t.match(/\p{Extended_Pictographic}/gu) ?? []) emo.set(e, (emo.get(e) ?? 0) + 1)
  const top = [...emo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([e]) => e).join(' ')
  const lens = texts.map((t) => t.length).sort((a, b) => a - b)
  let runs = 0, inRun = 0, prevMe = false
  for (const m of all) { if (m.service) continue; if (m.side === 'me') { if (!prevMe) runs++; inRun++ } prevMe = m.side === 'me' }
  const samples = texts.slice(-14).map((t) => `  «${t.length > 140 ? t.slice(0, 140) + '…' : t}»`)
  return [
    `Как пишет «Я» (по ${texts.length} сообщениям, посчитано программой):`,
    `- с маленькой буквы: ${pct(lower, texts.length)}; точка в конце: ${pct(dot, texts.length)}; без знака в конце: ${pct(bare, texts.length)}; запятые в длинных сообщениях: ${longer.length ? pct(comma, longer.length) : 'нет данных'}`,
    `- скобочки-смайлы «)» в конце: ${pct(brackets, texts.length)}; капс: ${pct(caps, texts.length)}; буква «ё»: ${pct(yo, texts.length)}; эмодзи чаще всего: ${top || 'почти не ставит'}`,
    `- обычная длина: ${lens[Math.floor(lens.length / 2)]} знаков; сообщений подряд за раз: в среднем ${(inRun / Math.max(1, runs)).toFixed(1)}`,
    'Последние сообщения «Я» дословно (образец стиля, вместе с ошибками и опечатками):',
    ...samples
  ].join('\n')
}

/**
 * The conversation as plain text, oldest first, with a line for every new day and the pause before slow answers.
 * If it is longer than `max`, the oldest messages drop out (the latest matter most for advice) and `cut` says how many.
 */
export function transcriptOf(entries: ExportEntry[], partner: Person, looks?: Map<string, string>, max = MAX_CHARS): Transcript {
  const name = oneLine(partner.name || partner.handle || 'Собеседник', 24)
  const lines: { text: string; day?: string }[] = []
  const msgs: { m: ExportMessage; at?: number }[] = []
  let day = ''
  let prev: { m: ExportMessage; at?: number } | undefined
  for (const e of entries) {
    if (!isMsg(e)) { day = e.sep; lines.push({ text: `— ${e.sep} —`, day: e.sep }); continue }
    const at = stampOf(day, e.time)
    const gap = prev?.at !== undefined && at !== undefined ? at - prev.at : undefined
    const show = gap !== undefined && ((prev!.m.side !== e.side && gap >= 15 * 60000) || gap >= 3 * 3600000) ? gap : undefined
    lines.push({ text: lineOf(e, name, looks, show) })
    const x = { m: e, at }
    msgs.push(x)
    prev = x
  }
  let size = 0
  let from = lines.length
  while (from > 0 && size + lines[from - 1].text.length + 1 <= max) size += lines[--from].text.length + 1
  const kept = lines.slice(from)
  if (from > 0 && kept.length && !kept[0].day) { // never start in the middle of a day without saying which day it is
    const d = lines.slice(0, from).reverse().find((l) => l.day)
    if (d) kept.unshift(d)
  }
  const shown = kept.filter((l) => !l.day).length
  const days = kept.filter((l) => l.day).map((l) => l.day!)
  return { text: kept.map((l) => l.text).join('\n'), messages: shown, cut: msgs.length - shown, first: days[0], last: days[days.length - 1], stats: chatStats(msgs.slice(msgs.length - shown), name), style: styleOf(msgs.map((x) => x.m)) }
}

export interface PromptInfo { partner: Person; owner: Person; t: Transcript; complete: boolean }

/** System prompt: who is who, how far the context reaches, what to notice. Has no clock in it: it stays the same between questions. */
export function systemPrompt(i: PromptInfo): string {
  const them = `${i.partner.name || 'собеседник'}${i.partner.handle ? ` (@${i.partner.handle.replace(/^@/, '')})` : ''}`
  const reach = i.complete && !i.t.cut
    ? 'Ниже вся переписка с самого начала.'
    : `Ниже последние ${i.t.messages} сообщений${i.t.first ? `, начиная с ${i.t.first}` : ''}; более ранних ты не видишь, не выдумывай их.`
  return [
    'Ты — личный помощник по переписке в TikTok, внимательный и проницательный, как умный друг, который хорошо понимает людей. Ты видишь диалог пользователя и помогаешь: как ответить, что происходит, что человек на самом деле имеет в виду, как изменилось общение.',
    `Пользователь — «Я» в переписке${i.owner.name ? ` (${i.owner.name}${i.owner.handle ? `, @${i.owner.handle}` : ''})` : ''}. Собеседник — ${them}.`,
    reach,
    'Формат: «[чч:мм] автор: текст»; «— дд.мм.гггг —» — новый день; «(+2 ч)» — сколько прошло с предыдущего сообщения, когда пауза заметная; [стикер: …], [фото: …], [видео TikTok: подпись; обложка: …] — вложения, описанные словами (сами картинки ты не видишь); (ответ на: «…») — цитата; {реакции: …} — кто какую поставил. Каждая строка в квадратных скобках в начале — время сообщения.',
    'Замечай всё: время и скорость ответов, кто пишет первым и кто заканчивает разговор, длину сообщений и как она меняется, эмодзи, скобочки, точки, капс, сухие «ок» и «ну да», вопросы без ответа, сменённые темы, реакции, стикеры и что они выражают, какие видео человек присылает и на что этим намекает, ночные сообщения, паузы в днях. Лови суть и подтекст, а не пересказывай.',
    'Правила ответа:',
    '- По-русски (или на языке вопроса). Коротко и по делу: сначала главный вывод, потом 2–5 конкретных наблюдений со ссылкой на сообщения (короткая цитата и время или дата). Длинно — только если просят подробно.',
    '- Когда спрашивают, как ответить: 2–3 готовых сообщения, каждое отдельной строкой в кавычках «…», и одна фраза, чем они различаются. Учитывай, кто писал последним, сколько прошло времени и что осталось без ответа. Советуй смело и честно, даже если правда неприятная.',
    '- Готовые сообщения пиши ровно так, как пишет сам «Я» (см. «Как пишет «Я»» и его сообщения в переписке): та же грамотность, регистр, пунктуация, длина, сокращения, сленг, опечатки, скобочки и эмодзи. Если «Я» пишет с маленькой буквы, без точек и запятых, с «щас», «норм», «чё» — пиши так же. Никогда не делай текст грамотнее, вежливее, длиннее или «литературнее», чем у «Я», и не исправляй его ошибки. Если «Я» обычно шлёт несколько коротких сообщений подряд, дай вариант так же: части через « / » внутри одних кавычек.',
    '- Отделяй факты из переписки от догадок. Не выдумывай того, чего нет. Если истории мало для вывода, скажи и предложи загрузить больше.',
    '- Без диагнозов и ярлыков о личности: говори о сигналах и вероятностях.',
    '- Ты только советуешь и сам ничего не отправляешь.',
    '',
    i.t.stats,
    '',
    i.t.style,
    '',
    '<переписка>',
    i.t.text || '(сообщений нет)',
    '</переписка>'
  ].join('\n')
}

/** The clock goes with the question, not into the system prompt, so the long prompt stays cacheable. */
export function questionOf(text: string, now = new Date()): string {
  const stamp = now.toLocaleString('ru-RU', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  return `[сейчас ${stamp}]\n${text}`
}

// ───────── streaming client ─────────

export interface Reply { text: string; inTok: number; outTok: number }

function request(p: Provider, model: string, system: string, turns: AssistTurn[]): { url: string; headers: Record<string, string>; body: string } {
  const base = p.base.replace(/\/+$/, '')
  const messages = turns.slice(-MAX_TURNS).map((t) => ({ role: t.role, content: t.text }))
  while (messages.length && messages[0].role !== 'user') messages.shift() // both APIs want the user to speak first
  if (p.kind === 'anthropic') {
    return {
      url: base + '/v1/messages',
      headers: { 'x-api-key': p.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      // the transcript is the same for every question: cached, so follow-ups cost a tenth
      body: JSON.stringify({ model, max_tokens: ANSWER_TOKENS, stream: true, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], messages })
    }
  }
  return {
    url: base + '/chat/completions',
    headers: { authorization: 'Bearer ' + p.key, 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: ANSWER_TOKENS, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'system', content: system }, ...messages] })
  }
}

/** Reads one server-sent event's data into the reply. Unknown events are ignored. */
export function applyEvent(kind: Provider['kind'], data: string, r: Reply): void {
  if (!data || data === '[DONE]') return
  let j: any
  try { j = JSON.parse(data) } catch { return }
  if (j?.type === 'error' || (j?.error && !j?.choices)) throw new PsyError('Модель прервала ответ: ' + (j.error?.message ?? j.error ?? 'ошибка'), false)
  if (kind === 'anthropic') {
    if (j?.type === 'content_block_delta' && j.delta?.type === 'text_delta') r.text += String(j.delta.text ?? '')
    const u = j?.message?.usage ?? j?.usage
    if (u) {
      const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      if (input) r.inTok = input
      if (u.output_tokens) r.outTok = u.output_tokens
    }
    return
  }
  const d = j?.choices?.[0]?.delta
  if (typeof d?.content === 'string') r.text += d.content
  else if (Array.isArray(d?.content)) r.text += d.content.map((x: any) => String(x?.text ?? '')).join('')
  if (j?.usage) { r.inTok = j.usage.prompt_tokens ?? r.inTok; r.outTok = j.usage.completion_tokens ?? r.outTok }
}

/** Whole (non-streamed) answer, for servers that ignore `stream`. */
function wholeOf(kind: Provider['kind'], body: any): Reply {
  const text = kind === 'anthropic'
    ? (Array.isArray(body?.content) ? body.content.filter((b: any) => b?.type === 'text').map((b: any) => String(b.text)).join('') : '')
    : String(body?.choices?.[0]?.message?.content ?? '')
  return { text, inTok: body?.usage?.input_tokens ?? body?.usage?.prompt_tokens ?? 0, outTok: body?.usage?.output_tokens ?? body?.usage?.completion_tokens ?? 0 }
}

/**
 * One answer, streamed: `onText` gets the whole text so far after every piece. 429 and 5xx before the first piece are retried
 * with a pause; a bad key, an empty balance or a wrong model stop with a clear message (same wording as the portrait).
 */
export async function streamReply(
  p: Provider, model: string, system: string, turns: AssistTurn[],
  onText: (text: string) => void, signal?: AbortSignal, f: typeof fetch = fetch, wait: (ms: number) => Promise<void> = sleepMs
): Promise<Reply> {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw new PsyError('Остановлено.', false)
    const q = request(p, model, system, turns)
    let res: Response
    try {
      res = await f(q.url, { method: 'POST', headers: { ...q.headers, accept: 'text/event-stream' }, body: q.body, signal })
    } catch (e) {
      if (signal?.aborted) throw new PsyError('Остановлено.', false)
      if (attempt >= 3) throw new PsyError('Нет связи с API модели: ' + (e as Error).message)
      await wait(1500 * 2 ** attempt)
      continue
    }
    if (!res.ok) {
      const body = await res.json().catch(() => null) as any
      const msg: string = (typeof body?.error === 'string' ? body.error : body?.error?.message) ?? ''
      if (res.status === 401 || res.status === 403) throw new PsyError('Ключ API не принят. Проверьте его в «Настройках».')
      if (res.status === 402 || (res.status === 400 && /credit balance|billing|insufficient/i.test(msg))) throw new PsyError('На счёте провайдера закончились средства или токены.')
      if (res.status === 404) throw new PsyError(`Модель «${model}» или адрес API не найдены (${msg || '404'}). Проверьте «Настройки».`)
      if (res.status === 400 && /context|too long|maximum|prompt is too/i.test(msg)) throw new PsyError('Переписка не помещается в модель. Загрузите меньше сообщений или выберите модель с большим контекстом.')
      if (res.status === 429 || res.status === 529 || res.status >= 500) {
        if (attempt >= 4) throw new PsyError(res.status === 429 ? 'Лимит запросов провайдера: попробуйте через минуту.' : 'Провайдер перегружен: попробуйте позже.')
        const ra = Number(res.headers.get('retry-after'))
        await wait(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : Math.min(20000, 2000 * 2 ** attempt))
        continue
      }
      throw new PsyError(`API: ${res.status} ${msg}`.trim())
    }
    if (!/event-stream/i.test(res.headers.get('content-type') ?? '') || !res.body) {
      const whole = wholeOf(p.kind, await res.json().catch(() => null))
      if (!whole.text) throw new PsyError('Модель вернула пустой ответ.', false)
      onText(whole.text)
      return whole
    }
    const r: Reply = { text: '', inTok: 0, outTok: 0 }
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    const line = (raw: string) => {
      const l = raw.replace(/\r$/, '')
      if (!l.startsWith('data:')) return
      const before = r.text.length
      applyEvent(p.kind, l.slice(5).trim(), r)
      if (r.text.length !== before) onText(r.text)
    }
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) { line(buf.slice(0, nl)); buf = buf.slice(nl + 1) }
      }
      line(buf)
    } catch (e) {
      if (signal?.aborted) { if (r.text) return r; throw new PsyError('Остановлено.', false) }
      if (e instanceof PsyError) throw e
      if (r.text) return r // the connection broke mid-answer: keep what came
      throw new PsyError('Связь с API оборвалась: ' + (e as Error).message, false)
    }
    if (!r.text) throw new PsyError('Модель вернула пустой ответ (возможно, весь лимит ушёл на «размышления»).', false)
    return r
  }
}

// ───────── history of conversations with the assistant ─────────
// Kept so the user can come back to earlier advice. Only the questions and answers are stored (encrypted by the caller),
// never the loaded chat itself.

export interface StoredTurn { role: 'user' | 'assistant'; text: string; error?: boolean }
export interface Talk { id: string; chat: string; accountId: string; partner: string; handle?: string; title: string; createdAt: number; updatedAt: number; turns: StoredTurn[] }
export const TALKS_MAX = 150
export const TALK_TURNS_MAX = 200
const TURN_MAX = 20_000

/** The first question, short: the name of a conversation in the list. */
export const titleOf = (q: string) => oneLine(q, 70) || 'Разговор'

/** Talks read back from disk: anything odd is dropped, sizes are capped, newest first. */
export function cleanTalks(raw: unknown): Talk[] {
  if (!Array.isArray(raw)) return []
  const str = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '')
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const out: Talk[] = []
  for (const x of raw as Record<string, unknown>[]) {
    if (!x || typeof x !== 'object' || !str(x.id, 64) || !str(x.chat, 400) || !Array.isArray(x.turns)) continue
    const turns = (x.turns as Record<string, unknown>[])
      .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string')
      .slice(-TALK_TURNS_MAX)
      .map((t): StoredTurn => ({ role: t.role as StoredTurn['role'], text: str(t.text, TURN_MAX), ...(t.error === true ? { error: true } : {}) }))
    if (!turns.length) continue
    out.push({ id: str(x.id, 64), chat: str(x.chat, 400), accountId: str(x.accountId, 64), partner: str(x.partner, 100), handle: str(x.handle, 100) || undefined, title: str(x.title, 100) || titleOf(turns[0].text), createdAt: num(x.createdAt), updatedAt: num(x.updatedAt), turns })
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, TALKS_MAX)
}

/** Puts a talk first (new or updated) and keeps the list within its limit. */
export function upsertTalk(list: Talk[], t: Talk): Talk[] {
  const turns = t.turns.slice(-TALK_TURNS_MAX).map((x) => ({ ...x, text: x.text.slice(0, TURN_MAX) }))
  return [{ ...t, turns }, ...list.filter((x) => x.id !== t.id)].slice(0, TALKS_MAX)
}
