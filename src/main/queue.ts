import { randomUUID } from 'node:crypto'
import { canRetry, canTransition, isDue } from '../shared/logic'
import { Status, Task } from '../shared/types'
import type { Outcome } from './uploader'
import type { Store } from './store'

export type Runner = (task: Task, hooks: { log: (m: string) => void; markSubmitting: () => void }) => Promise<Outcome>

export interface NewTask {
  accountId: string
  videoPath: string
  caption: string
}

export class Queue {
  private running = new Set<string>() // task ids
  private busyAccounts = new Set<string>() // never two uploads in one session
  private overdue = new Set<string>() // were due while the app was closed: need an explicit go-ahead
  private timer?: NodeJS.Timeout
  logs: { t: number; msg: string }[] = []

  constructor(
    private store: Store,
    private run: Runner,
    private changed: () => void,
    private now: () => number = Date.now
  ) {
    this.recover()
  }

  private get tasks() { return this.store.data.tasks }
  get(id: string) { return this.tasks.find((t) => t.id === id) }
  overdueIds() { return [...this.overdue] }

  /** After a restart nothing is "uploading": decide safely what each interrupted task is. */
  private recover() {
    for (const t of this.tasks) {
      if (t.status === 'uploading') {
        // If the Post click may have happened, a retry could double-post, so a human must check.
        this.move(t, t.submitted ? 'needs_verification' : 'failed', {
          error: t.submitted ? 'Прервано после отправки; проверьте аккаунт.' : 'Прервано до отправки.'
        })
      }
      if (isDue(t, this.now())) this.overdue.add(t.id)
    }
  }

  private move(t: Task, to: Status, patch: Partial<Task> = {}) {
    if (!canTransition(t.status, to)) throw new Error(`Invalid transition ${t.status} -> ${to}`)
    Object.assign(t, patch, { status: to, updatedAt: this.now() })
    this.store.save()
    this.changed()
  }

  /** One task per account. Failure of one never affects the others. */
  create(items: NewTask[], mode: 'now' | 'schedule' | 'draft', scheduledAt?: number): Task[] {
    if (mode === 'schedule' && (scheduledAt === undefined || scheduledAt <= this.now())) throw new Error('Укажите время в будущем.')
    const batchId = randomUUID()
    const made = items.map((i): Task => {
      const t: Task = {
        id: randomUUID(), batchId, ...i, scheduledAt: mode === 'schedule' ? scheduledAt : undefined,
        status: 'draft', attempts: 0, submitted: false, createdAt: this.now(), updatedAt: this.now()
      }
      return t
    })
    this.tasks.push(...made)
    for (const t of made) if (mode !== 'draft') this.move(t, mode === 'now' ? 'ready' : 'scheduled')
    this.store.save()
    this.changed()
    this.kick()
    return made
  }

  start(id: string) { // draft -> ready
    const t = this.get(id)
    if (t?.status === 'draft') { this.move(t, 'ready'); this.kick() }
  }

  runNow(id: string) { // overdue / scheduled -> ready
    const t = this.get(id)
    if (t?.status === 'scheduled') { this.overdue.delete(id); this.move(t, 'ready'); this.kick() }
  }

  cancel(id: string) {
    const t = this.get(id)
    if (t && canTransition(t.status, 'cancelled')) { this.move(t, 'cancelled'); this.overdue.delete(id) }
  }

  retry(id: string) {
    const t = this.get(id)
    if (t && canRetry(t)) { this.move(t, 'ready', { error: undefined }); this.kick() }
  }

  /** User checked the account and confirms the video is live. */
  markPublished(id: string) {
    const t = this.get(id)
    if (t?.status === 'needs_verification') this.move(t, 'published', { confirmation: 'Подтверждено пользователем вручную' })
  }

  clearFinished() {
    const done: Status[] = ['published', 'cancelled']
    this.store.data.tasks = this.tasks.filter((t) => !done.includes(t.status))
    this.store.save()
    this.changed()
  }

  /** Marks account tasks as cancelled when the account is removed. */
  dropAccount(accountId: string) {
    for (const t of this.tasks) if (t.accountId === accountId) this.cancel(t.id)
  }

  startScheduler(intervalMs = 15_000) {
    this.timer = setInterval(() => this.tick(), intervalMs)
    this.tick()
  }
  stopScheduler() { clearInterval(this.timer) }

  tick() {
    if (!this.store.data.settings.autoRun) return
    for (const t of this.tasks) if (isDue(t, this.now()) && !this.overdue.has(t.id)) this.move(t, 'ready')
    this.kick()
  }

  private kick() {
    const limit = this.store.data.settings.concurrency
    for (const t of this.tasks) {
      if (this.running.size >= limit) return
      if (t.status !== 'ready' || this.busyAccounts.has(t.accountId)) continue
      this.running.add(t.id)
      this.busyAccounts.add(t.accountId)
      void this.execute(t)
    }
  }

  private async execute(t: Task) {
    this.move(t, 'uploading', { attempts: t.attempts + 1, error: undefined })
    const log = (m: string) => { t.step = m; this.logs.push({ t: this.now(), msg: `${t.id.slice(0, 6)} ${m}` }); this.logs = this.logs.slice(-200); this.changed() }
    let o: Outcome
    try {
      o = await this.run(t, { log, markSubmitting: () => { t.submitted = true; this.store.flush() } })
    } catch (e) {
      o = { kind: 'failed', error: (e as Error).message }
    }
    t.step = undefined
    // After the Post click, an unclear result must never read as a plain failure that invites a retry.
    if (o.kind === 'failed' && t.submitted) o = { kind: 'needs_verification', reason: o.error }
    if (o.kind === 'published') this.move(t, 'published', { confirmation: o.confirmation })
    else if (o.kind === 'awaiting_user') this.move(t, 'awaiting_user', { error: o.reason })
    else if (o.kind === 'needs_verification') this.move(t, 'needs_verification', { error: o.reason })
    else this.move(t, 'failed', { error: o.error })
    this.running.delete(t.id)
    this.busyAccounts.delete(t.accountId)
    this.store.flush()
    this.kick()
  }

  summary() {
    const c = (s: Status[]) => this.tasks.filter((t) => s.includes(t.status)).length
    return {
      published: c(['published']),
      failed: c(['failed']),
      needsAction: c(['awaiting_user', 'needs_verification']),
      pending: c(['draft', 'scheduled', 'ready', 'uploading'])
    }
  }
}
