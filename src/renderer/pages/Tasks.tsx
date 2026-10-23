import { useState } from 'react'
import { CalendarClock, Inbox, Play, RotateCw, X, CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react'
import { canRetry, formatLocal } from '@shared/logic'
import { Status, Task } from '@shared/types'
import { AppState, call } from '../api'
import { Avatar } from '../App'

const LABEL: Record<Status, string> = {
  draft: 'Черновик', scheduled: 'Запланировано', ready: 'Готово', uploading: 'Загрузка', awaiting_user: 'Нужны вы',
  published: 'Опубликовано', failed: 'Ошибка', needs_verification: 'Нужна проверка', cancelled: 'Отменено'
}
const TONE: Partial<Record<Status, string>> = { published: 'ok', failed: 'err', awaiting_user: 'warn', needs_verification: 'warn', uploading: 'info', ready: 'info' }
const UPCOMING: Status[] = ['draft', 'scheduled', 'ready']

function TaskRow({ t, s }: { t: Task; s: AppState }) {
  const [open, setOpen] = useState(false)
  const acct = s.accounts.find((a) => a.id === t.accountId)
  const overdue = s.overdue.includes(t.id)
  const file = t.videoPath.split(/[\\/]/).pop()
  const id = { id: t.id }
  return (
    <div className="task">
      <div className="task-head" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <Avatar a={acct ?? { label: '?' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file}</div>
          <div className="muted small">
            {acct?.label ?? 'Аккаунт удалён'}
            {t.scheduledAt ? ` · ${formatLocal(t.scheduledAt)}` : ''}
            {t.status === 'uploading' && t.step ? ` · ${t.step}…` : ''}
          </div>
        </div>
        {overdue && <span className="badge warn">Просрочено</span>}
        <span className={'badge ' + (TONE[t.status] ?? '')}>{LABEL[t.status]}</span>
        <div className="row" onClick={(e) => e.stopPropagation()}>
          {t.status === 'draft' && <button className="btn sm" onClick={() => call('task:start', id)}><Play size={12} />Запустить</button>}
          {t.status === 'scheduled' && <button className="btn sm" onClick={() => call('task:runNow', id)}><Play size={12} />{overdue ? 'Запустить сейчас' : 'Сейчас'}</button>}
          {canRetry(t) && <button className="btn sm" onClick={() => call('task:retry', id)}><RotateCw size={12} />{t.status === 'awaiting_user' ? 'Продолжить' : 'Повторить'}</button>}
          {t.status === 'needs_verification' && <button className="btn sm" onClick={() => call('task:markPublished', id)}><CheckCircle2 size={12} />Видео опубликовано</button>}
          {['draft', 'scheduled', 'ready', 'awaiting_user', 'failed', 'needs_verification'].includes(t.status) && (
            <button className="btn sm ghost" aria-label="Отменить задачу" onClick={() => call('task:cancel', id)}><X size={13} /></button>
          )}
        </div>
      </div>
      {t.error && !open && <div className="small" style={{ padding: '0 12px 10px 42px', color: t.status === 'failed' ? 'var(--err)' : 'var(--warn)' }}>{t.error}</div>}
      {open && (
        <div className="task-body">
          <dl className="kv" style={{ margin: 0 }}>
            <dt>ID задачи</dt><dd>{t.id}</dd>
            <dt>Видео</dt><dd>{t.videoPath}</dd>
            <dt>Описание</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{t.caption || '—'}</dd>
            <dt>Попытки</dt><dd>{t.attempts}{t.submitted ? ' · кнопка «Опубликовать» уже нажималась, автоповтор отключён' : ''}</dd>
            {t.error && <><dt>Примечание</dt><dd>{t.error}</dd></>}
            {t.confirmation && <><dt>Подтверждение</dt><dd>{t.confirmation}</dd></>}
            <dt>Обновлено</dt><dd>{formatLocal(t.updatedAt)}</dd>
          </dl>
        </div>
      )}
    </div>
  )
}

export function Tasks({ s, mode }: { s: AppState; mode: 'upcoming' | 'activity' }) {
  const [diag, setDiag] = useState(false)
  const tasks = s.tasks
    .filter((t) => (mode === 'upcoming') === UPCOMING.includes(t.status))
    .sort((a, b) => mode === 'upcoming' ? (a.scheduledAt ?? a.createdAt) - (b.scheduledAt ?? b.createdAt) : b.updatedAt - a.updatedAt)
  const sm = s.summary

  return (
    <div style={{ maxWidth: 900 }}>
      {mode === 'activity' && (
        <div className="summary">
          {([['Опубликовано', sm.published], ['Ошибки', sm.failed], ['Нужны вы', sm.needsAction], ['В ожидании', sm.pending]] as const).map(([k, v]) => (
            <div key={k} className="panel"><b>{v}</b><span className="muted small">{k}</span></div>
          ))}
        </div>
      )}
      {s.overdue.length > 0 && mode === 'upcoming' && (
        <div className="panel small" style={{ marginBottom: 12, borderColor: 'var(--warn)' }}>
          Задач, срок которых наступил, пока StackTok был закрыт: {s.overdue.length}. Сами они не запустятся — нажмите «Запустить сейчас» или отмените.
        </div>
      )}
      {tasks.length === 0 ? (
        <div className="empty">{mode === 'upcoming' ? <CalendarClock size={28} /> : <Inbox size={28} />}
          <b style={{ color: 'var(--text)' }}>{mode === 'upcoming' ? 'Ничего не запланировано' : 'Активности пока нет'}</b>
          <span>{mode === 'upcoming' ? 'Запланированные публикации выполняются, только пока StackTok открыт.' : 'Здесь появятся выполняемые и завершённые задачи.'}</span>
        </div>
      ) : tasks.map((t) => <TaskRow key={t.id} t={t} s={s} />)}
      {mode === 'activity' && (
        <div className="stack" style={{ marginTop: 16 }}>
          <div className="row">
            <button className="btn sm ghost" onClick={() => setDiag(!diag)}>{diag ? 'Скрыть' : 'Показать'} диагностику</button>
            <button className="btn sm ghost" onClick={() => call('task:clear')}>Очистить опубликованные и отменённые</button>
          </div>
          {diag && <div className="panel log">{s.logs.length ? s.logs.map((l) => `${new Date(l.t).toLocaleTimeString()}  ${l.msg}`).join('\n') : 'Событий автоматизации пока нет.'}</div>}
        </div>
      )}
    </div>
  )
}
