import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, Square, Trash2 } from 'lucide-react'
import { AppState, call } from './api'
import { Avatar } from './ui'

const CHOICES = [100, 200, 500]
const fmt = (n: number) => n.toLocaleString('ru-RU')
const when = (t?: number) => (t ? new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '—')
const clock = (ms: number) => { const t = Math.max(0, Math.round(ms / 1000)); return t >= 60 ? `${Math.floor(t / 60)} мин ${t % 60} с` : `${t} с` }

/** Full-screen repost cleanup: search with a live counter, what was found and how many to remove, then progress. */
export function RepostScreen({ s, onMin }: { s: AppState; onMin: () => void }) {
  const j = s.job!
  const acct = s.accounts.find((a) => a.id === j.accountId)
  const sum = j.summary
  const [pick, setPick] = useState<number | 'all'>('all')
  const [own, setOwn] = useState('')
  const [now, setNow] = useState(Date.now())
  const running = j.status === 'running'
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [running])
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('stacktok:modal', { detail: true })) // the native web view would draw over the screen
    return () => { window.dispatchEvent(new CustomEvent('stacktok:modal', { detail: false })) }
  }, [])

  const total = sum?.total ?? j.found
  const typed = Math.floor(Number(own))
  const count = own.trim() ? (typed > 0 ? Math.min(typed, total) : 0) : pick === 'all' ? total : Math.min(pick, total)
  const scanning = running && j.phase === 'scan'
  const left = Math.max(0, j.found - j.removed)
  const pct = j.found ? Math.round((j.removed / j.found) * 100) : 0
  const perMin = j.deleteStartedAt && j.removed ? Math.round(j.removed / Math.max(1 / 60, (now - j.deleteStartedAt) / 60000)) : 0
  const eta = running && perMin && left ? clock((left / perMin) * 60000) : ''
  const yearMax = Math.max(1, ...(sum?.years ?? []).map((y) => y.count))

  return (
    <div className="modal-bg psy-overlay">
      <div className="glass repscreen">
        <div className="row">
          {acct && <Avatar a={acct} size={40} />}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 650, fontSize: 17 }}>Удаление репостов</div>
            <div className="muted small">{acct ? acct.label + (acct.username ? ' · @' + acct.username : '') : 'аккаунт'}{j.pass && j.pass > 1 ? ` · проход ${j.pass}` : ''}</div>
          </div>
          {running ? <span className="spinner" /> : j.status === 'done' && !j.failed ? <CheckCircle2 size={24} className="ok-ic" /> : j.status === 'ready' ? null : <AlertTriangle size={24} className="warn-ic" />}
        </div>

        {scanning && <>
          <div className="rep-big"><b>{fmt(j.found)}</b><span>найдено репостов</span></div>
          <div className="rep-bar indeterminate"><i /></div>
        </>}

        {j.status === 'ready' && sum && <>
          <div className="rep-big"><b>{fmt(sum.total)}</b><span>репостов можно удалить</span></div>
          <div className="rep-tiles">
            <div><b>{fmt(sum.authors)}</b><span>авторов</span></div>
            <div><b>{fmt(sum.total - sum.photos)}</b><span>видео</span></div>
            <div><b>{fmt(sum.photos)}</b><span>фото</span></div>
            <div><b>{fmt(sum.entries)}</b><span>записей в списке</span></div>
          </div>
          <div className="rep-cols">
            {sum.top.length > 0 && <div>
              <h4>Чаще всего</h4>
              {sum.top.map((t) => <div className="rep-line" key={t.name}><span>@{t.name}</span><b>{fmt(t.count)}</b></div>)}
            </div>}
            {sum.years.length > 0 && <div>
              <h4>По годам видео</h4>
              {sum.years.slice(0, 5).map((y) => <div className="rep-year" key={y.year}><span>{y.year}</span><i style={{ width: Math.max(4, (y.count / yearMax) * 70) + '%' }} /><b>{fmt(y.count)}</b></div>)}
            </div>}
          </div>
          <div className="muted small">Видео от {when(sum.oldest)} до {when(sum.newest)}{sum.entries > sum.total + PAGE_GAP ? ' Остальные записи списка TikTok не отдаёт: их видео удалены или скрыты.' : ''}</div>
          <div>
            <div className="muted small" style={{ marginBottom: 8 }}>Сколько удалить, начиная с самых свежих в списке:</div>
            <div className="chips">
              {CHOICES.filter((n) => n < total).map((n) => <button key={n} className={'chip' + (!own && pick === n ? ' on' : '')} onClick={() => { setPick(n); setOwn('') }}>Последние {n}</button>)}
              <button className={'chip' + (!own && pick === 'all' ? ' on' : '')} onClick={() => { setPick('all'); setOwn('') }}>Все {fmt(total)}</button>
              <input className="input rep-own" type="number" min={1} max={total} placeholder="Своё число" value={own} onChange={(e) => setOwn(e.target.value)} />
            </div>
          </div>
        </>}

        {!scanning && j.status !== 'ready' && <>
          <div className="rep-big"><b>{fmt(j.removed)}</b><span>{j.found ? `удалено из ${fmt(j.found)}` : 'удалено'}</span></div>
          <div className="rep-bar"><i style={{ width: pct + '%' }} /></div>
          <div className="rep-tiles">
            <div><b>{fmt(left)}</b><span>осталось</span></div>
            <div><b>{perMin ? fmt(perMin) : '—'}</b><span>в минуту</span></div>
            <div><b className={j.returned ? 'warn-ic' : ''}>{fmt(j.returned ?? 0)}</b><span>откатилось</span></div>
            <div><b>{eta || clock((j.finishedAt ?? now) - (j.deleteStartedAt ?? j.startedAt))}</b><span>{eta ? 'ещё примерно' : 'времени'}</span></div>
          </div>
        </>}

        <div className="muted small">{j.message}</div>

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          {running && !scanning && <button className="btn" onClick={onMin}>Свернуть</button>}
          {running && <button className="btn" onClick={() => call('reposts:stop')}><Square size={14} />Остановить</button>}
          {!running && <button className="btn" onClick={() => call('reposts:dismiss')}>{j.status === 'ready' ? 'Отмена' : 'Закрыть'}</button>}
          {j.status === 'ready' && <button className="btn primary danger-fill" disabled={!count} onClick={() => call('reposts:delete', { count: count >= total ? undefined : count })}><Trash2 size={14} />Удалить {fmt(count)}</button>}
        </div>
      </div>
    </div>
  )
}

const PAGE_GAP = 30
