import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ACCENTS, BACKGROUNDS, CHAT_TEXT_SIZES, OPEN_IN, CHAT_WALLPAPERS, Data, Settings, THEMES } from '../shared/types'

export const DEFAULT_SETTINGS: Settings = { theme: 'dark', accent: 'blue', background: 'aurora', glass: 55, restoreLast: true, muteByDefault: true, chatOverlay: true, chatWallpaper: 'none', chatDim: 50, chatPrivacy: false, chatTextSize: 'normal' }

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const pick = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d)

/** Validates loaded JSON; drops malformed records instead of crashing. */
export function sanitize(raw: any): Data {
  const r = raw && typeof raw === 'object' ? raw : {}
  const s = r.settings && typeof r.settings === 'object' ? r.settings : {}
  const accounts = (Array.isArray(r.accounts) ? r.accounts : [])
    .filter((a: any) => a && typeof a === 'object' && str(a.id))
    .map((a: any) => ({
      id: str(a.id),
      label: str(a.label, 'Аккаунт'),
      username: str(a.username) || undefined,
      avatar: str(a.avatar) || undefined,
      verified: a.verified === true,
      openIn: pick(a.openIn, OPEN_IN, 'studio'),
      createdAt: num(a.createdAt) ?? Date.now()
    }))
  return {
    version: 1,
    accounts,
    settings: {
      theme: pick(s.theme, THEMES, DEFAULT_SETTINGS.theme),
      accent: pick(s.accent, ACCENTS, DEFAULT_SETTINGS.accent),
      background: pick(s.background, BACKGROUNDS, DEFAULT_SETTINGS.background),
      glass: Math.min(100, Math.max(0, num(s.glass) ?? DEFAULT_SETTINGS.glass)),
      restoreLast: s.restoreLast !== false,
      muteByDefault: s.muteByDefault !== false,
      chatOverlay: s.chatOverlay !== false,
      chatWallpaper: pick(s.chatWallpaper, CHAT_WALLPAPERS, DEFAULT_SETTINGS.chatWallpaper),
      chatDim: Math.min(100, Math.max(0, num(s.chatDim) ?? DEFAULT_SETTINGS.chatDim)),
      chatPrivacy: s.chatPrivacy === true,
      chatTextSize: pick(s.chatTextSize, CHAT_TEXT_SIZES, DEFAULT_SETTINGS.chatTextSize)
    },
    activeAccountId: accounts.some((a: any) => a.id === r.activeAccountId) ? r.activeAccountId : undefined
  }
}

/** Tiny JSON store with atomic writes. Holds metadata only: no cookies, passwords, or secrets. */
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
