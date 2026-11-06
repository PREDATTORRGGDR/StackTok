import { ReactNode, useState } from 'react'
import { CalendarDays, CalendarRange, Clock, FileDown, Hash, Infinity } from 'lucide-react'
import { AccountView, ChatRange } from '@shared/types'
import { call, toast } from './api'
import { Modal } from './ui'

export type Dialog = { kind: 'add' } | { kind: 'rename' | 'remove' | 'wipe' | 'reposts' | 'sweep' | 'psy' | 'stats' | 'chatexport'; acct: AccountView; who?: string; overlay?: boolean }

type Pick = 'all' | 'last' | 'today' | 'yesterday' | 'week' | 'month' | 'span'
const PICKS: { id: Pick; icon: ReactNode; title: string; hint: string }[] = [
  { id: 'all', icon: <Infinity size={20} />, title: 'Весь чат', hint: 'С самого начала' },
  { id: 'last', icon: <Hash size={20} />, title: 'Последние', hint: 'Сколько сообщений' },
  { id: 'today', icon: <Clock size={20} />, title: 'Сегодня', hint: 'С полуночи' },
  { id: 'yesterday', icon: <CalendarDays size={20} />, title: 'Вчера', hint: 'Один день' },
  { id: 'week', icon: <CalendarDays size={20} />, title: '7 дней', hint: 'Последняя неделя' },
  { id: 'month', icon: <CalendarRange size={20} />, title: 'Этот месяц', hint: 'С 1 числа' },
  { id: 'span', icon: <CalendarRange size={20} />, title: 'Свой период', hint: 'Выбрать даты' }
]
const dayStart = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
const parseDay = (s: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : undefined }
const showDay = (ms: number) => new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })

/** Turns the choice into a range for `chat:export` plus a one-line description for the dialog. */
function rangeOf(pick: Pick, count: number, from: string, to: string): { range: ChatRange | null; text: string } {
  const now = new Date()
  const today = dayStart(now)
  const DAY = 86_400_000
  if (pick === 'all') return { range: { mode: 'all' }, text: 'Вся переписка с первого сообщения.' }
  if (pick === 'last') return count >= 1 ? { range: { mode: 'last', count }, text: `${count} последних сообщений.` } : { range: null, text: 'Введите число сообщений.' }
  if (pick === 'today') return { range: { mode: 'time', from: today }, text: `Сообщения за сегодня, ${showDay(today)}.` }
  if (pick === 'yesterday') return { range: { mode: 'time', from: today - DAY, to: today - 1 }, text: `Сообщения за вчера, ${showDay(today - DAY)}.` }
  if (pick === 'week') return { range: { mode: 'time', from: today - 6 * DAY }, text: `С ${showDay(today - 6 * DAY)} по сегодня.` }
  if (pick === 'month') { const f = new Date(now.getFullYear(), now.getMonth(), 1).getTime(); return { range: { mode: 'time', from: f }, text: `С ${showDay(f)} по сегодня.` } }
  const f = parseDay(from), t = parseDay(to)
  if (f === undefined && t === undefined) return { range: null, text: 'Выберите хотя бы одну дату.' }
  const end = t === undefined ? undefined : t + DAY - 1
  if (f !== undefined && end !== undefined && f > end) return { range: { mode: 'time', from: t!, to: f + DAY - 1 }, text: `С ${showDay(t!)} по ${showDay(f)}.` }
  return { range: { mode: 'time', from: f, to: end }, text: f !== undefined && t !== undefined ? `С ${showDay(f)} по ${showDay(t)}.` : f !== undefined ? `С ${showDay(f)} и позже.` : `До ${showDay(t!)} включительно.` }
}

