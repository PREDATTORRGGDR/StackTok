import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Globe, Layers, Plus, Settings as Cog, Square, Users } from 'lucide-react'
import { AppState, call, useAppState, useToasts } from './api'
import { Dialog, Dialogs } from './Dialogs'
import { Accounts } from './pages/Accounts'
import { Browse } from './pages/Browse'
import { SettingsPage } from './pages/Settings'
import { Avatar } from './ui'

export type Page = 'accounts' | 'browse' | 'settings'
const TITLES: Record<Page, string> = { accounts: 'Аккаунты', browse: 'Обзор', settings: 'Настройки' }

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
      root.dataset.accent = set.accent
      root.dataset.bg = set.background
      root.style.setProperty('--blur', 10 + set.glass * 0.4 + 'px')
      root.style.setProperty('--fill', String((set.background === 'clear' ? (light ? 0.3 : 0.2) + set.glass * 0.003 : light ? 0.22 + set.glass * 0.004 : 0.035 + set.glass * 0.0012).toFixed(3)))
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [set?.theme, set?.accent, set?.background, set?.glass])
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

  const left = Math.max(0, j.found - j.removed - j.failed)
  const pct = j.found ? Math.round(((j.removed + j.failed) / j.found) * 100) : 0
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
          <div className="muted small">{acct ? acct.label + (acct.username ? ' · @' + acct.username : '') : 'аккаунт'}</div>
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
        <div><b className={j.failed ? 'warn-ic' : ''}>{j.failed}</b><span>ошибок</span></div>
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

export function App() {
  const s = useAppState()
  const [page, setPage] = useState<Page | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const toasts = useToasts()
  useAppearance(s)

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
            {active && (
              <div className="chip-acct"><Avatar a={active} size={26} /><span>{active.label}</span><span className={'dot ' + (active.session === 'logged_in' ? 'ok' : 'warn')} /></div>
            )}
          </header>
          <div className={'content' + (page === 'browse' ? ' frame-wrap' : '')}>
            {page === 'accounts' && <Accounts s={s} go={setPage} openDialog={setDialog} />}
            {page === 'browse' && <Browse active={active} go={setPage} openDialog={setDialog} />}
            {page === 'settings' && <SettingsPage s={s} />}
          </div>
        </main>
      </div>
      {s.job && <JobCard s={s} />}
      {dialog && <Dialogs dialog={dialog} close={() => setDialog(null)} onAdded={() => setPage('browse')} />}
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={'glass toast' + (t.err ? ' err' : '')}>{t.text}</div>)}</div>
    </>
  )
}
