import { useEffect, useState } from 'react'
import { AlertTriangle, Bell, BellOff, CircleHelp, Download, Eraser, Eye, Heart, Minimize2, Pause, Play, Plus, RefreshCw, Repeat2, Trash2, UserPlus, UserRound, Video, VideoOff, Zap } from 'lucide-react'
import type { WatchdogEventView, WatchdogJob, WatchdogTargetView } from '@shared/types'
import { AppState, call, toast } from './api'
import { Select } from './ui'

const fmt = (n: number) => n.toLocaleString('ru-RU')
const dur = (ms: number) => {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s} сек`
  if (s < 3600) return `${Math.floor(s / 60)} мин${s % 60 ? ` ${s % 60} сек` : ''}`
  if (s < 86_400) return `${Math.floor(s / 3600)} ч ${Math.floor((s % 3600) / 60)} мин`
  return `${Math.floor(s / 86_400)} дн ${Math.floor((s % 86_400) / 3600)} ч`
}
/** «12 с назад», «5 мин назад», «вчера в 14:05» */
const ago = (t: number | undefined, now: number) => {
  if (!t) return 'ещё не было'
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 5) return 'только что'
  if (s < 60) return `${s} с назад`
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`
  if (s < 86_400) return `${Math.floor(s / 3600)} ч назад`
  return new Date(t).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}
const until = (t: number | undefined, now: number) => {
  if (!t) return '—'
  const s = Math.round((t - now) / 1000)
  if (s <= 0) return 'сейчас'
  return s < 60 ? `через ${s} с` : `через ${Math.ceil(s / 60)} мин`
}
const clock = (t: number) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
const dayOf = (t: number, now: number) => {
  const d = new Date(t), n = new Date(now)
  const days = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000)
  return days === 0 ? 'Сегодня' : days === 1 ? 'Вчера' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })
}

function useNow(ms = 1000) {
  const [now, set] = useState(Date.now())
  useEffect(() => { const t = setInterval(() => set(Date.now()), ms); return () => clearInterval(t) }, [ms])
  return now
}

type Tone = 'ok' | 'busy' | 'warn' | 'off'
/** One word about a target and its colour: the same in the list, in the card and in the header chip. */
function stateOf(t: WatchdogTargetView): { tone: Tone; label: string } {
  if (!t.active) return t.error ? { tone: 'warn', label: 'Остановлен' } : { tone: 'off', label: 'На паузе' }
  if (t.error) return { tone: 'warn', label: 'Нет ответа' }
  if (!t.ready) return { tone: 'busy', label: 'Запоминаю список' }
  if (t.checking) return { tone: 'busy', label: 'Проверяю' }
  return { tone: 'ok', label: 'Следит' }
}

const FILTERS: { id: string; label: string; pick: (e: WatchdogEventView) => boolean }[] = [
  { id: 'all', label: 'Все', pick: () => true },
  { id: 'added', label: 'Новые репосты', pick: (e) => e.kind === 'repost_added' },
  { id: 'removed', label: 'Удалённые', pick: (e) => e.kind === 'repost_removed' },
  { id: 'flash', label: 'Быстро удалённые', pick: (e) => !!e.isFlash },
  { id: 'activity', label: 'Активность', pick: (e) => e.kind === 'activity' }
]

