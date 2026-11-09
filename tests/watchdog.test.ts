import { describe, it, expect } from 'vitest'
import {
  applyScan, scanList, scanHead, feedStats, newMemo, isActivity, PAGE, FLASH,
  feedPresence, newHyst, newCircuit, recordFailure, recordSuccess,
  jittered, REPOST_INTERVAL, JITTER,
  type RepostRecord, type Scan, type TargetMemo, type PageFn, type PresenceSession, type PresenceSample,
  serialise, deserialise, emptyState
} from '../src/main/watchdog'

const items = (ids: string[]) => ids.map((id) => ({ id, author: 'a_' + id }))
const head = (ids: string[]): Scan => ({ full: false, complete: false, items: items(ids) })
const full = (ids: string[], complete = true): Scan => ({ full: true, complete, items: items(ids) })
/** A target whose list was read once: a, b, c… from the top. */
function watched(ids: string[], complete = true) {
  const known = new Map<string, RepostRecord>(), memo = newMemo()
  applyScan('t', known, memo, full(ids, complete), 1000)
  return { known, memo, look: (scan: Scan, now: number) => applyScan('t', known, memo, scan, now) }
}
const kinds = (r: { events: { kind: string; videoId?: string }[] }) => r.events.map((e) => e.kind + ':' + e.videoId)

