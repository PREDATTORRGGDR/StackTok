// Watchdog engine: watches a public TikTok profile for reposts (added / removed) and for signs of activity in its public counters.
// Pure logic, no Electron — covered by unit tests.
//
// What makes an event trustworthy (each rule exists because TikTok's list lies):
// - the first look only remembers what is there (a baseline), it never reports it as new;
// - a removal counts only after the repost is missing from two looks in a row that really covered its place in the list,
//   three when many vanish at once (a quiet refusal looks exactly like an emptied list);
// - an incomplete list never removes anything;
// - a counter change counts only once the same new number is seen twice (TikTok's caches flap between old and new).

export interface WatchdogTarget {
  id: string
  handle: string
  secUid: string
  nickname?: string
  avatar?: string
  accountId: string // through which account we monitor
  active: boolean
  createdAt: number
}

export type ActivityWhat = 'following' | 'liked' | 'videos' | 'nickname' | 'bio'

export interface WatchdogEvent {
  id: string
  targetId: string
  kind: 'repost_added' | 'repost_removed' | 'activity' | 'online' | 'offline'
  videoId?: string
  meta?: { author?: string; desc?: string; cover?: string; createTime?: number }
  at: number
  duration?: number // ms the repost lived; only when we saw it appear
  isFlash?: boolean // appeared and vanished within FLASH
  late?: boolean // appeared below the top of the list: most likely a video that became available again
  why?: 'unavailable' // the video itself is gone (deleted or hidden by its author), the person did not remove the repost
  what?: ActivityWhat
  delta?: number
}

export interface RepostItem { id: string; author?: string; desc?: string; cover?: string; createTime?: number }
/** `base`: it was already in the list when we started watching, so its age is unknown. */
export interface RepostRecord { id: string; firstSeen: number; meta?: WatchdogEvent['meta']; base?: boolean }

export interface ProfileStats { following?: number; liked?: number; videos?: number; nickname?: string; bio?: string }

/** What the engine remembers about one target between looks. */
export interface TargetMemo {
  baselined: boolean // the list was read at least once
  baseComplete: boolean // …and to its confirmed end
  head: string[] // ids of the last look at the top, in order
  /** Reposts missing from a look: how many looks in a row, and the ids that stood below it (while one of them is on the page, the page covers its place). */
  missing: Record<string, { n: number; below: string[] }>
  /** Removals reported a short while ago: if the repost shows up again, the report was TikTok's glitch and is taken back. */
  removed?: Record<string, { at: number; event: string; rec: RepostRecord }>
  stats?: ProfileStats
  statsPending?: Partial<Record<ActivityWhat, { value: number | string; n: number }>>
}

export function newMemo(): TargetMemo {
  return { baselined: false, baseComplete: false, head: [], missing: {} }
}

export interface WatchdogState {
  targets: WatchdogTarget[]
  /** Known reposts per target: videoId → record. */
  reposts: Map<string, Map<string, RepostRecord>>
  memos: Map<string, TargetMemo>
  events: WatchdogEvent[]
  seenAt: number // events up to this moment were shown to the user
  notify: boolean
}

export function emptyState(): WatchdogState {
  return { targets: [], reposts: new Map(), memos: new Map(), events: [], seenAt: 0, notify: true }
}

// ── reading the list ──

export const PAGE = 30
export const HEAD_PAGES = 2
const MAX_OFFSET = 90_000

/** One page of the repost list by offset: `more` = TikTok says entries follow; null = no usable answer. May throw to stop the look. */
export type PageFn = (offset: number) => Promise<{ more: boolean; items: RepostItem[] } | null>

/** One look at the list, top to bottom. `complete`: read to an end that TikTok confirmed. */
export interface Scan { full: boolean; complete: boolean; items: RepostItem[] }

/** The top of the list: new reposts land here. Null when a page gave no answer. */
export async function scanHead(page: PageFn): Promise<Scan | null> {
  const pages = await Promise.all(Array.from({ length: HEAD_PAGES }, (_, i) => page(i * PAGE)))
  if (pages.some((p) => !p)) return null
  return { full: false, complete: false, items: pages.flatMap((p) => p!.items) }
}

