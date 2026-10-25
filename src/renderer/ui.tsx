import { ReactNode, useEffect } from 'react'

export type Person = { id?: string; label: string; avatar?: string }

const hue = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)

/** Photo when known, otherwise a gradient derived from the account id so every account is recognisable. */
export function Avatar({ a, size = 34 }: { a: Person; size?: number }) {
  const h = hue(a.id ?? a.label)
  return (
    <div className="avatar" style={{ ['--s' as string]: size + 'px', background: `linear-gradient(145deg, hsl(${h} 85% 64%), hsl(${(h + 45) % 360} 80% 46%))` }}>
      {a.avatar ? <img src={a.avatar} alt="" referrerPolicy="no-referrer" /> : a.label.trim().slice(0, 2).toUpperCase()}
    </div>
  )
}

export function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    window.dispatchEvent(new CustomEvent('stacktok:modal', { detail: true })) // the native web view would draw over the dialog
    return () => { window.removeEventListener('keydown', k); window.dispatchEvent(new CustomEvent('stacktok:modal', { detail: false })) }
  }, [onClose])
  return (
    <div className="modal-bg" onMouseDown={onClose}>
      <div className="glass modal stack" onMouseDown={(e) => e.stopPropagation()}>{children}</div>
    </div>
  )
}

export const statusText = (a: { session: string; verified: boolean; username?: string }) =>
  a.session === 'logged_in' ? (a.verified ? (a.username ? '@' + a.username : 'Вход выполнен') : 'Нужно подтвердить') : 'Не авторизован'