describe('applyScan', () => {
  it('the first look is a baseline: nothing is reported', () => {
    const known = new Map<string, RepostRecord>(), memo = newMemo()
    const r = applyScan('t', known, memo, full(['a', 'b', 'c']), 1000)
    expect(r.events).toEqual([])
    expect(known.size).toBe(3)
    expect(memo.baselined).toBe(true)
    expect(known.get('a')?.base).toBe(true)
  })

  it('a look at the top before the baseline does nothing and asks for the whole list', () => {
    const known = new Map<string, RepostRecord>(), memo = newMemo()
    const r = applyScan('t', known, memo, head(['a']), 1000)
    expect(r.events).toEqual([])
    expect(r.needFull).toBe(true)
    expect(known.size).toBe(0)
  })

  it('a new repost on top is reported once, with its data', () => {
    const w = watched(['a', 'b'])
    const r = w.look(head(['n', 'a', 'b']), 2000)
    expect(kinds(r)).toEqual(['repost_added:n'])
    expect(r.events[0].meta?.author).toBe('a_n')
    expect(w.look(head(['n', 'a', 'b']), 3000).events).toEqual([])
  })

  it('a removal needs two looks in a row', () => {
    const w = watched(['a', 'b', 'c'])
    const first = w.look(head(['a', 'c']), 2000)
    expect(first.events).toEqual([])
    expect(first.pending).toBe(1)
    expect(kinds(w.look(head(['a', 'c']), 3000))).toEqual(['repost_removed:b'])
    expect(w.known.has('b')).toBe(false)
  })

  it('a repost that is back on the next look was never removed', () => {
    const w = watched(['a', 'b', 'c'])
    w.look(head(['a', 'c']), 2000)
    const r = w.look(head(['a', 'b', 'c']), 3000)
    expect(r.events).toEqual([])
    expect(r.pending).toBe(0)
    expect(w.look(head(['a', 'c']), 4000).events).toEqual([]) // the count starts over
  })

  it('an empty answer never removes anything through the top', () => {
    const w = watched(['a', 'b', 'c'])
    for (let i = 0; i < 5; i++) expect(w.look(head([]), 2000 + i).events).toEqual([])
    expect(w.known.size).toBe(3)
  })

  it('an incomplete whole list never removes anything', () => {
    const ids = Array.from({ length: 100 }, (_, i) => 'v' + i)
    const w = watched(ids)
    for (let i = 0; i < 5; i++) expect(w.look(full(ids.slice(0, 70), false), 2000 + i).events).toEqual([])
    expect(w.known.size).toBe(100)
  })

  it('many vanishing at once (a cut list that looks complete) needs three looks', () => {
    const ids = Array.from({ length: 100 }, (_, i) => 'v' + i)
    const w = watched(ids)
    const cut = full(ids.slice(0, 40))
    expect(w.look(cut, 2000).events).toEqual([])
    expect(w.look(cut, 3000).events).toEqual([])
    expect(w.look(full(ids), 4000).events).toEqual([]) // the list is whole again: nothing happened
    expect(w.known.size).toBe(100)
  })

  it('a deep removal is found by the whole list after two looks', () => {
    const ids = Array.from({ length: 100 }, (_, i) => 'v' + i)
    const w = watched(ids)
    const without = full(ids.filter((x) => x !== 'v90'))
    expect(w.look(without, 2000).events).toEqual([])
    expect(kinds(w.look(without, 3000))).toEqual(['repost_removed:v90'])
  })

  it('a repost that was there from the start has no lifetime and is not "quick"', () => {
    const w = watched(['a', 'b'])
    w.look(head(['b']), 2000)
    const [e] = w.look(head(['b']), 3000).events
    expect(e.duration).toBeUndefined()
    expect(e.isFlash).toBeUndefined()
  })

  it('a repost that appeared and vanished within ten minutes is quick', () => {
    const w = watched(['a', 'b'])
    w.look(head(['n', 'a', 'b']), 10_000)
    w.look(head(['a', 'b']), 70_000)
    const [e] = w.look(head(['a', 'b']), 90_000).events
    expect(e.kind).toBe('repost_removed')
    expect(e.duration).toBe(80_000)
    expect(e.isFlash).toBe(true)
  })

  it('…and one that lived longer is not', () => {
    const w = watched(['a', 'b'])
    w.look(head(['n', 'a', 'b']), 10_000)
    w.look(head(['a', 'b']), 10_000 + FLASH)
    expect(w.look(head(['a', 'b']), 10_000 + FLASH + 20_000).events[0].isFlash).toBe(false)
  })

  it('a reported removal is taken back when the repost shows up again soon', () => {
    const w = watched(['a', 'b', 'c'])
    w.look(head(['a', 'c']), 2000)
    const [gone] = w.look(head(['a', 'c']), 3000).events
    const r = w.look(head(['a', 'b', 'c']), 60_000)
    expect(r.events).toEqual([])
    expect(r.retract).toEqual([gone.id])
    expect(w.known.get('b')?.base).toBe(true)
  })

  it('reordering and duplicates make no events', () => {
    const w = watched(['a', 'b', 'c'])
    expect(w.look(head(['c', 'a', 'b', 'a']), 2000).events).toEqual([])
    expect(w.look(head(['c', 'a', 'b']), 3000).events).toEqual([])
  })

  it('new reposts pushing an old one off the top page do not remove it', () => {
    const ids = Array.from({ length: 2 * PAGE }, (_, i) => 'v' + i)
    const w = watched([...ids, 'deep'])
    const r = w.look(head(['n', ...ids.slice(0, -1)]), 2000)
    expect(kinds(r)).toEqual(['repost_added:n'])
    expect(w.look(head(['n', ...ids.slice(0, -1)]), 3000).events).toEqual([])
    expect(w.known.has(ids[ids.length - 1])).toBe(true)
  })

  it('after a cut baseline, old reposts met later are learnt silently', () => {
    const w = watched(['a', 'b'], false)
    expect(w.look(full(['a', 'b', 'c', 'd']), 2000).events).toEqual([]) // at the bottom of the top: nothing known below
    expect(kinds(w.look(head(['n', 'a', 'b', 'c', 'd']), 3000))).toEqual(['repost_added:n'])
  })

  it('a repost that appears deep in a complete list is marked late', () => {
    const ids = Array.from({ length: 100 }, (_, i) => 'v' + i)
    const w = watched(ids)
    const r = w.look(full([...ids.slice(0, 80), 'back', ...ids.slice(80)]), 2000)
    expect(r.events).toHaveLength(1)
    expect(r.events[0].late).toBe(true)
    expect(isActivity(r.events[0])).toBe(false)
  })
})

describe('scanList', () => {
  const server = (ids: string[], opts: { lieAt?: number; failAt?: number } = {}): PageFn => {
    let lied = false
    return async (o) => {
      if (opts.failAt === o) return null
      if (opts.lieAt === o && !lied) { lied = true; return { more: false, items: items(ids.slice(o, o + PAGE)) } }
      return { more: o + PAGE < ids.length, items: items(ids.slice(o, o + PAGE)) }
    }
  }
  const ids = Array.from({ length: 200 }, (_, i) => 'v' + i)

  it('reads the whole list in order', async () => {
    const s = await scanList(server(ids))
    expect(s.complete).toBe(true)
    expect(s.items.map((x) => x.id)).toEqual(ids)
  })

  it('a false "no more" in the middle does not end the list', async () => {
    const s = await scanList(server(ids, { lieAt: 60 }))
    expect(s.complete).toBe(true)
    expect(s.items).toHaveLength(200)
  })

  it('a page without an answer makes the look incomplete', async () => {
    const s = await scanList(server(ids, { failAt: 90 }))
    expect(s.complete).toBe(false)
  })

  it('the top is two pages, or nothing when one of them is silent', async () => {
    expect((await scanHead(server(ids)))?.items).toHaveLength(2 * PAGE)
    expect(await scanHead(server(ids, { failAt: 30 }))).toBeNull()
  })
})

