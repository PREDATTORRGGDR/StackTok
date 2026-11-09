// Electron side of the watchdog: requests through the account's session, the schedule, storage.
import { app, session, type WebContents } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, unlink, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { WatchdogJob, WatchdogTargetView, WatchdogEventView } from '../shared/types'
import {
  type WatchdogState, type WatchdogTarget, type WatchdogEvent, type CircuitState, type PageFn, type ProfileStats, type RepostItem,
  emptyState, applyScan, feedStats, isActivity, newMemo, newCircuit, recordFailure, recordSuccess, scanHead, scanList,
  jittered, REPOST_INTERVAL, FULL_INTERVAL, STATS_INTERVAL, serialise, deserialise
} from './watchdog'
import { pageScope } from './account-stats'
import { HOME_URL, partitionFor } from './browse'

const SHOTS_DIR = 'watchdog-shots' // screenshots of older versions; nothing new is written there
const DATA_FILE = 'watchdog.json'
const MAX_EVENTS = 10_000
const SOFT_FAILS = 3 // looks without an answer in a row before the pause grows
const ALIVE_CHECKS = 5 // removed reposts whose video is looked up in one go

// ── persistence ──

function dataPath() { return join(app.getPath('userData'), DATA_FILE) }
function shotsBase() { return join(app.getPath('userData'), SHOTS_DIR) }

export function loadState(): WatchdogState {
  try {
    return deserialise(JSON.parse(readFileSync(dataPath(), 'utf8')))
  } catch { return emptyState() }
}

function saveState(s: WatchdogState) {
  const dir = app.getPath('userData')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(dataPath(), JSON.stringify(serialise(s)), 'utf8')
}

// ── request helpers ──

/** TikTok said stop: a limit, a captcha or a refusal. `hard` = do not ask again until the user says so. */
class Blocked extends Error {
  constructor(message: string, readonly hard = false) { super(message) }
}

/** No account of the app is signed in to TikTok right now. */
class NoAccount extends Error {}

const get = (accountId: string, path: string) =>
  session.fromPartition(partitionFor(accountId)).fetch(new URL(path, HOME_URL).href, { credentials: 'include' })

const html = (accountId: string, path: string) => get(accountId, path).then((r) => (r.ok ? r.text() : null)).catch(() => null)

/** JSON of an API address; null = no usable answer (TikTok's quiet refusal is an empty body). */
async function api(accountId: string, path: string): Promise<any | null> {
  let r: Response
  try { r = await get(accountId, path) } catch { return null }
  if (r.status === 429) throw new Blocked('TikTok просит реже спрашивать (429).')
  if (r.status === 401 || r.status === 403) throw new Blocked(`TikTok отказал в доступе (${r.status}).`)
  if (!r.ok) return null
  const j = await r.json().catch(() => null)
  const code = Number(j?.status_code ?? j?.statusCode ?? 0)
  if (code === 10214) throw new Blocked('TikTok просит пройти проверку (капча). Откройте TikTok в «Обзоре» этим аккаунтом, пройдите её и включите слежку снова.', true)
  if (code === 10202) throw new Blocked('TikTok ограничил запросы этого аккаунта.')
  return j
}

const num = (v: unknown) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v)) ? Number(v) : undefined

interface Profile { secUid: string; nickname?: string; avatar?: string; closed: boolean; stats: ProfileStats }

function profileOf(info: any): Profile | null {
  const u = info?.user
  if (!u?.secUid) return null
  const st = { ...info.stats, ...info.statsV2 } // statsV2 holds exact numbers as strings, stats is rounded
  return {
    secUid: String(u.secUid), nickname: u.nickname || undefined, avatar: u.avatarThumb || u.avatarMedium || undefined, closed: !!(u.privateAccount || u.secret),
    stats: { following: num(st.followingCount), liked: num(st.diggCount), videos: num(st.videoCount), nickname: typeof u.nickname === 'string' ? u.nickname : undefined, bio: typeof u.signature === 'string' ? u.signature : undefined }
  }
}

