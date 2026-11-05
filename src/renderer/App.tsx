import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Copy, Download, Globe, Layers, LayoutGrid, Minus, Plus, Settings as Cog, Sparkles, Square, Users, X } from 'lucide-react'
import { ACCENT_COLORS, BG_SOLID } from '@shared/types'
import { AppState, call, toast, useAppState, useToasts } from './api'
import { Dialog, Dialogs } from './Dialogs'
import { Accounts } from './pages/Accounts'
import { ToolsPage } from './pages/Tools'
import { Browse, progressText } from './pages/Browse'
import { DownloaderPage } from './pages/Downloader'
import { SettingsPage } from './pages/Settings'
import { Avatar } from './ui'

export type Page = 'accounts' | 'browse' | 'tools' | 'downloader' | 'settings'
const TITLES: Record<Page, string> = { accounts: 'Аккаунты', browse: 'Обзор', tools: 'Инструменты', downloader: 'Загрузчик', settings: 'Настройки' }

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const mix = (c: number[], to: number, t: number) => c.map((v) => Math.round(v + (to - v) * t))
const toHex = (c: number[]) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')

function WinControls({ maximized }: { maximized: boolean }) {
  return (
    <div className="winctl">
      <button aria-label="Свернуть" title="Свернуть" onClick={() => call('win:min')}><Minus size={15} /></button>
      <button aria-label={maximized ? 'Восстановить' : 'Развернуть'} title={maximized ? 'Восстановить' : 'Развернуть'} onClick={() => call('win:max')}>{maximized ? <Copy size={13} /> : <Square size={12} />}</button>
      <button className="close" aria-label="Закрыть" title="Закрыть" onClick={() => call('win:close')}><X size={16} /></button>
    </div>
  )
}

