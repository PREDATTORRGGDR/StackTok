import { useEffect, useRef, useState } from 'react'
import { Check, ClipboardPaste, Download, Eye, FolderOpen, Heart, Link2, MessageCircle, Music, Pause, Play, Repeat2, RotateCw, Trash2, X } from 'lucide-react'
import { ScItem } from '@shared/types'
import { AppState, call, toast } from '../api'

const flag = (k: string, d: boolean) => { try { const v = localStorage.getItem(k); return v === null ? d : v === '1' } catch { return d } }
const save = (k: string, v: boolean) => { try { localStorage.setItem(k, v ? '1' : '0') } catch { /* no storage: the choice lasts until restart */ } }

const mb = (n: number) => (n >= 1e9 ? (n / 1e9).toFixed(2) : (n / 1e6).toFixed(n >= 1e7 ? 0 : 1)).replace('.', ',') + (n >= 1e9 ? ' ГБ' : ' МБ')
const count = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace('.0', '') + ' млн' : n >= 1e4 ? Math.round(n / 1e3) + ' тыс' : n.toLocaleString('ru-RU'))
const dur = (s: number) => { const h = Math.floor(s / 3600); return (h ? h + ':' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') : Math.floor(s / 60)) + ':' + String(Math.round(s % 60)).padStart(2, '0') }

function Switch({ on, set }: { on: boolean; set: (v: boolean) => void }) {
  return <span className="switch"><input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} /><span className="track" /><span className="thumb" /></span>
}

/** SoundCloud downloader: a track or set link (typed or taken from the clipboard) → the best audio is saved with title, artist and cover in the tag. */
export function SoundCloudPage({ s }: { s: AppState }) {
  const [text, setText] = useState('')
  const [auto, setAuto] = useState(() => flag('scAuto', true))
  const [now, setNow] = useState(() => flag('scNow', true))
  const [playId, setPlayId] = useState<string | null>(null)
  const nowRef = useRef(now)
  nowRef.current = now

  useEffect(() => {
    if (!auto) return
    let busy = false
    const look = async () => {
      if (busy || !document.hasFocus()) return
      busy = true
      const link = await call<string | null>('soundcloud:clip', undefined, true)
      if (link) await call('soundcloud:add', { text: link, start: nowRef.current }, true)
      busy = false
    }
    look()
    const t = setInterval(look, 1200)
    window.addEventListener('focus', look)
    return () => { clearInterval(t); window.removeEventListener('focus', look) }
  }, [auto])

  const add = async (value: string) => {
    if (!value.trim()) return
    await call('soundcloud:add', { text: value, start: now })
    setText('')
  }
  const paste = async () => {
    try { await add(await navigator.clipboard.readText()) } catch { toast('Не удалось прочитать буфер обмена: вставьте ссылку в поле.', true) }
  }

  const { items, dir } = s.sc
  const ready = items.filter((i) => i.status === 'ready').length
  const finished = items.some((i) => i.status === 'done' || i.status === 'error')
  const folder = dir.split(/[\\/]/).filter(Boolean).pop() || '…'

  return (
    <div className="page dl sc">
      <div className="page-head">
        <div><h2>Загрузчик SoundCloud</h2><p>Скопируйте ссылку на трек или подборку: файл сохранится в лучшем качестве, с названием, исполнителем и обложкой в теге.</p></div>
      </div>

      <div className="glass dl-hero">
        <div className="dl-field">
          <Link2 size={19} />
          <input placeholder="Вставьте ссылку: soundcloud.com/артист/трек или on.soundcloud.com/…" value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add(text) }} onPaste={(e) => { const t = e.clipboardData.getData('text'); if (t) { e.preventDefault(); add(t) } }} />
          <button className="btn" onClick={paste} title="Взять ссылку из буфера обмена"><ClipboardPaste size={16} />Из буфера</button>
          <button className="btn primary" onClick={() => add(text)} disabled={!text.trim()}><Download size={16} />{now ? 'Скачать' : 'Добавить'}</button>
        </div>
        <div className="dl-opts">
          <label className="dl-opt">
            <span className="dl-ot"><b>Ссылки из буфера</b><small>Скопировали ссылку, она появится сама</small></span>
            <Switch on={auto} set={(v) => { setAuto(v); save('scAuto', v) }} />
          </label>
          <label className="dl-opt">
            <span className="dl-ot"><b>Скачивать сразу</b><small>Без лишнего нажатия «Скачать»</small></span>
            <Switch on={now} set={(v) => { setNow(v); save('scNow', v) }} />
          </label>
          <button className="dl-opt" onClick={() => call('soundcloud:dir')} title={dir}>
            <span className="dl-ot"><b>Папка: {folder}</b><small>Нажмите, чтобы выбрать другую</small></span>
            <span className="dl-oi"><FolderOpen size={17} /></span>
          </button>
        </div>
        <div className={'dl-live' + (auto ? '' : ' off')}><i />{auto ? 'Слежу за буфером обмена, пока это окно открыто' : 'Слежение за буфером выключено'}</div>
      </div>

      {items.length === 0 && (
        <div className="glass dl-empty">
          <div className="big"><Music size={32} /></div>
          <div className="tt">Пока ничего нет</div>
          <div className="muted small">{auto ? 'Скопируйте ссылку на трек в SoundCloud, и он появится здесь.' : 'Вставьте ссылку в поле выше.'} Подборки (sets) добавляются все сразу.</div>
          <button className="btn sm" style={{ marginTop: 6 }} onClick={() => call('soundcloud:reveal', {})}><FolderOpen size={15} />Открыть папку</button>
        </div>
      )}

      {(ready > 1 || finished) && (
        <div className="dl-bar">
          {ready > 1 && <button className="btn sm primary" onClick={() => call('soundcloud:startAll')}><Download size={15} />Скачать все ({ready})</button>}
          {finished && <button className="btn sm" onClick={() => call('soundcloud:clear')}><Trash2 size={15} />Убрать завершённые</button>}
          <button className="btn sm ghost" onClick={() => call('soundcloud:reveal', {})}><FolderOpen size={15} />Открыть папку</button>
        </div>
      )}

      <div className="dl-list">{items.map((it) => <Card key={it.id} it={it} open={playId === it.id} listen={() => setPlayId(playId === it.id ? null : it.id)} />)}</div>
    </div>
  )
}