describe('feedStats', () => {
  const memo = (): TargetMemo => ({ ...newMemo(), stats: { following: 10, liked: 100, videos: 3, nickname: 'Bob', bio: 'hi' } })

  it('a change counts once the same number comes twice', () => {
    const m = memo()
    expect(feedStats('t', m, { following: 11, liked: 100, videos: 3 }, 1)).toEqual([])
    const [e] = feedStats('t', m, { following: 11, liked: 100, videos: 3 }, 2)
    expect(e).toMatchObject({ kind: 'activity', what: 'following', delta: 1 })
    expect(feedStats('t', m, { following: 11 }, 3)).toEqual([])
  })

  it('a number that flaps back is not a change', () => {
    const m = memo()
    feedStats('t', m, { liked: 105 }, 1)
    expect(feedStats('t', m, { liked: 100 }, 2)).toEqual([])
    expect(feedStats('t', m, { liked: 105 }, 3)).toEqual([])
    expect(feedStats('t', m, { liked: 105 }, 4)).toHaveLength(1)
  })

  it('the first reading and missing numbers are silent', () => {
    const m = newMemo()
    expect(feedStats('t', m, { following: 5 }, 1)).toEqual([])
    expect(feedStats('t', m, {}, 2)).toEqual([])
    expect(m.stats?.following).toBe(5)
  })

  it('name and description changes are events without the text', () => {
    const m = memo()
    feedStats('t', m, { nickname: 'Bobby' }, 1)
    const [e] = feedStats('t', m, { nickname: 'Bobby' }, 2)
    expect(e).toMatchObject({ kind: 'activity', what: 'nickname' })
    expect(JSON.stringify(e)).not.toContain('Bobby')
  })
})

describe('presence hysteresis', () => {
  const sample = (state: 'online' | 'offline' | 'unknown', at: number): PresenceSample => ({ at, state })

  it('2 positives → online', () => {
    const h = newHyst()
    const ss: PresenceSession[] = []
    expect(feedPresence('t1', sample('online', 100), h, ss)).toBeNull()
    const evt = feedPresence('t1', sample('online', 200), h, ss)
    expect(evt).not.toBeNull()
    expect(evt!.kind).toBe('online')
    expect(ss).toHaveLength(1)
    expect(ss[0].start).toBe(200)
  })

  it('4 negatives → offline', () => {
    const h = newHyst()
    const ss: PresenceSession[] = []
    feedPresence('t1', sample('online', 100), h, ss)
    feedPresence('t1', sample('online', 200), h, ss)
    // now online
    expect(feedPresence('t1', sample('offline', 300), h, ss)).toBeNull()
    expect(feedPresence('t1', sample('offline', 400), h, ss)).toBeNull()
    expect(feedPresence('t1', sample('offline', 500), h, ss)).toBeNull()
    const evt = feedPresence('t1', sample('offline', 600), h, ss)
    expect(evt).not.toBeNull()
    expect(evt!.kind).toBe('offline')
    expect(evt!.duration).toBe(400) // 600 - 200
    expect(ss[0].end).toBe(600)
  })

  it('session merge: multiple on/off cycles', () => {
    const h = newHyst()
    const ss: PresenceSession[] = []
    // go online
    feedPresence('t1', sample('online', 100), h, ss)
    feedPresence('t1', sample('online', 200), h, ss)
    // go offline
    for (let i = 0; i < 4; i++) feedPresence('t1', sample('offline', 300 + i * 100), h, ss)
    // go online again
    feedPresence('t1', sample('online', 1000), h, ss)
    feedPresence('t1', sample('online', 1100), h, ss)
    expect(ss).toHaveLength(2)
  })

  it('unknown samples do not affect counters', () => {
    const h = newHyst()
    const ss: PresenceSession[] = []
    feedPresence('t1', sample('online', 100), h, ss)
    feedPresence('t1', sample('unknown', 150), h, ss) // should not reset pos
    const evt = feedPresence('t1', sample('online', 200), h, ss)
    expect(evt).not.toBeNull()
    expect(evt!.kind).toBe('online')
  })
})

