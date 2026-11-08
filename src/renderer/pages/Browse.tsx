import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Bot, Bug, Clapperboard, ExternalLink, FileDown, Home, MessageCircle, Plus, Repeat2, RotateCw, ShieldCheck, Sparkles, UserRound, Users, Volume2, VolumeX } from 'lucide-react'
import { AccountView, AssistState, ChatExportProgress } from '@shared/types'
import { AssistPanel, assistWasOpen } from '../AssistPanel'
import { call } from '../api'
import { Dialog } from '../Dialogs'
import { Page } from '../App'

export const progressText = (p: ChatExportProgress) =>
  p.phase === 'loading' ? `Загружаю историю: ${p.done} сообщений…` : p.phase === 'reading' ? `Читаю сообщения${p.total ? `: ${p.done} из ${p.total}` : `: ${p.done}`}…` : p.phase === 'media' ? `Сохраняю картинки и стикеры: ${p.done} из ${p.total ?? 0}…` : 'Записываю файл…'

export function Browse({ active, go, openDialog, exporting, reposting, analyzing, assist, hasKey }: { active?: AccountView; go: (p: Page) => void; openDialog: (d: Dialog) => void; exporting: ChatExportProgress | null; reposting: boolean; analyzing: boolean; assist: AssistState; hasKey: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const [confirming, setConfirming] = useState(false)
  const [username, setUsername] = useState('')
  const [avatar, setAvatar] = useState<string>()
  const [covered, setCovered] = useState(false)
  const [muted, setMuted] = useState(true)
  const [assistOpen, setAssistOpen] = useState(assistWasOpen)
  const showAssist = (on: boolean) => { setAssistOpen(on); try { localStorage.setItem('assistOpen', on ? '1' : '0') } catch {} }

  useEffect(() => {
    const h = () => setAssistOpen(true)
    window.addEventListener('stacktok:assist', h)
    return () => window.removeEventListener('stacktok:assist', h)
  }, [])

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

  const [profile, setProfile] = useState<string | null>(null) // the profile open in the view now, if the page is one

  // The page is TikTok's own single-page app, so the address is polled; it is a cheap local call.
  useEffect(() => {
    if (!active) return
    let on = true
    const tick = async () => { const p = await call<string | null>('browse:profile', { id: active.id }, true); if (on) setProfile(p ?? null) }
    tick()
    const t = setInterval(tick, 700)
    return () => { on = false; clearInterval(t) }
  }, [active?.id])

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
  const exportChat = () => openDialog({ kind: 'chatexport', acct: active! })
  const nav = (a: string) => call('browse:nav', a)
  const analyze = () => openDialog({ kind: 'psy', acct: active!, who: profile ?? '', overlay: true })
  const signedIn = active.session === 'logged_in'

  return (
    <>
      <div className="glass toolbar">
        <div className="tgroup">
        <button className="btn ghost round" aria-label="Назад" onClick={() => nav('back')}><ArrowLeft size={17} /></button>
        <button className="btn ghost round" aria-label="Вперёд" onClick={() => nav('forward')}><ArrowRight size={17} /></button>
        <button className="btn ghost round" aria-label="Обновить" onClick={() => nav('reload')}><RotateCw size={16} /></button>
        <button className="btn ghost round" aria-label="Домой" onClick={() => nav('home')}><Home size={17} /></button>
        </div>
        <div className="tgroup">
        <button className="btn ghost sm" title="Открыть TikTok Studio этого аккаунта" onClick={() => call('account:page', { id: active.id, value: 'studio' })}><Clapperboard size={16} /><span className="lbl">Студия</span></button>
        <button className="btn ghost sm" title="Открыть профиль этого аккаунта" onClick={() => call('account:page', { id: active.id, value: 'profile' })}><UserRound size={16} /><span className="lbl">Профиль</span></button>
        <button className="btn ghost sm" title="Открыть сообщения этого аккаунта" onClick={() => call('account:page', { id: active.id, value: 'chats' })}><MessageCircle size={16} /><span className="lbl">Чаты</span></button>
        </div>
        <div className="tgroup">
        <button className="btn ghost sm" disabled={!!exporting} title="Сохранить открытый диалог в HTML-файл: все сообщения, время, видео, стикеры и картинки" onClick={exportChat}><FileDown size={16} /><span className="lbl">Экспорт чата</span></button>
        <button className={'btn ghost sm' + (assistOpen ? ' on' : '')} title="Помощник по переписке: знает открытый диалог, подсказывает, что происходит и как ответить" onClick={() => showAssist(!assistOpen)}><Bot size={16} /><span className="lbl">Помощник</span></button>
        <button className="btn ghost sm" disabled={!signedIn || !!reposting} title={reposting ? 'Удаление репостов уже идёт' : signedIn ? 'Удалить все репосты этого аккаунта' : 'Сначала войдите в аккаунт'} onClick={() => openDialog({ kind: 'reposts', acct: active })}><Repeat2 size={16} /><span className="lbl">Удалить репосты</span></button>
        </div>
        <button className="btn primary sm analyze" disabled={!profile || analyzing} title={analyzing ? 'Анализ уже идёт' : profile ? `Психопортрет профиля @${profile} по его репостам` : 'Откройте профиль человека (страница вида tiktok.com/@имя), и кнопка станет активной'} onClick={analyze}><Sparkles size={16} /><span className="lbl">{profile ? `Запустить анализ @${profile}` : 'Запустить анализ'}</span></button>
        <span style={{ flex: 1 }} />
        <div className="tgroup">
        <button className="btn ghost round" aria-label={muted ? 'Включить звук' : 'Выключить звук'} title={muted ? 'Звук выключен — нажмите, чтобы включить' : 'Выключить звук'} onClick={async () => setMuted((await call<boolean>('browse:toggleMute')) ?? muted)}>{muted ? <VolumeX size={17} /> : <Volume2 size={17} />}</button>
        <button className="btn ghost sm" onClick={() => call('browse:external')} title="Если встроенный просмотр заблокирован, откройте в браузере по умолчанию"><ExternalLink size={15} /><span className="lbl first">Открыть в браузере</span></button>
        <button className="btn ghost round" aria-label="Диагностика" title="Инструменты разработчика сессии" onClick={() => call('account:devtools')}><Bug size={16} /></button>
        </div>
      </div>
      {exporting && (
        <div className="glass banner">
          <FileDown size={18} />
          <span>{progressText(exporting)} Можно переключаться между страницами и аккаунтами, окно не сворачивайте.</span>
          <span style={{ flex: 1 }} />
          <button className="btn sm" onClick={() => call('chat:exportCancel')}>Отмена</button>
        </div>
      )}
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
      <div className="browse-row">
        <div className="glass frame"><div className="viewport" ref={box} /></div>
        {assistOpen && <AssistPanel a={assist} hasKey={hasKey} signedIn={signedIn} busyExport={!!exporting} onClose={() => showAssist(false)} toSettings={() => go('settings')} />}
      </div>
    </>
  )
}
