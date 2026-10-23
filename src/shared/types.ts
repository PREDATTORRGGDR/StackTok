export type SessionState = 'unknown' | 'logged_in' | 'logged_out'

export interface Account {
  id: string // stable internal id; never the username
  label: string
  username?: string // confirmed by the user, may be absent
  avatar?: string
  verified: boolean // user confirmed the identity of this session
  defaultPresetIds: string[]
  createdAt: number
}
export type AccountView = Account & { session: SessionState }

export interface Preset { id: string; name: string; tags: string[] }
export interface Template { id: string; name: string; text: string }

export const STATUSES = [
  'draft', 'scheduled', 'ready', 'uploading', 'awaiting_user',
  'published', 'failed', 'needs_verification', 'cancelled'
] as const
export type Status = (typeof STATUSES)[number]

export interface Task {
  id: string
  accountId: string
  batchId: string
  videoPath: string
  caption: string // final text including hashtags
  scheduledAt?: number // epoch ms (UTC); displayed in local time
  status: Status
  attempts: number
  submitted: boolean // the Post button was clicked at least once -> never auto-retry
  error?: string
  confirmation?: string
  step?: string // live progress while uploading (not persisted)
  createdAt: number
  updatedAt: number
}

export interface Settings {
  concurrency: number // parallel uploads across different accounts
  autoRun: boolean // run scheduler while app is open
  defaultPresetIds: string[]
  showAutomationWindow: boolean
}

export interface Data {
  version: 1
  accounts: Account[]
  presets: Preset[]
  templates: Template[]
  tasks: Task[]
  settings: Settings
  activeAccountId?: string
}

export interface Bounds { x: number; y: number; width: number; height: number }
export interface VideoInfo { path: string; name: string; size: number }
export interface LogEntry { t: number; msg: string }
