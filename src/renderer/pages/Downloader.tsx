import { useEffect, useRef, useState } from 'react'
import { Bookmark, Check, ClipboardPaste, Download, Eye, FolderOpen, Heart, Link2, MessageCircle, Music2, Play, RotateCw, Share2, Sparkles, Trash2, X } from 'lucide-react'
import { DlItem } from '@shared/types'
import { AppState, call, toast } from '../api'

const flag = (k: string, d: boolean) => { try { const v = localStorage.getItem(k); return v === null ? d : v === '1' } catch { return d } }
const save = (k: string, v: boolean) => { try { localStorage.setItem(k, v ? '1' : '0') } catch { /* no storage: the choice lasts until restart */ } }

const mb = (n: number) => (n >= 1e9 ? (n / 1e9).toFixed(2) : (n / 1e6).toFixed(n >= 1e7 ? 0 : 1)).replace('.', ',') + (n >= 1e9 ? ' ГБ' : ' МБ')
const count = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace('.0', '') + ' млн' : n >= 1e4 ? Math.round(n / 1e3) + ' тыс' : n.toLocaleString('ru-RU'))
const dur = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`

function Switch({ on, set }: { on: boolean; set: (v: boolean) => void }) {
  return <span className="switch"><input type="checkbox" checked={on} onChange={(e) => set(e.target.checked)} /><span className="track" /><span className="thumb" /></span>
}

/** Own TikTok downloader: a link is taken from the clipboard (or typed), the page is read, the file without the watermark is saved at its original quality. */
export function DownloaderPage({ s }: { s: AppState }) {
  const [text, setText] = useState('')
  const [auto, setAuto] = useState(() => flag('dlAuto', true)) // watch the clipboard
  const [now, setNow] = useState(() => flag('dlNow', true)) // start downloading as soon as the link is read
  const nowRef = useRef(now)
  nowRef.current = now

  useEffect(() => {
    if (!auto) return
    let busy = false
    const look = async () => {
      if (busy || !document.hasFocus()) return
      busy = true
      const link = await call<string | null>('downloader:clip', undefined, true)
      if (link) await call('downloader:add', { text: link, start: nowRef.current }, true)
      busy = false
    }
    look()
    const t = setInterval(look, 1200)
    window.addEventListener('focus', look)
    return () => { clearInterval(t); window.removeEventListener('focus', look) }
  }, [auto])

  const add = async (value: string) => {
    if (!value.trim()) return
    await call('downloader:add', { text: value, start: now })
    setText('')
  }
  const paste = async () => {
    try { await add(await navigator.clipboard.readText()) } catch { toast('Не удалось прочитать буфер обмена: вставьте ссылку в поле.', true) }
  }

  const { items, dir } = s.dl
  const ready = items.filter((i) => i.status === 'ready').length
  const finished = items.some((i) => i.status === 'done' || i.status === 'error')
  const folder = dir.split(/[\\/]/).filter(Boolean).pop() || '…'

  return (
    <div className="page dl">
      <div className="page-head">
        <div><h2>Загрузчик</h2><p>Скопируйте ссылку на видео TikTok: файл сохранится без водяного знака, в лучшем качестве, какое отдаёт TikTok.</p></div>
      </div>

      <div className="glass dl-hero">
        <div className="dl-field">
          <Link2 size={19} />
          <input placeholder="Вставьте ссылку: tiktok.com/@имя/video/… или vm.tiktok.com/…" value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') add(text) }} onPaste={(e) => { const t = e.clipboardData.getData('text'); if (t) { e.preventDefault(); add(t) } }} />
          <button className="btn" onClick={paste} title="Взять ссылку из буфера обмена"><ClipboardPaste size={16} />Из буфера</button>
          <button className="btn primary" onClick={() => add(text)} disabled={!text.trim()}><Download size={16} />{now ? 'Скачать' : 'Добавить'}</button>
        </div>
        <div className="dl-opts">
          <label className="dl-opt">
            <span className="dl-ot"><b>Ссылки из буфера</b><small>Скопировали ссылку, она появится сама</small></span>
            <Switch on={auto} set={(v) => { setAuto(v); save('dlAuto', v) }} />
          </label>
          <label className="dl-opt">
            <span className="dl-ot"><b>Скачивать сразу</b><small>Без лишнего нажатия «Скачать»</small></span>
            <Switch on={now} set={(v) => { setNow(v); save('dlNow', v) }} />
          </label>
          <button className="dl-opt" onClick={() => call('downloader:dir')} title={dir}>
            <span className="dl-ot"><b>Папка: {folder}</b><small>Нажмите, чтобы выбрать другую</small></span>
            <span className="dl-oi"><FolderOpen size={17} /></span>
          </button>
        </div>
        <div className={'dl-live' + (auto ? '' : ' off')}><i />{auto ? 'Слежу за буфером обмена, пока это окно открыто' : 'Слежение за буфером выключено'}</div>
      </div>

      {items.length === 0 && (
        <div className="glass dl-empty">
          <div className="big"><Sparkles size={32} /></div>
          <div className="tt">Пока ничего нет</div>
          <div className="muted small">{auto ? 'Скопируйте ссылку на видео в TikTok, и оно появится здесь.' : 'Вставьте ссылку в поле выше.'}</div>
          <button className="btn sm" style={{ marginTop: 6 }} onClick={() => call('downloader:reveal', {})}><FolderOpen size={15} />Открыть папку</button>
        </div>
      )}

      {(ready > 1 || finished) && (
        <div className="dl-bar">
          {ready > 1 && <button className="btn sm primary" onClick={() => call('downloader:startAll')}><Download size={15} />Скачать все ({ready})</button>}
          {finished && <button className="btn sm" onClick={() => call('downloader:clear')}><Trash2 size={15} />Убрать завершённые</button>}
          <button className="btn sm ghost" onClick={() => call('downloader:reveal', {})}><FolderOpen size={15} />Открыть папку</button>
        </div>
      )}

      <div className="dl-list">{items.map((it) => <Card key={it.id} it={it} />)}</div>
    </div>
  )
}

function Card({ it }: { it: DlItem }) {
  const pct = it.size ? Math.min(100, (it.received / it.size) * 100) : 0
  const id = { id: it.id }
  return (
    <div className={'glass dl-card ' + it.status}>
      <div className="dl-cover">{it.cover ? <img src={it.cover} alt="" referrerPolicy="no-referrer" /> : <Play size={26} />}{it.duration ? <span>{dur(it.duration)}</span> : null}</div>
      <div className="dl-body">
        {it.status === 'loading' && <><div className="dl-who">Читаю страницу видео…</div><div className="muted small" style={{ wordBreak: 'break-all' }}>{it.url}</div><div className="dl-track indeterminate"><i /></div></>}
        {it.status === 'error' && <><div className="dl-who">Не получилось</div><div className="dl-err">{it.error}</div><div className="muted small" style={{ wordBreak: 'break-all' }}>{it.url}</div></>}
        {it.status !== 'loading' && it.status !== 'error' && (
          <>
            <div className="dl-who">{it.author ? '@' + it.author : 'Видео'}{it.nickname ? <small>{it.nickname}</small> : null}</div>
            {it.desc && <div className="dl-desc">{it.desc}</div>}
            {it.tags && it.tags.length > 0 && <div className="dl-tags">{it.tags.slice(0, 12).map((t) => <span key={t} className="dl-tag" title="Скопировать" onClick={() => navigator.clipboard?.writeText('#' + t).then(() => toast('#' + t + ' скопирован'), () => {})}>#{t}</span>)}</div>}
            {it.stats && (
              <div className="dl-stats">
                <span className="dl-stat" title="Просмотры"><Eye size={13} />{count(it.stats.plays)}</span>
                <span className="dl-stat" title="Лайки"><Heart size={13} />{count(it.stats.likes)}</span>
                <span className="dl-stat" title="Комментарии"><MessageCircle size={13} />{count(it.stats.comments)}</span>
                <span className="dl-stat" title="Репосты"><Share2 size={13} />{count(it.stats.shares)}</span>
                <span className="dl-stat" title="В избранном"><Bookmark size={13} />{count(it.stats.saves)}</span>
              </div>
            )}
            <div className="dl-meta">
              {it.music && <span><Music2 size={13} />{it.music}</span>}
              {it.createdAt ? <span>{new Date(it.createdAt * 1000).toLocaleDateString('ru-RU')}</span> : null}
              <span className="dl-q">{it.quality}{it.size ? ' · ' + mb(it.size) : ''}</span>
            </div>
            {it.warning && <div className="dl-err">{it.warning}</div>}
            {it.status === 'downloading' && (
              <div className="dl-prog">
                <div className="dl-pnum"><b>{it.size ? Math.round(pct) + ' %' : mb(it.received)}</b><span>{mb(it.received)}{it.size ? ` из ${mb(it.size)}` : ''}{it.speed ? ` · ${mb(it.speed)}/с` : ''}</span></div>
                <div className={'dl-track' + (it.size ? '' : ' indeterminate')}><i style={it.size ? { width: pct + '%' } : undefined} /></div>
              </div>
            )}
            {it.status === 'done' && <div className="dl-ok"><i><Check size={12} /></i>Сохранено: {it.file} ({mb(it.size ?? it.received)})</div>}
          </>
        )}
      </div>
      <div className="dl-acts">
        {it.status === 'ready' && <button className="btn primary" onClick={() => call('downloader:start', id)}><Download size={16} />Скачать</button>}
        {it.status === 'downloading' && <button className="btn" onClick={() => call('downloader:cancel', id)}><X size={16} />Отмена</button>}
        {it.status === 'done' && <button className="btn primary" onClick={() => call('downloader:play', id)}><Play size={16} />Открыть</button>}
        {it.status === 'done' && <button className="btn" onClick={() => call('downloader:reveal', id)}><FolderOpen size={16} />В папке</button>}
        {it.status === 'error' && <button className="btn primary" onClick={() => call('downloader:add', { text: it.url, start: true })}><RotateCw size={16} />Ещё раз</button>}
        {it.status !== 'downloading' && it.status !== 'loading' && (
          <div className="row2">
            {it.status === 'done' && <button className="btn ghost round" title="Скачать ещё раз" aria-label="Скачать ещё раз" onClick={() => call('downloader:start', id)}><RotateCw size={16} /></button>}
            <button className="btn ghost round" title="Убрать из списка" aria-label="Убрать из списка" onClick={() => call('downloader:remove', id)}><Trash2 size={16} /></button>
          </div>
        )}
      </div>
    </div>
  )
}
