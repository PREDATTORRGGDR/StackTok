import { useState } from 'react'
import { AccountView } from '@shared/types'
import { call } from './api'
import { Modal } from './ui'

export type Dialog = { kind: 'add' } | { kind: 'rename' | 'remove' | 'wipe' | 'reposts' | 'psy' | 'stats'; acct: AccountView; who?: string; overlay?: boolean }

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