/** What happened, in plain words. */
function describe(e: WatchdogEventView): { icon: React.ReactNode; tone: string; title: string; hint?: string } {
  const n = Math.abs(e.delta ?? 0), many = n > 1 ? ` (${e.delta! > 0 ? '+' : '−'}${fmt(n)})` : ''
  if (e.kind === 'repost_added') return e.late
    ? { icon: <Repeat2 size={16} />, tone: 'dim', title: 'Репост появился в списке', hint: 'Не сверху списка: скорее всего, это старый репост, чьё видео снова стало доступным.' }
    : { icon: <Repeat2 size={16} />, tone: 'add', title: 'Новый репост' }
  if (e.kind === 'repost_removed') {
    if (e.why === 'unavailable') return { icon: <VideoOff size={16} />, tone: 'dim', title: 'Видео стало недоступно', hint: 'Автор удалил или скрыл видео, поэтому репост пропал сам. Человек его не убирал.' }
    if (e.isFlash) return { icon: <Zap size={16} />, tone: 'flash', title: 'Быстро удалил репост', hint: `Репост провисел всего ${dur(e.duration ?? 0)}.` }
    return { icon: <Trash2 size={16} />, tone: 'del', title: 'Удалил репост', hint: e.duration ? `Репост провисел ${dur(e.duration)}.` : 'Репост был в списке ещё до начала слежки.' }
  }
  if (e.kind === 'activity') {
    const up = (e.delta ?? 0) > 0
    if (e.what === 'following') return up ? { icon: <UserPlus size={16} />, tone: 'act', title: 'Подписался на кого-то' + many } : { icon: <UserPlus size={16} />, tone: 'act', title: 'Подписок стало меньше' + many, hint: 'Отписался сам, или аккаунт из его подписок пропал.' }
    if (e.what === 'liked') return { icon: <Heart size={16} />, tone: 'act', title: (up ? 'Поставил лайк' : 'Убрал лайк') + many }
    if (e.what === 'videos') return up ? { icon: <Video size={16} />, tone: 'act', title: 'Выложил видео' + many } : { icon: <VideoOff size={16} />, tone: 'act', title: 'Удалил или скрыл своё видео' + many }
    return { icon: <UserRound size={16} />, tone: 'act', title: e.what === 'nickname' ? 'Сменил имя профиля' : 'Изменил описание профиля' }
  }
  return { icon: <Eye size={16} />, tone: 'dim', title: e.kind === 'online' ? 'В сети' : 'Не в сети' }
}

function EventCard({ e, onOpen }: { e: WatchdogEventView; onOpen: () => void }) {
  const d = describe(e)
  const [noCover, setNoCover] = useState(false) // cover links expire
  const url = e.videoId && e.meta?.author && e.why !== 'unavailable' ? `https://www.tiktok.com/@${e.meta.author}/video/${e.videoId}` : null
  const open = () => { if (url) { call('browse:openUrl', { url }); onOpen() } }
  return (
    <div className={'wd-event ' + d.tone + (url ? ' clickable' : '')} onClick={open} title={url ? 'Открыть это видео в «Обзоре»' : undefined}>
      <div className="wd-ic">{d.icon}</div>
      <div className="wd-ebody">
        <div className="wd-etitle">{d.title}</div>
        {d.hint && <div className="muted small">{d.hint}</div>}
        {(e.meta?.author || e.meta?.desc) && <div className="muted small wd-desc">{e.meta.author ? '@' + e.meta.author : ''}{e.meta.author && e.meta.desc ? ' · ' : ''}{e.meta.desc}</div>}
      </div>
      {e.meta?.cover && !noCover && <img src={e.meta.cover} className="wd-cover" alt="" referrerPolicy="no-referrer" onError={() => setNoCover(true)} />}
      <div className="wd-time">{clock(e.at)}</div>
    </div>
  )
}