function ChatExportDialog({ close }: { close: () => void }) {
  const [pick, setPick] = useState<Pick>('all')
  const [count, setCount] = useState(100)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const { range, text } = rangeOf(pick, count, from, to)
  async function go() {
    if (!range) return
    close()
    const r = await call<{ messages: number; complete: boolean } | null>('chat:export', { range })
    if (r) toast(`Чат сохранён: ${r.messages} сообщений. ${r.complete ? (range.mode === 'all' ? 'История загружена полностью.' : 'Выбранная часть загружена полностью.') : 'История неполная, подробности в файле.'}`, !r.complete)
  }
  return (
    <Modal onClose={close} wide>
      <h3>Экспорт чата</h3>
      <span className="muted small">Сохраняется диалог, который сейчас открыт на вкладке «Обзор». Выберите, что войдёт в файл: чем меньше часть, тем быстрее выгрузка.</span>
      <div className="rgrid">
        {PICKS.map((p) => (
          <button key={p.id} type="button" className={'rcard' + (pick === p.id ? ' on' : '')} onClick={() => setPick(p.id)}>
            {p.icon}<b>{p.title}</b><span>{p.hint}</span>
          </button>
        ))}
      </div>
      {pick === 'last' && (
        <div className="row small wrap"><span>Сколько сообщений</span>
          <div className="seg sm">{[50, 100, 500, 1000, 5000].map((n) => <button key={n} className={count === n ? 'on' : ''} onClick={() => setCount(n)}>{n}</button>)}</div>
          <input className="input" type="number" min={1} max={1000000} value={count || ''} onChange={(e) => setCount(Math.min(1_000_000, Math.max(0, Math.round(Number(e.target.value) || 0))))} />
        </div>
      )}
      {pick === 'span' && (
        <div className="row small wrap"><span>С</span><input className="input dateinput" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /><span>по</span><input className="input dateinput" type="date" value={to} onChange={(e) => setTo(e.target.value)} /><span className="muted">последний день включается целиком</span></div>
      )}
      <div className="rsum"><FileDown size={16} /><span>{text}</span></div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
        <button className="btn" onClick={close}>Отмена</button>
        <button className="btn primary" disabled={!range} onClick={go}>Выбрать файл и экспортировать</button>
      </div>
    </Modal>
  )
}

