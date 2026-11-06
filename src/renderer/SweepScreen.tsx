import { ReactNode, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Bookmark, CheckCircle2, ChevronLeft, FileDown, Heart, Square, Trash2, UserMinus, X } from 'lucide-react'
import { AccountView, SweepChoice, SweepItem, SweepKind } from '@shared/types'
import { AppState, call, toast } from './api'
import { Avatar } from './ui'

const fmt = (n: number) => n.toLocaleString('ru-RU')
const clock = (ms: number) => { const t = Math.max(0, Math.round(ms / 1000)); return t >= 60 ? `${Math.floor(t / 60)} мин ${t % 60} с` : `${t} с` }

export const KINDS: { kind: SweepKind; title: string; desc: string; icon: ReactNode; button: string; found: string; done: string }[] = [
  { kind: 'likes', title: 'Лайки', desc: 'Снять лайки с видео', icon: <Heart size={22} />, button: 'Снять лайки', found: 'лайков можно снять', done: 'лайков снято' },
  { kind: 'favorites', title: 'Избранное', desc: 'Убрать видео из избранного', icon: <Bookmark size={22} />, button: 'Убрать из избранного', found: 'видео в избранном', done: 'убрано из избранного' },
  { kind: 'following', title: 'Подписки', desc: 'Отписаться от аккаунтов', icon: <UserMinus size={22} />, button: 'Отписаться', found: 'подписок', done: 'отписок' }
]
const SPEEDS: { value: SweepChoice['speed']; label: string; note: string }[] = [
  { value: 'careful', label: 'Осторожно', note: '1–2 потока, паузы 0,8–2 с и перерыв каждые 50. Меньше всего шансов на ограничение.' },
  { value: 'normal', label: 'Обычно', note: '4–8 потоков, как в удалении репостов. Скорость подстраивается по откатам.' },
  { value: 'fast', label: 'Быстро', note: '8–12 потоков почти без пауз. TikTok может ограничить действия на время.' }
]
const COUNTS = [100, 500, 1000]

/** Which list to clean. Nothing is touched here: a click only starts reading the list. */
function Start({ acct, onClose }: { acct: AccountView; onClose: () => void }) {
  return (
    <>
      <div className="row">
        <Avatar a={acct} size={40} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 650, fontSize: 17 }}>Чистка аккаунта</div>
          <div className="muted small">{acct.label}{acct.username ? ' · @' + acct.username : ''}</div>
        </div>
      </div>
      <div className="muted small">Сначала приложение только читает список и показывает, что нашлось. Ничего не меняется, пока вы не выберете и не подтвердите.</div>
      <div className="sw-kinds">
        {KINDS.map((k) => (
          <button key={k.kind} className="sw-kind" onClick={() => call('sweep:start', { id: acct.id, kind: k.kind })}>
            <span className="ic">{k.icon}</span><b>{k.title}</b><span className="muted small">{k.desc}</span>
          </button>
        ))}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" onClick={onClose}>Закрыть</button></div>
    </>
  )
}

function Option({ on, set, title, note }: { on: boolean; set: (v: boolean) => void; title: string; note?: string }) {
  return (
    <label className="sw-check">
      <input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} />
      <span>{title}{note && <em>{note}</em>}</span>
    </label>
  )
}

