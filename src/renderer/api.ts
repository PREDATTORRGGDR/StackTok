import { useEffect, useState } from 'react'
import { AccountView, Bounds, LogEntry, Preset, Settings, Task, Template, VideoInfo } from '@shared/types'

export interface AppState {
  accounts: AccountView[]
  presets: Preset[]
  templates: Template[]
  tasks: Task[]
  settings: Settings
  activeAccountId?: string
  overdue: string[]
  summary: { published: number; failed: number; needsAction: number; pending: number }
  logs: LogEntry[]
  version: string
  dataPath: string
}

declare global {
  interface Window {
    api: {
      call(channel: string, arg?: unknown): Promise<{ ok: boolean; value?: any; error?: string }>
      onState(cb: (s: AppState) => void): () => void
      pathFor(f: File): string
    }
  }
}

type Listener = (t: { text: string; err?: boolean; id: number }[]) => void
let toasts: { text: string; err?: boolean; id: number }[] = []
const listeners = new Set<Listener>()
export function toast(text: string, err = false) {
  const t = { text, err, id: Math.random() }
  toasts = [...toasts, t]
  listeners.forEach((l) => l(toasts))
  setTimeout(() => { toasts = toasts.filter((x) => x !== t); listeners.forEach((l) => l(toasts)) }, err ? 6000 : 3000)
}
export function useToasts() {
  const [list, set] = useState(toasts)
  useEffect(() => { listeners.add(set); return () => void listeners.delete(set) }, [])
  return list
}

/** Calls a main-process handler. Errors surface as toasts unless `quiet`. */
export async function call<T = any>(channel: string, arg?: unknown, quiet = false): Promise<T | undefined> {
  const r = await window.api.call(channel, arg)
  if (!r.ok) { if (!quiet) toast(r.error ?? 'Something went wrong', true); return undefined }
  return r.value as T
}

export function useAppState(): AppState | null {
  const [s, set] = useState<AppState | null>(null)
  useEffect(() => {
    const off = window.api.onState(set)
    call<AppState>('state:get').then((v) => v && set(v))
    return off
  }, [])
  return s
}

export const videoSrc = (p: string) => 'stacktok-media://v/' + encodeURIComponent(p)
export type { Bounds, VideoInfo }