/** Applies theme, accent, background and glass strength to the document. */
function useAppearance(s: AppState | null) {
  const set = s?.settings
  useEffect(() => {
    if (!set) return
    const mq = matchMedia('(prefers-color-scheme: light)')
    const apply = () => {
      const light = set.theme === 'light' || (set.theme === 'system' && mq.matches)
      const root = document.documentElement
      root.dataset.theme = light ? 'light' : 'dark'
      root.dataset.bg = set.background
      root.dataset.motion = set.motion ? 'on' : 'off'
      const base = rgb(set.accentColor || ACCENT_COLORS[set.accent])
      root.style.setProperty('--accent', toHex(light ? mix(base, 0, 0.12) : base))
      root.style.setProperty('--accent-2', toHex(mix(base, 255, light ? 0.22 : 0.38)))
      root.style.setProperty('--accent-rgb', (light ? mix(base, 0, 0.12) : base).join(', '))
      root.style.setProperty('--on-accent', base[0] * 0.299 + base[1] * 0.587 + base[2] * 0.114 > 175 ? '#14161f' : '#fff')
      const solid = set.background === 'clear' ? null : set.background === 'custom' ? set.bgCustom[0] : BG_SOLID[set.background][light ? 'light' : 'dark']
      if (solid) root.style.setProperty('--bg-base', solid); else root.style.removeProperty('--bg-base')
      const lum = base[0] * 0.299 + base[1] * 0.587 + base[2] * 0.114 // text in the accent colour on plain glass must stay readable (a white accent on white, a black one on black)
      root.style.setProperty('--accent-ink', toHex(light ? (lum > 140 ? mix(base, 0, 0.55) : mix(base, 0, 0.12)) : lum < 100 ? mix(base, 255, 0.5) : base))
      root.style.setProperty('--blur', 10 + set.glass * 0.4 + 'px')
      const fill = set.background === 'clear' ? (light ? 0.4 : 0.2) + set.glass * 0.003 : light ? 0.42 + set.glass * 0.0035 : 0.035 + set.glass * 0.0012
      const dense = (o: number) => String(Math.min(0.97, fill * (0.15 + o * 0.017)).toFixed(3)) // 50 = as designed, 0 = nearly clear, 100 = nearly solid
      root.style.setProperty('--fill', dense(set.panelOpacity))
      root.style.setProperty('--fill-bar', dense(set.barOpacity))
      root.style.setProperty('--pop-a', String(set.popOpacity / 100))
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [set?.theme, set?.accent, set?.accentColor, set?.background, set?.bgCustom.join(), set?.motion, set?.glass, set?.panelOpacity, set?.barOpacity, set?.popOpacity])
}

const PHASES = [['scan', 'Поиск'], ['delete', 'Удаление'], ['verify', 'Проверка']] as const
const clock = (ms: number) => { const t = Math.max(0, Math.round(ms / 1000)); return t >= 60 ? `${Math.floor(t / 60)} мин ${t % 60} с` : `${t} с` }

/** Floating progress of a repost cleanup: steps, a progress bar, counters and time. */
function JobCard({ s }: { s: AppState }) {
  const j = s.job!
  const acct = s.accounts.find((a) => a.id === j.accountId)
  const running = j.status === 'running'
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])

  const left = Math.max(0, j.found - j.removed)
  const pct = j.found ? Math.round((j.removed / j.found) * 100) : 0
  const spent = (j.finishedAt ?? now) - j.startedAt
  const rate = j.deleteStartedAt && j.removed ? (now - j.deleteStartedAt) / j.removed : 0
  const eta = running && j.phase === 'delete' && rate && left ? 'осталось ≈ ' + clock(rate * left) : ''
  const at = PHASES.findIndex(([p]) => p === j.phase)
  const icon = running ? <span className="spinner" /> : j.status === 'done' && !j.failed ? <CheckCircle2 size={22} className="ok-ic" /> : <AlertTriangle size={22} className="warn-ic" />

  return (
    <div className={'glass jobcard ' + j.status}>
      <div className="row">
        {acct && <Avatar a={acct} size={34} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>Удаление репостов</div>
          <div className="muted small">{acct ? acct.label + (acct.username ? ' · @' + acct.username : '') : 'аккаунт'}{j.pass && j.pass > 1 ? ` · проход ${j.pass}` : ''}</div>
        </div>
        {icon}
      </div>
      <div className="steps">
        {PHASES.map(([p, label], i) => (
          <span key={p} className={'step' + (i < at || (!running && j.status === 'done') ? ' done' : i === at && running ? ' now' : '')}>{label}</span>
        ))}
      </div>
      <div className={'bar' + (running && j.phase === 'scan' ? ' indeterminate' : '')}><i style={{ width: (j.phase === 'scan' && running ? 100 : pct) + '%' }} /></div>
      <div className="stats">
        <div><b>{j.found}</b><span>найдено</span></div>
        <div><b className="ok-ic">{j.removed}</b><span>удалено</span></div>
        <div><b className={j.failed ? 'warn-ic' : ''}>{j.failed}</b><span>не удалось</span></div>
        <div><b>{j.phase === 'scan' && running ? '—' : pct + '%'}</b><span>готово</span></div>
      </div>
      <div className="muted small">{j.message}</div>
      <div className="row">
        <span className="faint small" style={{ flex: 1 }}>{clock(spent)}{eta && ' · ' + eta}</span>
        {running ? <button className="btn sm" onClick={() => call('reposts:stop')}><Square size={13} />Остановить</button> : <button className="btn sm" onClick={() => call('reposts:dismiss')}>Закрыть</button>}
      </div>
    </div>
  )
}

const PSY_PHASES = [['collect', 'Сбор'], ['vision', 'Обложки'], ['synth', 'Портрет'], ['save', 'Файл']] as const

/** Floating progress of a repost portrait: steps, a bar over covers read, tokens spent, and the finished file. */
function PsyCard({ s, full, onMin }: { s: AppState; full?: boolean; onMin?: () => void }) {
  const j = s.psy!
  const acct = s.accounts.find((a) => a.id === j.accountId)
  const running = j.status === 'running'
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])
  const at = PSY_PHASES.findIndex(([p]) => p === j.phase)
  const pct = j.phase === 'vision' && j.total ? Math.round((j.done / j.total) * 100) : j.status === 'done' ? 100 : 0
  const icon = running ? <span className="spinner" /> : j.status === 'done' ? <CheckCircle2 size={22} className="ok-ic" /> : <AlertTriangle size={22} className="warn-ic" />
  useEffect(() => {
    if (!full) return
    window.dispatchEvent(new CustomEvent('stacktok:modal', { detail: true })) // the native web view would draw over the overlay
    return () => { window.dispatchEvent(new CustomEvent('stacktok:modal', { detail: false })) }
  }, [full])
  const card = (
    <div className={'glass jobcard psycard ' + j.status + (full ? ' full' : '')}>
      <div className="row">
        {acct && !j.target && <Avatar a={acct} size={34} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600 }}>Психопортрет</div>
          <div className="muted small">{j.target ? '@' + j.target : acct ? acct.label + (acct.username ? ' · @' + acct.username : '') : 'аккаунт'}</div>
        </div>
        {icon}
      </div>
      <div className="steps">
        {PSY_PHASES.map(([p, label], i) => <span key={p} className={'step' + (i < at || j.status === 'done' ? ' done' : i === at && running ? ' now' : '')}>{label}</span>)}
      </div>
      <div className={'bar' + (running && j.phase !== 'vision' ? ' indeterminate' : '')}><i style={{ width: (running && j.phase !== 'vision' ? 100 : pct) + '%' }} /></div>
      <div className="muted small">{j.message}</div>
      <div className="row">
        <span className="faint small" style={{ flex: 1 }}>{clock((j.finishedAt ?? now) - j.startedAt)}{j.tokens ? ` · ${(j.tokens / 1000).toFixed(1)}k токенов` : ''}</span>
        {running ? <button className="btn sm" onClick={() => call('psy:stop')}><Square size={13} />Остановить</button> : (
          <>
            {j.status === 'done' && <button className="btn sm primary" onClick={() => call('psy:open')}><Sparkles size={13} />Открыть</button>}
            <button className="btn sm" onClick={() => call('psy:dismiss')}>Закрыть</button>
          </>
        )}
        {full && running && <button className="btn sm" onClick={onMin}>Свернуть</button>}
      </div>
    </div>
  )
  return full ? <div className="modal-bg psy-overlay">{card}</div> : card
}

