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
export const ACCENTS = ['blue', 'violet', 'pink', 'red', 'orange', 'yellow', 'lime', 'green', 'teal', 'cyan'] as const
export const ACCENT_COLORS: Record<(typeof ACCENTS)[number], string> = {
  blue: '#4d8dff', violet: '#9b6bff', pink: '#ff5c93', red: '#ff5252', orange: '#ff9340',
  yellow: '#ffc933', lime: '#9be04a', green: '#35d49a', teal: '#1fc2b5', cyan: '#35c7ff'
}
export const BACKGROUNDS = ['clear', 'aurora', 'sunset', 'ocean', 'graphite', 'forest', 'rose', 'midnight', 'lavender', 'mint', 'ember', 'mono', 'custom'] as const
/** Three light spots behind the glass; 'custom' uses the user's own three. */
export const BG_COLORS: Record<Exclude<(typeof BACKGROUNDS)[number], 'clear' | 'custom'>, [string, string, string]> = {
  aurora: ['#2f5bff', '#8a3dff', '#00c2c7'], sunset: ['#ff5a7a', '#ff9a3d', '#8d3dff'], ocean: ['#0a84ff', '#00c2c7', '#3d5bff'],
  graphite: ['#4b5160', '#2a2f3b', '#646c80'], forest: ['#1f9d55', '#0b6e4f', '#9be04a'], rose: ['#ff4d8d', '#c13cff', '#ff9c7a'],
  midnight: ['#1b2a8f', '#4a1fa8', '#0a5bd1'], lavender: ['#a78bfa', '#f0abfc', '#7dd3fc'], mint: ['#34d399', '#22d3ee', '#a3e635'],
  ember: ['#ff3d2e', '#ff8a1f', '#b8135c'], mono: ['#ffffff', '#9aa0b0', '#4b5160']
}
export const GLASS_MATERIALS = ['acrylic', 'mica', 'tabbed'] as const // native window material of the "Чистое" background
export const HEX = /^#[0-9a-f]{6}$/i
export const CHAT_WALLPAPERS = ['none', 'aurora', 'sunset', 'ocean', 'graphite', 'custom'] as const // 'custom' = the image file picked in main
export const CHAT_TEXT_SIZES = ['small', 'normal', 'large'] as const

export interface Settings {
  theme: (typeof THEMES)[number]
  accent: (typeof ACCENTS)[number]
  accentColor: string // '' or #rrggbb picked in the palette; wins over `accent`
  background: (typeof BACKGROUNDS)[number]
  bgCustom: [string, string, string] // the three spots of the 'custom' background
  glassMaterial: (typeof GLASS_MATERIALS)[number]
  motion: boolean // slowly drifting background light
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

/** Progress of a running chat export: messages loaded and read, then files saved, then the file written. */
export interface ChatExportProgress { phase: 'loading' | 'reading' | 'media' | 'saving'; done: number; total?: number }
