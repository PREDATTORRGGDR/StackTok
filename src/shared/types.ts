export type SessionState = 'unknown' | 'logged_in' | 'logged_out'

export interface Account {
  id: string // stable internal id; never the username
  label: string
  username?: string // confirmed by the user, may be absent
  avatar?: string
  verified: boolean // user confirmed which TikTok account this session belongs to
  createdAt: number
}
export type AccountView = Account & { session: SessionState }

export const THEMES = ['dark', 'light', 'system'] as const
export const ACCENTS = ['blue', 'violet', 'pink', 'orange', 'green'] as const
export const BACKGROUNDS = ['clear', 'aurora', 'sunset', 'ocean', 'graphite'] as const

export interface Settings {
  theme: (typeof THEMES)[number]
  accent: (typeof ACCENTS)[number]
  background: (typeof BACKGROUNDS)[number]
  glass: number // 0..100, how strong the frosted blur is
  restoreLast: boolean // reopen the last active account on launch
  muteByDefault: boolean // start every account's page silent
}

export interface Data {
  version: 1
  accounts: Account[]
  settings: Settings
  activeAccountId?: string
}

export interface Bounds { x: number; y: number; width: number; height: number }
