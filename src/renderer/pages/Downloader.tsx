import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, Home, RotateCw } from 'lucide-react'
import { call } from '../api'

/** Third-party downloader site in a separate native view; the view is hidden while a dialog is open or the page is left. */
export function DownloaderPage() {
  const box = useRef<HTMLDivElement>(null)
  const [covered, setCovered] = useState(false)

  useEffect(() => {
    const h = (e: Event) => setCovered((e as CustomEvent<boolean>).detail)
    window.addEventListener('stacktok:modal', h)
    return () => window.removeEventListener('stacktok:modal', h)
  }, [])

  useEffect(() => {
    const el = box.current
    if (!el || covered) return
    const send = () => {
      const r = el.getBoundingClientRect()
      call('downloader:bounds', { x: r.x, y: r.y, width: r.width, height: r.height }, true)
    }
    send()
    const ro = new ResizeObserver(send)
    ro.observe(el)
    window.addEventListener('resize', send)
    return () => { ro.disconnect(); window.removeEventListener('resize', send); call('downloader:bounds', null, true) }
  }, [covered])

  const nav = (a: string) => call('downloader:nav', a)
  return (
    <>
      <div className="glass toolbar">
        <button className="btn ghost round" aria-label="Назад" onClick={() => nav('back')}><ArrowLeft size={17} /></button>
        <button className="btn ghost round" aria-label="Вперёд" onClick={() => nav('forward')}><ArrowRight size={17} /></button>
        <button className="btn ghost round" aria-label="Обновить" onClick={() => nav('reload')}><RotateCw size={16} /></button>
        <button className="btn ghost round" aria-label="Домой" onClick={() => nav('home')}><Home size={17} /></button>
        <span className="muted small" style={{ marginLeft: 8 }}>Отдельная сессия: ваши входы в TikTok сюда не попадают</span>
        <span style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => call('downloader:external')} title="Открыть страницу загрузчика в браузере по умолчанию"><ExternalLink size={15} />Открыть в браузере</button>
      </div>
      <div className="glass frame"><div className="viewport" ref={box} /></div>
    </>
  )
}