/**
 * The whole list. The cursor is a plain offset, so pages are read side by side. Under load TikTok says `more: false` far before
 * the end, so an end only counts once the same page and the next one confirm it; a page without an answer is asked once more,
 * then the look is marked incomplete (and nothing will be removed by it).
 */
export async function scanList(page: PageFn, threads = 4, stopped: () => boolean = () => false): Promise<Scan> {
  const got = new Map<number, RepostItem[]>()
  let next = 0, end = Infinity, broken = false
  const ask = async (o: number) => {
    const r = (await page(o)) ?? (await page(o))
    if (!r) broken = true
    else if (r.items.length || !got.has(o)) got.set(o, r.items)
    return r
  }
  const worker = async () => {
    while (!broken && !stopped() && next < end && next < MAX_OFFSET) {
      const o = next
      next += PAGE
      const r = await ask(o)
      if (!r || r.more || o >= end) continue
      const again = await ask(o)
      const after = again && !again.more ? await ask(o + PAGE) : null
      if (after && !after.more && !after.items.length) end = Math.min(end, o)
    }
  }
  await Promise.all(Array.from({ length: threads }, worker))
  const items = [...got.keys()].sort((a, b) => a - b).flatMap((o) => got.get(o)!)
  return { full: true, complete: Number.isFinite(end) && !broken && !stopped(), items }
}

// ── repost diff ──

export const FLASH = 10 * 60_000
const CONFIRM = 2 // looks in a row without the repost before it counts as removed
const CONFIRM_MASS = 3 // …when many vanish at once
const MASS_MIN = 5
const MASS_SHARE = 0.3
const RETRACT = 15 * 60_000 // a "removed" repost that is back within this time was never removed

let eventSeq = 0
const eid = () => `we-${Date.now()}-${++eventSeq}`

export interface ScanResult {
  events: WatchdogEvent[]
  retract: string[] // ids of earlier events that turned out false
  changed: boolean // something to save
  pending: number // removals waiting for a second look
  needFull: boolean // …that only a look at the whole list can confirm
}

/** Folds one look into what is known about the target; returns the events it proves. */
export function applyScan(targetId: string, known: Map<string, RepostRecord>, memo: TargetMemo, scan: Scan, now: number): ScanResult {
  const events: WatchdogEvent[] = []
  const ids: string[] = []
  const meta = new Map<string, WatchdogEvent['meta']>()
  for (const it of scan.items) {
    if (!it.id || meta.has(it.id)) continue
    ids.push(it.id)
    meta.set(it.id, { author: it.author, desc: it.desc, cover: it.cover, createTime: it.createTime })
  }
  const here = new Set(ids)
  const headSize = HEAD_PAGES * PAGE
  let changed = false

  // the first look is a baseline: everything there is old news
  if (!memo.baselined) {
    if (!scan.full) return { events, retract: [], changed: false, pending: 0, needFull: true }
    for (const id of ids) if (!known.has(id)) known.set(id, { id, firstSeen: now, meta: meta.get(id), base: true })
    memo.baselined = true
    memo.baseComplete = scan.complete
    memo.head = ids.slice(0, headSize)
    return { events, retract: [], changed: true, pending: 0, needFull: false }
  }

  const retract: string[] = []
  const removed = memo.removed ?? (memo.removed = {})
  for (const id of Object.keys(removed)) if (now - removed[id].at > RETRACT) delete removed[id]

  // new reposts
  ids.forEach((id, i) => {
    if (known.has(id)) return
    if (removed[id]) { // it never left: TikTok hid it for a moment
      known.set(id, removed[id].rec)
      retract.push(removed[id].event)
      delete removed[id]
      changed = true
      return
    }
    const top = i < headSize
    // Without a complete baseline an unknown id is new only when it stands above something we know.
    const fresh = top && (memo.baseComplete || ids.slice(i + 1).some((x) => known.has(x)))
    const late = !top && memo.baseComplete && scan.complete
    known.set(id, { id, firstSeen: now, meta: meta.get(id), base: !fresh })
    changed = true
    if (fresh || late) events.push({ id: eid(), targetId, kind: 'repost_added', videoId: id, meta: meta.get(id), at: now, ...(late ? { late: true } : {}) })
  })

  // removals
  const whole = scan.full && scan.complete
  const prev = memo.head
  const gone: string[] = []
  for (const id of known.keys()) {
    if (here.has(id)) {
      if (memo.missing[id]) { delete memo.missing[id]; changed = true }
      continue
    }
    const miss = memo.missing[id]
    const at = prev.indexOf(id)
    const below = miss?.below.length ? miss.below : at >= 0 ? prev.slice(at + 1) : []
    // A look covers the repost's place when it is the whole list, or when something that stood below it is still on the page.
    if (whole || below.some((x) => here.has(x))) gone.push(id)
    if (!miss && (whole || at >= 0)) memo.missing[id] = { n: 0, below }
  }
  const mass = gone.length > Math.max(MASS_MIN, known.size * MASS_SHARE)
  const need = mass ? CONFIRM_MASS : CONFIRM
  for (const id of gone) {
    const miss = memo.missing[id] ?? (memo.missing[id] = { n: 0, below: [] })
    miss.n++
    changed = true
    if (miss.n < need) continue
    const rec = known.get(id)!
    const lived = rec.base ? undefined : now - rec.firstSeen
    const ev: WatchdogEvent = { id: eid(), targetId, kind: 'repost_removed', videoId: id, meta: rec.meta, at: now, ...(lived !== undefined ? { duration: lived, isFlash: lived < FLASH } : {}) }
    events.push(ev)
    removed[id] = { at: now, event: ev.id, rec }
    known.delete(id)
    delete memo.missing[id]
  }
  for (const id of Object.keys(memo.missing)) if (!known.has(id) || memo.missing[id].n === 0 && !gone.includes(id) && !whole && !prev.includes(id)) delete memo.missing[id]

  if (whole) memo.baseComplete = true
  memo.head = ids.slice(0, headSize)
  const waiting = Object.values(memo.missing)
  return { events, retract, changed, pending: waiting.filter((m) => m.n > 0).length, needFull: waiting.some((m) => !m.below.length) }
}

