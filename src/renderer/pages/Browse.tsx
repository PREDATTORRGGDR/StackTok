import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Bug, ExternalLink, Home, RotateCw, ShieldCheck, UserPlus } from 'lucide-react'
import { AccountView } from '@shared/types'
import { AppState, call } from '../api'

export function Browse({ active }: { s: AppState; active?: AccountView }) {
  const box = useRef<HTMLDivElement>(null)
  const [confirming, setConfirming] = useState(false)
  const [username, setUsername] = useState('')
  const [avatar, setAvatar] = useState<string>()
  const [covered, setCovered] = useState(false)
  useEffect(() => {
    const h = (e: Event) => setCovered((e as CustomEvent<boolean>).detail)
    window.addEventListener('stacktok:modal', h)
    return () => window.removeEventListener('stacktok:modal', h)
  }, [])

  // Report where the native TikTok view should sit; hide it when leaving this page.
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

  if (!active)
    return (
      <div className="empty" style={{ flex: 1 }}>
        <UserPlus size={28} />
        <b style={{ color: 'var(--text)' }}>Добавьте первый аккаунт</b>
        <span>Нажмите «+» в боковой панели. У каждого аккаунта свой вход.</span>
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
      <div className="toolbar">
        <button className="btn ghost sm" aria-label="Назад" onClick={() => nav('back')}><ArrowLeft size={15} /></button>
        <button className="btn ghost sm" aria-label="Вперёд" onClick={() => nav('forward')}><ArrowRight size={15} /></button>
        <button className="btn ghost sm" aria-label="Обновить" onClick={() => nav('reload')}><RotateCw size={14} /></button>
        <button className="btn ghost sm" aria-label="Домой" onClick={() => nav('home')}><Home size={15} /></button>
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => call('browse:external')} title="Если встроенный просмотр заблокирован, откройте в браузере по умолчанию"><ExternalLink size={14} />Открыть в браузере</button>
        <button className="btn ghost sm" aria-label="Диагностика" title="Инструменты разработчика сессии" onClick={() => call('account:devtools')}><Bug size={14} /></button>
      </div>
      {signedIn && !active.verified && !confirming && (
        <div className="banner">
          <ShieldCheck size={15} />
          <span>Вход выполнен. Перед публикацией подтвердите, какому аккаунту TikTok принадлежит эта сессия.</span>
          <span style={{ flex: 1 }} />
          <button className="btn sm primary" onClick={startConfirm}>Подтвердить аккаунт</button>
        </div>
      )}
      {confirming && (
        <div className="banner">
          <span>{username ? 'Найден профиль:' : 'Профиль определить не удалось. Введите имя пользователя из TikTok:'}</span>
          <input className="input" style={{ width: 200 }} placeholder="имя пользователя" value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && confirm()} />
          <button className="btn sm primary" onClick={confirm}>Да, это он</button>
          <button className="btn sm" onClick={() => setConfirming(false)}>Отмена</button>
        </div>
      )}
      {!signedIn && <div className="banner"><span>Войдите в TikTok ниже. Вход сохраняется только в профиле этого аккаунта.</span></div>}
      <div className="viewport" ref={box} />
    </>
  )
}
