// Protobuf wire codec and the shapes of TikTok web's IM calls (POST https://im-api-<region>.tiktok.com/v1/message/get_by_conversation).
// No Electron in here, so it runs in unit tests. Field numbers come from the open-source reference cv-cat/catbus (MIT,
// src/platforms/tiktok/web/wire.ts) and from what the page itself sends: a request the page made is the template for ours,
// every envelope field we do not understand stays byte for byte as the page had it.

export type Raw = bigint | Uint8Array
export interface Field { no: number; wire: number; v: Raw }

const td = new TextDecoder()
const te = new TextEncoder()

/** Reads one message level. Throws on anything malformed: a half-understood answer must never become data. */
export function decode(buf: Uint8Array): Field[] {
  const out: Field[] = []
  let o = 0
  const varint = (): bigint => {
    let v = 0n
    for (let s = 0n; s < 70n; s += 7n) {
      if (o >= buf.length) throw new Error('protobuf: varint cut off')
      const b = buf[o++]
      v |= BigInt(b & 0x7f) << s
      if (b < 0x80) return v
    }
    throw new Error('protobuf: varint too long')
  }
  while (o < buf.length) {
    const tag = varint()
    const no = Number(tag >> 3n)
    const wire = Number(tag & 7n)
    if (!no) throw new Error('protobuf: field 0')
    if (wire === 0) out.push({ no, wire, v: varint() })
    else if (wire === 2 || wire === 1 || wire === 5) {
      const n = wire === 2 ? Number(varint()) : wire === 1 ? 8 : 4
      if (n < 0 || o + n > buf.length) throw new Error('protobuf: bytes cut off')
      out.push({ no, wire, v: buf.subarray(o, o + n) })
      o += n
    } else throw new Error('protobuf: wire type ' + wire)
  }
  return out
}

function putVarint(out: number[], value: bigint) {
  let n = value < 0n ? value + (1n << 64n) : value
  while (n > 0x7fn) { out.push(Number(n & 0x7fn) | 0x80); n >>= 7n }
  out.push(Number(n))
}

export function encode(fields: Field[]): Uint8Array {
  const parts: Uint8Array[] = []
  for (const f of fields) {
    const head: number[] = []
    putVarint(head, BigInt((f.no << 3) | f.wire))
    if (f.v instanceof Uint8Array) {
      if (f.wire === 2) putVarint(head, BigInt(f.v.length))
      parts.push(Uint8Array.from(head), f.v)
    } else {
      putVarint(head, f.v)
      parts.push(Uint8Array.from(head))
    }
  }
  return Buffer.concat(parts)
}

export const vint = (no: number, v: bigint | number): Field => ({ no, wire: 0, v: BigInt(v) })
export const bytes = (no: number, v: Uint8Array): Field => ({ no, wire: 2, v })
export const text = (no: number, s: string): Field => bytes(no, te.encode(s))
export const sub = (no: number, fields: Field[]): Field => bytes(no, encode(fields))

export const get = (fs: Field[], no: number): Raw | undefined => fs.find((f) => f.no === no)?.v
export const getAll = (fs: Field[], no: number): Raw[] => fs.filter((f) => f.no === no).map((f) => f.v)
export const asInt = (v?: Raw): bigint => (typeof v === 'bigint' ? v : 0n)
export const asStr = (v?: Raw): string => (v instanceof Uint8Array ? td.decode(v) : '')
export const asMsg = (v?: Raw): Field[] => (v instanceof Uint8Array ? decode(v) : [])

// ----- requests -----

export interface Conversation { id: string; type: bigint; shortId: bigint }
export interface HistoryAsk { conv: Conversation; direction: bigint; anchor: bigint; limit: bigint }

/** What a captured page request says: its command, the conversation body (cmd 301) and the headers the page sent along. */
export function parseRequest(captured: Uint8Array): { cmd: number; fields: Field[]; body: Field[]; headerKeys: string[] } {
  const fields = decode(captured)
  const cmd = Number(asInt(get(fields, 1)))
  const body = asMsg(get(asMsg(get(fields, 8)), cmd))
  const headerKeys = getAll(fields, 15).map((h) => asStr(get(asMsg(h), 1)))
  return { cmd, fields, body, headerKeys }
}

/** The conversation, direction, anchor and limit of a captured get_by_conversation request. */
export function historyOf(captured: Uint8Array): HistoryAsk | undefined {
  const r = parseRequest(captured)
  if (r.cmd !== 301) return
  const id = asStr(get(r.body, 1))
  if (!id) return
  return {
    conv: { id, type: asInt(get(r.body, 2)), shortId: asInt(get(r.body, 3)) },
    direction: asInt(get(r.body, 4)), anchor: asInt(get(r.body, 5)), limit: asInt(get(r.body, 6))
  }
}

