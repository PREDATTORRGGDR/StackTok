import { ReactNode } from 'react'
import { ACCENT_COLORS, ACCENTS, BACKGROUNDS, BG_COLORS, GLASS_MATERIALS, CHAT_TEXT_SIZES, CHAT_WALLPAPERS, Settings, THEMES } from '@shared/types'
import { AppState, call } from '../api'

const THEME_LABEL = { dark: 'Тёмная', light: 'Светлая', system: 'Системная' }
const ACCENT_LABEL = { blue: 'Синий', violet: 'Фиолетовый', pink: 'Розовый', red: 'Красный', orange: 'Оранжевый', yellow: 'Жёлтый', lime: 'Лайм', green: 'Зелёный', teal: 'Бирюзовый', cyan: 'Голубой' }
const BG_LABEL = { clear: 'Чистое', aurora: 'Аврора', sunset: 'Закат', ocean: 'Океан', graphite: 'Графит', forest: 'Лес', rose: 'Роза', midnight: 'Полночь', lavender: 'Лаванда', mint: 'Мята', ember: 'Жар', mono: 'Моно', custom: 'Свой' }
const MATERIAL_LABEL = { acrylic: 'Акрил', mica: 'Слюда', tabbed: 'Слюда+' }
const trio = (c: readonly string[]) => `linear-gradient(135deg,${c[0]},${c[1]} 55%,${c[2]})`
const BG_GRADIENT: Record<string, string> = {
  clear: 'repeating-conic-gradient(rgba(255,255,255,.22) 0% 25%, rgba(255,255,255,.06) 0% 50%) 0 0/14px 14px',
  ...Object.fromEntries(Object.entries(BG_COLORS).map(([k, v]) => [k, trio(v)]))
}

const TEXT_LABEL = { small: 'Мелкий', normal: 'Обычный', large: 'Крупный' }
const WALLPAPERS = CHAT_WALLPAPERS.filter((w) => w !== 'custom')
const isHex = (v: string) => /^#[0-9a-f]{6}$/i.test(v)

