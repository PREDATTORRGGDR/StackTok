import { ReactNode } from 'react'
import { ACCENTS, BACKGROUNDS, Settings, THEMES } from '@shared/types'
import { AppState, call } from '../api'

const THEME_LABEL = { dark: 'Тёмная', light: 'Светлая', system: 'Системная' }
const ACCENT_COLOR = { blue: '#4d8dff', violet: '#9b6bff', pink: '#ff5c93', orange: '#ff9340', green: '#35d49a' }
const BG_LABEL = { clear: 'Чистое', aurora: 'Аврора', sunset: 'Закат', ocean: 'Океан', graphite: 'Графит' }
const BG_GRADIENT = {
  clear: 'repeating-conic-gradient(rgba(255,255,255,.22) 0% 25%, rgba(255,255,255,.06) 0% 50%) 0 0/14px 14px',
  aurora: 'linear-gradient(135deg,#2f5bff,#8a3dff 55%,#00c2c7)',
  sunset: 'linear-gradient(135deg,#ff5a7a,#ff9a3d 55%,#8d3dff)',
  ocean: 'linear-gradient(135deg,#0a84ff,#00c2c7 55%,#3d5bff)',
  graphite: 'linear-gradient(135deg,#4b5160,#2a2f3b 55%,#646c80)'
}

const Row = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
  <div className="setting">
    <div><div className="label">{label}</div>{hint && <div className="hint">{hint}</div>}</div>
    {children}
  </div>
)

export function SettingsPage({ s }: { s: AppState }) {
  const st = s.settings
  const set = (v: Partial<Settings>) => call('settings:set', v)

  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <div className="page-head"><div><h2>Настройки</h2><p>Внешний вид и поведение приложения.</p></div></div>

      <div className="glass group">
        <h4>Внешний вид</h4>
        <Row label="Тема">
          <div className="seg">{THEMES.map((t) => <button key={t} className={st.theme === t ? 'on' : ''} onClick={() => set({ theme: t })}>{THEME_LABEL[t]}</button>)}</div>
        </Row>
        <Row label="Акцентный цвет">
          <div className="swatches">{ACCENTS.map((a) => <button key={a} aria-label={a} className={'swatch' + (st.accent === a ? ' on' : '')} style={{ background: `linear-gradient(145deg, ${ACCENT_COLOR[a]}, ${ACCENT_COLOR[a]}aa)` }} onClick={() => set({ accent: a })} />)}</div>
        </Row>
        <Row label="Фон" hint="«Чистое» — настоящая прозрачность: стекло показывает ваш рабочий стол">
          <div className="bgs">{BACKGROUNDS.map((b) => <button key={b} className={'bgtile' + (st.background === b ? ' on' : '')} style={{ background: BG_GRADIENT[b] }} onClick={() => set({ background: b })}><span>{BG_LABEL[b]}</span></button>)}</div>
        </Row>
        <Row label="Матовость стекла" hint="Сила размытия и плотность панелей">
          <input className="slider" type="range" min={0} max={100} value={st.glass} style={{ ['--p' as string]: st.glass + '%' }} onChange={(e) => set({ glass: Number(e.target.value) })} />
        </Row>
      </div>

      <div className="glass group">
        <h4>Поведение</h4>
        <Row label="Помнить последний аккаунт" hint="При запуске сразу открывать TikTok с прошлого аккаунта">
          <label className="switch"><input type="checkbox" checked={st.restoreLast} onChange={(e) => set({ restoreLast: e.target.checked })} /><span className="track" /><span className="thumb" /></label>
        </Row>
        <Row label="Без звука при открытии" hint="Видео не запускаются сами и не кричат при входе в аккаунт. Звук включается кнопкой в «Обзоре»">
          <label className="switch"><input type="checkbox" checked={st.muteByDefault} onChange={(e) => set({ muteByDefault: e.target.checked })} /><span className="track" /><span className="thumb" /></label>
        </Row>
      </div>

      <div className="glass group">
        <h4>Данные</h4>
        <Row label="Папка данных" hint="Список аккаунтов и профили браузера (входы). Храните копию приватно.">
          <button className="btn" onClick={() => call('data:open')}>Открыть папку</button>
        </Row>
        <div style={{ padding: '0 0 14px' }}><code>{s.dataPath}</code></div>
      </div>

      <p className="muted small" style={{ textAlign: 'center' }}>StackTok {s.version}</p>
    </div>
  )
}
