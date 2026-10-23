import { useEffect, useState, ReactNode } from 'react'
import { Activity, CalendarClock, Globe, MoreHorizontal, Plus, Send, Settings as Cog, Layers, Pencil, Trash2, LogIn, Bug, Eraser } from 'lucide-react'
import { AccountView } from '@shared/types'
import { AppState, call, useAppState, useToasts } from './api'
import { Browse } from './pages/Browse'
import { Publish } from './pages/Publish'
import { Tasks } from './pages/Tasks'
import { SettingsPage } from './pages/Settings'

export type Page = 'browse' | 'publish' | 'scheduled' | 'activity' | 'settings'
const TITLES: Record<Page, string> = { browse: 'Обзор', publish: 'Публикация', scheduled: 'Запланировано', activity: 'Активность', settings: 'Настройки' }

export const initials = (a: { label: string }) => a.label.trim().slice(0, 2).toUpperCase()
export const Avatar = ({ a }: { a: { label: string; avatar?: string } }) => (
  <div className="avatar">{a.avatar ? <img src={a.avatar} alt="" referrerPolicy="no-referrer" /> : initials(a)}</div>
)

export function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    window.dispatchEvent(new CustomEvent('stacktok:modal', { detail: true })) // native web view would draw over the dialog
    return () => { window.removeEventListener('keydown', k); window.dispatchEvent(new CustomEvent('stacktok:modal', { detail: false })) }
  }, [onClose])
  return (
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="panel modal stack" onMouseDown={(e) => e.stopPropagation()}>{children}</div>
    </div>
  )
}

type Dialog = { kind: 'add' } | { kind: 'rename' | 'remove' | 'wipe'; acct: AccountView }