function Card({ it, open, listen }: { it: ScItem; open: boolean; listen: () => void }) {
  const id = { id: it.id }
  const known = it.pct >= 0
  return (
    <div className={'glass dl-card sc-card ' + it.status}>
      <div className="dl-cover sq">{it.cover ? <img src={it.cover} alt="" referrerPolicy="no-referrer" /> : <Music size={28} />}{it.duration ? <span>{dur(it.duration)}</span> : null}</div>
      <div className="dl-body">
        {it.status === 'loading' && <><div className="dl-who">Читаю трек…</div><div className="muted small" style={{ wordBreak: 'break-all' }}>{it.url}</div><div className="dl-track indeterminate"><i /></div></>}
        {it.status === 'error' && <><div className="dl-who">Не получилось</div><div className="dl-err">{it.error}</div><div className="muted small" style={{ wordBreak: 'break-all' }}>{it.url}</div></>}
        {it.status !== 'loading' && it.status !== 'error' && (
          <>
            <div className="dl-who">{it.title || 'Трек'}</div>
            <div className="dl-desc">{it.artist}</div>
            {((it.tags && it.tags.length > 0) || it.genre) && (
              <div className="dl-tags">
                {it.genre && <span className="dl-tag">{it.genre}</span>}
                {(it.tags ?? []).filter((t) => t.toLowerCase() !== (it.genre ?? '').toLowerCase()).slice(0, 8).map((t) => <span key={t} className="dl-tag" title="Скопировать" onClick={() => navigator.clipboard?.writeText(t).then(() => toast(t + ' скопирован'), () => {})}>{t}</span>)}
              </div>
            )}
            {it.stats && (
              <div className="dl-stats">
                <span className="dl-stat" title="Прослушивания"><Eye size={13} />{count(it.stats.plays)}</span>
                <span className="dl-stat" title="Лайки"><Heart size={13} />{count(it.stats.likes)}</span>
                <span className="dl-stat" title="Комментарии"><MessageCircle size={13} />{count(it.stats.comments)}</span>
                <span className="dl-stat" title="Репосты"><Repeat2 size={13} />{count(it.stats.reposts)}</span>
              </div>
            )}
            <div className="dl-meta">
              {it.createdAt ? <span>{new Date(it.createdAt).toLocaleDateString('ru-RU')}</span> : null}
              <span className="dl-q">{it.quality}{it.size ? ' · ' + mb(it.size) : ''}</span>
            </div>
            {it.warning && <div className="dl-err">{it.warning}</div>}
            {it.status === 'downloading' && (
              <div className="dl-prog">
                <div className="dl-pnum"><b>{known ? Math.round(it.pct) + ' %' : mb(it.received)}</b><span>{mb(it.received)}{it.size ? ` из ${mb(it.size)}` : ''}{it.speed ? ` · ${mb(it.speed)}/с` : ''}</span></div>
                <div className={'dl-track' + (known ? '' : ' indeterminate')}><i style={known ? { width: it.pct + '%' } : undefined} /></div>
              </div>
            )}
            {it.status === 'done' && <div className="dl-ok"><i><Check size={12} /></i>Сохранено: {it.file} ({mb(it.size ?? it.received)})</div>}
            {it.status === 'done' && open && <Player id={it.id} total={it.duration ?? 0} mse={/\.m4a$/i.test(it.file ?? '')} />}
          </>
        )}
      </div>
      <div className="dl-acts">
        {it.status === 'ready' && <button className="btn primary" onClick={() => call('soundcloud:start', id)}><Download size={16} />Скачать</button>}
        {it.status === 'downloading' && <button className="btn" onClick={() => call('soundcloud:cancel', id)}><X size={16} />Отмена</button>}
        {it.status === 'done' && <button className={'btn primary' + (open ? ' on' : '')} onClick={listen}>{open ? <Pause size={16} /> : <Play size={16} />}{open ? 'Закрыть плеер' : 'Слушать'}</button>}
        {it.status === 'done' && <button className="btn" onClick={() => call('soundcloud:reveal', id)}><FolderOpen size={16} />В папке</button>}
        {it.status === 'error' && <button className="btn primary" onClick={() => call('soundcloud:add', { text: it.url, start: true })}><RotateCw size={16} />Ещё раз</button>}
        {it.status !== 'downloading' && it.status !== 'loading' && (
          <div className="row2">
            {it.status === 'done' && <button className="btn ghost round" title="Скачать ещё раз" aria-label="Скачать ещё раз" onClick={() => call('soundcloud:start', id)}><RotateCw size={16} /></button>}
            <button className="btn ghost round" title="Убрать из списка" aria-label="Убрать из списка" onClick={() => call('soundcloud:remove', id)}><Trash2 size={16} /></button>
          </div>
        )}
      </div>
    </div>
  )
}

