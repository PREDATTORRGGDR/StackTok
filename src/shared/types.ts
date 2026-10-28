export type SessionState = 'unknown' | 'logged_in' | 'logged_out'

export const OPEN_IN = ['studio', 'profile', 'chats'] as const // where an account opens: TikTok Studio, own profile, messages
export type OpenIn = (typeof OPEN_IN)[number]

export interface Account {
  id: string // stable internal id; never the username
  label: string
  username?: string // confirmed by the user, may be absent
  avatar?: string
  verified: boolean // user confirmed which TikTok account this session belongs to
  openIn: OpenIn // start page of this account's view
  createdAt: number
}
export type AccountView = Account & { session: SessionState }

export const THEMES = ['dark', 'light', 'system'] as const
export const ACCENTS = ['blue', 'violet', 'pink', 'orange', 'green'] as const
export const BACKGROUNDS = ['clear', 'aurora', 'sunset', 'ocean', 'graphite'] as const
export const CHAT_WALLPAPERS = ['none', 'aurora', 'sunset', 'ocean', 'graphite', 'custom'] as const // 'custom' = the image file picked in main
export const CHAT_TEXT_SIZES = ['small', 'normal', 'large'] as const

export interface Settings {
  theme: (typeof THEMES)[number]
  accent: (typeof ACCENTS)[number]
  background: (typeof BACKGROUNDS)[number]
  glass: number // 0..100, how strong the frosted blur is
  restoreLast: boolean // reopen the last active account on launch
  muteByDefault: boolean // start every account's page silent
  chatOverlay: boolean // glass styling on TikTok's messages page
  chatWallpaper: (typeof CHAT_WALLPAPERS)[number]
  chatDim: number // 0..100, how dark the wallpaper is under the glass
  chatPrivacy: boolean // blur names, previews and messages until the mouse is over them
  chatTextSize: (typeof CHAT_TEXT_SIZES)[number]
}

export interface Data {
  version: 1
  accounts: Account[]
  settings: Settings
  activeAccountId?: string
}

export interface Bounds { x: number; y: number; width: number; height: number }
