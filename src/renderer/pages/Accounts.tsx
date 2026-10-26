import { useEffect, useState } from 'react'
import { Bug, Eraser, Repeat2, LogIn, MoreHorizontal, Pencil, Plus, ShieldCheck, Trash2, Users, ArrowRight } from 'lucide-react'
import { AccountView } from '@shared/types'
import { AppState, call } from '../api'
import { Dialog } from '../Dialogs'
import { Page } from '../App'
import { Avatar, statusText } from '../ui'

function Card({ a, i, active, go, openDialog }: { a: AccountView; i: number; active: boolean; go: (p: Page) => void; openDialog: (d: Dialog) => void }) {
  const [menu, setMenu] = useState(false)
  useEffect(() => {
    if (!menu) return
    const h = () => setMenu(false)
    window.addEventListener('click', h)
    return () => window.removeEventListener('click', h)
  }, [menu])
  const signedIn = a.session === 'logged_in'
  const open = () => { call('account:select', { id: a.id }); go('browse') }
  const item = (icon: React.ReactNode, text: string, fn: () => void, danger = false) => (
    <button className={danger ? 'danger' : ''} onClick={() => { setMenu(false); fn() }}>{icon}{text}</button>
  )

  return (
    <div className={'glass card' + (active ? ' active' : '')} style={{ animationDelay: i * 50 + 'ms' }}>
      <div className="top">
        <Avatar a={a} size={56} />
        <div className="who">
          <div className="name">{a.label}</div>
          <div className="user">{statusText(a)}</div>
        </div>
        <button className="btn ghost round" aria-label="Меню аккаунта" onClick={(e) => { e.stopPropagation(); setMenu(!menu) }}><MoreHorizontal size={18} /></button>
        {menu && (
          <div className="glass menu" onClick={(e) => e.stopPropagation()}>
            {item(<Pencil size={15} />, 'Переименовать', () => openDialog({ kind: 'rename', acct: a }))}
            {item(<LogIn size={15} />, 'Войти заново', open)}
            {item(<Bug size={15} />, 'Открыть сессию для диагностики', () => { open(); setTimeout(() => call('account:devtools'), 300) })}
            <hr />
            {item(<Eraser size={15} />, 'Удалить данные сессии…', () => openDialog({ kind: 'wipe', acct: a }))}
            {item(<Trash2 size={15} />, 'Убрать из списка…', () => openDialog({ kind: 'remove', acct: a }), true)}
          </div>
        )}
      </div>
      <div className="tags">
        <span className="pill"><span className={'dot ' + (signedIn ? 'ok' : 'warn')} />{signedIn ? 'Вход выполнен' : 'Не авторизован'}</span>
        {a.verified && <span className="pill accent"><ShieldCheck size={13} />Подтверждён</span>}
        {active && <span className="pill">Активный</span>}
      </div>
      <div className="actions">
        <button className="btn primary" onClick={open}>{signedIn ? 'Открыть' : 'Войти'}<ArrowRight size={15} /></button>
        <button className="btn" disabled={!signedIn} title={signedIn ? 'Удалить все репосты этого аккаунта' : 'Сначала войдите в аккаунт'} onClick={() => openDialog({ kind: 'reposts', acct: a })}><Repeat2 size={15} />Репосты</button>
      </div>
    </div>
  )
}

export function Accounts({ s, go, openDialog }: { s: AppState; go: (p: Page) => void; openDialog: (d: Dialog) => void }) {
  if (s.accounts.length === 0)
    return (
      <div className="empty">
        <div className="orb"><Users size={34} /></div>
        <h3>Добавьте первый аккаунт</h3>
        <p>Каждый аккаунт получает собственный профиль браузера: входы не пересекаются и сохраняются между запусками.</p>
        <button className="btn primary" onClick={() => openDialog({ kind: 'add' })}><Plus size={16} />Добавить аккаунт</button>
      </div>
    )
  return (
    <div className="page">
      <div className="page-head">
        <div><h2>Ваши аккаунты</h2><p>Изолированные профили TikTok. Переключайтесь в один клик или клавишами Ctrl+1…9.</p></div>
        <button className="btn primary" onClick={() => openDialog({ kind: 'add' })}><Plus size={16} />Добавить</button>
      </div>
      <div className="cards">
        {s.accounts.map((a, i) => <Card key={a.id} a={a} i={i} active={a.id === s.activeAccountId} go={go} openDialog={openDialog} />)}
        <button className="add-card" onClick={() => openDialog({ kind: 'add' })}>
          <div><div className="plus"><Plus size={20} /></div>Новый аккаунт</div>
        </button>
      </div>
    </div>
  )
}
