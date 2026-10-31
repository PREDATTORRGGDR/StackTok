import { useEffect, useState } from 'react'
import { Copy, Download, Globe, Layers, Minus, Plus, Settings as Cog, Square, Users, X } from 'lucide-react'
import { ACCENT_COLORS, BG_COLORS } from '@shared/types'
import { AppState, call, toast, useAppState, useToasts } from './api'
import { Dialog, Dialogs } from './Dialogs'
import { Accounts } from './pages/Accounts'
import { Browse, progressText } from './pages/Browse'
import { DownloaderPage } from './pages/Downloader'
import { SettingsPage } from './pages/Settings'
import { Avatar } from './ui'

export type Page = 'accounts' | 'browse' | 'downloader' | 'settings'
const TITLES: Record<Page, string> = { accounts: 'Аккаунты', browse: 'Обзор', downloader: 'Загрузчик', settings: 'Настройки' }

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
      const spots = set.background === 'custom' ? set.bgCustom : set.background === 'clear' ? null : BG_COLORS[set.background]
      ;['--b1', '--b2', '--b3'].forEach((v, i) => spots ? root.style.setProperty(v, spots[i]) : root.style.removeProperty(v))
      root.style.setProperty('--blur', 10 + set.glass * 0.4 + 'px')
      root.style.setProperty('--fill', String((set.background === 'clear' ? (light ? 0.4 : 0.2) + set.glass * 0.003 : light ? 0.42 + set.glass * 0.0035 : 0.035 + set.glass * 0.0012).toFixed(3)))
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [set?.theme, set?.accent, set?.accentColor, set?.background, set?.bgCustom.join(), set?.motion, set?.glass])
}

export function App() {
  const s = useAppState()
  const [page, setPage] = useState<Page | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
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
            {page === 'browse' && <Browse active={active} go={setPage} openDialog={setDialog} exporting={s.chatExport} />}
            {page === 'downloader' && <DownloaderPage />}
            {page === 'settings' && <SettingsPage s={s} />}
          </div>
        </main>
      </div>
      {dialog && <Dialogs dialog={dialog} close={() => setDialog(null)} onAdded={() => setPage('browse')} />}
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={'glass toast' + (t.err ? ' err' : '')}>{t.text}</div>)}</div>
    </>
  )
}
