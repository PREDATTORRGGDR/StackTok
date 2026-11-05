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
export const BACKGROUNDS = ['clear', 'graphite', 'black', 'midnight', 'ocean', 'forest', 'wine', 'plum', 'sand', 'custom'] as const
/** One flat colour behind the glass, a dark and a light variant; 'custom' uses the first colour of `bgCustom` in both themes. */
export const BG_SOLID: Record<Exclude<(typeof BACKGROUNDS)[number], 'clear' | 'custom'>, { dark: string; light: string }> = {
  graphite: { dark: '#16181f', light: '#e3e5ea' }, black: { dark: '#000000', light: '#ffffff' }, midnight: { dark: '#0a1130', light: '#dce4fa' },
  ocean: { dark: '#08202f', light: '#d6ebf7' }, forest: { dark: '#0b2017', light: '#d8f0e3' }, wine: { dark: '#2a0c17', light: '#f7dde5' },
  plum: { dark: '#1a0e30', light: '#e7ddf8' }, sand: { dark: '#241d14', light: '#f1e7d6' }
}
/** Gradients of the chat wallpapers (previews in Settings; the page itself gets them from chat-overlay.ts). */
export const BG_COLORS: Record<string, [string, string, string]> = {
  aurora: ['#2f5bff', '#8a3dff', '#00c2c7'], sunset: ['#ff5a7a', '#ff9a3d', '#8d3dff'], ocean: ['#0a84ff', '#00c2c7', '#3d5bff'], graphite: ['#4b5160', '#2a2f3b', '#646c80']
}
export const GLASS_MATERIALS = ['acrylic', 'mica', 'tabbed'] as const // native window material of the "Чистое" background
export const HEX = /^#[0-9a-f]{6}$/i
export const CHAT_WALLPAPERS = ['none', 'aurora', 'sunset', 'ocean', 'graphite', 'custom'] as const // 'custom' = the image file picked in main
export const CHAT_TEXT_SIZES = ['small', 'normal', 'large'] as const
/** Model providers for the repost portrait. `openai` speaks Chat Completions, which most others copy; `custom` = any such address. */
export const PSY_PRESETS = ['anthropic', 'openai', 'gemini', 'openrouter', 'deepseek', 'custom'] as const
export const PSY_PRESET_INFO: Record<(typeof PSY_PRESETS)[number], { kind: 'anthropic' | 'openai'; base: string; vision: string; synth: string }> = {
  anthropic: { kind: 'anthropic', base: 'https://api.anthropic.com', vision: 'claude-haiku-5-5', synth: 'claude-haiku-5-5' }, // the cheapest model that reads pictures is the default for both steps
  openai: { kind: 'openai', base: 'https://api.openai.com/v1', vision: 'gpt-4o-mini', synth: 'gpt-4o' },
  gemini: { kind: 'openai', base: 'https://generativelanguage.googleapis.com/v1beta/openai', vision: 'gemini-2.5-flash', synth: 'gemini-2.5-pro' },
  openrouter: { kind: 'openai', base: 'https://openrouter.ai/api/v1', vision: 'google/gemini-2.5-flash', synth: 'anthropic/claude-sonnet-4.5' },
  deepseek: { kind: 'openai', base: 'https://api.deepseek.com', vision: 'deepseek-chat', synth: 'deepseek-chat' },
  custom: { kind: 'openai', base: '', vision: 'claude-haiku-5-5', synth: 'claude-haiku-5-5' } // a gateway with many models: the same cheap one
}

export interface Settings {
  theme: (typeof THEMES)[number]
  accent: (typeof ACCENTS)[number]
  accentColor: string // '' or #rrggbb picked in the palette; wins over `accent`
  background: (typeof BACKGROUNDS)[number]
  bgCustom: [string, string, string] // the three spots of the 'custom' background
  glassMaterial: (typeof GLASS_MATERIALS)[number]
  motion: boolean // slowly drifting background light
  glass: number // 0..100, how strong the frosted blur is
  panelOpacity: number // 0..100, how dense the glass of cards and panels is (50 = default)
  barOpacity: number // 0..100, the same for the sidebar and the header
  popOpacity: number // 20..100, how opaque dialogs, menus, toasts and progress cards are
  restoreLast: boolean // reopen the last active account on launch
  muteByDefault: boolean // start every account's page silent
  chatOverlay: boolean // glass styling on TikTok's messages page
  chatWallpaper: (typeof CHAT_WALLPAPERS)[number]
  chatDim: number // 0..100, how dark the wallpaper is under the glass
  chatPrivacy: boolean // blur names, previews and messages until the mouse is over them
  chatTextSize: (typeof CHAT_TEXT_SIZES)[number]
  psyPreset: (typeof PSY_PRESETS)[number] // which provider reads covers and writes the portrait (the API key itself lives only in main)
  psyBase: string // address for 'custom'
  psyVision: string // model that reads covers; '' = the preset's own
  psySynth: string // model that writes the portrait; '' = the preset's own
}

export interface Data {
  version: 1
  accounts: Account[]
  settings: Settings
  activeAccountId?: string
}

export interface Bounds { x: number; y: number; width: number; height: number }

/** Progress of a repost cleanup, pushed to the UI with every change. */
export interface Job {
  accountId: string
  status: 'running' | 'done' | 'stopped'
  phase: 'scan' | 'delete' | 'verify'
  pass?: number // delete passes so far; each one ends with a rescan from the start
  found: number // every repost seen on the profile so far
  removed: number
  failed: number
  message: string
  startedAt: number
  deleteStartedAt?: number // for the time-left estimate
  finishedAt?: number
}

/** Progress of a running chat export: messages loaded and read, then files saved, then the file written. */
export interface ChatExportProgress { phase: 'loading' | 'reading' | 'media' | 'saving'; done: number; total?: number }

/** Progress of a repost portrait (VLM analysis), pushed to the UI with every change. */
export interface PsyJob {
  accountId: string
  status: 'running' | 'done' | 'stopped'
  phase: 'collect' | 'vision' | 'synth' | 'save'
  done: number
  total: number
  message: string
  startedAt: number
  finishedAt?: number
  path?: string // where the finished presentation was saved
  target?: string // @name of a profile that is not one of the app's accounts
  tokens: number
}
