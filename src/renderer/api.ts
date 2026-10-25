import { useEffect, useState } from 'react'
import { AccountView, Settings } from '@shared/types'

export interface AppState {
  accounts: AccountView[]
  settings: Settings
  activeAccountId?: string
  version: string
  dataPath: string
}

declare global {
  interface Window {
    api: {
      call(channel: string, arg?: unknown): Promise<{ ok: boolean; value?: any; error?: string }>
      onState(cb: (s: AppState) => void): () => void
    }
  }
}

type Toast = { text: string; err?: boolean; id: number }
const listeners = new Set<(t: Toast[]) => void>()
let toasts: Toast[] = []
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
  if (!r.ok) { if (!quiet) toast(r.error ?? 'Что-то пошло не так', true); return undefined }
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