/** The public profile: the page (TikTok randomly answers one address of it with 403, so two forms are asked side by side), then the API. */
async function readProfile(accountId: string, handle: string): Promise<Profile | null> {
  const name = encodeURIComponent(handle)
  const page = (path: string) => html(accountId, path).then((h) => {
    const p = profileOf(pageScope(h)?.['webapp.user-detail']?.userInfo)
    if (!p) throw new Error('no profile')
    return p
  })
  const fromPage = await Promise.any([page(`/@${name}/`), page(`/@${name}?lang=ru-RU`)]).catch(() => null)
  if (fromPage) return fromPage
  const j = await api(accountId, `/api/user/detail/?uniqueId=${name}&aid=1988`).catch(() => null)
  return profileOf(j?.userInfo)
}

/** Resolve a @handle to secUid through the account's session. */
export async function resolveProfile(accountId: string, handle: string): Promise<{ secUid: string; nickname?: string; avatar?: string; stats: ProfileStats } | null> {
  const p = await readProfile(accountId, handle)
  if (!p) return null
  if (p.closed) throw new Error('Закрытый профиль: репосты недоступны.')
  return p
}

/**
 * The same list asked by the site's own request client inside an open TikTok page of the account (it signs the request in full).
 * A real function serialised with toString(): nothing from the outer scope. Returns the JSON, or null.
 */