// ── activity: public counters of the profile ──

const COUNTERS = ['following', 'liked', 'videos'] as const
const TEXTS = ['nickname', 'bio'] as const

/** One reading of the profile's public counters. A change counts once the same new value comes twice in a row. */
export function feedStats(targetId: string, memo: TargetMemo, sample: ProfileStats, now: number): WatchdogEvent[] {
  const events: WatchdogEvent[] = []
  const stats = memo.stats ?? (memo.stats = {})
  const pend = memo.statsPending ?? (memo.statsPending = {})
  const settle = (key: ActivityWhat, value: number | string | undefined, old: number | string | undefined): boolean => {
    if (value === undefined) return false
    if (old === undefined) { (stats as Record<string, number | string>)[key] = value; return false } // first reading
    if (value === old) { delete pend[key]; return false }
    const p = pend[key]
    if (!p || p.value !== value) { pend[key] = { value, n: 1 }; return false }
    delete pend[key]
    ;(stats as Record<string, number | string>)[key] = value
    return true
  }
  for (const key of COUNTERS) {
    const old = stats[key]
    if (settle(key, sample[key], old)) events.push({ id: eid(), targetId, kind: 'activity', what: key, delta: sample[key]! - old!, at: now })
  }
  for (const key of TEXTS) if (settle(key, sample[key], stats[key])) events.push({ id: eid(), targetId, kind: 'activity', what: key, at: now })
  return events
}

/** Did this event need the person to do something? (A video deleted by its author did not.) */
export const isActivity = (e: WatchdogEvent) => e.kind === 'activity' || e.kind === 'repost_added' && !e.late || e.kind === 'repost_removed' && e.why !== 'unavailable'

// ── presence hysteresis (kept for a source of online/offline samples; the TikTok website has none, see AGENTS.md) ──

export interface PresenceSample { at: number; state: 'online' | 'offline' | 'unknown' }
export interface PresenceSession { start: number; end?: number }

const ONLINE_THRESHOLD = 2  // consecutive positives to open a session
const OFFLINE_THRESHOLD = 4 // consecutive negatives to close it

export interface PresenceHyst { pos: number; neg: number; state: 'online' | 'offline' | 'unknown' }

export function newHyst(): PresenceHyst { return { pos: 0, neg: 0, state: 'unknown' } }

