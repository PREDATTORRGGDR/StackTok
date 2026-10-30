import { createHash } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ChatExportProgress } from '../shared/types'
import { HistoryPage, ImMessage, historyOf, historyRequest, parseHistory } from './chat-api'
import { ChatDump, ExportEntry, ExportMedia, Person } from './chat-export-html'
import { EntryContext, Fatal, PullResult, isHidden, pullHistory, textOf, toEntries } from './chat-history'

const MAX_FILE = 100 * 1024 * 1024 // one downloaded file
const INLINE_MAX = 1.5 * 1024 * 1024 // files up to this size go inside the page, bigger ones into the folder next to it
const INLINE_TOTAL = 120 * 1024 * 1024 // everything inside the page together (the page is one string)
const MAX_WAIT = 3 * 60 * 60 * 1000 // loading the history
const STALL = 120000 // a page that draws no frames for this long stops the export
const CHUNK = 250 // messages read per call into the page
const FETCHERS = 24
const RETRIES = 2

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface ExportCtl {
  cancelled(): boolean
  progress(p: ChatExportProgress): void
}

interface PageInfo { onMessages: boolean; hasChat: boolean; count: number; name: string; handle: string; height: number }
interface LoadStatus extends PageInfo { est: number; done: boolean; reason: string; rendering: boolean; busy: boolean; hint: string }
interface Prepared { total: number; messages: number; virtual: boolean }
interface ReadResult { entries: ExportEntry[]; lost: number }
interface PageArg { from?: number; to?: number; step?: string }

/**
 * Runs inside TikTok's messages page (isolated world): finds the open chat by the data-e2e hooks in
 * «Справочник DOM чатов TikTok» (AGENTS.md), scrolls it to load older messages and reads it.
 * It sends, clicks and changes nothing. Self-contained: it is stringified and evaluated in the page,
 * so it may not use anything from this file.
 */
