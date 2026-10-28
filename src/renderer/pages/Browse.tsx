import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Bug, ExternalLink, Home, MessageCircle, Plus, RotateCw, ShieldCheck, Users, Volume2, VolumeX } from 'lucide-react'
import { AccountView } from '@shared/types'
import { call } from '../api'
import { Dialog } from '../Dialogs'
import { Page } from '../App'

export function Browse({ active, go, openDialog }: { active?: AccountView; go: (p: Page) => void; openDialog: (d: Dialog) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const [confirming, setConfirming] = useState(false)
  const [username, setUsername] = useState('')
  const [avatar, setAvatar] = useState<string>()
  const [covered, setCovered] = useState(false)
  const [muted, setMuted] = useState(true)

  useEffect(() => {
    const h = (e: Event) => setCovered((e as CustomEvent<boolean>).detail)
    window.addEventListener('stacktok:modal', h)
    return () => window.removeEventListener('stacktok:modal', h)
  }, [])

  // Report where the native TikTok view sits; hide it when leaving this page or when a dialog is open.
  useEffect(() => {
    const el = box.current
    if (!el || !active || covered) return
    const send = () => {
      const r = el.getBoundingClientRect()
      call('browse:bounds', { x: r.x, y: r.y, width: r.width, height: r.height }, true)
    }
    send()
    const ro = new ResizeObserver(send)
    ro.observe(el)
    window.addEventListener('resize', send)
    return () => { ro.disconnect(); window.removeEventListener('resize', send); call('browse:bounds', null, true) }
  }, [active?.id, covered])

  useEffect(() => setConfirming(false), [active?.id])
  useEffect(() => { if (active) call<boolean>('browse:muted', undefined, true).then((m) => setMuted(m ?? true)) }, [active?.id])

  if (!active)
    return (
      <div className="empty">
        <div className="orb"><Users size={34} /></div>
        <h3>Нет активного аккаунта</h3>
        <p>Добавьте аккаунт или выберите его на вкладке «Аккаунты».</p>
        <div className="row">
          <button className="btn primary" onClick={() => openDialog({ kind: 'add' })}><Plus size={16} />Добавить аккаунт</button>
          <button className="btn" onClick={() => go('accounts')}>К аккаунтам</button>
        </div>
      </div>
    )

  async function startConfirm() {
    const d = await call<{ username?: string; avatar?: string }>('account:detect', { id: active!.id })
    setUsername(d?.username ?? active!.username ?? '')
    setAvatar(d?.avatar)
    setConfirming(true)
  }
  async function confirm() {
    await call('account:confirm', { id: active!.id, username, avatar })
    setConfirming(false)
  }
  const nav = (a: string) => call('browse:nav', a)
  const signedIn = active.session === 'logged_in'

  return (
    <>
      <div className="glass toolbar">
        <button className="btn ghost round" aria-label="Назад" onClick={() => nav('back')}><ArrowLeft size={17} /></button>
        <button className="btn ghost round" aria-label="Вперёд" onClick={() => nav('forward')}><ArrowRight size={17} /></button>
        <button className="btn ghost round" aria-label="Обновить" onClick={() => nav('reload')}><RotateCw size={16} /></button>
        <button className="btn ghost round" aria-label="Домой" onClick={() => nav('home')}><Home size={17} /></button>
        <button className="btn ghost sm" title="Открыть сообщения этого аккаунта" onClick={() => call('account:chats', { id: active.id })}><MessageCircle size={16} />Чаты</button>
        <button className="btn ghost round" aria-label={muted ? 'Включить звук' : 'Выключить звук'} title={muted ? 'Звук выключен — нажмите, чтобы включить' : 'Выключить звук'} onClick={async () => setMuted((await call<boolean>('browse:toggleMute')) ?? muted)}>{muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => call('browse:external')} title="Если встроенный просмотр заблокирован, откройте в браузере по умолчанию"><ExternalLink size={15} />Открыть в браузере</button>
        <button className="btn ghost round" aria-label="Диагностика" title="Инструменты разработчика сессии" onClick={() => call('account:devtools')}><Bug size={16} /></button>
      </div>
      {signedIn && !active.verified && !confirming && (
        <div className="glass banner">
          <ShieldCheck size={18} />
          <span>Вход выполнен. Подтвердите, какому аккаунту TikTok принадлежит эта сессия.</span>
          <span style={{ flex: 1 }} />
          <button className="btn primary sm" onClick={startConfirm}>Подтвердить</button>
        </div>
      )}
      {confirming && (
        <div className="glass banner">
          <span>{username ? 'Найден профиль:' : 'Не удалось определить профиль. Введите имя пользователя:'}</span>
          <input className="input" style={{ width: 200, padding: '6px 12px' }} placeholder="имя пользователя" value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && confirm()} />
          <span style={{ flex: 1 }} />
          <button className="btn primary sm" onClick={confirm}>Да, это он</button>
          <button className="btn sm" onClick={() => setConfirming(false)}>Отмена</button>
        </div>
      )}
      {!signedIn && <div className="glass banner"><span>Войдите в TikTok ниже. Вход сохранится только в профиле этого аккаунта.</span></div>}
      <div className="glass frame"><div className="viewport" ref={box} /></div>
    </>
  )
}
