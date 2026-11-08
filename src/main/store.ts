import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { ACCENTS, API_PROFILES_MAX, ApiProfile, ApiUsage, BACKGROUNDS, GLASS_MATERIALS, HEX, CHAT_TEXT_SIZES, OPEN_IN, PSY_PRESETS, CHAT_WALLPAPERS, Data, Settings, THEMES, newProfile } from '../shared/types'

export const DEFAULT_SETTINGS: Settings = { theme: 'dark', accent: 'blue', accentColor: '', background: 'graphite', bgCustom: ['#2f5bff', '#8a3dff', '#00c2c7'], glassMaterial: 'acrylic', motion: true, glass: 55, panelOpacity: 50, barOpacity: 50, popOpacity: 96, restoreLast: true, muteByDefault: true, chatOverlay: true, chatWallpaper: 'none', chatDim: 50, chatPrivacy: false, chatTextSize: 'normal', apiProfiles: [newProfile('main')], apiActive: 'main' }

const str = (v: unknown, d = ''): string => (typeof v === 'string' ? v : d)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const hex = (v: unknown, d: string): string => (typeof v === 'string' && HEX.test(v) ? v.toLowerCase() : d)
const pick = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d)

/** API profiles; settings from before profiles existed (one provider, one key) become the profile 'main'. */
function profilesOf(s: any): ApiProfile[] {
  const one = (p: any, id: string): ApiProfile => ({
    id, name: str(p.name, 'Ключ').trim().slice(0, 40) || 'Ключ', preset: pick(p.preset, PSY_PRESETS, 'anthropic'),
    base: str(p.base).trim().slice(0, 200), vision: str(p.vision).trim().slice(0, 100), synth: str(p.synth).trim().slice(0, 100), assist: str(p.assist).trim().slice(0, 100)
  })
  if (Array.isArray(s.apiProfiles)) {
    const seen = new Set<string>()
    const list = s.apiProfiles
      .filter((p: any) => p && typeof p === 'object' && /^[\w-]{1,64}$/.test(str(p.id)) && !seen.has(p.id) && seen.add(p.id))
      .slice(0, API_PROFILES_MAX)
      .map((p: any) => one(p, p.id))
    if (list.length) return list
  }
  return [one({ name: 'Основной', preset: s.psyPreset, base: s.psyBase, vision: s.psyVision, synth: s.psySynth, assist: s.assistModel }, 'main')]
}

function usageOf(u: any, ids: string[]): Record<string, ApiUsage> {
  const out: Record<string, ApiUsage> = {}
  for (const id of ids) {
    const x = u && typeof u === 'object' ? u[id] : undefined
    if (x && typeof x === 'object') out[id] = { inTok: Math.max(0, num(x.inTok) ?? 0), outTok: Math.max(0, num(x.outTok) ?? 0), requests: Math.max(0, num(x.requests) ?? 0), since: num(x.since) ?? Date.now() }
  }
  return out
}

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
  const profiles = profilesOf(s)
  return {
    version: 1,
    accounts,
    settings: {
      theme: pick(s.theme, THEMES, DEFAULT_SETTINGS.theme),
      accent: pick(s.accent, ACCENTS, DEFAULT_SETTINGS.accent),
      accentColor: hex(s.accentColor, '') ,
      background: pick(s.background, BACKGROUNDS, DEFAULT_SETTINGS.background),
      bgCustom: Array.isArray(s.bgCustom) && s.bgCustom.length === 3 ? (s.bgCustom.map((c: unknown, i: number) => hex(c, DEFAULT_SETTINGS.bgCustom[i])) as [string, string, string]) : DEFAULT_SETTINGS.bgCustom,
      glassMaterial: pick(s.glassMaterial, GLASS_MATERIALS, DEFAULT_SETTINGS.glassMaterial),
      motion: s.motion !== false,
      glass: Math.min(100, Math.max(0, num(s.glass) ?? DEFAULT_SETTINGS.glass)),
      panelOpacity: Math.min(100, Math.max(0, num(s.panelOpacity) ?? DEFAULT_SETTINGS.panelOpacity)),
      barOpacity: Math.min(100, Math.max(0, num(s.barOpacity) ?? DEFAULT_SETTINGS.barOpacity)),
      popOpacity: Math.min(100, Math.max(20, num(s.popOpacity) ?? DEFAULT_SETTINGS.popOpacity)),
      restoreLast: s.restoreLast !== false,
      muteByDefault: s.muteByDefault !== false,
      chatOverlay: s.chatOverlay !== false,
      chatWallpaper: pick(s.chatWallpaper, CHAT_WALLPAPERS, DEFAULT_SETTINGS.chatWallpaper),
      chatDim: Math.min(100, Math.max(0, num(s.chatDim) ?? DEFAULT_SETTINGS.chatDim)),
      chatPrivacy: s.chatPrivacy === true,
      chatTextSize: pick(s.chatTextSize, CHAT_TEXT_SIZES, DEFAULT_SETTINGS.chatTextSize),
      apiProfiles: profiles,
      apiActive: profiles.some((p) => p.id === s.apiActive) ? s.apiActive : profiles[0].id
    },
    activeAccountId: accounts.some((a: any) => a.id === r.activeAccountId) ? r.activeAccountId : undefined,
    apiUsage: usageOf(r.apiUsage, profiles.map((p) => p.id))
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
