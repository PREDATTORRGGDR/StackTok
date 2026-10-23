import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { Data, STATUSES, Settings, Task } from '../shared/types'

export const DEFAULT_SETTINGS: Settings = {
  concurrency: 1,
  autoRun: true,
  defaultPresetIds: [],
  showAutomationWindow: false
}

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string')
const arr = <T>(v: unknown, f: (x: any) => T | null): T[] =>
  (Array.isArray(v) ? v : []).map((x) => (x && typeof x === 'object' ? f(x) : null)).filter((x): x is T => x !== null)

/** Validates loaded JSON; drops malformed records instead of crashing. */
export function sanitize(raw: any): Data {
  const r = raw && typeof raw === 'object' ? raw : {}
  const s = r.settings ?? {}
  const accounts = arr(r.accounts, (a) =>
    str(a.id)
      ? {
          id: str(a.id),
          label: str(a.label, 'Account'),
          username: str(a.username) || undefined,
          avatar: str(a.avatar) || undefined,
          verified: a.verified === true,
          defaultPresetIds: strings(a.defaultPresetIds),
          createdAt: num(a.createdAt) ?? Date.now()
        }
      : null
  )
  const tasks = arr<Task>(r.tasks, (t) =>
    str(t.id) && str(t.accountId) && str(t.videoPath) && (STATUSES as readonly string[]).includes(t.status)
      ? {
          id: str(t.id),
          accountId: str(t.accountId),
          batchId: str(t.batchId),
          videoPath: str(t.videoPath),
          caption: str(t.caption),
          scheduledAt: num(t.scheduledAt),
          status: t.status,
          attempts: num(t.attempts) ?? 0,
          submitted: t.submitted === true,
          error: str(t.error) || undefined,
          confirmation: str(t.confirmation) || undefined,
          createdAt: num(t.createdAt) ?? Date.now(),
          updatedAt: num(t.updatedAt) ?? Date.now()
        }
      : null
  )
  return {
    version: 1,
    accounts,
    presets: arr(r.presets, (p) =>
      str(p.id) ? { id: str(p.id), name: str(p.name, 'Preset'), tags: strings(p.tags) } : null
    ),
    templates: arr(r.templates, (t) => (str(t.id) ? { id: str(t.id), name: str(t.name, 'Template'), text: str(t.text) } : null)),
    tasks,
    settings: {
      concurrency: Math.min(3, Math.max(1, num(s.concurrency) ?? DEFAULT_SETTINGS.concurrency)),
      autoRun: s.autoRun !== false,
      defaultPresetIds: strings(s.defaultPresetIds),
      showAutomationWindow: s.showAutomationWindow === true
    },
    activeAccountId: str(r.activeAccountId) || undefined
  }
}

/** Tiny JSON store with atomic writes. Holds metadata only: no cookies, passwords, or videos. */
export class Store {
  data: Data
  private timer?: NodeJS.Timeout

  constructor(private file: string) {
    this.data = this.load()
  }

  private load(): Data {
    if (!existsSync(this.file)) return sanitize({})
    try {
      return sanitize(JSON.parse(readFileSync(this.file, 'utf8')))
    } catch {
      renameSync(this.file, this.file + `.corrupt-${Date.now()}`) // keep the bad file, start clean
      return sanitize({})
    }
  }

  save(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 150)
  }

  flush(): void {
    clearTimeout(this.timer)
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    renameSync(tmp, this.file)
  }
}