/** A choice of what to clean: what it touches is counted by main and shown next to the settings. */
function Choose({ s, onBack }: { s: AppState; onBack: () => void }) {
  const j = s.sweep!
  const sum = j.summary!
  const k = KINDS.find((x) => x.kind === j.kind)!
  const follow = j.kind === 'following'
  const [count, setCount] = useState<number | 'all'>(follow ? 100 : 'all')
  const [own, setOwn] = useState('')
  const [order, setOrder] = useState<SweepChoice['order']>('new')
  const [speed, setSpeed] = useState<SweepChoice['speed']>(follow ? 'careful' : 'normal')
  const [type, setType] = useState<SweepChoice['type']>('all')
  const [years, setYears] = useState<number[]>([])
  const [keep, setKeep] = useState<string[]>([])
  const [typed, setTyped] = useState('')
  const [keepFriends, setKeepFriends] = useState(true)
  const [keepVerified, setKeepVerified] = useState(true)
  const [onlyEmpty, setOnlyEmpty] = useState(false)
  const [view, setView] = useState<{ matched: number; sample: SweepItem[] }>({ matched: 0, sample: [] })
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const number = Math.floor(Number(own))
  const limit = own.trim() ? (number > 0 ? number : 0) : count === 'all' ? undefined : count
  const choice: SweepChoice = { count: limit, order, speed, type, years, keep, keepFriends, keepVerified, onlyEmpty }
  const key = JSON.stringify(choice)
  useEffect(() => {
    let live = true
    setArmed(false)
    void call<{ matched: number; sample: SweepItem[] }>('sweep:preview', choice).then((v) => { if (live && v) setView(v) })
    return () => { live = false }
  }, [key])
  useEffect(() => () => clearTimeout(timer.current), [])

  const addKeep = () => {
    const names = typed.split(/[\s,]+/).map((x) => x.replace(/^@/, '').trim()).filter(Boolean)
    if (names.length) setKeep([...new Set([...keep, ...names])])
    setTyped('')
  }
  const go = () => {
    if (!armed) { // the action can't be undone in one click: the first press only arms it
      setArmed(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setArmed(false), 5000)
      return
    }
    void call('sweep:run', choice)
  }
  const none = own.trim() !== '' && !limit

  return (
    <>
      <div className="sw-grid">
        <div className="sw-side">
          <div className="sw-field">
            <h4>Сколько</h4>
            <div className="chips">
              {COUNTS.filter((n) => n < sum.total).map((n) => <button key={n} className={'chip' + (!own && count === n ? ' on' : '')} onClick={() => { setCount(n); setOwn('') }}>{fmt(n)}</button>)}
              <button className={'chip' + (!own && count === 'all' ? ' on' : '')} onClick={() => { setCount('all'); setOwn('') }}>Все</button>
              <input className="input rep-own" type="number" min={1} placeholder="Своё число" value={own} onChange={(e) => setOwn(e.target.value)} />
            </div>
          </div>
          <div className="sw-field">
            <h4>С какой стороны</h4>
            <div className="seg sm">
              <button className={order === 'new' ? 'on' : ''} onClick={() => setOrder('new')}>Сначала новые</button>
              <button className={order === 'old' ? 'on' : ''} onClick={() => setOrder('old')}>Сначала старые</button>
            </div>
          </div>
          {!follow && sum.photos > 0 && <div className="sw-field">
            <h4>Что именно</h4>
            <div className="seg sm">
              <button className={type === 'all' ? 'on' : ''} onClick={() => setType('all')}>Всё</button>
              <button className={type === 'video' ? 'on' : ''} onClick={() => setType('video')}>Видео</button>
              <button className={type === 'photo' ? 'on' : ''} onClick={() => setType('photo')}>Фото</button>
            </div>
          </div>}
          {!follow && sum.years.length > 1 && <div className="sw-field">
            <h4>Только видео за годы</h4>
            <div className="chips">
              {sum.years.map((y) => <button key={y.year} className={'chip' + (years.includes(y.year) ? ' on' : '')} onClick={() => setYears(years.includes(y.year) ? years.filter((x) => x !== y.year) : [...years, y.year])}>{y.year} · {fmt(y.count)}</button>)}
            </div>
          </div>}
          {follow && <div className="sw-field">
            <h4>Кого оставить</h4>
            <Option on={keepFriends} set={setKeepFriends} title="Взаимных друзей" note={fmt(sum.friends)} />
            <Option on={keepVerified} set={setKeepVerified} title="С галочкой" note={fmt(sum.verified)} />
            <Option on={onlyEmpty} set={setOnlyEmpty} title="Отписаться только от аккаунтов без видео" note={fmt(sum.empty)} />
          </div>}
          <div className="sw-field">
            <h4>Не трогать авторов</h4>
            <div className="row">
              <input className="input" placeholder="@имя, можно несколько" value={typed} onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addKeep() }} onBlur={addKeep} />
            </div>
            {keep.length > 0 && <div className="chips sw-tags">{keep.map((n) => <button key={n} className="chip on" onClick={() => setKeep(keep.filter((x) => x !== n))}>@{n}<X size={12} /></button>)}</div>}
            {sum.top.length > 0 && !follow && <div className="chips sw-tags">{sum.top.filter((t) => !keep.includes(t.name)).map((t) => <button key={t.name} className="chip" onClick={() => setKeep([...keep, t.name])}>+ @{t.name} · {fmt(t.count)}</button>)}</div>}
          </div>
          <div className="sw-field">
            <h4>Скорость</h4>
            <div className="seg sm">{SPEEDS.map((p) => <button key={p.value} className={speed === p.value ? 'on' : ''} onClick={() => setSpeed(p.value)}>{p.label}</button>)}</div>
            <div className="muted small">{SPEEDS.find((p) => p.value === speed)!.note}</div>
          </div>
        </div>

        <div className="sw-main">
          <div className="rep-big"><b>{fmt(view.matched)}</b><span>из {fmt(sum.total)} {k.found}</span></div>
          <div className={'sw-preview' + (follow ? ' people' : '')}>
            {view.sample.map((it) => follow
              ? <div className="sw-person" key={it.id}><Avatar a={{ id: it.id, label: it.title || it.author || '?', avatar: it.cover }} size={30} /><span><b>{it.title || it.author}</b><em>{it.author ? '@' + it.author : 'аккаунт недоступен'}{it.friend ? ' · друзья' : ''}</em></span></div>
              : <div className="sw-thumb" key={it.id} title={it.title}>{it.cover ? <img src={it.cover} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = 'none' }} /> : null}<span>@{it.author}</span></div>)}
            {!view.sample.length && <div className="muted small">Под эти настройки ничего не подходит.</div>}
          </div>
          {view.matched > view.sample.length && <div className="muted small">Показаны первые {view.sample.length}. Первыми пойдут они.</div>}
          {sum.partial && <div className="muted small">TikTok сейчас не отдаёт полный список подписок, поэтому здесь аккаунты из ленты «Подписки»: {sum.declared ? `${fmt(sum.total)} из ${fmt(sum.declared)}` : fmt(sum.total)}. Те, кто давно не публиковал видео, сюда не попали. После чистки можно запустить поиск снова.</div>}
          {!sum.partial && !!sum.declared && sum.declared > sum.total + 30 && <div className="muted small">TikTok считает {fmt(sum.declared)}, но отдаёт {fmt(sum.total)}. Остальное удалено или скрыто, TikTok этого не показывает, поэтому и убрать не даст.</div>}
          <div className="muted small">Каждая часть проверяется, а чистый результат читается ещё два раза: что откатилось, уйдёт в новый проход.</div>
        </div>
      </div>
      <div className="row sw-foot">
        <span className="muted small" style={{ flex: 1 }}>{armed ? 'Вернуть всё разом будет нельзя. Нажмите ещё раз, чтобы начать.' : ''}</span>
        <button className="btn" onClick={onBack}><ChevronLeft size={14} />Назад</button>
        <button className={'btn primary' + (armed ? ' danger-fill' : '')} disabled={!view.matched || none} onClick={go}><Trash2 size={14} />{armed ? `Подтвердить: ${fmt(view.matched)}` : `${k.button}: ${fmt(view.matched)}`}</button>
      </div>
    </>
  )
}