function Sidebar({ s, page, go }: { s: AppState; page: Page; go: (p: Page) => void }) {
  const [menu, setMenu] = useState<string | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [text, setText] = useState('')
  const [wipe, setWipe] = useState(false)
  const open = (d: Dialog) => { setMenu(null); setText(d.kind === 'add' ? '' : d.kind === 'rename' ? d.acct.label : ''); setWipe(false); setDialog(d) }
  const close = () => setDialog(null)
  useEffect(() => { const h = () => setMenu(null); window.addEventListener('click', h); return () => window.removeEventListener('click', h) }, [])

  const waiting = s.tasks.filter((t) => ['awaiting_user', 'needs_verification'].includes(t.status)).length
  const upcoming = s.tasks.filter((t) => ['scheduled', 'draft', 'ready'].includes(t.status)).length
  const nav = (p: Page, icon: ReactNode, count?: number) => (
    <button className={'nav-item' + (page === p ? ' active' : '')} onClick={() => go(p)}>
      {icon}{TITLES[p]}{count ? <span className="count">{count}</span> : null}
    </button>
  )

  async function submit() {
    if (dialog?.kind === 'add') {
      if (await call('account:add', { label: text })) { go('browse'); close() }
    } else if (dialog?.kind === 'rename') {
      await call('account:rename', { id: dialog.acct.id, label: text }); close()
    } else if (dialog?.kind === 'remove') {
      await call('account:remove', { id: dialog.acct.id, wipe }); close()
    } else if (dialog?.kind === 'wipe') {
      await call('account:wipe', { id: dialog.acct.id }); close()
    }
  }

  return (
    <aside className="sidebar">
      <div className="nav">
        {nav('browse', <Globe size={15} />)}
        {nav('publish', <Send size={15} />)}
        {nav('scheduled', <CalendarClock size={15} />, upcoming)}
        {nav('activity', <Activity size={15} />, waiting)}
      </div>
      <div className="section-title">
        Аккаунты
        <button className="btn ghost sm" title="Добавить аккаунт" aria-label="Добавить аккаунт" onClick={() => open({ kind: 'add' })}><Plus size={14} /></button>
      </div>
      <div className="accounts">
        {s.accounts.length === 0 && <div className="muted small" style={{ padding: '6px 10px' }}>Аккаунтов пока нет.</div>}
        {s.accounts.map((a) => (
          <div key={a.id} className={'acct' + (a.id === s.activeAccountId ? ' active' : '')} onClick={() => { call('account:select', { id: a.id }); if (page !== 'browse' && page !== 'publish') go('browse') }}>
            <Avatar a={a} />
            <div className="meta">
              <div className="name">{a.label}</div>
              <div className="sub">
                <span className={'dot ' + (a.session === 'logged_in' ? 'ok' : 'warn')} />
                {a.session === 'logged_in' ? (a.verified ? (a.username ? '@' + a.username : 'Вход выполнен') : 'Подтвердите аккаунт') : 'Не авторизован'}
              </div>
            </div>
            <button className={'menu-btn' + (menu === a.id ? ' open' : '')} aria-label="Меню аккаунта" onClick={(e) => { e.stopPropagation(); setMenu(menu === a.id ? null : a.id) }}><MoreHorizontal size={15} /></button>
            {menu === a.id && (
              <div className="menu" onClick={(e) => e.stopPropagation()}>
                <button onClick={() => open({ kind: 'rename', acct: a })}><Pencil size={13} />Переименовать</button>
                <button onClick={() => { setMenu(null); call('account:select', { id: a.id }); go('browse') }}><LogIn size={13} />Войти / войти заново</button>
                <button onClick={() => { setMenu(null); call('account:select', { id: a.id }); go('browse'); setTimeout(() => call('account:devtools'), 200) }}><Bug size={13} />Открыть сессию для диагностики</button>
                <button onClick={() => open({ kind: 'wipe', acct: a })}><Eraser size={13} />Удалить данные сессии…</button>
                <button className="danger" onClick={() => open({ kind: 'remove', acct: a })}><Trash2 size={13} />Убрать из списка…</button>
              </div>
            )}
          </div>
        ))}
      </div>
      {nav('settings', <Cog size={15} />)}

      {dialog && (
        <Modal onClose={close}>
          {(dialog.kind === 'add' || dialog.kind === 'rename') && (
            <>
              <b>{dialog.kind === 'add' ? 'Добавить аккаунт' : 'Переименовать аккаунт'}</b>
              {dialog.kind === 'add' && <span className="muted small">У аккаунта будет свой изолированный профиль браузера. Далее вы войдёте в TikTok обычным способом.</span>}
              <input className="input" autoFocus placeholder="Название, например: Основной аккаунт" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && text.trim() && submit()} />
            </>
          )}
          {dialog.kind === 'remove' && (
            <>
              <b>Убрать «{dialog.acct.label}»?</b>
              <span className="muted small">Его задачи в очереди будут отменены. Сохранённый профиль браузера останется на диске, если не отметить галочку ниже.</span>
              <label className="row small"><input type="checkbox" checked={wipe} onChange={(e) => setWipe(e.target.checked)} /> Также удалить локальные данные сессии (cookies, хранилище, кэш)</label>
            </>
          )}
          {dialog.kind === 'wipe' && (
            <>
              <b>Удалить данные сессии «{dialog.acct.label}»?</b>
              <span className="muted small">Аккаунт будет разлогинен, cookies, хранилище и кэш очистятся. Сам аккаунт останется в списке.</span>
            </>
          )}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={close}>Отмена</button>
            <button className={'btn primary'} disabled={(dialog.kind === 'add' || dialog.kind === 'rename') && !text.trim()} onClick={submit}>
              {dialog.kind === 'add' ? 'Добавить' : dialog.kind === 'rename' ? 'Сохранить' : dialog.kind === 'wipe' ? 'Удалить данные' : wipe ? 'Убрать и удалить данные' : 'Убрать'}
            </button>
          </div>
        </Modal>
      )}
    </aside>
  )
}

export function App() {
  const s = useAppState()
  const [page, setPage] = useState<Page>('browse')
  const toasts = useToasts()
  if (!s) return null
  const active = s.accounts.find((a) => a.id === s.activeAccountId)

  return (
    <div className="app">
      <div className="drag" />
      <div className="brand"><div className="logo"><Layers size={11} /></div>StackTok</div>
      <Sidebar s={s} page={page} go={setPage} />
      <main className="main">
        <header className="header">
          <h1>{TITLES[page]}</h1>
          <span className="sp" />
          {active && <span className="who"><Avatar a={active} />{active.label}</span>}
        </header>
        <div className={'content' + (page === 'browse' ? ' flush' : '')}>
          {page === 'browse' && <Browse s={s} active={active} />}
          {page === 'publish' && <Publish s={s} go={setPage} />}
          {page === 'scheduled' && <Tasks s={s} mode="upcoming" />}
          {page === 'activity' && <Tasks s={s} mode="activity" />}
          {page === 'settings' && <SettingsPage s={s} />}
        </div>
      </main>
      <div className="toasts">{toasts.map((t) => <div key={t.id} className={'toast' + (t.err ? ' err' : '')}>{t.text}</div>)}</div>
    </div>
  )
}
