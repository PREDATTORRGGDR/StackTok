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