export function Dialogs({ dialog, close, onAdded, onPsyStarted }: { dialog: Dialog; close: () => void; onAdded: () => void; onPsyStarted?: () => void }) {
  const [text, setText] = useState(dialog.kind === 'rename' ? dialog.acct.label : '')
  const [wipe, setWipe] = useState(false)
  const [frames, setFrames] = useState(false)
  const [limit, setLimit] = useState(500)
  const [gender, setGender] = useState<'' | 'male' | 'female'>('')
  const [age, setAge] = useState('')
  const [relation, setRelation] = useState('')
  const signed = dialog.kind === 'psy' && dialog.acct.session === 'logged_in'
  const [other, setOther] = useState(true) // true = any public profile by name, false = the account itself
  const [who, setWho] = useState(dialog.kind === 'psy' ? dialog.who ?? '' : '')
  const typing = dialog.kind === 'add' || dialog.kind === 'rename'

  if (dialog.kind === 'chatexport') return <ChatExportDialog close={close} />

  async function submit() {
    if (dialog.kind === 'add') { if (await call('account:add', { label: text })) { onAdded(); close() } return }
    if (dialog.kind === 'rename') await call('account:rename', { id: dialog.acct.id, label: text })
    else if (dialog.kind === 'psy') { const r = await call('psy:start', { id: dialog.acct.id, username: other || !signed ? who : undefined, frames, limit, gender: gender || undefined, age, relation }); if (r === undefined) return; if (r === null) return close(); if (dialog.overlay) onPsyStarted?.() }
    else if (dialog.kind === 'remove') await call('account:remove', { id: dialog.acct.id, wipe })
    else await call('account:wipe', { id: dialog.acct.id })
    close()
  }

  return (
    <Modal onClose={close}>
      {typing && (
        <>
          <h3>{dialog.kind === 'add' ? 'Новый аккаунт' : 'Переименовать'}</h3>
          {dialog.kind === 'add' && <span className="muted small">У аккаунта будет свой изолированный профиль браузера. Дальше вы войдёте в TikTok как обычно.</span>}
          <input className="input" autoFocus placeholder="Название, например: Личный" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && text.trim() && submit()} />
        </>
      )}
      {dialog.kind === 'remove' && (
        <>
          <h3>Убрать «{dialog.acct.label}»?</h3>
          <span className="muted small">Аккаунт исчезнет из списка, но сохранённый вход останется на диске. Его можно стереть отдельно.</span>
          <label className="row small" style={{ cursor: 'pointer' }}><input type="checkbox" checked={wipe} onChange={(e) => setWipe(e.target.checked)} /> Также удалить данные сессии (cookies, хранилище, кэш)</label>
        </>
      )}
      {dialog.kind === 'wipe' && (
        <>
          <h3>Удалить данные сессии?</h3>
          <span className="muted small">«{dialog.acct.label}» будет разлогинен, cookies, хранилище и кэш очистятся. Сам аккаунт останется в списке.</span>
        </>
      )}
      {dialog.kind === 'psy' && (
        <>
          <h3>Психопортрет по репостам</h3>
          {signed && <div className="seg sm"><button className={other ? 'on' : ''} onClick={() => setOther(true)}>Любой профиль</button><button className={!other ? 'on' : ''} onClick={() => setOther(false)}>Мой аккаунт «{dialog.acct.label}»</button></div>}
          {(other || !signed) && <input className="input" autoFocus placeholder="@имя или ссылка на профиль TikTok" value={who} onChange={(e) => setWho(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && who.trim() && submit()} />}
          <span className="muted small">{other || !signed ? 'Берутся репосты, которые видит любой посетитель профиля; вход в аккаунт не нужен (запросы идут из окна «' + dialog.acct.label + '»). У закрытых профилей репосты не видны.' : `Репосты аккаунта «${dialog.acct.label}»${dialog.acct.username ? ` (@${dialog.acct.username})` : ''}.`} Нейросеть посмотрит обложки и подписи и напишет портрет в виде презентации: черты, настроение, о чём он думает, чувства и отношения, интересы, манера общения. Это догадки по ленте, а не факты.</span>
          <span className="muted small">Обложки, подписи и теги репостов уйдут в API выбранного в «Настройках» провайдера, вы платите по своему ключу. Клинических диагнозов и категоричных выводов о расе, национальности и ориентации портрет не делает, третьих лиц не называет.</span>
          <div className="row small wrap"><span>Пол</span>
            <div className="seg sm">{([['', 'Не знаю'], ['male', 'Мужской'], ['female', 'Женский']] as const).map(([v, l]) => <button key={v} className={gender === v ? 'on' : ''} onClick={() => setGender(v)}>{l}</button>)}</div>
          </div>
          <input className="input" maxLength={20} placeholder="Возраст (можно примерный, например ~25)" value={age} onChange={(e) => setAge(e.target.value)} />
          <input className="input" maxLength={40} placeholder="Кто он(а) вам: подруга, брат, девушка… (необязательно)" value={relation} onChange={(e) => setRelation(e.target.value)} />
          <div className="chips">{['друг', 'подруга', 'парень', 'девушка', 'брат', 'сестра', 'мама', 'папа', 'коллега', 'знакомый', 'я сам(а)'].map((r) => <button type="button" key={r} className={'chip' + (relation === r ? ' on' : '')} onClick={() => setRelation(relation === r ? '' : r)}>{r}</button>)}</div>
          <div className="row small wrap"><span>Сколько последних репостов</span>
            <div className="seg sm">{[100, 300, 500, 1000, 3000].map((n) => <button key={n} className={limit === n ? 'on' : ''} onClick={() => setLimit(n)}>{n}</button>)}</div>
            <input className="input" type="number" min={10} max={10000} step={10} value={limit} onChange={(e) => setLimit(Math.min(10000, Math.max(0, Math.round(Number(e.target.value) || 0))))} onBlur={() => setLimit((l) => Math.max(10, l))} />
          </div>
          <label className="row small" style={{ cursor: 'pointer' }}><input type="checkbox" checked={frames} onChange={(e) => setFrames(e.target.checked)} /> Ещё и кадры из видео (глубже, но медленнее и дороже; первые 48 видео)</label>
        </>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
        <button className="btn" onClick={close}>Отмена</button>
        <button className="btn primary" disabled={(typing && !text.trim()) || (dialog.kind === 'psy' && (other || !signed) && !who.trim())} onClick={submit}>
          {dialog.kind === 'add' ? 'Добавить' : dialog.kind === 'rename' ? 'Сохранить' : dialog.kind === 'wipe' ? 'Удалить данные' : dialog.kind === 'psy' ? 'Построить портрет' : wipe ? 'Убрать и стереть' : 'Убрать'}
        </button>
      </div>
    </Modal>
  )
}