export function App() {
  const s = useAppState()
  const [page, setPage] = useState<Page | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [psyFull, setPsyFull] = useState(false) // full-screen progress for an analysis started from the Browse tab
  const hasPsy = !!s?.psy
  useEffect(() => { if (!hasPsy) setPsyFull(false) }, [hasPsy])
  const toasts = useToasts()
  useAppearance(s)

  const noticeId = s?.notice?.id
  useEffect(() => { if (s?.notice) toast(s.notice.text, true) }, [noticeId])

  useEffect(() => { if (s && page === null) setPage(s.settings.restoreLast && s.activeAccountId ? 'browse' : 'accounts') }, [s, page])

  // Ctrl+1..9 jumps straight to an account, Ctrl+N adds one.
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!e.ctrlKey || !s) return
      if (e.key === 'n') { e.preventDefault(); setDialog({ kind: 'add' }) }
      const i = Number(e.key) - 1
      if (i >= 0 && s.accounts[i]) { e.preventDefault(); call('account:select', { id: s.accounts[i].id }); setPage('browse') }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [s])

  if (!s || !page) return <div className="ambient"><i /><i /><i /></div>
  const active = s.accounts.find((a) => a.id === s.activeAccountId)
  const nav = (p: Page, icon: React.ReactNode) => (
    <button className={'nav-item' + (page === p ? ' active' : '')} onClick={() => setPage(p)}>{icon}{TITLES[p]}</button>
  )

  return (
    <>
      <div className="ambient"><i /><i /><i /></div>
      <div className="shell">
        <aside className="glass sidebar">
          <div className="brand"><div className="logo"><Layers size={15} /></div>StackTok</div>
          <div className="nav">
            {nav('accounts', <Users size={17} />)}
            {nav('browse', <Globe size={17} />)}
            {nav('tools', <LayoutGrid size={17} />)}
            {nav('downloader', <Download size={17} />)}
          </div>
          <div className="section-title">
            Быстрое переключение
            <button className="btn ghost round" style={{ width: 24, height: 24 }} title="Новый аккаунт (Ctrl+N)" aria-label="Добавить аккаунт" onClick={() => setDialog({ kind: 'add' })}><Plus size={15} /></button>
          </div>
          <div className="quick">
            {s.accounts.length === 0 && <div className="muted small" style={{ padding: '4px 10px' }}>Пока пусто</div>}
            {s.accounts.map((a, i) => (
              <div key={a.id} className={'qrow' + (a.id === s.activeAccountId ? ' active' : '')} onClick={() => { call('account:select', { id: a.id }); setPage('browse') }}>
                <Avatar a={a} size={28} />
                <span className="name">{a.label}</span>
                <span className={'dot ' + (a.session === 'logged_in' ? 'ok' : 'warn')} />
                {i < 9 && <span className="kbd">{i + 1}</span>}
              </div>
            ))}
          </div>
          {nav('settings', <Cog size={17} />)}
        </aside>

        <main className="main">
          <header className="glass header">
            <h1>{TITLES[page]}</h1>
            <span className="sp" />
            {s.chatExport && page !== 'browse' && (
              <div className="chip-acct"><span>{progressText(s.chatExport)}</span><button className="btn sm" onClick={() => call('chat:exportCancel')}>Отмена</button></div>
            )}
            {active && (
              <div className="chip-acct"><Avatar a={active} size={26} /><span>{active.label}</span><span className={'dot ' + (active.session === 'logged_in' ? 'ok' : 'warn')} /></div>
            )}
            <WinControls maximized={s.maximized} />
          </header>
          <div className={'content' + (page === 'browse' || page === 'downloader' ? ' frame-wrap' : '')}>
            {page === 'accounts' && <Accounts s={s} go={setPage} openDialog={setDialog} />}
            {page === 'browse' && <Browse active={active} go={setPage} openDialog={setDialog} exporting={s.chatExport} reposting={s.job?.status === 'running'} analyzing={s.psy?.status === 'running'} />}
            {page === 'tools' && <ToolsPage s={s} active={active} go={setPage} openDialog={setDialog} />}
            {page === 'downloader' && <DownloaderPage />}
            {page === 'settings' && <SettingsPage s={s} />}
          </div>
        </main>
      </div>
      {s.job && <JobCard s={s} />}
      {s.psy && <PsyCard s={s} full={psyFull} onMin={() => setPsyFull(false)} />}
      {dialog && <Dialogs dialog={dialog} close={() => setDialog(null)} onAdded={() => setPage('browse')} onPsyStarted={() => setPsyFull(true)} />}
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={'glass toast' + (t.err ? ' err' : '')}>{t.text}</div>)}</div>
    </>
  )
}