/** Sets a field, keeping the order of the others (a new one goes in by number). */
const put = (fs: Field[], f: Field): Field[] => {
  if (fs.some((x) => x.no === f.no)) return fs.map((x) => (x.no === f.no ? f : x))
  const i = fs.findIndex((x) => x.no > f.no)
  return i < 0 ? [...fs, f] : [...fs.slice(0, i), f, ...fs.slice(i)]
}

/**
 * A get_by_conversation request on the envelope of a request the page made (the same conversation's history or any other
 * command, e.g. the conversation list): only the command, the sequence id and the conversation part change.
 */
export function historyRequest(captured: Uint8Array, ask: HistoryAsk, sequenceId: number): Uint8Array {
  const r = parseRequest(captured)
  if (!get(r.fields, 8)) throw new Error('captured request has no body')
  let body = r.cmd === 301 ? r.body : []
  for (const f of [text(1, ask.conv.id), vint(2, ask.conv.type), vint(3, ask.conv.shortId), vint(4, ask.direction), vint(5, ask.anchor), vint(6, ask.limit)]) body = put(body, f)
  return encode(r.fields.map((f) => (f.no === 1 ? vint(1, 301) : f.no === 2 ? vint(2, sequenceId) : f.no === 8 ? sub(8, [bytes(301, encode(body))]) : f)))
}

// ----- answers -----

export interface HistoryPage {
  status: number
  error: string
  /** each message as its own list of fields, newest or oldest first, as the server sent them */
  messages: Field[][]
  /** where the next page starts, as the server says it */
  next?: bigint
  hasMore: boolean
}

/** Response: status_code (3), error_desc (4), body (6) holding the command's answer: messages (1), next_cursor (2), has_more (3). */
export function parseHistory(resp: Uint8Array): HistoryPage {
  const top = decode(resp)
  const status = Number(asInt(get(top, 3)))
  const error = asStr(get(top, 4))
  const answer = asMsg(get(asMsg(get(top, 6)), 301))
  const next = get(answer, 2)
  return {
    status, error,
    messages: getAll(answer, 1).map(asMsg),
    next: typeof next === 'bigint' ? next : undefined,
    hasMore: asInt(get(answer, 3)) !== 0n
  }
}

export interface ImMessage {
  conversationId: string
  serverId: bigint
  /** position in the conversation: grows with every message, so pages can be asked for by position */
  index: bigint
  type: bigint
  sender: bigint
  /** the content as the server sent it: JSON text for the types we know about */
  content: string
  time: bigint
  ext: Record<string, string>
  /** every field the reader above does not name, kept so nothing is lost silently */
  other: Field[]
}

const NAMED = new Set([1, 3, 4, 6, 7, 8, 9, 10])

export function parseMessage(f: Field[]): ImMessage {
  const ext: Record<string, string> = {}
  for (const e of getAll(f, 9)) {
    const kv = asMsg(e)
    ext[asStr(get(kv, 1))] = asStr(get(kv, 2))
  }
  return {
    conversationId: asStr(get(f, 1)), serverId: asInt(get(f, 3)), index: asInt(get(f, 4)), type: asInt(get(f, 6)),
    sender: asInt(get(f, 7)), content: asStr(get(f, 8)), time: asInt(get(f, 10)), ext,
    other: f.filter((x) => !NAMED.has(x.no))
  }
}

// ----- what a message carries besides its JSON content -----
// Field numbers from im_proto in TikTok's own web bundle (the chunk with `e.MessageBody=function`), read 2026-11-06:
// 15 property_list (reactions), 18 reference_info (quotes), 20 content_pb (cards: stickers, photos, videos, voice), 24 media_info_list.

type Scalar = 's' | 'i'
type Spec = { [no: number]: [string, Scalar | Spec, ('list' | 'map')?] }
export type Json = Record<string, unknown>

