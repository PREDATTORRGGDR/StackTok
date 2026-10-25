import { useEffect, useState } from 'react'
import { Globe, Layers, Plus, Settings as Cog, Users } from 'lucide-react'
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
      root.style.setProperty('--fill', String((light ? 0.22 + set.glass * 0.004 : 0.035 + set.glass * 0.0012).toFixed(3)))
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [set?.theme, set?.accent, set?.background, set?.glass])
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
      {dialog && <Dialogs dialog={dialog} close={() => setDialog(null)} onAdded={() => setPage('browse')} />}
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={'glass toast' + (t.err ? ' err' : '')}>{t.text}</div>)}</div>
    </>
  )
}