/** Palette button + hex field: any colour, applied as soon as it is valid. */
function ColorPick({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className="colorpick" title={label}>
      <input type="color" value={isHex(value) ? value : '#4d8dff'} aria-label={label} onChange={(e) => onChange(e.target.value)} />
      <span style={{ background: isHex(value) ? value : 'transparent' }} />
    </label>
  )
}
const WP_LABEL: Record<string, string> = { none: 'Без обоев', ...BG_LABEL }
const WP_GRADIENT: Record<string, string> = { none: 'transparent', ...BG_GRADIENT }

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
        <Row label="Акцентный цвет" hint="Готовые цвета или любой свой из палитры">
          <div className="swatches">
            {ACCENTS.map((a) => <button key={a} title={ACCENT_LABEL[a]} aria-label={ACCENT_LABEL[a]} className={'swatch' + (!st.accentColor && st.accent === a ? ' on' : '')} style={{ background: `linear-gradient(145deg, ${ACCENT_COLORS[a]}, ${ACCENT_COLORS[a]}aa)` }} onClick={() => set({ accent: a, accentColor: '' })} />)}
            <ColorPick label="Свой цвет" value={st.accentColor} onChange={(v) => set({ accentColor: v })} />
          </div>
        </Row>
        <Row label="Фон" hint="«Чистое» — настоящая прозрачность: стекло показывает рабочий стол. «Свой» — три цвета из палитры">
          <div className="bgs">{BACKGROUNDS.map((b) => <button key={b} className={'bgtile' + (st.background === b ? ' on' : '')} style={{ background: b === 'custom' ? trio(st.bgCustom) : BG_GRADIENT[b] }} onClick={() => set({ background: b })}><span>{BG_LABEL[b]}</span></button>)}</div>
        </Row>
        {st.background === 'custom' && (
          <Row label="Цвета фона" hint="Три световых пятна за стеклом">
            <div className="swatches">{st.bgCustom.map((c, i) => <ColorPick key={i} label={'Пятно ' + (i + 1)} value={c} onChange={(v) => set({ bgCustom: st.bgCustom.map((x, j) => (j === i ? v : x)) as [string, string, string] })} />)}</div>
          </Row>
        )}
        {st.background === 'clear' ? (
          <Row label="Материал окна" hint="Акрил размывает рабочий стол, но становится плоским, когда окно не в фокусе. Слюда этого не делает">
            <div className="seg">{GLASS_MATERIALS.map((m) => <button key={m} className={st.glassMaterial === m ? 'on' : ''} onClick={() => set({ glassMaterial: m })}>{MATERIAL_LABEL[m]}</button>)}</div>
          </Row>
        ) : (
          <Row label="Движение света" hint="Фоновые пятна медленно плывут. Выключите, если нужна статика">
            <label className="switch"><input type="checkbox" checked={st.motion} onChange={(e) => set({ motion: e.target.checked })} /><span className="track" /><span className="thumb" /></label>
          </Row>
        )}
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
        <h4>Чаты TikTok</h4>
        <Row label="Оформление чатов" hint="Стекло и мягкие скругления на странице сообщений TikTok. Логику сайта не трогает">
          <label className="switch"><input type="checkbox" checked={st.chatOverlay} onChange={(e) => set({ chatOverlay: e.target.checked })} /><span className="track" /><span className="thumb" /></label>
        </Row>
        <Row label="Обои чатов" hint={st.chatWallpaper === 'custom' ? 'Выбрана своя картинка' : 'Лёгкий узор поверх страницы сообщений'}>
          <div className="bgs">{WALLPAPERS.map((w) => <button key={w} className={'bgtile' + (st.chatWallpaper === w ? ' on' : '') + (w === 'none' ? ' none' : '')} style={{ background: WP_GRADIENT[w] }} onClick={() => set({ chatWallpaper: w })}><span>{WP_LABEL[w]}</span></button>)}</div>
        </Row>
        <Row label="Затемнение обоев" hint="Чем больше, тем лучше читается текст поверх картинки">
          <input className="slider" type="range" min={0} max={100} value={st.chatDim} style={{ ['--p' as string]: st.chatDim + '%' }} onChange={(e) => set({ chatDim: Number(e.target.value) })} />
        </Row>
        <Row label="Размер текста в чатах">
          <div className="seg">{CHAT_TEXT_SIZES.map((t) => <button key={t} className={st.chatTextSize === t ? 'on' : ''} onClick={() => set({ chatTextSize: t })}>{TEXT_LABEL[t]}</button>)}</div>
        </Row>
        <Row label="Режим приватности" hint="Имена, превью и сообщения размыты, пока не наведёте мышь. Удобно при записи экрана">
          <label className="switch"><input type="checkbox" checked={st.chatPrivacy} onChange={(e) => set({ chatPrivacy: e.target.checked })} /><span className="track" /><span className="thumb" /></label>
        </Row>
        <Row label="Своя картинка" hint="PNG, JPG или WebP до 2 МБ">
          <div className="row">
            <button className="btn" onClick={() => call('chat:wallpaperPick')}>Выбрать файл…</button>
            <button className="btn" disabled={st.chatWallpaper === 'none'} onClick={() => call('chat:wallpaperReset')}>Сбросить</button>
          </div>
        </Row>
      </div>

      <div className="glass group">
        <h4>Данные</h4>
        <Row label="Папка данных" hint="Список аккаунтов, обои чатов и профили браузера (входы). Храните копию приватно.">
          <button className="btn" onClick={() => call('data:open')}>Открыть папку</button>
        </Row>
        <div style={{ padding: '0 0 14px' }}><code>{s.dataPath}</code></div>
      </div>

      <p className="muted small" style={{ textAlign: 'center' }}>StackTok {s.version}</p>
    </div>
  )
}