/** Full-screen cleanup: the choice of a list, the search, what to clean, then progress. */
export function SweepScreen({ s, acct, onClose, onMin }: { s: AppState; acct?: AccountView; onClose: () => void; onMin: () => void }) {
  const j = s.sweep
  const [now, setNow] = useState(Date.now())
  const running = j?.status === 'running'
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('stacktok:modal', { detail: true })) // the native web view would draw over the screen
    return () => { window.dispatchEvent(new CustomEvent('stacktok:modal', { detail: false })) }
  }, [])

  const owner = s.accounts.find((a) => a.id === j?.accountId) ?? acct
  const k = KINDS.find((x) => x.kind === j?.kind)
  const scanning = running && j?.phase === 'scan'
  const close = () => { void call('sweep:dismiss'); onClose() }
  const back = () => { void call('sweep:dismiss') }
  const save = async () => {
    const r = await call<number | null>('sweep:saveList')
    if (r) toast(`Список сохранён: ${fmt(r)}`)
  }

  let body: ReactNode
  if (!j) body = owner ? <Start acct={owner} onClose={onClose} /> : null
  else {
    const done = j.removed
    const sent = j.sent ?? 0
    const shown = Math.max(done, sent)
    const pct = j.found ? Math.min(100, Math.round((shown / j.found) * 100)) : 0
    const perMin = j.deleteStartedAt && sent ? Math.round(sent / Math.max(1 / 60, (now - j.deleteStartedAt) / 60000)) : 0
    const eta = running && j.phase === 'delete' && perMin && j.found > sent ? clock(((j.found - sent) / perMin) * 60000) : ''
    body = (
      <>
        <div className="row">
          {owner && <Avatar a={owner} size={40} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 650, fontSize: 17 }}>Чистка: {k?.title.toLowerCase()}</div>
            <div className="muted small">{owner ? owner.label + (owner.username ? ' · @' + owner.username : '') : 'аккаунт'}{j.pass && j.pass > 1 ? ` · проход ${j.pass}` : ''}</div>
          </div>
          {running ? <span className="spinner" /> : j.status === 'done' && !j.failed ? <CheckCircle2 size={24} className="ok-ic" /> : j.status === 'ready' ? null : <AlertTriangle size={24} className="warn-ic" />}
        </div>
        {scanning && <>
          <div className="rep-big"><b>{fmt(j.found)}</b><span>найдено</span></div>
          <div className="rep-bar indeterminate"><i /></div>
          <div className="muted small">{j.message}</div>
        </>}
        {j.status === 'ready' && j.summary && <Choose s={s} onBack={back} />}
        {!scanning && j.status !== 'ready' && <>
          <div className="rep-big"><b>{fmt(j.phase === 'delete' && running ? sent : done)}</b><span>{j.phase === 'delete' && running ? `отправлено из ${fmt(j.found)}` : `${k?.done ?? 'готово'} из ${fmt(j.found)}`}</span></div>
          <div className="rep-bar"><i style={{ width: pct + '%' }} /></div>
          <div className="rep-tiles">
            <div><b>{fmt(Math.max(0, j.found - shown))}</b><span>осталось</span></div>
            <div><b>{perMin ? fmt(perMin) : '—'}</b><span>в минуту</span></div>
            <div><b className={j.returned ? 'warn-ic' : ''}>{fmt(j.returned ?? 0)}</b><span>откатилось</span></div>
            <div><b>{eta || clock((j.finishedAt ?? now) - (j.deleteStartedAt ?? j.startedAt))}</b><span>{eta ? 'ещё примерно' : 'времени'}</span></div>
          </div>
          <div className="muted small">{j.message}</div>
        </>}
        {j.status !== 'ready' && <div className="row" style={{ justifyContent: 'flex-end' }}>
          {running && !scanning && <button className="btn" onClick={onMin}>Свернуть</button>}
          {running && <button className="btn" onClick={() => call('sweep:stop')}><Square size={14} />Остановить</button>}
          {!running && !!done && <button className="btn" onClick={save}><FileDown size={14} />Сохранить список</button>}
          {!running && <button className="btn" onClick={back}><ChevronLeft size={14} />Другая чистка</button>}
          {!running && <button className="btn" onClick={close}>Закрыть</button>}
        </div>}
      </>
    )
  }

  return (
    <div className="modal-bg psy-overlay">
      <div className={'glass repscreen sweep' + (j?.status === 'ready' ? ' wide' : '')}>{body}</div>
    </div>
  )
}