const clock = (s: number) => (Number.isFinite(s) ? Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0') : '0:00')

/** Built-in player: the file is served by main under stacktok-audio://, seeking works. */
function Player({ id, total, mse }: { id: string; total: number; mse: boolean }) {
  const a = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [cur, setCur] = useState(0)
  const [len, setLen] = useState(total)
  const [bad, setBad] = useState(false)
  // A fragmented m4a (what SoundCloud's HLS gives) has no total length in the file, so the browser stops at the first piece and cannot seek: feed it through MediaSource instead.
  useEffect(() => {
    const e = a.current
    if (!mse || !e) return
    const ms = new MediaSource(), url = URL.createObjectURL(ms)
    let dead = false
    e.src = url
    ms.addEventListener('sourceopen', async () => {
      try {
        const buf = await (await fetch(`stacktok-audio://a/${id}`)).arrayBuffer()
        if (dead) return
        const sb = ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"')
        sb.addEventListener('updateend', () => { if (!dead && ms.readyState === 'open') { try { ms.endOfStream(); e.play().catch(() => {}) } catch { setBad(true) } } }, { once: true })
        sb.appendBuffer(buf)
      } catch { setBad(true) }
    }, { once: true })
    return () => { dead = true; e.pause(); URL.revokeObjectURL(url) }
  }, [id, mse])
  const toggle = () => { const e = a.current; if (!e) return; if (e.paused) e.play().catch(() => setBad(true)); else e.pause() }
  return (
    <div className="sc-player">
      <audio ref={a} src={mse ? undefined : `stacktok-audio://a/${id}`} autoPlay={!mse} preload="auto"
        onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setCur(0) }} onError={() => setBad(true)}
        onTimeUpdate={(e) => setCur(e.currentTarget.currentTime)} onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setLen(e.currentTarget.duration)} />
      <button className="btn round primary" onClick={toggle} aria-label={playing ? 'Пауза' : 'Играть'}>{playing ? <Pause size={17} /> : <Play size={17} />}</button>
      <span className="sc-time">{clock(cur)}</span>
      <input type="range" min={0} max={len || 1} step={0.1} value={Math.min(cur, len || 1)} style={{ '--p': len ? (cur / len) * 100 + '%' : '0%' } as React.CSSProperties}
        onChange={(e) => { if (a.current) a.current.currentTime = Number(e.target.value) }} aria-label="Перемотка" />
      <span className="sc-time">{clock(len)}</span>
      {bad && <span className="dl-err">Не удалось проиграть этот формат. Откройте файл из папки.</span>}
    </div>
  )
}
