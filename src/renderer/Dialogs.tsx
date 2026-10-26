import { useState } from 'react'
import { AccountView } from '@shared/types'
import { call } from './api'
import { Modal } from './ui'

export type Dialog = { kind: 'add' } | { kind: 'rename' | 'remove' | 'wipe' | 'reposts'; acct: AccountView }

export function Dialogs({ dialog, close, onAdded }: { dialog: Dialog; close: () => void; onAdded: () => void }) {
  const [text, setText] = useState(dialog.kind === 'rename' ? dialog.acct.label : '')
  const [wipe, setWipe] = useState(false)
  const typing = dialog.kind === 'add' || dialog.kind === 'rename'

  async function submit() {
    if (dialog.kind === 'add') { if (await call('account:add', { label: text })) { onAdded(); close() } return }
    if (dialog.kind === 'rename') await call('account:rename', { id: dialog.acct.id, label: text })
    else if (dialog.kind === 'reposts') await call('reposts:start', { id: dialog.acct.id })
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
      {dialog.kind === 'reposts' && (
        <>
          <h3>Удалить все репосты?</h3>
          <span className="muted small">У аккаунта «{dialog.acct.label}» (@{dialog.acct.username}) будут по одному убраны все репосты через сайт TikTok. Это займёт несколько секунд на каждый репост. Собственные видео не затрагиваются. Вернуть репосты автоматически нельзя.</span>
        </>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
        <button className="btn" onClick={close}>Отмена</button>
        <button className={'btn primary' + (dialog.kind === 'reposts' ? ' danger-fill' : '')} disabled={typing && !text.trim()} onClick={submit}>
          {dialog.kind === 'add' ? 'Добавить' : dialog.kind === 'rename' ? 'Сохранить' : dialog.kind === 'wipe' ? 'Удалить данные' : dialog.kind === 'reposts' ? 'Удалить репосты' : wipe ? 'Убрать и стереть' : 'Убрать'}
        </button>
      </div>
    </Modal>
  )
}