const viaSite = async (a: { secUid: string; offset: number }) => {
  const w = window as any
  try {
    let c = w.__stackClient
    if (!c) {
      const g = w.__LOADABLE_LOADED_CHUNKS__
      let req: any
      if (g && g.push) g.push([[Symbol('stacktok')], {}, (r: any) => { req = r }])
      for (const [id, fn] of Object.entries((req && req.m) || {})) {
        const src = Function.prototype.toString.call(fn)
        if (!src.includes('csrfToken') || !/\.post|post\(/.test(src)) continue
        let e: any
        try { e = req(id) } catch { continue }
        for (const k of Object.keys(e ?? {})) {
          let v: any
          try { v = e[k] } catch { continue }
          if (v && typeof v === 'object' && typeof v.get === 'function' && typeof v.post === 'function' && 'csrfToken' in v) { c = w.__stackClient = v; break }
        }
        if (c) break
      }
    }
    if (!c) return null
    return await c.get('/api/repost/item_list/', { query: { secUid: a.secUid, count: 30, cursor: a.offset, coverFormat: 2, needPinnedItemIds: true, post_item_list_request_type: 0 }, baseUrlType: 2 })
  } catch { return null }
}

/** One page of the repost list by offset: straight from main with the account's session, then through the account's open TikTok page. */
const repostPage = (accountId: string, secUid: string, page: WebContents | null): PageFn => async (offset) => {
  const q = new URLSearchParams({ aid: '1988', count: '30', coverFormat: '2', cursor: String(offset), needPinnedItemIds: 'true', post_item_list_request_type: '0', secUid })
  let j = await api(accountId, '/api/repost/item_list/?' + q)
  if ((!j || typeof j.hasMore !== 'boolean') && page && !page.isDestroyed() && /^https:\/\/www\.tiktok\.com\/(?!tiktokstudio)/.test(page.getURL()) && !page.isLoading()) {
    j = await page.executeJavaScript(`(${viaSite})(${JSON.stringify({ secUid, offset })})`).catch(() => null)
  }
  if (!j || (j.status_code ?? 0) !== 0 || typeof j.hasMore !== 'boolean') return null
  const items: RepostItem[] = ((j.itemList ?? []) as any[]).map((x) => ({
    id: String(x.id),
    author: x.author?.uniqueId || '',
    desc: String(x.desc ?? '').slice(0, 300),
    cover: x.video?.cover || x.video?.originCover || '',
    createTime: Number(x.createTime) || 0
  }))
  return { more: j.hasMore, items }
}

/** Is the video itself still there? false = deleted or hidden by its author; null = could not tell. */
async function videoAlive(accountId: string, author: string | undefined, id: string): Promise<boolean | null> {
  if (!author) return null
  const detail = pageScope(await html(accountId, `/@${encodeURIComponent(author)}/video/${encodeURIComponent(id)}`))?.['webapp.video-detail']
  if (!detail) return null
  if (detail.itemInfo?.itemStruct?.id) return true
  return typeof detail.statusCode === 'number' && detail.statusCode !== 0 ? false : null
}

// ── the runner ──

/** What is going on with a target right now; lives in memory only. */
interface Live {
  circuit: CircuitState
  checking: boolean
  lastCheck?: number // a look ended (with or without an answer)
  lastOk?: number // a look that TikTok answered
  nextAt?: number
  fails: number
  error?: string
  note?: string
  lastFull: number
  wantFull: boolean
  lastStats: number
  statsOk?: boolean
  pending: number
  via?: string // the account whose session got the last answer
}

/** What the runner needs to know about the app's accounts. */
export interface WatchdogHost {
  loggedIn: () => string[] // ids of the accounts signed in to TikTok
  label: (accountId: string) => string
  page: (accountId: string) => WebContents | null // the account's TikTok view, if one is open
}

export class WatchdogRunner {
  state: WatchdogState
  private live = new Map<string, Live>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()
  private running = false
  private dirty = false

  constructor(private push: () => void, private host: WatchdogHost, private onEvents: (t: WatchdogTarget, events: WatchdogEvent[]) => void = () => {}) {
    this.state = loadState()
  }

  private liveOf(id: string): Live {
    let l = this.live.get(id)
    if (!l) { l = { circuit: newCircuit(), checking: false, fails: 0, lastFull: 0, wantFull: false, lastStats: 0, pending: 0 }; this.live.set(id, l) }
    return l
  }

  private memoOf(id: string) {
    let m = this.state.memos.get(id)
    if (!m) { m = newMemo(); this.state.memos.set(id, m) }
    return m
  }

  view(): WatchdogJob {
    const count = new Map<string, number>(), active = new Map<string, number>()
    let unread = 0
    for (const e of this.state.events) {
      count.set(e.targetId, (count.get(e.targetId) ?? 0) + 1)
      if (isActivity(e)) active.set(e.targetId, e.at)
      if (e.at > this.state.seenAt) unread++
    }
    const targets: WatchdogTargetView[] = this.state.targets.map((t) => {
      const l = this.liveOf(t.id), m = this.memoOf(t.id)
      return {
        id: t.id, handle: t.handle, nickname: t.nickname, avatar: t.avatar, accountId: t.accountId, active: t.active, since: t.createdAt,
        checking: l.checking, lastCheck: l.lastCheck, lastOk: l.lastOk, nextAt: t.active ? l.nextAt : undefined, error: l.error, note: l.note,
        ready: m.baselined, reposts: this.state.reposts.get(t.id)?.size ?? 0, pending: l.pending,
        eventCount: count.get(t.id) ?? 0, lastActive: active.get(t.id), activityOk: l.statsOk, via: this.host.label(l.via ?? t.accountId)
      }
    })
    return { targets, events: this.state.events.slice(-500).reverse() as WatchdogEventView[], unread, notify: this.state.notify, status: this.running ? 'running' : 'idle' }
  }

  // ── target management ──

  async addTarget(handle: string, accountId: string): Promise<WatchdogTarget> {
    const existing = this.state.targets.find((t) => t.handle.toLowerCase() === handle.toLowerCase())
    if (existing) throw new Error('Этот профиль уже отслеживается.')
    const info = await resolveProfile(accountId, handle)
    if (!info) throw new Error('Профиль не найден. Проверьте @имя.')
    const t: WatchdogTarget = { id: randomUUID(), handle, secUid: info.secUid, nickname: info.nickname, avatar: info.avatar, accountId, active: true, createdAt: Date.now() }
    this.state.targets.push(t)
    this.memoOf(t.id).stats = info.stats
    this.save()
    this.schedule(t, 0) // the first look right away: it only remembers what is there
    this.push()
    return t
  }

  removeTarget(targetId: string) {
    this.stopTarget(targetId)
    this.state.targets = this.state.targets.filter((t) => t.id !== targetId)
    this.state.events = this.state.events.filter((e) => e.targetId !== targetId)
    this.state.reposts.delete(targetId)
    this.state.memos.delete(targetId)
    this.live.delete(targetId)
    this.save()
    this.push()
  }

  /** Targets watched through an account that is being removed go with it. */
  removeAccount(accountId: string) {
    for (const t of this.state.targets.filter((x) => x.accountId === accountId)) this.removeTarget(t.id)
  }

  toggleTarget(targetId: string) {
    const t = this.state.targets.find((x) => x.id === targetId)
    if (!t) return
    t.active = !t.active
    const l = this.liveOf(t.id)
    if (t.active) { l.error = undefined; l.fails = 0; l.circuit = newCircuit(); this.schedule(t, 0) } else { this.stopTarget(targetId); l.nextAt = undefined }
    this.save()
    this.push()
  }

  private stopTarget(id: string) {
    const t1 = this.timers.get(id)
    if (t1) { clearTimeout(t1); this.timers.delete(id) }
  }

  // ── scheduling ──

  startAll() {
    this.running = true
    this.state.targets.filter((t) => t.active).forEach((t, i) => this.schedule(t, 1500 + i * 2000)) // not all at once at start
  }

  stopAll() {
    this.running = false
    for (const t of this.state.targets) this.stopTarget(t.id)
  }

  private schedule(t: WatchdogTarget, wait?: number) {
    if (!this.running || !t.active) return
    this.stopTarget(t.id)
    const l = this.liveOf(t.id)
    const delay = wait ?? (l.circuit.nextAt > Date.now() ? l.circuit.nextAt - Date.now() : jittered(REPOST_INTERVAL))
    l.nextAt = Date.now() + delay
    this.timers.set(t.id, setTimeout(() => void this.look(t), delay))
  }

  /** One look at the target: the top of the list, or the whole list when it is due; the profile's counters once a minute. */
  private async look(t: WatchdogTarget) {
    this.timers.delete(t.id)
    const l = this.liveOf(t.id)
    if (!t.active || l.checking) return
    const gone = () => !this.state.targets.includes(t) // removed while a request was on its way
    l.checking = true
    this.push()
    const memo = this.memoOf(t.id)
    const fresh: WatchdogEvent[] = []
    const asked: string[] = []
    try {
      // TikTok answers this list only to signed-in sessions and goes silent (an empty 200) for a session that asked too much,
      // so every signed-in account of the app is a way in: the one that answered last goes first, the chosen one next.
      const signedIn = this.host.loggedIn()
      const order = [...new Set([l.via, t.accountId, ...signedIn].filter((x): x is string => !!x && signedIn.includes(x)))]
      if (!order.length) throw new NoAccount()
      let silent = false // every account was tried and none answered: the rest of this look does not ask again
      const page: PageFn = async (offset) => {
        if (silent) return null
        for (const id of order) {
          if (!asked.includes(id)) asked.push(id)
          const r = await repostPage(id, t.secUid, this.host.page(id))(offset).catch((e) => { if (e instanceof Blocked && e.hard) throw e; return null })
          if (r) { if (order[0] !== id) { order.splice(order.indexOf(id), 1); order.unshift(id) } l.via = id; return r }
        }
        silent = true
        return null
      }
      const full = !memo.baselined || l.wantFull || Date.now() - l.lastFull > FULL_INTERVAL
      const scan = full ? await scanList(page, 4, () => gone() || !t.active) : await scanHead(page)
      if (gone()) return
      if (!scan || (full && !scan.complete && !scan.items.length)) {
        l.fails++
        const why = `TikTok вернул пустой ответ на список репостов (спрашивал через: ${asked.map((id) => this.host.label(id)).join(', ') || '—'}). Так он молча придерживает аккаунт, с которого список запрашивали слишком часто; обычно это проходит само.`
        if (l.fails >= SOFT_FAILS) this.failed(t, l, why)
        else l.error = why + ' Спрошу ещё раз через несколько секунд.'
      } else {
        let known = this.state.reposts.get(t.id)
        if (!known) { known = new Map(); this.state.reposts.set(t.id, known) }
        const now = Date.now()
        const r = applyScan(t.id, known, memo, scan, now)
        if (full) l.lastFull = now
        l.wantFull = r.needFull
        l.pending = r.pending
        l.note = full && !scan.complete ? 'TikTok отдал список не целиком: новые репосты видны, удаления проверю следующим заходом.' : r.pending ? 'Часть репостов пропала из списка, перепроверяю, прежде чем сообщать.' : undefined
        if (r.retract.length) { this.state.events = this.state.events.filter((e) => !r.retract.includes(e.id)); this.dirty = true }
        // A repost also vanishes when its video is deleted or hidden by the author: that is not the person's doing.
        const removed = r.events.filter((e) => e.kind === 'repost_removed')
        if (removed.length <= ALIVE_CHECKS) await Promise.all(removed.map(async (e) => { if ((await videoAlive(t.accountId, e.meta?.author, e.videoId!)) === false) { e.why = 'unavailable'; delete e.isFlash } }))
        if (gone()) return
        fresh.push(...r.events)
        if (r.changed) this.dirty = true
        l.lastOk = now
        l.fails = 0
        l.error = undefined
        recordSuccess(l.circuit)
      }
      if (Date.now() - l.lastStats > STATS_INTERVAL) {
        l.lastStats = Date.now()
        const p = await readProfile(t.accountId, t.handle).catch(() => null)
        if (gone()) return
        l.statsOk = !!p
        if (p) {
          fresh.push(...feedStats(t.id, memo, p.stats, Date.now()))
          if (p.avatar && p.avatar !== t.avatar) { t.avatar = p.avatar; this.dirty = true }
          if (p.nickname && p.nickname !== t.nickname) { t.nickname = p.nickname; this.dirty = true }
        }
      }
    } catch (err) {
      if (gone()) return
      if (err instanceof NoAccount) l.error = 'Ни один аккаунт в приложении не вошёл в TikTok, а без входа TikTok не отдаёт список репостов. Войдите в аккаунт на вкладке «Обзор»: слежка продолжится сама.'
      else if (err instanceof Blocked && err.hard) { t.active = false; l.error = err.message; l.nextAt = undefined; this.dirty = true } else this.failed(t, l, err instanceof Blocked ? err.message : 'Не получилось проверить: ' + (err as Error).message)
    } finally {
      l.checking = false
      l.lastCheck = Date.now()
    }
    if (fresh.length) {
      this.state.events.push(...fresh)
      this.trimEvents()
      this.dirty = true
      this.onEvents(t, fresh)
    }
    if (this.dirty) this.save()
    this.schedule(t)
    this.push()
  }

  /** A look that failed: the pause grows 2 → 5 → 15 minutes, then the target is paused with the reason. */
  private failed(t: WatchdogTarget, l: Live, why: string) {
    const delay = recordFailure(l.circuit, Date.now())
    if (delay < 0) {
      t.active = false
      l.error = why + ' Слежка поставлена на паузу: включите её снова позже.'
      l.nextAt = undefined
      this.dirty = true
    } else l.error = `${why} Следующая попытка через ${Math.round(delay / 60_000)} мин.`
  }

  /** Immediate look by user request. */
  async checkNow(targetId: string) {
    const t = this.state.targets.find((x) => x.id === targetId)
    if (!t) return
    const l = this.liveOf(t.id)
    if (l.checking) return
    this.stopTarget(t.id)
    l.circuit = newCircuit()
    l.fails = 0
    if (!t.active) { t.active = true; l.error = undefined; l.fails = 0 }
    await this.look(t)
  }

  // ── events ──

  getEvents(targetId: string, filter?: string, limit = 50, before?: number): WatchdogEventView[] {
    let evts = this.state.events.filter((e) => e.targetId === targetId)
    if (filter && filter !== 'all') evts = evts.filter((e) => filter === 'flash' ? e.isFlash : e.kind === filter)
    if (before) evts = evts.filter((e) => e.at < before)
    return evts.slice(-limit).reverse() as WatchdogEventView[]
  }

  /** Forgets the found events (of one target or of all). What is known about the lists stays, so nothing is reported twice. */
  clearEvents(targetId?: string) {
    this.state.events = targetId ? this.state.events.filter((e) => e.targetId !== targetId) : []
    for (const [id, m] of this.state.memos) if (!targetId || id === targetId) m.removed = {}
    this.save()
    this.push()
  }

  markSeen() {
    const last = this.state.events[this.state.events.length - 1]?.at ?? 0
    if (this.state.seenAt >= last) return
    this.state.seenAt = last
    this.save()
    this.push()
  }

  setNotify(on: boolean) {
    this.state.notify = on
    this.save()
    this.push()
  }

  private trimEvents() {
    if (this.state.events.length > MAX_EVENTS) {
      this.state.events = this.state.events.slice(-MAX_EVENTS)
    }
  }

  // ── cleanup ──

  async cleanup(days: number) {
    const cutoff = Date.now() - days * 86_400_000
    this.state.events = this.state.events.filter((e) => e.at > cutoff)
    // delete old screenshots
    const base = shotsBase()
    if (existsSync(base)) {
      for (const tid of await readdir(base).catch(() => [])) {
        const dir = join(base, tid)
        for (const f of await readdir(dir).catch(() => [])) {
          const p = join(dir, f)
          const s = await stat(p).catch(() => null)
          if (s && s.mtimeMs < cutoff) await unlink(p).catch(() => {})
        }
      }
    }
    this.save()
    this.push()
  }

  /** Total size of screenshot folder in bytes. */
  async storageSize(): Promise<number> {
    const base = shotsBase()
    if (!existsSync(base)) return 0
    let total = 0
    for (const tid of await readdir(base).catch(() => [])) {
      const dir = join(base, tid)
      for (const f of await readdir(dir).catch(() => [])) {
        const s = await stat(join(dir, f)).catch(() => null)
        if (s) total += s.size
      }
    }
    return total
  }

  // ── export ──

  exportData(targetId: string, format: 'json' | 'csv'): string {
    const evts = this.state.events.filter((e) => e.targetId === targetId)
    if (format === 'json') return JSON.stringify(evts, null, 2)
    const header = 'time,kind,videoId,author,desc,duration_ms,isFlash,why,what,delta'
    const rows = evts.map((e) => [
      new Date(e.at).toISOString(), e.kind, e.videoId ?? '', e.meta?.author ?? '', `"${(e.meta?.desc ?? '').replace(/"/g, '""')}"`, e.duration ?? '', e.isFlash ? '1' : '', e.why ?? '', e.what ?? '', e.delta ?? ''
    ].join(','))
    return '﻿' + [header, ...rows].join('\n') // the mark makes Excel read the Russian text
  }

  // ── save ──

  save() { this.dirty = false; saveState(this.state) }

  /** Stop everything (app closing). */
  destroy() {
    this.stopAll()
    this.save()
  }
}
