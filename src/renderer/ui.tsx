import { ReactNode, useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'

export type Person = { id?: string; label: string; avatar?: string }

const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)

/** Photo when known, otherwise a gradient derived from the account id so every account is recognisable. */
export function Avatar({ a, size = 34 }: { a: Person; size?: number }) {
  const h = hue(a.id ?? a.label)
  const [bad, setBad] = useState<string>() // an expired link shows the letters until a fresh one arrives
  return (
    <div className="avatar" style={{ ['--s' as string]: size + 'px', background: `linear-gradient(145deg, hsl(${h} 85% 64%), hsl(${(h + 45) % 360} 80% 46%))` }}>
      {a.avatar && a.avatar !== bad ? <img src={a.avatar} alt="" referrerPolicy="no-referrer" onError={() => setBad(a.avatar)} /> : a.label.trim().slice(0, 2).toUpperCase()}
    </div>
  )
}

export function Modal({ children, onClose, wide }: { children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    window.dispatchEvent(new CustomEvent('stacktok:modal', { detail: true })) // the native web view would draw over the dialog
    return () => { window.removeEventListener('keydown', k); window.dispatchEvent(new CustomEvent('stacktok:modal', { detail: false })) }
  }, [onClose])
  return (
    <div className="modal-bg" onMouseDown={onClose}>
      <div className={'glass modal stack' + (wide ? ' wide' : '')} onMouseDown={(e) => e.stopPropagation()}>{children}</div>
    </div>
  )
}

export const statusText = (a: { session: string; verified: boolean; username?: string }) =>
  a.session === 'logged_in' ? (a.verified ? (a.username ? '@' + a.username : 'Р’С…РѕРґ РІС‹РїРѕР»РЅРµРЅ') : 'РќСѓР¶РЅРѕ РїРѕРґС‚РІРµСЂРґРёС‚СЊ') : 'РќРµ Р°РІС‚РѕСЂРёР·РѕРІР°РЅ'

/** Our own dropdown instead of the native <select>: the system list is white, unthemed and ignores the glass look. */
export function Select({ value, options, onChange, align = 'left', label }: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void; align?: 'left' | 'right'; label?: string }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    window.addEventListener('mousedown', down)
    window.addEventListener('keydown', key, true)
    return () => { window.removeEventListener('mousedown', down); window.removeEventListener('keydown', key, true) }
  }, [open])
  const cur = options.find((o) => o.value === value)
  return (
    <div className="sel" ref={box}>
      <button type="button" className="sel-btn" aria-haspopup="listbox" aria-expanded={open} aria-label={label} onClick={() => setOpen((o) => !o)}>
        <span className="sel-cur">{cur?.label ?? 'вЂ”'}</span><ChevronDown size={15} />
      </button>
      {open && (
        <div className={'sel-list ' + align} role="listbox">
          {options.map((o) => <button type="button" role="option" aria-selected={o.value === value} key={o.value} className={o.value === value ? 'on' : ''} onClick={() => { setOpen(false); onChange(o.value) }}>{o.label}</button>)}
        </div>
      )}
    </div>
  )
}