const TEXT: Spec = { 1: ['text', 's'] }
const SIZE: Spec = { 1: ['width', 'i'], 2: ['height', 'i'] }
const LINK: Spec = { 1: ['url_list', 's', 'list'], 2: ['action_type', 'i'] }
const IMAGE: Spec = { 1: ['image_id', 's'], 2: ['url_list', 's', 'list'], 4: ['display_name', 's'], 5: ['resolution', SIZE], 6: ['decrypt_key', 's'], 7: ['fallback_icon_type', 'i'] }
const VIDEO: Spec = { 1: ['video_id', 's'], 2: ['video_type', 'i'], 3: ['cover', IMAGE], 4: ['video_model', 's'], 5: ['link_info', LINK], 6: ['resolution', SIZE] }
const USER: Spec = { 1: ['user_id', 'i'], 2: ['nickname', TEXT], 3: ['description', TEXT], 4: ['avatar', IMAGE], 5: ['link_info', LINK], 6: ['username', TEXT], 7: ['follower_count', 'i'], 8: ['is_verify', 'i'] }
const FALLBACK: Spec = { 1: ['image', IMAGE], 2: ['text', TEXT], 3: ['link_info', LINK], 4: ['status', 'i'] }
const HINT: Spec = { 1: ['sender_preview_text', TEXT], 2: ['receiver_preview_text', TEXT], 3: ['quote_preview_text', TEXT] }
const REQ: Spec = { 1: ['query_data', { 1: ['resource_id', 's'], 2: ['extra', 's', 'map'] }] }
const RESP: Spec = { 1: ['ttl', { 1: ['expired_at', 'i'] }], 2: ['context_menu', 's', 'list'], 3: ['min_version', 'i'], 4: ['extra', 's', 'map'] }
const BUTTON: Spec = { 1: ['text', TEXT], 4: ['link_info', LINK] }
const BASE: Spec = { 200: ['req_base', REQ], 201: ['resp_base', RESP] }
const BASE2: Spec = { 201: ['req_base', REQ], 202: ['resp_base', RESP] }

const CONTENT: Spec = {
  2: ['image_card', { 1: ['title', { 1: ['image', IMAGE], 2: ['title', TEXT], 3: ['subtitle', TEXT], 4: ['button', BUTTON] }], 2: ['videos', VIDEO, 'list'], 3: ['link_info', LINK], 4: ['preview_hint', HINT], ...BASE }],
  4: ['picture_card', { 1: ['image', IMAGE], 2: ['thumbnail', IMAGE], 3: ['preview_hint', HINT], 4: ['link_info', LINK], 5: ['fallback', FALLBACK], 6: ['image_mint', IMAGE], 7: ['thumbnail_mint', IMAGE], ...BASE }],
  5: ['video_card', { 1: ['video', VIDEO], 2: ['preview_hint', HINT], 3: ['link_info', LINK], 4: ['fallback', FALLBACK], 5: ['user_info', USER], 6: ['top_inline_text', TEXT], ...BASE }],
  6: ['info_card', { 1: ['title', { 1: ['title', TEXT], 2: ['image', IMAGE] }], 2: ['content', { 1: ['description', TEXT], 2: ['contents', TEXT, 'list'] }], 3: ['video', VIDEO], 4: ['buttons', { 1: ['text', TEXT], 2: ['hint', TEXT], 3: ['link', LINK], 4: ['type', 'i'] }, 'list'], 6: ['link_info', LINK], ...BASE }],
  7: ['sticker_card', {
    1: ['sticker', IMAGE], 2: ['preview_hint', HINT], 3: ['fallback', { 1: ['placeholder', IMAGE] }], 4: ['creator', { 1: ['user_id', 'i'], 2: ['nick_name', 's'], 3: ['avatar_thumb', IMAGE] }],
    10: ['attachment', { 1: ['type', 'i'], 2: ['id', 's'], 3: ['uid', 'i'], 4: ['cover', { 1: ['uri', 's'], 2: ['url_list', 's', 'list'] }], 20: ['aweme_type', 'i'], 21: ['is_story', 'i'] }],
    11: ['sticker_biz_type', 's'], ...BASE
  }],
  14: ['audio_card', { 101: ['fallback_info', FALLBACK], 102: ['preview_hint', HINT], ...BASE }],
  100: ['common_msg_card', {
    1: ['text_map', TEXT, 'map'], 2: ['image_map', IMAGE, 'map'], 3: ['link_map', LINK, 'map'], 4: ['button_map', BUTTON, 'map'], 5: ['video_map', VIDEO, 'map'], 6: ['user_map', USER, 'map'],
    7: ['fallback_info', FALLBACK], 8: ['preview_hint', HINT], 100: ['business_image_map', IMAGE, 'map'], 101: ['business_video_map', VIDEO, 'map'], 102: ['business_user_map', USER, 'map'], ...BASE2
  }],
  101: ['dynamic_card', { 1: ['dynamic_info', { 1: ['card_key', 's'], 2: ['schema', 's'], 3: ['card_template', 's'], 4: ['business_type', 's'], 5: ['business_id', 's'], 9: ['raw_data', 's'] }], 10: ['fallback_info', FALLBACK], 11: ['preview_hint', HINT], ...BASE2 }],
  200: ['streak_cmd', { 1: ['cmd_type', 'i'], 3: ['streak_action', 'i'] }]
}
const MEDIA: Spec = {
  1: ['id', 's'], 2: ['type', 'i'], 3: ['decrypt_key', 's'],
  20: ['url_info_list', { 1: ['display_type', 's'], 2: ['url_list', 's', 'list'], 3: ['video_model', 's'], 20: ['width', 'i'], 21: ['height', 'i'], 22: ['duration', 'i'], 23: ['size', 'i'], 24: ['name', 's'], 25: ['codec', 's'] }, 'list']
}