/** Progress folded into the corner while the rest of the app stays usable. */
export function SweepCard({ s, onOpen }: { s: AppState; onOpen: () => void }) {
  const j = s.sweep!
  const k = KINDS.find((x) => x.kind === j.kind)
  const shown = Math.max(j.removed, j.sent ?? 0)
  const pct = j.found ? Math.min(100, Math.round((shown / j.found) * 100)) : 0
  return (
    <div className={'glass jobcard sweepcard ' + j.status}>
      <div className="row">
        <div style={{ flex: 1, minWidth: 0 }}><div style={{ fontWeight: 600 }}>Чистка: {k?.title.toLowerCase()}</div><div className="muted small">{fmt(shown)} из {fmt(j.found)}</div></div>
        {j.status === 'running' ? <span className="spinner" /> : <CheckCircle2 size={22} className="ok-ic" />}
      </div>
      <div className="bar"><i style={{ width: pct + '%' }} /></div>
      <div className="muted small">{j.message}</div>
      <div className="row">
        <span style={{ flex: 1 }} />
        <button className="btn sm" onClick={onOpen}>Развернуть</button>
        {j.status === 'running' && <button className="btn sm" onClick={() => call('sweep:stop')}><Square size={13} />Стоп</button>}
      </div>
    </div>
  )
}