describe('circuit breaker', () => {
  it('backoff: 2m → 5m → 15m', () => {
    const c = newCircuit()
    expect(recordFailure(c, 0)).toBe(2 * 60_000)
    expect(c.failures).toBe(1)
    expect(recordFailure(c, 0)).toBe(5 * 60_000)
    expect(recordFailure(c, 0)).toBe(15 * 60_000)
    expect(recordFailure(c, 0)).toBe(-1) // exhausted
  })

  it('success resets failures', () => {
    const c = newCircuit()
    recordFailure(c, 0)
    recordFailure(c, 0)
    recordSuccess(c)
    expect(c.failures).toBe(0)
    expect(recordFailure(c, 0)).toBe(2 * 60_000) // starts over
  })
})

describe('jitter', () => {
  it('stays within ±20%', () => {
    for (let i = 0; i < 100; i++) {
      const v = jittered(REPOST_INTERVAL)
      expect(v).toBeGreaterThanOrEqual(REPOST_INTERVAL * (1 - JITTER))
      expect(v).toBeLessThanOrEqual(REPOST_INTERVAL * (1 + JITTER))
    }
  })
})

describe('serialise / deserialise', () => {
  it('round-trips targets and events', () => {
    const s = emptyState()
    s.targets.push({ id: 't1', handle: 'bob', secUid: 'su1', accountId: 'a1', active: true, createdAt: 1000 })
    s.events.push({ id: 'e1', targetId: 't1', kind: 'repost_added', videoId: 'v1', at: 2000 })
    s.events.push({ id: 'e2', targetId: 't1', kind: 'repost_removed', videoId: 'v1', at: 3000, duration: 1000, isFlash: true })
    const d = serialise(s)
    const s2 = deserialise(d)
    expect(s2.targets).toEqual(s.targets)
    expect(s2.events).toEqual(s.events)
    // removed repost should not be in the rebuilt map
    expect(s2.reposts.get('t1')?.has('v1')).toBeFalsy()
  })

  it('keeps what the engine remembers, the read mark and the notification switch', () => {
    const s = emptyState()
    s.memos.set('t1', { ...newMemo(), baselined: true, baseComplete: true, head: ['v1'], stats: { following: 3 } })
    s.seenAt = 77
    s.notify = false
    const s2 = deserialise(JSON.parse(JSON.stringify(serialise(s))))
    expect(s2.memos.get('t1')).toMatchObject({ baselined: true, baseComplete: true, head: ['v1'], stats: { following: 3 } })
    expect(s2.seenAt).toBe(77)
    expect(s2.notify).toBe(false)
  })

  it('data saved by the older version: known reposts become the baseline', () => {
    const s = deserialise({ targets: [], events: [], reposts: [['t1', [{ id: 'v1', firstSeen: 5 }]]] })
    expect(s.memos.get('t1')?.baselined).toBe(true)
    expect(s.reposts.get('t1')?.get('v1')?.base).toBe(true)
    expect(applyScan('t1', s.reposts.get('t1')!, s.memos.get('t1')!, { full: true, complete: true, items: [{ id: 'v1' }, { id: 'v0' }] }, 9).events).toEqual([])
  })

  it('persists known reposts so trimmed events do not cause duplicates', () => {
    const s = emptyState()
    s.targets.push({ id: 't1', handle: 'bob', secUid: 'su1', accountId: 'a1', active: true, createdAt: 1000 })
    // repost is known
    const m = new Map<string, { id: string; firstSeen: number }>()
    m.set('v1', { id: 'v1', firstSeen: 2000 })
    m.set('v2', { id: 'v2', firstSeen: 3000 })
    s.reposts.set('t1', m)
    // events trimmed: no repost_added for v1/v2
    s.events = []
    const d = serialise(s)
    expect(d.reposts?.length).toBe(1)
    const s2 = deserialise(d)
    expect(s2.reposts.get('t1')?.size).toBe(2)
    expect(s2.reposts.get('t1')?.has('v1')).toBe(true)
    // now diffReposts should NOT emit repost_added for v1/v2
    const r = applyScan('t1', s2.reposts.get('t1')!, s2.memos.get('t1')!, { full: true, complete: true, items: [{ id: 'v1' }, { id: 'v2' }] }, 5000)
    expect(r.events).toEqual([])
  })

  it('falls back to event replay for old format without reposts field', () => {
    const d = { targets: [], events: [{ id: 'e1', targetId: 't1', kind: 'repost_added' as const, videoId: 'v1', at: 1000 }] }
    const s = deserialise(d)
    expect(s.reposts.get('t1')?.has('v1')).toBe(true)
  })
})
