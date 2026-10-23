import { describe, expect, it } from 'vitest'
import { applyTags, canRetry, canTransition, epochToLocalInput, localInputToEpoch, parseTags } from '../src/shared/logic'
import { Queue } from '../src/main/queue'
import { sanitize } from '../src/main/store'
import type { Data } from '../src/shared/types'

const fakeStore = (d: Data = sanitize({})) => ({ data: d, save() {}, flush() {} }) as any
const item = (accountId: string) => ({ accountId, videoPath: 'C:\\v.mp4', caption: 'hi' })
const tick = () => new Promise((r) => setTimeout(r, 20))

describe('hashtags', () => {
  it('normalises and de-duplicates', () => {
    expect(parseTags('fyp #FYP, ##Viral! #a-b')).toEqual(['#fyp', '#Viral', '#ab'])
  })
  it('appends only missing tags and keeps the caption intact', () => {
    expect(applyTags('Hello #fyp', ['#fyp', '#new'])).toBe('Hello #fyp #new')
    expect(applyTags('Hello', [])).toBe('Hello')
  })
})

describe('time', () => {
  it('round-trips local datetime input', () => {
    const ms = localInputToEpoch('2030-05-06T14:30')!
    expect(new Date(ms).getHours()).toBe(14) // interpreted in the local zone
    expect(epochToLocalInput(ms)).toBe('2030-05-06T14:30')
  })
})

describe('state machine', () => {
  it('blocks impossible transitions', () => {
    expect(canTransition('published', 'ready')).toBe(false)
    expect(canTransition('needs_verification', 'ready')).toBe(false)
    expect(canTransition('ready', 'uploading')).toBe(true)
  })
  it('never retries once submitted', () => {
    const t = { status: 'failed', submitted: true } as any
    expect(canRetry(t)).toBe(false)
    expect(canRetry({ ...t, submitted: false })).toBe(true)
  })
})

describe('queue', () => {
  it('creates one task per account and isolates failures', async () => {
    const q = new Queue(fakeStore(), async (t) => (t.accountId === 'a' ? { kind: 'failed', error: 'boom' } : { kind: 'published', confirmation: 'ok' }), () => {})
    const [a, b] = q.create([item('a'), item('b')], 'now')
    await tick(); await tick()
    expect(q.get(a.id)!.status).toBe('failed')
    expect(q.get(b.id)!.status).toBe('published')
  })

  it('failure after Post click becomes needs_verification and cannot be retried', async () => {
    const q = new Queue(fakeStore(), async (_t, h) => { h.markSubmitting(); return { kind: 'failed', error: 'network' } }, () => {})
    const [t] = q.create([item('a')], 'now')
    await tick()
    expect(t.status).toBe('needs_verification')
    q.retry(t.id)
    expect(t.status).toBe('needs_verification')
  })

  it('never runs two uploads in the same account at once', async () => {
    let active = 0, max = 0
    const store = fakeStore(); store.data.settings.concurrency = 3
    const q = new Queue(store, async () => { active++; max = Math.max(max, active); await tick(); active--; return { kind: 'published', confirmation: 'ok' } }, () => {})
    q.create([item('a'), item('a'), item('b')], 'now')
    await new Promise((r) => setTimeout(r, 120))
    expect(max).toBe(2) // a and b in parallel, second a waits
  })

  it('recovers interrupted uploads safely after restart', () => {
    const store = fakeStore()
    const mk = (id: string, submitted: boolean) => ({ id, accountId: 'a', batchId: 'b', videoPath: 'x', caption: '', status: 'uploading', attempts: 1, submitted, createdAt: 1, updatedAt: 1 })
    store.data.tasks.push(mk('1', true), mk('2', false))
    new Queue(store, async () => ({ kind: 'published', confirmation: '' }), () => {})
    expect(store.data.tasks[0].status).toBe('needs_verification')
    expect(store.data.tasks[1].status).toBe('failed')
  })

  it('does not auto-run tasks that were overdue at launch', () => {
    const store = fakeStore()
    store.data.tasks.push({ id: '1', accountId: 'a', batchId: 'b', videoPath: 'x', caption: '', status: 'scheduled', scheduledAt: 1000, attempts: 0, submitted: false, createdAt: 1, updatedAt: 1 })
    const q = new Queue(store, async () => ({ kind: 'published', confirmation: 'ok' }), () => {}, () => 5000)
    expect(q.overdueIds()).toEqual(['1'])
    q.tick()
    expect(store.data.tasks[0].status).toBe('scheduled')
  })

  it('rejects scheduling in the past', () => {
    const q = new Queue(fakeStore(), async () => ({ kind: 'failed', error: '' }), () => {}, () => 5000)
    expect(() => q.create([item('a')], 'schedule', 4000)).toThrow()
  })
})

describe('store validation', () => {
  it('drops corrupt records and keeps valid ones', () => {
    const d = sanitize({ accounts: [{ id: 'x', label: 'L' }, { label: 'no id' }, 5], tasks: [{ id: 't', accountId: 'x', videoPath: 'p', status: 'bogus' }], settings: { concurrency: 99 } })
    expect(d.accounts).toHaveLength(1)
    expect(d.tasks).toHaveLength(0)
    expect(d.settings.concurrency).toBe(3)
  })
})
