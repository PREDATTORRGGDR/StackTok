import { useMemo, useState } from 'react'
import { FileVideo, RotateCcw, Send, CalendarClock } from 'lucide-react'
import { applyTags, epochToLocalInput, localInputToEpoch } from '@shared/logic'
import { VideoInfo } from '@shared/types'
import { AppState, call, toast, videoSrc } from '../api'
import { Avatar, Page } from '../App'

const MAX = 2200
const fmtSize = (n: number) => (n > 1e9 ? (n / 1e9).toFixed(2) + ' ГБ' : (n / 1e6).toFixed(1) + ' МБ')
const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

export function Publish({ s, go }: { s: AppState; go: (p: Page) => void }) {
  const [video, setVideo] = useState<VideoInfo | null>(null)
  const [duration, setDuration] = useState<number>()
  const [over, setOver] = useState(false)
  const [caption, setCaption] = useState('')
  const [presetIds, setPresetIds] = useState<string[]>(s.settings.defaultPresetIds)
  const [targets, setTargets] = useState<string[]>(s.activeAccountId ? [s.activeAccountId] : [])
  const [overrides, setOverrides] = useState<Record<string, string>>({})
  const [when, setWhen] = useState(false)
  const [at, setAt] = useState(epochToLocalInput(Date.now() + 3600_000))
  const [busy, setBusy] = useState(false)
  const [naming, setNaming] = useState<string | null>(null)

  const tagsOf = (ids: string[]) => ids.flatMap((id) => s.presets.find((p) => p.id === id)?.tags ?? [])
  // The user's own caption is never modified; each account's final text is composed from it.
  const finalFor = (id: string) => {
    const acct = s.accounts.find((a) => a.id === id)!
    return overrides[id] ?? applyTags(caption, [...tagsOf(presetIds), ...tagsOf(acct.defaultPresetIds)])
  }

  async function load(p: Promise<VideoInfo | null | undefined>) {
    const v = await p
    if (v) { setVideo(v); setDuration(undefined) }
  }
  const toggle = (arr: string[], set: (v: string[]) => void, id: string) => set(arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id])

  const scheduledAt = when ? localInputToEpoch(at) : undefined
  const problems = useMemo(() => {
    const p: string[] = []
    if (!video) p.push('Выберите видео.')
    if (!targets.length) p.push('Выберите хотя бы один аккаунт.')
    if (when && (!scheduledAt || scheduledAt <= Date.now())) p.push('Укажите время в будущем.')
    for (const id of targets) if (finalFor(id).length > MAX) p.push(`Описание слишком длинное для ${s.accounts.find((a) => a.id === id)?.label}.`)
    for (const id of targets) { const a = s.accounts.find((x) => x.id === id); if (a && a.session !== 'logged_in') p.push(`${a.label}: нет входа в аккаунт.`) }
    return p
  }, [video, targets, when, scheduledAt, caption, presetIds, overrides, s.accounts])

  async function submit(mode: 'now' | 'schedule' | 'draft') {
    setBusy(true)
    const ids = await call<string[]>('task:create', {
      videoPath: video!.path, mode, scheduledAt,
      items: targets.map((id) => ({ accountId: id, caption: finalFor(id) }))
    })
    setBusy(false)
    if (ids) { toast(`Создано задач: ${ids.length}`); go(mode === 'now' ? 'activity' : 'scheduled') }
  }

  return (
    <div className="grid2">
      <div className="stack">
        <div className="panel stack">
          <h2>Видео</h2>
          {!video ? (
            <div
              className={'drop' + (over ? ' over' : '')} tabIndex={0} role="button"
              onClick={() => load(call('video:pick'))}
              onKeyDown={(e) => e.key === 'Enter' && load(call('video:pick'))}
              onDragOver={(e) => { e.preventDefault(); setOver(true) }}
              onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) load(call('video:info', { path: window.api.pathFor(f) })) }}
            >
              <div className="stack" style={{ alignItems: 'center' }}><FileVideo size={26} /><span>Перетащите видео сюда или нажмите для выбора</span><span className="small">mp4, mov, webm, avi</span></div>
            </div>
          ) : (
            <>
              <video src={videoSrc(video.path)} controls onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)} onError={() => toast('Предпросмотр этого формата недоступен, но загрузка может сработать.', true)} />
              <div className="row small">
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{video.name}</span>
                <span className="muted">{fmtSize(video.size)}{duration ? ' · ' + fmtDur(duration) : ''}</span>
                <button className="btn sm" onClick={() => load(call('video:pick'))}>Заменить</button>
              </div>
              <span className="muted small">Файл остаётся на месте, копирование не выполняется.</span>
            </>
          )}
        </div>

        <div className="panel stack">
          <h2>Описание</h2>
          {s.templates.length > 0 && (
            <select value="" onChange={(e) => { const t = s.templates.find((x) => x.id === e.target.value); if (t) setCaption(t.text) }}>
              <option value="">Загрузить шаблон…</option>
              {s.templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          )}
          <textarea className="textarea" placeholder="Напишите описание…" value={caption} onChange={(e) => setCaption(e.target.value)} />
          <div className="row small muted">
            <span style={{ flex: 1 }}>{caption.length} / {MAX}</span>
            {naming === null ? (
              <button className="btn sm ghost" disabled={!caption.trim()} onClick={() => setNaming('')}>Сохранить как шаблон</button>
            ) : (
              <>
                <input className="input" style={{ width: 160 }} autoFocus placeholder="Название шаблона" value={naming} onChange={(e) => setNaming(e.target.value)} />
                <button className="btn sm" disabled={!naming.trim()} onClick={async () => { await call('template:save', { name: naming, text: caption }); setNaming(null) }}>Сохранить</button>
              </>
            )}
          </div>
          <div>
            <div className="muted small" style={{ marginBottom: 6 }}>Наборы хэштегов</div>
            {s.presets.length === 0 ? <span className="muted small">Создайте наборы в Настройках.</span> : (
              <div className="chips">{s.presets.map((p) => <button key={p.id} className={'chip' + (presetIds.includes(p.id) ? ' on' : '')} onClick={() => toggle(presetIds, setPresetIds, p.id)}>{p.name} · {p.tags.length}</button>)}</div>
            )}
          </div>
        </div>
      </div>

      <div className="stack">
        <div className="panel stack">
          <h2>Аккаунты</h2>
          {s.accounts.length === 0 && <span className="muted">Добавьте аккаунт в боковой панели.</span>}
          {s.accounts.map((a) => {
            const on = targets.includes(a.id)
            return (
              <div key={a.id} className="stack" style={{ gap: 6 }}>
                <label className="row" style={{ cursor: 'pointer' }}>
                  <input type="checkbox" checked={on} onChange={() => toggle(targets, setTargets, a.id)} />
                  <Avatar a={a} /><span style={{ flex: 1 }}>{a.label}</span>
                  {a.session !== 'logged_in' ? <span className="badge warn">Нет входа</span> : !a.verified && <span className="badge warn">Не подтверждён</span>}
                </label>
                {on && video && (
                  <div className="stack" style={{ gap: 4, paddingLeft: 24 }}>
                    <textarea className="textarea" style={{ minHeight: 64 }} value={finalFor(a.id)} onChange={(e) => setOverrides({ ...overrides, [a.id]: e.target.value })} />
                    <div className="row small muted">
                      <span style={{ flex: 1 }}>{overrides[a.id] !== undefined ? 'Своё описание для этого аккаунта' : 'Собрано из описания и наборов'}</span>
                      {overrides[a.id] !== undefined && <button className="btn sm ghost" onClick={() => { const { [a.id]: _, ...rest } = overrides; setOverrides(rest) }}><RotateCcw size={12} />Сбросить</button>}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <div className="panel stack">
          <h2>Когда</h2>
          <div className="row">
            <button className={'chip' + (!when ? ' on' : '')} onClick={() => setWhen(false)}>Опубликовать сейчас</button>
            <button className={'chip' + (when ? ' on' : '')} onClick={() => setWhen(true)}>Запланировать</button>
          </div>
          {when && (
            <label className="field"><span>Местное время ({Intl.DateTimeFormat().resolvedOptions().timeZone}). Выполняется только пока StackTok открыт.</span>
              <input className="input" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
            </label>
          )}
          {problems.length > 0 && video && <div className="small" style={{ color: 'var(--warn)' }}>{problems.join(' ')}</div>}
          <div className="row">
            <button className="btn primary" disabled={busy || problems.length > 0} onClick={() => submit(when ? 'schedule' : 'now')}>
              {when ? <CalendarClock size={14} /> : <Send size={14} />}{when ? 'Запланировать' : 'Опубликовать'} {targets.length > 1 ? `(аккаунтов: ${targets.length})` : ''}
            </button>
            <button className="btn ghost" disabled={busy || !video || !targets.length} onClick={() => submit('draft')}>Сохранить черновик</button>
          </div>
          <span className="muted small">Хэштеги — лишь подсказка и не гарантируют охват.</span>
        </div>
      </div>
    </div>
  )
}