/** The form that starts watching a profile. */
function AddTarget({ s, big, onDone }: { s: AppState; big?: boolean; onDone: (id?: string) => void }) {
  const [handle, setHandle] = useState('')
  const [acctId, setAcctId] = useState(s.activeAccountId ?? s.accounts[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!handle.trim() || busy) return
    setBusy(true)
    const id = await call<string>('watchdog:add', { handle: handle.trim(), accountId: acctId })
    setBusy(false)
    if (!id) return
    toast('Слежка началась: сначала запомню текущие репосты')
    setHandle('')
    onDone(id)
  }
  return (
    <div className={'wd-add' + (big ? ' big' : '')}>
      <input className="input" placeholder="@имя или ссылка на профиль" value={handle} autoFocus onChange={(e) => setHandle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      {s.accounts.length > 1 && (
        <div className="row wd-via">
          <span className="muted small">Смотреть через аккаунт</span>
          <Select value={acctId} onChange={setAcctId} options={s.accounts.map((a) => ({ value: a.id, label: a.label + (a.username ? ` (@${a.username})` : '') }))} />
        </div>
      )}
      <div className="row">
        <button className="btn primary" style={{ flex: 1 }} disabled={busy || !handle.trim() || !acctId} onClick={submit}>{busy ? <span className="spinner" /> : <Eye size={16} />}{busy ? 'Ищу профиль…' : 'Начать следить'}</button>
        {!big && <button className="btn" onClick={() => onDone()}>Отмена</button>}
      </div>
    </div>
  )
}

function HowItWorks() {
  return (
    <div className="wd-help">
      <div className="wd-help-t">Как работает сторож</div>
      <ol>
        <li><b>Каждые ~20 секунд</b> смотрит верх списка репостов: новые репосты появляются там.</li>
        <li><b>Раз в 5 минут</b> перечитывает список целиком: так находятся удалённые старые репосты.</li>
        <li><b>Первый раз только запоминает</b>, что уже есть. В ленту попадают изменения с этого момента.</li>
        <li><b>Об удалении сообщает после повторной проверки.</b> TikTok иногда отдаёт список не целиком, и без перепроверки были бы ложные «удалил». Если видео удалил его автор, так и будет написано.</li>
        <li><b>«Быстро удалил»</b>: репост появился и исчез меньше чем за 10 минут.</li>
        <li><b>Активность</b>: раз в минуту сверяются открытые счётчики профиля (подписки, поставленные лайки, свои видео). Счётчик изменился, значит человек только что был в TikTok. Самого статуса «в сети» на сайте TikTok нет, он есть только в мобильном приложении.</li>
        <li><b>Работает, пока запущен StackTok.</b> Этот экран можно свернуть, окно тоже: значок «Сторож» в шапке показывает, что слежка идёт.</li>
      </ol>
    </div>
  )
}

/** A button that asks once more before doing something that cannot be undone. */
function Sure({ label, sure, icon, onYes }: { label: string; sure: string; icon: React.ReactNode; onYes: () => void }) {
  const [ask, setAsk] = useState(false)
  useEffect(() => { if (!ask) return; const t = setTimeout(() => setAsk(false), 4000); return () => clearTimeout(t) }, [ask])
  return <button className={'btn sm' + (ask ? ' danger' : '')} onClick={() => { if (ask) { setAsk(false); onYes() } else setAsk(true) }}>{icon}{ask ? sure : label}</button>
}

function TargetRow({ t, on, now, fresh, onClick }: { t: WatchdogTargetView; on: boolean; now: number; fresh: number; onClick: () => void }) {
  const st = stateOf(t)
  const [bad, setBad] = useState(false)
  return (
    <button className={'wd-target' + (on ? ' on' : '')} onClick={onClick}>
      {t.avatar && !bad ? <img src={t.avatar} className="wd-avatar" alt="" referrerPolicy="no-referrer" onError={() => setBad(true)} /> : <div className="wd-avatar ph">{(t.handle[0] ?? '?').toUpperCase()}</div>}
      <div className="wd-tbody">
        <div className="wd-tname">@{t.handle}</div>
        <div className="wd-tstate"><span className={'wd-dot ' + st.tone} />{st.label}{st.tone === 'ok' ? ` · ${ago(t.lastOk, now)}` : ''}</div>
      </div>
      {fresh > 0 && <span className="wd-badge">{fresh > 99 ? '99+' : fresh}</span>}
    </button>
  )
}

function TargetPanel({ t, now, onRemoved }: { t: WatchdogTargetView; now: number; onRemoved: () => void }) {
  const st = stateOf(t)
  return (
    <div className="wd-panel">
      <div className="row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="wd-pname">@{t.handle}{t.nickname && <span className="muted"> · {t.nickname}</span>}</div>
          <div className="muted small">Слежка с {new Date(t.since).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}{t.via ? ` · через аккаунт «${t.via}»` : ''}</div>
        </div>
        <span className={'wd-state ' + st.tone}><span className={'wd-dot ' + st.tone} />{st.label}</span>
      </div>
      <div className="wd-tiles">
        <div><b>{t.ready ? fmt(t.reposts) : '…'}</b><span>репостов сейчас</span></div>
        <div><b>{ago(t.lastOk, now)}</b><span>последняя проверка</span></div>
        <div><b>{t.checking ? 'идёт' : t.active ? until(t.nextAt, now) : 'пауза'}</b><span>следующая проверка</span></div>
        <div title="Последний раз, когда человек что-то сделал: репост, лайк, подписка, видео"><b>{t.lastActive ? ago(t.lastActive, now) : 'не замечена'}</b><span>последняя активность</span></div>
      </div>
      {t.error && <div className="wd-note warn"><AlertTriangle size={15} /><span>{t.error}</span></div>}
      {!t.error && !t.ready && <div className="wd-note"><span className="spinner" style={{ width: 14, height: 14 }} /><span>Читаю список репостов в первый раз, чтобы запомнить, что уже есть. Сообщать буду только о том, что изменится после этого.</span></div>}
      {!t.error && t.ready && t.note && <div className="wd-note"><RefreshCw size={14} /><span>{t.note}</span></div>}
      {t.activityOk === false && <div className="wd-note"><AlertTriangle size={15} /><span>TikTok сейчас не отдаёт страницу профиля: лайки, подписки и новые видео пока не отслеживаются, репосты отслеживаются.</span></div>}
      <div className="wd-actions">
        <button className="btn sm" disabled={t.checking} title="Не ждать таймера и посмотреть прямо сейчас" onClick={() => call('watchdog:check', { targetId: t.id })}><RefreshCw size={14} className={t.checking ? 'wd-spin' : ''} />{t.checking ? 'Проверяю…' : 'Проверить сейчас'}</button>
        <button className="btn sm" onClick={() => call('watchdog:toggle', { targetId: t.id })}>{t.active ? <Pause size={14} /> : <Play size={14} />}{t.active ? 'Пауза' : 'Продолжить'}</button>
        <button className="btn sm" disabled={!t.eventCount} title="Сохранить найденные события в таблицу CSV" onClick={() => call('watchdog:export', { targetId: t.id, format: 'csv' })}><Download size={14} />Сохранить в файл</button>
        <span style={{ flex: 1 }} />
        {t.eventCount > 0 && <Sure label="Очистить историю" sure="Точно очистить?" icon={<Eraser size={14} />} onYes={() => call('watchdog:clear', { targetId: t.id }).then(() => toast('История очищена, слежка продолжается'))} />}
        <Sure label="Перестать следить" sure="Точно убрать?" icon={<Trash2 size={14} />} onYes={() => { call('watchdog:remove', { targetId: t.id }); onRemoved() }} />
      </div>
    </div>
  )
}

export function WatchdogScreen({ s, onClose, go }: { s: AppState; onClose: () => void; go: (p: 'browse') => void }) {
  const wd = s.watchdog
  const targets = wd?.targets ?? []
  const events = wd?.events ?? []
  const now = useNow()
  const [activeId, setActiveId] = useState<string | null>(targets[0]?.id ?? null)
  const [filter, setFilter] = useState('all')
  const [adding, setAdding] = useState(false)
  const [help, setHelp] = useState(false)
  const [seenAt] = useState(() => events[(wd?.unread ?? 0) - 1]?.at ?? Date.now()) // the oldest event not shown yet: those stay marked as new until the screen closes

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    window.dispatchEvent(new CustomEvent('stacktok:modal', { detail: true }))
    return () => { window.removeEventListener('keydown', k); window.dispatchEvent(new CustomEvent('stacktok:modal', { detail: false })) }
  }, [onClose])
  const unread = wd?.unread ?? 0
  useEffect(() => { if (unread) call('watchdog:seen', undefined, true) }, [unread])

  const target = targets.find((t) => t.id === activeId) ?? targets[0]
  const mine = target ? events.filter((e) => e.targetId === target.id) : []
  const pick = FILTERS.find((f) => f.id === filter) ?? FILTERS[0]
  const shown = mine.filter(pick.pick)
  const days: [string, WatchdogEventView[]][] = []
  for (const e of shown) {
    const d = dayOf(e.at, now)
    if (days[days.length - 1]?.[0] === d) days[days.length - 1][1].push(e); else days.push([d, [e]])
  }
  const watching = targets.filter((t) => t.active).length

  return (
    <div className="modal-bg psy-overlay">
      <div className="glass wd-screen">
        <div className="wd-header">
          <div className="wd-logo"><Eye size={18} /></div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="wd-title">Сторож</div>
            <div className="muted small">{!targets.length ? 'Следит за репостами и активностью профиля в фоне' : watching ? `Работает в фоне · профилей под наблюдением: ${watching}` : 'Все профили на паузе'}</div>
          </div>
          {targets.length > 0 && (
            <>
              <button className={'btn sm ghost' + (wd?.notify ? ' on' : '')} title="Уведомление Windows, когда что-то найдено, а окно StackTok свёрнуто или не на переднем плане" onClick={() => call('watchdog:notify', { on: !wd?.notify })}>{wd?.notify ? <Bell size={15} /> : <BellOff size={15} />}Уведомления {wd?.notify ? 'вкл.' : 'выкл.'}</button>
              <button className={'btn sm ghost' + (help ? ' on' : '')} onClick={() => setHelp(!help)}><CircleHelp size={15} />Как это работает</button>
            </>
          )}
          <button className="btn sm" title="Закрыть экран. Слежка продолжится, значок «Сторож» останется в шапке" onClick={onClose}><Minimize2 size={15} />Свернуть</button>
        </div>

        {!targets.length ? (
          <div className="wd-empty">
            <div className="wd-empty-in">
              <h2>За кем следить?</h2>
              <p className="muted">Сторож сообщит, когда человек добавит или удалит репост, поставит лайк, подпишется на кого-то или выложит видео. Профиль должен быть открытым. Сам сторож ничего не лайкает, не пишет и не подписывается.</p>
              <AddTarget s={s} big onDone={(id) => id && setActiveId(id)} />
              <HowItWorks />
            </div>
          </div>
        ) : (
          <div className="wd-body">
            <div className="wd-sidebar">
              {targets.map((t) => <TargetRow key={t.id} t={t} on={t.id === target?.id} now={now} fresh={events.filter((e) => e.targetId === t.id && e.at >= seenAt && t.id !== target?.id).length} onClick={() => { setActiveId(t.id); setFilter('all') }} />)}
              {adding ? <AddTarget s={s} onDone={(id) => { setAdding(false); if (id) setActiveId(id) }} /> : <button className="btn sm wd-more" onClick={() => setAdding(true)}><Plus size={15} />Добавить профиль</button>}
            </div>
            <div className="wd-feed">
              {help && <HowItWorks />}
              {target && <TargetPanel t={target} now={now} onRemoved={() => setActiveId(null)} />}
              <div className="wd-filters">
                {FILTERS.map((f) => {
                  const n = mine.filter(f.pick).length
                  return <button key={f.id} className={'chip' + (filter === f.id ? ' on' : '')} onClick={() => setFilter(f.id)}>{f.label}{n > 0 && <span className="wd-n">{fmt(n)}</span>}</button>
                })}
              </div>
              <div className="wd-events">
                {days.map(([d, list]) => (
                  <div key={d} className="wd-daygroup">
                    <div className="wd-day">{d}</div>
                    {list.map((e) => <EventCard key={e.id} e={e} onOpen={() => { onClose(); go('browse') }} />)}
                  </div>
                ))}
                {!shown.length && target && (
                  <div className="wd-none">
                    <Eye size={30} />
                    <div>{mine.length ? 'Таких событий нет' : target.ready ? 'Пока ничего не произошло' : 'Запоминаю текущие репосты…'}</div>
                    {!mine.length && <div className="muted small">Здесь появится запись, как только @{target.handle} добавит или удалит репост, поставит лайк, подпишется на кого-то или выложит видео. Держать этот экран открытым не нужно.</div>}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** The always-visible sign in the app header that the watchdog is at work; opens its screen. */
export function WatchdogChip({ wd, onOpen }: { wd: WatchdogJob | null; onOpen: () => void }) {
  const now = useNow(5000)
  if (!wd?.targets.length) return null
  const states = wd.targets.map(stateOf)
  const tone: Tone = states.some((x) => x.tone === 'warn') ? 'warn' : states.some((x) => x.tone === 'ok' || x.tone === 'busy') ? 'ok' : 'off'
  const last = Math.max(0, ...wd.targets.map((t) => t.lastOk ?? 0))
  const text = tone === 'warn' ? 'Сторож: нужна помощь' : tone === 'off' ? 'Сторож на паузе' : 'Сторож следит'
  return (
    <button className="chip-acct wd-chip" onClick={onOpen} title={`${text}. Профилей: ${wd.targets.length}. Последняя проверка: ${ago(last || undefined, now)}. Нажмите, чтобы открыть.`}>
      <span className={'wd-dot ' + tone} />
      <span>{text}</span>
      {wd.unread > 0 && <span className="wd-badge">{wd.unread > 99 ? '99+' : wd.unread}</span>}
    </button>
  )
}