async function chatPage(cmd: string, arg: PageArg = {}): Promise<unknown> {
  const ITEM = "[data-e2e='dm-new-chat-item']"
  const SEP = "[data-e2e='dm-new-time-separator']"
  const E = (n: string) => `[data-e2e='${n}']`
  const MAX = 25 * 1024 * 1024
  type St = { count: number; height: number; rendering: boolean; done: boolean; reason: string; cancel: boolean; busy: boolean; reversed: boolean; hint: string; items: Element[] }
  const w = window as unknown as { __st?: St }
  const list = document.querySelector<HTMLElement>(E('dm-new-message-list'))
  const textAt = (s: string) => (document.querySelector(s)?.textContent ?? '').trim()
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  // A page that is not drawing never fires the scroll that loads older messages: resolves false instead of hanging.
  const frame = () => new Promise<boolean>((res) => {
    let fin = false
    const t = setTimeout(() => { if (!fin) { fin = true; res(false) } }, 1500)
    requestAnimationFrame(() => { if (!fin) { fin = true; clearTimeout(t); res(true) } })
  })
  const scroller = (): HTMLElement | null => {
    if (!list) return null
    const box = document.querySelector(E('dm-new-chatbox'))
    const scrolls = (el: HTMLElement) => /(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1
    for (let el: HTMLElement | null = list; el; el = el.parentElement) {
      if (scrolls(el)) return el
      if (el === box) break
    }
    return [...list.querySelectorAll<HTMLElement>('div')].slice(0, 40).find(scrolls) ?? list
  }
  const count = () => (list ? list.querySelectorAll(ITEM).length : 0)
  const busy = () => !!document.querySelector(E('dm-new-chatbox'))?.querySelector("[aria-busy='true'], [role='progressbar'], [data-e2e*='loading']")
  /** A "load earlier messages" style control the exporter does not press: if one is there, the history may be longer than what scrolling loaded. */
  const loadMoreHint = () => {
    const re = /(earlier|older|previous|load more|show more|more messages|ранее|ещё|еще|загрузить|показать|предыдущ)/i
    for (const b of document.querySelector(E('dm-new-chatbox'))?.querySelectorAll<HTMLElement>("button, [role='button'], a") ?? []) {
      if (b.closest(ITEM) || b.closest(E('dm-new-chat-bottom'))) continue
      const t = (b.textContent ?? '').trim()
      if (t && t.length < 60 && re.test(t)) return t
    }
    return ''
  }
  /** Span of the rendered messages: far smaller than the scroll height means the list draws only a window of its messages. */
  const extent = () => {
    const nodes = list ? list.querySelectorAll(ITEM) : []
    if (!nodes.length) return 0
    const a = nodes[0].getBoundingClientRect(), b = nodes[nodes.length - 1].getBoundingClientRect()
    return Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top)
  }
  const virtual = (sc: HTMLElement | null) => {
    if (!sc) return false
    const ex = extent()
    return ex > 0 && sc.scrollHeight - ex > 1200 && ex < sc.scrollHeight * 0.5
  }
  const info = (): PageInfo => ({
    onMessages: /^\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?messages(?:\/|$)/.test(location.pathname),
    hasChat: !!document.querySelector(E('dm-new-chatbox')) && !!list,
    count: count(),
    name: textAt(E('dm-new-chat-nickname')),
    handle: textAt(E('chat-uniqueid')),
    height: scroller()?.scrollHeight ?? 0
  })

  if (cmd === 'info') return info()
  if (cmd === 'cancel') { if (w.__st) w.__st.cancel = true; return null }
  if (cmd === 'bottom') { const sc = scroller(); if (sc) sc.scrollTop = 1e9; return null } // a reversed list clamps this to its bottom too
  if (cmd === 'uid') { // the signed-in account's own user id, from the state TikTok embeds in the page ('' when it is not there)
    try {
      const t = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__')?.textContent
      const u = t ? (JSON.parse(t) as { __DEFAULT_SCOPE__?: Record<string, { user?: { uid?: string; id?: string } } | undefined> }).__DEFAULT_SCOPE__?.['webapp.app-context']?.user : undefined
      return String(u?.uid ?? u?.id ?? '')
    } catch { return '' }
  }

  if (cmd === 'status') {
    const st = w.__st
    if (!st) return null
    const i = info()
    const ex = virtual(scroller()) ? extent() : 0
    return { ...i, est: ex ? Math.round(i.count * (i.height / ex)) : i.count, done: st.done, reason: st.reason, rendering: st.rendering, busy: st.busy, hint: st.hint }
  }

  if (cmd === 'start') {
    if (!list) return null
    if (w.__st && !w.__st.done) w.__st.cancel = true
    const st: St = { count: count(), height: 0, rendering: true, done: false, reason: '', cancel: false, busy: false, reversed: false, hint: '', items: [] }
    w.__st = st
    void (async () => {
      let wake: (() => void) | null = null
      const mo = new MutationObserver(() => wake?.())
      mo.observe(list, { childList: true, subtree: true })
      const nap = (ms: number) => new Promise<void>((res) => {
        const t = setTimeout(() => { wake = null; res() }, ms)
        wake = () => { clearTimeout(t); wake = null; res() }
      })
      const meas = () => ({ n: count(), h: scroller()?.scrollHeight ?? 0 })
      try {
        let cur = meas()
        let quiet = 2500 // until a load has been seen, be patient with a slow first answer
        let still = 0
        let busyFor = 0
        while (!st.cancel) {
          const sc = scroller()
          if (!sc || !list.isConnected) { st.reason = 'gone'; return }
          if (!(await frame())) { st.rendering = false; await sleep(200); continue }
          st.rendering = true
          if (still > 0) { sc.scrollTop = 120; await frame() } // leave the top and come back so the page's own "load older" trigger fires again
          sc.scrollTop = -1e9 // clamps to the top in a normal list and a reversed one
          const at = Date.now()
          let changed = false
          while (!st.cancel && Date.now() - at < quiet) {
            await nap(Math.min(250, quiet - (Date.now() - at)))
            const m = meas()
            if (m.n !== cur.n || m.h !== cur.h) {
              if (m.n > cur.n || m.h > cur.h) quiet = Math.min(10000, Math.max(1200, 3 * (Date.now() - at))) // wait three times as long as the slowest answer seen
              cur = m
              st.count = m.n
              st.height = m.h
              changed = true
              break
            }
            await sleep(30)
          }
          if (changed) { still = 0; busyFor = 0; continue }
          st.busy = busy()
          if (st.busy && busyFor < 60000) { busyFor += quiet; continue }
          if (++still >= 2) break // two quiet windows in a row, the second after leaving and re-entering the top
        }
        st.hint = loadMoreHint()
        st.reason = st.cancel ? 'cancel' : 'complete'
      } catch {
        st.reason = 'error'
      } finally {
        mo.disconnect()
        st.done = true
      }
    })()
    return null
  }

  // ----- reading -----
  if (cmd === 'prepare') {
    const nodes = list ? [...list.querySelectorAll(`${SEP}, ${ITEM}`)] : []
    const keyed = nodes.map((n, i) => ({ n, i, y: n.getBoundingClientRect().top }))
    // Visual order, not DOM order: a reversed list keeps its newest message first in the DOM.
    if (!keyed.every((k) => k.y === keyed[0].y)) keyed.sort((a, b) => a.y - b.y || a.i - b.i)
    const st = (w.__st ??= { count: 0, height: 0, rendering: true, done: true, reason: '', cancel: false, busy: false, reversed: false, hint: '', items: [] })
    st.items = keyed.map((k) => k.n)
    return { total: nodes.length, messages: nodes.filter((n) => n.matches(ITEM)).length, virtual: virtual(scroller()) }
  }
  if (cmd === 'scan') {
    const sc = scroller()
    const st = w.__st
    if (!sc || !st) return { atBottom: true, pos: 0 }
    if (arg.step === 'top') { sc.scrollTop = -1e9; st.reversed = sc.scrollTop < 0 }
    else sc.scrollTop = sc.scrollTop + Math.max(80, Math.round(sc.clientHeight * 0.5))
    await frame()
    await sleep(120)
    await frame()
    const atBottom = st.reversed ? sc.scrollTop >= -2 : sc.scrollTop >= sc.scrollHeight - sc.clientHeight - 2
    return { atBottom, pos: sc.scrollTop }
  }

  const toData = async (u: string) => {
    try {
      const b = await (await fetch(u)).blob()
      if (b.size > MAX) return undefined
      return await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(b) })
    } catch { return undefined }
  }
  const absUrl = (u: string | null) => { try { const x = new URL(u ?? '', location.href); return /^https?:$/.test(x.protocol) ? x.href : '' } catch { return '' } }
  const textOf = (root: Node): string => {
    let out = ''
    const walk = (n: Node) => {
      if (n.nodeType === 3) { out += n.nodeValue ?? ''; return }
      if (n.nodeType !== 1) return
      const el = n as HTMLElement
      const tag = el.tagName.toLowerCase()
      if (tag === 'script' || tag === 'style' || tag === 'svg' || tag === 'canvas') return
      if (tag === 'img') { out += (el as HTMLImageElement).alt || ''; return } // emoji are often images with the emoji as alt
      if (tag === 'br') { out += '\n'; return }
      const block = tag === 'p' || tag === 'div'
      if (block && out && !out.endsWith('\n')) out += '\n'
      el.childNodes.forEach(walk)
      if (block && !out.endsWith('\n')) out += '\n'
    }
    walk(root)
    return out.replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  }
  const outline = (el: Element, left = { n: 70 }, depth = 0): string => {
    if (left.n-- <= 0 || depth > 7) return ''
    const e2e = el.getAttribute('data-e2e')
    const kids = [...el.children].map((c) => outline(c, left, depth + 1)).filter(Boolean).join(' ')
    return el.tagName.toLowerCase() + (e2e ? `[${e2e}]` : '') + (kids ? `(${kids})` : '')
  }
  const media = async (kind: 'image' | 'sticker' | 'video' | 'audio', src: string, extra: Partial<ExportMedia> = {}): Promise<ExportMedia> => {
    const m: ExportMedia = { kind, src, ...extra }
    if (src.startsWith('blob:')) { m.data = await toData(src); m.src = '' }
    else if (src.startsWith('data:')) { m.data = src.length <= MAX * 1.4 ? src : undefined; m.src = '' }
    else m.src = absUrl(src)
    if (m.src === '' && !m.data) m.note = 'источник недоступен'
    return m
  }

  if (cmd === 'header') {
    const head = document.querySelector(E('top-chat-avatar'))
    const hi = head instanceof HTMLImageElement ? head : head?.querySelector('img')
    const partner: Person = {
      name: textAt(E('dm-new-chat-nickname')), handle: textAt(E('chat-uniqueid')) || undefined,
      avatar: hi && (hi.currentSrc || hi.src) ? await media('image', hi.currentSrc || hi.src) : undefined
    }
    return partner
  }

  // cmd === 'read': messages from..to of the prepared list, in visual order
  const inButton = (el: Element) => !!el.closest("[data-e2e*='-btn'], button")
  const TIME = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp][Mm])?\b/
  const timeOf = (item: Element, bubbles: Element[]): string | undefined => {
    const t = item.querySelector('time')
    if (t) return t.getAttribute('datetime') || t.textContent?.trim() || undefined
    for (const el of [item, ...item.querySelectorAll('[title],[aria-label],[datetime],[data-time]')]) {
      for (const a of ['datetime', 'data-time', 'title', 'aria-label']) {
        const v = el.getAttribute(a)
        if (v && v.length <= 60 && TIME.test(v)) return v
      }
    }
    const tw = document.createTreeWalker(item, NodeFilter.SHOW_TEXT)
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const v = (n.nodeValue ?? '').trim()
      if (v.length <= 12 && /^\d{1,2}:\d{2}(\s?[AaPp][Mm])?$/.test(v) && !bubbles.some((b) => b.contains(n))) return v
    }
  }

  const items = (w.__st?.items ?? []).slice(arg.from ?? 0, arg.to ?? 0)
  const lr = list?.getBoundingClientRect()
  const entries: ExportEntry[] = []
  let lost = 0
  for (const item of items) {
    if (!item.isConnected) { lost++; continue }
    if (item.matches(SEP)) { entries.push({ sep: textOf(item) }); continue }
    if (item.parentElement?.closest(ITEM)) continue // nested duplicate of the same message
    try {
      const bubbles = [...item.querySelectorAll(E('dm-new-message-text'))].filter((b, _i, all) => !all.some((o) => o !== b && o.contains(b)))
      const shared = item.querySelector(E('dm-new-shared-video'))
      const outside = (el: Element) => !bubbles.some((b) => b.contains(el)) && !(shared && shared.contains(el)) && !inButton(el) && !el.closest("[data-e2e*='avatar']")
      const text = bubbles.map(textOf).filter(Boolean).join('\n')

      const links: { href: string; text: string }[] = []
      for (const a of item.querySelectorAll('a[href]')) {
        const href = absUrl(a.getAttribute('href'))
        if (href && !inButton(a) && !links.some((l) => l.href === href)) links.push({ href, text: textOf(a).slice(0, 200) })
      }

      const found: ExportMedia[] = []
      const seen = new Set<string>()
      const add = async (kind: 'image' | 'sticker' | 'video' | 'audio', src: string, extra: Partial<ExportMedia> = {}) => {
        if (!src || seen.has(src)) return
        seen.add(src)
        found.push(await media(kind, src, extra))
      }
      for (const img of item.querySelectorAll('img')) {
        if (!outside(img)) continue // emoji inside text bubbles are already part of the text
        const src = img.currentSrc || img.src
        const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height
        const sticker = /sticker|emoji|emote|gif/i.test(src) || (!img.alt && Math.max(iw, ih) > 0 && Math.max(iw, ih) <= 220 && Math.abs(iw - ih) <= Math.max(iw, ih) * 0.25)
        await add(sticker ? 'sticker' : 'image', src, { alt: img.alt || undefined, width: iw || undefined, height: ih || undefined })
      }
      for (const c of item.querySelectorAll('canvas')) {
        if (!outside(c)) continue
        try { const d = (c as HTMLCanvasElement).toDataURL('image/png'); if (d.length > 200) await add('sticker', d, { width: c.width, height: c.height }) } catch { /* tainted canvas: not readable */ }
      }
      for (const v of item.querySelectorAll<HTMLMediaElement>('video, audio')) {
        if (!outside(v)) continue
        const src = v.currentSrc || v.src || v.querySelector('source')?.src || ''
        await add(v.tagName === 'VIDEO' ? 'video' : 'audio', src, { alt: (v as HTMLVideoElement).poster || undefined })
      }
      if (!found.length && !text && !shared) { // a picture drawn as a CSS background: only worth looking for when nothing else was found
        for (const el of [item, ...item.querySelectorAll<HTMLElement>('div, span, i')].slice(0, 40)) {
          if (!outside(el)) continue
          const m = /url\((["']?)(.+?)\1\)/.exec(getComputedStyle(el).backgroundImage)
          if (m && !/^data:image\/svg/.test(m[2])) await add('image', m[2])
        }
      }

      let video: { href?: string; text: string; cover?: ExportMedia } | undefined
      if (shared) {
        const a = shared.closest('a[href]') ?? shared.querySelector('a[href]') ?? item.querySelector('a[href]')
        const cover = shared.querySelector('img') ?? undefined
        const poster = shared.querySelector('video')?.poster
        let src = cover ? cover.currentSrc || cover.src : poster || ''
        if (!src) { // the preview may be a CSS background
          for (const el of [shared, ...shared.querySelectorAll<HTMLElement>('div, span, i')].slice(0, 30)) {
            const m = /url\((["']?)(.+?)\1\)/.exec(getComputedStyle(el).backgroundImage)
            if (m && !/^data:image\/svg/.test(m[2])) { src = m[2]; break }
          }
        }
        video = {
          href: a ? absUrl(a.getAttribute('href')) || undefined : undefined,
          text: textOf(shared),
          cover: src ? await media('image', src, { alt: cover?.alt || undefined }) : undefined
        }
      }

      const reply = [...item.querySelectorAll("[data-e2e*='reply']")].find((r) => !/btn/.test(r.getAttribute('data-e2e') ?? ''))
      const reactions = [...item.querySelectorAll("[data-e2e*='reaction']")].filter((r) => !/btn/.test(r.getAttribute('data-e2e') ?? '')).map(textOf).filter(Boolean)

      // Who wrote it: own messages sit on the right of the list, the other person's on the left.
      const anchor = bubbles[0] ?? item.querySelector('img, video') ?? item
      const r = anchor.getBoundingClientRect()
      const side = lr && lr.width > 0 && r.width > 0 ? (r.left + r.width / 2 > lr.left + lr.width / 2 ? 'me' : 'them') : 'unknown'
      const nick = item.querySelector("[data-e2e*='nickname'], [data-e2e*='username'], [data-e2e*='uniqueid']")
      const raw = textOf(item).slice(0, 4000)

      entries.push({
        side, author: nick ? textOf(nick).slice(0, 120) || undefined : undefined, time: timeOf(item, bubbles), text, links, media: found, video,
        reply: reply ? textOf(reply) || undefined : undefined,
        reactions, rawText: raw === text ? '' : raw, outline: outline(item).slice(0, 600)
      })
    } catch {
      // One odd message must never lose the others: keep whatever text it has.
      entries.push({ side: 'unknown', text: '', links: [], media: [], reactions: [], rawText: textOf(item).slice(0, 4000), outline: 'ошибка чтения' })
    }
  }
  return { entries, lost }
}

const run = <T>(wc: Electron.WebContents, cmd: string, arg?: PageArg): Promise<T> =>
  wc.executeJavaScriptInIsolatedWorld(997, [{ code: `(${chatPage.toString()})(${JSON.stringify(cmd)}, ${JSON.stringify(arg ?? {})})` }]) as Promise<T>

/** Reads the chat that is open in the account's view. Throws a user-facing message if there is none. */
export async function chatInfo(wc: Electron.WebContents) {
  const i = await run<PageInfo>(wc, 'info').catch(() => undefined)
  if (!i?.onMessages || !i.hasChat) throw new Error('Откройте диалог на странице «Чаты» этого аккаунта и повторите.')
  return i
}

const isMsg = (e: ExportEntry) => !('sep' in e)

// ----- the fast way: TikTok's own history requests, many pages at once -----
// The page loads older messages one small page at a time, each a full round trip to TikTok's IM server. Once the page has made
// its first such request, that request is the template for ours: same envelope and headers, other anchor and size, sent from
// the account's session (its cookies) in parallel. The slow way (scrolling) stays as the fallback for anything unexpected.

const ORIGIN = 'https://www.tiktok.com'
const FAST_WORKERS = 12

/** What the page itself sent to load older messages. */
interface Template { url: string; body: Uint8Array; headers: Record<string, string> }
interface Watch { template(): Template | undefined; stop(): void }
interface Fast { state: 'wait' | 'run' | 'done' | 'dead'; out?: PullResult; ctx?: EntryContext; notes: string[]; restarted: boolean; stopped?: string }

/** Watches the page's own network traffic (devtools protocol) for its first request for older messages of a conversation. */
async function watchTemplate(wc: Electron.WebContents): Promise<Watch> {
  const dbg = wc.debugger
  let found: Template | undefined
  let mine = false
  const onMessage = (_e: Electron.Event, method: string, params: unknown) => {
    const r = (params as { request?: { url: string; method: string; headers: Record<string, string>; postDataEntries?: { bytes?: string }[] } }).request
    if (found || method !== 'Network.requestWillBeSent' || !r || r.method !== 'POST' || !/\/v1\/message\/get_by_conversation(\?|$)/.test(r.url)) return
    const parts = (r.postDataEntries ?? []).flatMap((x) => (x.bytes ? [Buffer.from(x.bytes, 'base64')] : []))
    if (parts.length) found = { url: r.url.split('?')[0], body: new Uint8Array(Buffer.concat(parts)), headers: r.headers }
  }
  const stop = () => {
    dbg.removeListener('message', onMessage)
    if (mine && dbg.isAttached()) { dbg.sendCommand('Network.disable').catch(() => {}); dbg.detach() }
  }
  try {
    if (!dbg.isAttached()) { dbg.attach('1.3'); mine = true }
    dbg.on('message', onMessage)
    await dbg.sendCommand('Network.enable')
  } catch { // somebody else is debugging this page: the slow way still works
    stop()
    return { template: () => undefined, stop: () => {} }
  }
  return { template: () => found, stop }
}

/**
 * Our own requests for older messages: the page's request with another anchor, sent from the account's session.
 * The main process goes first (no preflight, no page in the way); if TikTok refuses it for any reason, the requests are made
 * from inside the page instead, exactly like its own (this way was measured on a live account).
 */
function pageAsk(wc: Electron.WebContents, tpl: Template): (anchor: bigint, limit: number) => Promise<HistoryPage> {
  const first = historyOf(tpl.body)
  if (!first) throw new Error('the page request is not a history request')
  const headers: Record<string, string> = { origin: ORIGIN }
  for (const [k, v] of Object.entries(tpl.headers)) if (!/^(cookie|content-length|host|connection|accept-encoding|origin)$/i.test(k)) headers[k] = v
  let seq = 40000 + Math.floor(Math.random() * 1000)
  let inPage = false

  const direct = async (body: Uint8Array<ArrayBuffer>) => {
    const res = await wc.session.fetch(tpl.url, { method: 'POST', body, headers, credentials: 'include', signal: AbortSignal.timeout(60000) })
    return { status: res.status, data: new Uint8Array(await res.arrayBuffer()) }
  }
  const fromPage = async (body: Uint8Array) => {
    const r = (await wc.executeJavaScript(`(async () => {
      const bin = Uint8Array.from(atob(${JSON.stringify(Buffer.from(body).toString('base64'))}), (c) => c.charCodeAt(0))
      const r = await fetch(${JSON.stringify(tpl.url)}, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/x-protobuf', accept: 'application/x-protobuf' }, body: bin })
      const buf = new Uint8Array(await r.arrayBuffer())
      let s = ''
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000))
      return { status: r.status, b64: btoa(s) }
    })()`)) as { status: number; b64: string }
    return { status: r.status, data: new Uint8Array(Buffer.from(r.b64, 'base64')) }
  }

  return async (anchor, limit) => {
    const body = new Uint8Array(historyRequest(tpl.body, { conv: first.conv, direction: first.direction, anchor, limit: BigInt(limit) }, ++seq))
    if (!inPage) {
      try {
        const r = await direct(body)
        if (r.status === 200) { const p = parseHistory(r.data); if (p.status === 0) return p }
      } catch { /* refused or unreachable from the main process */ }
      inPage = true
    }
    const r = await fromPage(body)
    if (r.status === 429 || r.status === 403) throw new Fatal('HTTP ' + r.status) // TikTok says stop: nothing is repeated
    if (r.status !== 200) throw new Error('HTTP ' + r.status)
    return parseHistory(r.data)
  }
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * The pulled messages must be the chat that is open: some of the last ones have to match what the page shows.
 * Also works out which sender is the account itself (from the page's state, or by comparing with the messages the page shows).
 */
async function checkFast(wc: Electron.WebContents, messages: ImMessage[]): Promise<{ ctx: EntryContext; notes: string[] }> {
  const prep = await run<Prepared>(wc, 'prepare')
  const tail = await run<ReadResult>(wc, 'read', { from: Math.max(0, prep.total - 16), to: prep.total })
  const shown = tail.entries.flatMap((e) => (isMsg(e) && 'text' in e && norm(e.text) ? [e] : []))
  const byText = new Map<string, ImMessage>()
  for (const m of messages.slice(-150)) { const t = norm(textOf(m)); if (t) byText.set(t, m) }
  if (shown.length && !shown.some((e) => byText.has(norm(e.text)))) throw new Error('последние сообщения не совпали с тем, что видно на странице')
  const own = await run<string>(wc, 'uid').catch(() => '')
  if (own && messages.some((m) => String(m.sender) === own)) return { ctx: { own }, notes: [] }
  const sides = new Map<string, 'me' | 'them'>()
  for (const e of shown) {
    const m = byText.get(norm(e.text))
    if (m && 'side' in e && e.side !== 'unknown') sides.set(String(m.sender), e.side)
  }
  const senders = new Set(messages.map((m) => String(m.sender)))
  if (senders.size === 2 && sides.size === 1) {
    const [id, side] = [...sides][0]
    for (const s of senders) if (s !== id) sides.set(s, side === 'me' ? 'them' : 'me')
  }
  return { ctx: { sides }, notes: sides.size ? [] : ['Не удалось определить, какие сообщения ваши: стороны в файле не различаются.'] }
}

/** Pulls the whole conversation from TikTok directly and checks it against the page. */
async function pullFast(wc: Electron.WebContents, tpl: Template, ctl: ExportCtl): Promise<{ out: PullResult; ctx: EntryContext; notes: string[] }> {
  const out = await pullHistory(pageAsk(wc, tpl), { concurrency: FAST_WORKERS, cancelled: () => ctl.cancelled(), progress: (n) => ctl.progress({ phase: 'loading', done: n }) })
  if (!out.messages.length) throw new Error('история пришла пустой')
  return { out, ...(await checkFast(wc, out.messages)) }
}

/** What identifies a message when two reads of the page overlap. */
function signature(e: ExportEntry): string {
  if ('sep' in e) return 's:' + e.sep
  const m = (x: ExportMedia) => x.src || (x.data ? x.data.length + x.data.slice(-32) : '')
  return JSON.stringify([e.side, e.author, e.time, e.text, e.media.map(m), e.video?.href, e.video?.text, e.rawText, e.reply])
}

/**
 * Appends one window of a virtualized list to what was read so far: the window's leading entries that repeat the
 * end of the list are skipped. `gap` means there was no overlap at all, so something in between may be missing.
 */
export function appendWindow(acc: ExportEntry[], chunk: ExportEntry[]): { added: number; gap: boolean } {
  if (!chunk.length) return { added: 0, gap: false }
  const had = acc.length
  const a = acc.slice(-chunk.length).map(signature)
  const c = chunk.map(signature)
  let k = Math.min(a.length, c.length)
  for (; k > 0; k--) {
    let same = true
    for (let j = 0; j < k && same; j++) same = a[a.length - k + j] === c[j]
    if (same) break
  }
  const fresh = chunk.slice(k)
  acc.push(...fresh)
  return { added: fresh.length, gap: had > 0 && k === 0 }
}

/**
 * Loads the whole history, then reads every message. The page is told to scroll itself (no round trip per step),
 * so loading runs as fast as TikTok answers. The page must be drawing frames: otherwise nothing loads, and a quiet page
 * would look like the beginning of the chat; such a page is never counted as finished.
 */
export async function collectChat(wc: Electron.WebContents, ctl: ExportCtl): Promise<{ partner: Person; entries: ExportEntry[]; complete: boolean; warnings: string[] }> {
  const watch = await watchTemplate(wc)
  try { return await collectLoaded(wc, ctl, watch) } finally { watch.stop() }
}

async function collectLoaded(wc: Electron.WebContents, ctl: ExportCtl, watch: Watch): Promise<{ partner: Person; entries: ExportEntry[]; complete: boolean; warnings: string[] }> {
  const first = await chatInfo(wc)
  const key = first.name + '|' + first.handle
  const warnings: string[] = []
  const started = Date.now()
  const stop = async (msg: string): Promise<never> => { await run(wc, 'cancel').catch(() => {}); throw new Error(msg) }
  let stalled = 0
  let complete = false
  let peak = 0
  let est = 0

  const fast: Fast = { state: 'wait', notes: [], restarted: false }
  await run(wc, 'start')
  for (;;) {
    await sleep(300)
    if (ctl.cancelled()) await stop('Экспорт отменён.')
    if (wc.isDestroyed()) throw new Error('Страница закрыта, экспорт остановлен.')
    const s = await run<LoadStatus | null>(wc, 'status').catch(() => null)
    if (!s) throw new Error('Страница перезагрузилась во время экспорта, он остановлен.')
    if (!s.onMessages || !s.hasChat || s.name + '|' + s.handle !== key) await stop('Диалог сменился во время экспорта, он остановлен.')
    if (fast.state === 'wait') {
      const tpl = watch.template()
      if (tpl) { // the page asked TikTok for older messages: its request is the template for ours
        fast.state = 'run'
        await run(wc, 'cancel').catch(() => {}) // the page stops scrolling, our own requests take over
        void pullFast(wc, tpl, ctl).then(
          (r) => { fast.out = r.out; fast.ctx = r.ctx; fast.notes.push(...r.notes); fast.state = 'done' },
          (e: unknown) => {
            if (e instanceof Fatal) fast.stopped = `TikTok ограничил запросы (${e.message}). Экспорт остановлен: подождите несколько минут и повторите.`
            else if (e instanceof Error && e.message === 'cancelled') fast.stopped = 'Экспорт отменён.'
            else fast.notes.push(`Быстрая загрузка не сработала (${e instanceof Error ? e.message : 'ошибка'}), история загружена обычным способом.`)
            fast.state = 'dead'
          }
        )
      }
    }
    if (fast.state === 'run') continue
    if (fast.state === 'done') break
    if (fast.state === 'dead' && fast.stopped) await stop(fast.stopped) // TikTok said stop: scrolling would only ask it again
    if (fast.state === 'dead' && !fast.restarted) { fast.restarted = true; await run(wc, 'start'); continue } // back to scrolling
    peak = Math.max(peak, s.count)
    est = Math.max(est, s.est)
    ctl.progress({ phase: 'loading', done: est })
    if (s.done) {
      if (s.reason === 'complete') complete = true
      else if (s.reason !== 'cancel') throw new Error('Список сообщений пропал со страницы (' + s.reason + '), экспорт остановлен.')
      if (s.hint) { complete = false; warnings.push(`На странице есть кнопка «${s.hint}»: она не нажималась, история может быть длиннее, чем загрузилось прокруткой.`) }
      break
    }
    if (s.rendering) stalled = 0
    else {
      stalled ||= Date.now()
      if (Date.now() - stalled > STALL) await stop('Экспорт остановлен: страница не отрисовывается, старые сообщения не подгружаются. Откройте чат на странице «Обзор» и запустите снова.')
    }
    if (Date.now() - started > MAX_WAIT) {
      await run(wc, 'cancel').catch(() => {})
      warnings.push('Загрузка истории остановлена по времени (3 часа): в файл попало то, что успело загрузиться.')
      break
    }
  }

  if (fast.state === 'done' && fast.out) {
    const partner = await run<Person>(wc, 'header')
    await run(wc, 'bottom').catch(() => {})
    const hidden = fast.out.messages.filter(isHidden).length
    if (hidden) fast.notes.push(`Служебных записей TikTok пропущено: ${hidden} (в чате их не видно).`)
    return { partner, entries: toEntries(fast.out.messages, fast.ctx ?? {}), complete: true, warnings: fast.notes }
  }

  // ----- reading -----
  const readAll = async (total: number): Promise<ReadResult> => {
    const entries: ExportEntry[] = []
    let lost = 0
    for (let from = 0; from < total; from += CHUNK) {
      if (ctl.cancelled()) throw new Error('Экспорт отменён.')
      const r = await run<ReadResult>(wc, 'read', { from, to: Math.min(total, from + CHUNK) })
      entries.push(...r.entries)
      lost += r.lost
      ctl.progress({ phase: 'reading', done: Math.min(total, from + CHUNK), total })
    }
    return { entries, lost }
  }

  const partner = await run<Person>(wc, 'header')
  let prep = await run<Prepared>(wc, 'prepare')
  let entries: ExportEntry[] = []
  const windowed = prep.virtual || (peak > 0 && prep.messages < peak * 0.98)
  if (!windowed) {
    let r = await readAll(prep.total)
    if (r.lost) { // TikTok redrew part of the list while it was being read: read it once more
      prep = await run<Prepared>(wc, 'prepare')
      r = await readAll(prep.total)
      if (r.lost) warnings.push(`Во время чтения TikTok перерисовал часть списка: не удалось прочитать элементов — ${r.lost}.`)
    }
    entries = r.entries
  } else {
    // The list draws only a window of its messages: walk down it from the top and join the windows.
    let gaps = 0
    let stuck = 0
    let lastPos = NaN
    await run(wc, 'scan', { step: 'top' })
    for (;;) {
      if (ctl.cancelled()) throw new Error('Экспорт отменён.')
      prep = await run<Prepared>(wc, 'prepare')
      const r = await readAll(prep.total)
      if (appendWindow(entries, r.entries).gap) gaps++
      ctl.progress({ phase: 'reading', done: entries.filter(isMsg).length })
      const step = await run<{ atBottom: boolean; pos: number }>(wc, 'scan', { step: 'down' })
      stuck = step.pos === lastPos ? stuck + 1 : 0
      lastPos = step.pos
      if (step.atBottom || stuck >= 3) {
        prep = await run<Prepared>(wc, 'prepare')
        const last = await readAll(prep.total)
        if (appendWindow(entries, last.entries).gap) gaps++
        break
      }
    }
    if (gaps) warnings.push(`Список показывает сообщения окном, и в ${gaps} местах окна не перекрылись: между ними возможны пропуски.`)
  }
  await run(wc, 'bottom').catch(() => {})

  const got = entries.filter(isMsg).length
  if (!got) warnings.push('Сообщения в диалоге не найдены (возможно, TikTok изменил разметку).')
  if (!complete && !warnings.length) warnings.push('Начало переписки не подтверждено.')
  return { partner, entries, complete: complete && got > 0 && !warnings.length, warnings: [...warnings, ...fast.notes] }
}

const publicHttps = (u: string, devOrigin?: string) => {
  try {
    const x = new URL(u)
    if (devOrigin && x.origin === devOrigin) return true
    const h = x.hostname
    return x.protocol === 'https:' && h.includes('.') && !/^[\d.]+$/.test(h) && !h.includes(':') && !/(^|\.)(localhost|local|internal|lan|home|corp)$/i.test(h)
  } catch {
    return false
  }
}

/** File type by its first bytes, not by what the server says. Only formats a browser can show. */
export function sniff(b: Buffer): { mime: string; ext: string } | undefined {
  const s = (o: number, n: number) => b.toString('latin1', o, o + n)
  if (b.length < 12) return
  if (b[0] === 0x89 && s(1, 3) === 'PNG') return { mime: 'image/png', ext: 'png' }
  if (b[0] === 0xff && b[1] === 0xd8) return { mime: 'image/jpeg', ext: 'jpg' }
  if (s(0, 3) === 'GIF') return { mime: 'image/gif', ext: 'gif' }
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP') return { mime: 'image/webp', ext: 'webp' }
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WAVE') return { mime: 'audio/wav', ext: 'wav' }
  if (s(4, 4) === 'ftyp') {
    const brand = s(8, 4)
    if (/^avi[fs]$/.test(brand)) return { mime: 'image/avif', ext: 'avif' }
    if (brand === 'M4A ' || brand === 'M4B ') return { mime: 'audio/mp4', ext: 'm4a' }
    return { mime: 'video/mp4', ext: 'mp4' }
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { mime: 'video/webm', ext: 'webm' }
  if (s(0, 4) === 'OggS') return { mime: 'audio/ogg', ext: 'ogg' }
  if (s(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { mime: 'audio/mpeg', ext: 'mp3' }
}

/**
 * Saves every picture, sticker, cover and sound once. Small files go inside the page, big ones into a folder next to it,
 * so nothing is dropped for being large. Downloads are retried; whatever still fails keeps a note and its original link.
 */
export async function embedMedia(
  dump: ChatDump, ses: Electron.Session, ctl: ExportCtl,
  opt: { dir: string; folder: string; devOrigin?: string }
): Promise<{ saved: number; failed: number; files: number }> {
  const all: ExportMedia[] = []
  const take = (m?: ExportMedia) => { if (m) all.push(m) }
  take(dump.partner.avatar)
  take(dump.owner.avatar)
  for (const e of dump.entries) if (!('sep' in e)) { e.media.forEach(take); take(e.video?.cover) }

  let saved = 0, failed = 0, files = 0, inline = 0
  const fail = (ms: ExportMedia[], note: string) => { failed++; ms.forEach((m) => (m.note ??= note)) }
  const settle = async (ms: ExportMedia[], buf: Buffer) => {
    const t = sniff(buf)
    if (!t) return fail(ms, 'неизвестный формат файла')
    for (const m of ms) {
      if (t.mime.startsWith('video/')) { m.animated = m.kind !== 'video'; m.kind = 'video' } // animated stickers and GIFs often come as mp4
      else if (t.mime.startsWith('audio/')) m.kind = 'audio'
    }
    if (buf.length <= INLINE_MAX && inline + buf.length <= INLINE_TOTAL) {
      inline += buf.length
      const d = `data:${t.mime};base64,${buf.toString('base64')}`
      ms.forEach((m) => { m.data = d })
    } else {
      const name = `${createHash('sha1').update(buf).digest('hex')}.${t.ext}`
      await mkdir(opt.dir, { recursive: true })
      const full = join(opt.dir, name)
      if (!(await access(full).then(() => true, () => false))) await writeFile(full, buf)
      ms.forEach((m) => { m.file = `${opt.folder}/${name}`; m.data = undefined })
      files++
    }
    saved++
  }

  // files the page already handed over as data (blob: sources)
  for (const m of all) {
    if (!m.data) continue
    const x = /^data:[^;,]*;base64,(.*)$/s.exec(m.data)
    m.data = undefined
    if (x) await settle([m], Buffer.from(x[1], 'base64'))
    else fail([m], 'формат данных не поддерживается')
  }

  const bySrc = new Map<string, ExportMedia[]>()
  for (const m of all) if (m.src && !m.data && !m.file) bySrc.set(m.src, [...(bySrc.get(m.src) ?? []), m])
  const urls = [...bySrc.keys()]
  let done = 0
  const get = async (url: string): Promise<Buffer | string> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await ses.fetch(url, { credentials: 'omit', signal: AbortSignal.timeout(300000) })
        if (res.status === 429 || res.status >= 500) throw new Error('transient')
        if (!res.ok || !res.body) return `ответ ${res.status}`
        const chunks: Uint8Array[] = []
        let size = 0
        const reader = res.body.getReader()
        for (;;) {
          const { done: end, value } = await reader.read()
          if (end) break
          size += value.length
          if (size > MAX_FILE) { await reader.cancel(); return 'файл больше 100 МБ' }
          chunks.push(value)
        }
        return Buffer.concat(chunks)
      } catch {
        if (attempt >= RETRIES) return 'не удалось скачать'
        await sleep(400 * 3 ** attempt)
      }
    }
  }
  const queue = [...urls]
  const worker = async () => {
    for (let u = queue.shift(); u !== undefined; u = queue.shift()) {
      if (ctl.cancelled()) return
      const targets = bySrc.get(u)!
      if (!publicHttps(u, opt.devOrigin)) fail(targets, 'адрес не поддерживается')
      else {
        const got = await get(u)
        if (typeof got === 'string') fail(targets, got)
        else await settle(targets, got)
      }
      ctl.progress({ phase: 'media', done: ++done, total: urls.length })
    }
  }
  ctl.progress({ phase: 'media', done: 0, total: urls.length })
  await Promise.all(Array.from({ length: FETCHERS }, worker))
  if (ctl.cancelled()) throw new Error('Экспорт отменён.')
  return { saved, failed, files }
}