const intOf = (v: bigint): number | string => (v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : String(v))
const valueOf = (kind: Scalar | Spec, v: Raw): unknown => {
  if (kind === 's') return typeof v === 'bigint' ? String(v) : td.decode(v)
  if (kind === 'i') return typeof v === 'bigint' ? intOf(v) : `bytes(${v.length})`
  return v instanceof Uint8Array ? read(kind, v) : intOf(v)
}
/** One message level by its spec. A field the spec does not name stays as `f<number>`, so nothing goes missing without a trace. */
function read(spec: Spec, buf: Uint8Array): Json {
  const out: Json = {}
  for (const f of decode(buf)) {
    const s = spec[f.no]
    if (!s) { out['f' + f.no] = typeof f.v === 'bigint' ? intOf(f.v) : `bytes(${f.v.length})`; continue }
    const [name, kind, mode] = s
    if (mode === 'list') {
      const list = (out[name] ??= []) as unknown[]
      list.push(valueOf(kind, f.v))
    } else if (mode === 'map') {
      const kv = asMsg(f.v)
      const map = (out[name] ??= {}) as Json
      const val = get(kv, 2)
      if (val !== undefined) map[asStr(get(kv, 1))] = valueOf(kind, val)
    } else out[name] = valueOf(kind, f.v)
  }
  return out
}

export interface Card { kind: string; value: Json }
/** The card of a template message (sticker, photo, video, voice...), or nothing when there is none or it cannot be read. */
export function cardOf(m: ImMessage): Card | undefined {
  const raw = m.other.find((f) => f.no === 20)?.v
  if (!(raw instanceof Uint8Array) || !raw.length) return
  try {
    const all = read(CONTENT, raw)
    const kind = Object.keys(all).find((k) => k.endsWith('_card') || k === 'streak_cmd')
    return kind ? { kind, value: all[kind] as Json } : { kind: 'unknown', value: all }
  } catch { return undefined }
}

export interface MediaFile { type: number; key: string; urls: { urls: string[]; model: string; name: string }[] }
/** Files attached to a message (field 24): voice messages and other media live here. */
export function mediaInfoOf(m: ImMessage): MediaFile[] {
  const out: MediaFile[] = []
  for (const f of m.other) {
    if (f.no !== 24 || !(f.v instanceof Uint8Array)) continue
    try {
      const j = read(MEDIA, f.v)
      const list = (j.url_info_list ?? []) as Json[]
      out.push({
        type: Number(j.type ?? 0), key: String(j.decrypt_key ?? ''),
        urls: list.map((u) => ({ urls: (u.url_list ?? []) as string[], model: String(u.video_model ?? ''), name: String(u.name ?? '') }))
      })
    } catch { /* stays among the unknown fields */ }
  }
  return out
}

export interface Reference { id: string; hint: string; type: number; status: number; sender: string }
/** What a reply quotes (field 18). `status`: 0 available, 1 gone, 2 not visible, 3 recalled, 4 deleted. */
export function referenceOf(m: ImMessage): Reference | undefined {
  const raw = m.other.find((f) => f.no === 18)?.v
  if (!(raw instanceof Uint8Array)) return
  try {
    const r = decode(raw)
    const id = asInt(get(r, 1))
    if (!id) return
    return { id: String(id), hint: asStr(get(r, 2)), type: Number(asInt(get(r, 3))), status: Number(asInt(get(r, 4))), sender: String(asInt(get(r, 7))) }
  } catch { return undefined }
}

export interface Property { key: string; items: { uid: string; time: number }[] }
/** Reactions and other per-user marks (field 15): a map from a key like `e:💔` to who set it and when. Repeats of a key are merged. */
export function propertiesOf(m: ImMessage): Property[] {
  const byKey = new Map<string, Property>()
  for (const f of m.other) {
    if (f.no !== 15 || !(f.v instanceof Uint8Array)) continue
    try {
      const entry = decode(f.v)
      const key = asStr(get(entry, 1))
      if (!key) continue
      const p = byKey.get(key) ?? { key, items: [] }
      byKey.set(key, p)
      for (const item of getAll(asMsg(get(entry, 2)), 1)) {
        const x = asMsg(item)
        p.items.push({ uid: String(asInt(get(x, 1))), time: Number(asInt(get(x, 3))) })
      }
    } catch { /* stays among the unknown fields */ }
  }
  return [...byKey.values()]
}