/** Feed one sample into the hysteresis; returns event if state changed. */
export function feedPresence(targetId: string, sample: PresenceSample, h: PresenceHyst, sessions: PresenceSession[]): WatchdogEvent | null {
  const now = sample.at

  if (sample.state === 'online') {
    h.pos++
    h.neg = 0
  } else if (sample.state === 'offline') {
    h.neg++
    h.pos = 0
  } else {
    // unknown: don't change counters
    return null
  }

  const prev = h.state

  if (prev !== 'online' && h.pos >= ONLINE_THRESHOLD) {
    h.state = 'online'
    sessions.push({ start: now })
    return { id: eid(), targetId, kind: 'online', at: now }
  }

  if (prev === 'online' && h.neg >= OFFLINE_THRESHOLD) {
    h.state = 'offline'
    const last = sessions[sessions.length - 1]
    const dur = last ? now - last.start : undefined
    if (last) last.end = now
    return { id: eid(), targetId, kind: 'offline', at: now, duration: dur }
  }

  return null
}

// ── scheduler ──

export const REPOST_INTERVAL = 20_000     // the top of the list
export const FULL_INTERVAL = 5 * 60_000   // the whole list: removals deep in it
export const STATS_INTERVAL = 60_000      // public counters of the profile
export const JITTER = 0.2                 // ±20%

export function jittered(base: number): number {
  const spread = base * JITTER
  return base - spread + Math.random() * spread * 2
}

// ── circuit breaker / backoff ──

export const BACKOFF_STEPS = [2 * 60_000, 5 * 60_000, 15 * 60_000]

export interface CircuitState { failures: number; nextAt: number }

export function newCircuit(): CircuitState { return { failures: 0, nextAt: 0 } }

/** Record a failure; returns the delay before next attempt (ms). If all retries exhausted, returns -1. */
export function recordFailure(c: CircuitState, now: number): number {
  if (c.failures >= BACKOFF_STEPS.length) return -1
  const delay = BACKOFF_STEPS[c.failures]
  c.failures++
  c.nextAt = now + delay
  return delay
}

export function recordSuccess(c: CircuitState) {
  c.failures = 0
  c.nextAt = 0
}

// ── persistence shape ──

export interface WatchdogStore {
  targets: WatchdogTarget[]
  events: WatchdogEvent[]
  /** Known reposts per target, persisted so trimmed events don't cause false re-detections. */
  reposts?: [string, RepostRecord[]][]
  memos?: [string, TargetMemo][]
  seenAt?: number
  notify?: boolean
}

export function serialise(s: WatchdogState): WatchdogStore {
  const reposts: [string, RepostRecord[]][] = []
  for (const [tid, m] of s.reposts) reposts.push([tid, [...m.values()]])
  return { targets: s.targets, events: s.events, reposts, memos: [...s.memos], seenAt: s.seenAt, notify: s.notify }
}

export function deserialise(d: WatchdogStore): WatchdogState {
  const s = emptyState()
  s.targets = d.targets ?? []
  s.events = d.events ?? []
  s.seenAt = typeof d.seenAt === 'number' ? d.seenAt : 0
  s.notify = d.notify !== false
  for (const [tid, memo] of d.memos ?? []) s.memos.set(tid, { ...newMemo(), ...memo, missing: memo.missing ?? {}, head: memo.head ?? [] })
  // restore known reposts from the persisted map (preferred) or replay events (old format)
  if (d.reposts?.length) {
    for (const [tid, recs] of d.reposts) {
      const m = new Map<string, RepostRecord>()
      for (const r of recs) m.set(r.id, r)
      s.reposts.set(tid, m)
    }
  } else {
    for (const e of s.events) {
      if (e.kind === 'repost_added' && e.videoId) {
        let m = s.reposts.get(e.targetId)
        if (!m) { m = new Map(); s.reposts.set(e.targetId, m) }
        m.set(e.videoId, { id: e.videoId, firstSeen: e.at, meta: e.meta })
      }
      if (e.kind === 'repost_removed' && e.videoId) {
        s.reposts.get(e.targetId)?.delete(e.videoId)
      }
    }
  }
  // Data saved before the memo existed: its list may be cut short and "first seen" is when watching began, not when the repost appeared.
  for (const [tid, m] of s.reposts) {
    if (s.memos.has(tid)) continue
    for (const r of m.values()) r.base = true
    s.memos.set(tid, { ...newMemo(), baselined: m.size > 0 })
  }
  return s
}
