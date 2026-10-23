import { Status, Task } from './types'

// ---- hashtags ----
export function normalizeTag(raw: string): string {
  const t = raw.trim().replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '')
  return t ? '#' + t : ''
}

export function parseTags(text: string): string[] {
  return dedupeTags(text.split(/[\s,]+/).map(normalizeTag).filter(Boolean))
}

export function dedupeTags(tags: string[]): string[] {
  const seen = new Set<string>()
  return tags.filter((t) => {
    const k = t.toLowerCase()
    return seen.has(k) ? false : (seen.add(k), true)
  })
}

/** Appends tags not already present in the caption. Never rewrites the user's text. */
export function applyTags(caption: string, tags: string[]): string {
  const present = new Set((caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.toLowerCase()))
  const add = dedupeTags(tags).filter((t) => !present.has(t.toLowerCase()))
  if (!add.length) return caption
  return caption.replace(/\s+$/, '') + (caption.trim() ? ' ' : '') + add.join(' ')
}

// ---- task state machine ----
const NEXT: Record<Status, Status[]> = {
  draft: ['scheduled', 'ready', 'cancelled'],
  scheduled: ['ready', 'cancelled', 'draft'],
  ready: ['uploading', 'cancelled', 'scheduled'],
  uploading: ['published', 'failed', 'awaiting_user', 'needs_verification'],
  awaiting_user: ['ready', 'uploading', 'cancelled', 'failed', 'needs_verification'],
  published: [],
  failed: ['ready', 'scheduled', 'cancelled'],
  needs_verification: ['published', 'cancelled'],
  cancelled: []
}

export function canTransition(from: Status, to: Status): boolean {
  return NEXT[from].includes(to)
}

/** Retry is only safe when the Post button was never clicked. */
export function canRetry(t: Task): boolean {
  return (t.status === 'failed' || t.status === 'awaiting_user') && !t.submitted
}

export function isDue(t: Task, now: number): boolean {
  return t.status === 'scheduled' && t.scheduledAt !== undefined && t.scheduledAt <= now
}

// ---- time ----
/** `datetime-local` value (local wall time) -> epoch ms. */
export function localInputToEpoch(v: string): number | undefined {
  const ms = new Date(v).getTime() // no zone suffix => interpreted as local time
  return Number.isFinite(ms) ? ms : undefined
}

export function epochToLocalInput(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000)
  return d.toISOString().slice(0, 16)
}

export function formatLocal(ms: number): string {
  return new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
}
