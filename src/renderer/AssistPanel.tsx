import { Fragment, PointerEvent as RPointerEvent, ReactNode, useEffect, useRef, useState } from 'react'
import { Copy, Download, Eraser, History as History_, Image, MessageSquarePlus, RotateCw, Send, Sparkles, Square, Trash2, X } from 'lucide-react'
import { ASSIST_COUNTS, AssistState } from '@shared/types'
import { call, toast } from './api'

const COUNT_LABEL: Record<number, string> = { 100: '100', 300: '300', 1000: '1000', 0: 'Весь' }

/** Ready questions: one click instead of typing. */
const QUICK = [
  'Как лучше ответить на последнее сообщение?',
  'Что сейчас происходит между нами? Коротко и честно',
  'Что собеседник чувствует ко мне? По каким сигналам видно',
  'Как изменилось общение: время ответов, длина, тон',
  'Где я ошибся(лась) и что делать дальше?',
  'Перескажи последние дни в 5 пунктах'
]

/** The Tools page opens the assistant through this flag: the Browse page reads it when it mounts. */
export const openAssist = () => { try { localStorage.setItem('assistOpen', '1') } catch {} window.dispatchEvent(new Event('stacktok:assist')) }
export const assistWasOpen = () => { try { return localStorage.getItem('assistOpen') === '1' } catch { return false } }

const read = (k: string, d: string) => { try { return localStorage.getItem(k) ?? d } catch { return d } }
const write = (k: string, v: string) => { try { localStorage.setItem(k, v) } catch {} }

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); toast('Скопировано') } catch { toast('Не удалось скопировать', true) }
}

// ───── tiny safe markdown: paragraphs, lists, **bold**, *italic*, `code`, headings, and ready replies as copyable cards ─────
function inline(s: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g
  let at = 0
  for (const m of s.matchAll(re)) {
    if (m.index! > at) out.push(s.slice(at, m.index))
    const t = m[0]
    out.push(t.startsWith('**') ? <b key={at}>{t.slice(2, -2)}</b> : t.startsWith('`') ? <code key={at}>{t.slice(1, -1)}</code> : <i key={at}>{t.slice(1, -1)}</i>)
    at = m.index! + t.length
  }
  if (at < s.length) out.push(s.slice(at))
  return out
}
/** A line that is a ready message: «…», "…" or “…” on its own (maybe numbered). */
const REPLY = /^\s*(?:\d+[.)]\s*|[-•*]\s*)?(?:\*\*)?[«"“„]([^«»"“”„]{2,600})[»"”](?:\*\*)?\s*$/

function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = []
  let list: { ordered: boolean; items: ReactNode[] } | null = null
  const flush = () => { if (list) { blocks.push(list.ordered ? <ol key={blocks.length}>{list.items}</ol> : <ul key={blocks.length}>{list.items}</ul>); list = null } }
  text.split('\n').forEach((raw, i) => {
    const line = raw.trimEnd()
    const reply = REPLY.exec(line)
    if (reply) {
      flush()
      const parts = reply[1].split(' / ').map((x) => x.trim()).filter(Boolean) // several short messages in a row
      blocks.push(<button key={i} className="as-reply" title="Скопировать сообщение" onClick={() => copy(parts.join('\n'))}><span>{parts.map((x, k) => <span key={k} className="as-part">{x}</span>)}</span><Copy size={13} /></button>)
      return
    }
    const h = /^#{1,4}\s+(.*)$/.exec(line)
    const li = /^\s*(?:([-•*])|(\d+)[.)])\s+(.*)$/.exec(line)
    if (li) {
      const ordered = !!li[2]
      if (!list || list.ordered !== ordered) { flush(); list = { ordered, items: [] } }
      list.items.push(<li key={i}>{inline(li[3])}</li>)
      return
    }
    flush()
    if (!line.trim()) return
    blocks.push(h ? <h5 key={i}>{inline(h[1])}</h5> : <p key={i}>{inline(line)}</p>)
  })
  flush()
  return <>{blocks}</>
}

const WIDTH = { min: 300, def: 380, free: 360 } // `free`: what the TikTok view keeps at least
const clampWidth = (w: number, row: number) => Math.round(Math.max(WIDTH.min, Math.min(w, Math.max(WIDTH.min, row - WIDTH.free))))
const when = (ms: number) => {
  const d = new Date(ms), now = new Date()
  const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return 'сегодня ' + hm
  if (new Date(now.getTime() - 86400000).toDateString() === d.toDateString()) return 'вчера ' + hm
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: d.getFullYear() === now.getFullYear() ? undefined : '2-digit' }) + ' ' + hm
}

/** The latest conversations, one click to open and go on: shown on the start screens so the history tab is rarely needed. */
function Recent({ a, all }: { a: AssistState; all: () => void }) {
  if (!a.history.length) return null
  return (
    <div className="as-recent">
      <div className="as-recent-h small muted"><span>Недавние разговоры</span><button className="linkbtn" onClick={all}>все ({a.history.length})</button></div>
      {a.history.slice(0, 4).map((t) => (
        <button key={t.id} className="as-recent-i" onClick={() => call('assist:open', { id: t.id })}>
          <b>{t.title}</b><span className="small muted">{t.partner || t.handle || 'Диалог'} · {when(t.updatedAt)}</span>
        </button>
      ))}
    </div>
  )
}

/** Saved conversations with the assistant: open one to read or go on, delete one, or all. */
function History({ a, onPick }: { a: AssistState; onPick: () => void }) {
  const [sure, setSure] = useState(false)
  if (!a.history.length) return <div className="as-empty"><p className="muted small">Здесь появятся ваши разговоры с помощником: вопросы и ответы сохраняются после каждого ответа.</p></div>
  return (
    <div className="as-list as-history">
      {!a.historySaved && <div className="as-note small">Система не даёт зашифровать историю, поэтому она хранится только до закрытия приложения.</div>}
      {a.history.map((t) => (
        <div key={t.id} className={'as-talk' + (t.id === a.talkId ? ' on' : '')}>
          <button className="as-talk-main" onClick={async () => { if (await call('assist:open', { id: t.id })) onPick() }}>
            <b>{t.title}</b>
            <span className="small muted">{t.partner || t.handle || 'Диалог'} · {when(t.updatedAt)} · {Math.ceil(t.turns / 2)} вопр.{t.here ? ' · загружена' : ''}</span>
          </button>
          <button className="btn ghost round sm" title="Удалить разговор" onClick={() => call('assist:delete', { id: t.id })}><Trash2 size={14} /></button>
        </div>
      ))}
      <button className={'btn sm' + (sure ? ' danger' : '')} style={{ alignSelf: 'center', marginTop: 6 }} onClick={() => { if (sure) { call('assist:clearHistory'); setSure(false) } else setSure(true) }} onBlur={() => setSure(false)}>
        <Trash2 size={13} />{sure ? 'Точно удалить всю историю?' : 'Очистить историю'}
      </button>
    </div>
  )
}

/** The assistant beside the TikTok view: knows the loaded chat, answers questions, suggests replies. Sends nothing anywhere but the model API. */
export function AssistPanel({ a, hasKey, signedIn, busyExport, onClose, toSettings }: { a: AssistState; hasKey: boolean; signedIn: boolean; busyExport: boolean; onClose: () => void; toSettings: () => void }) {
  const [count, setCount] = useState(() => Number(read('assistCount', '300')))
  const [pictures, setPictures] = useState(() => read('assistPictures', '1') === '1')
  const [text, setText] = useState('')
  const [showWarn, setShowWarn] = useState(false)
  const [tab, setTab] = useState<'chat' | 'history'>('chat')
  const [width, setWidth] = useState(() => Number(read('assistWidth', String(WIDTH.def))) || WIDTH.def)
  const panel = useRef<HTMLElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const loaded = !!a.loadedAt
  const busy = a.status !== 'idle'

  useEffect(() => { const el = list.current; if (el) el.scrollTop = el.scrollHeight }, [tab, a.talkId, a.turns.length, a.turns[a.turns.length - 1]?.text.length])

  // Keeps the saved width inside the window when it gets narrower.
  useEffect(() => {
    const fit = () => { const row = panel.current?.parentElement?.clientWidth; if (row) setWidth((w) => clampWidth(w, row)) }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [])

  /** Drag the left edge. The native TikTok view would swallow the mouse, so it is hidden while dragging (like under a dialog). */
  const drag = (e: RPointerEvent<HTMLDivElement>) => {
    const row = panel.current?.parentElement?.clientWidth ?? window.innerWidth
    const x0 = e.clientX, w0 = width
    let w = w0
    const grip = e.currentTarget
    grip.setPointerCapture(e.pointerId)
    window.dispatchEvent(new CustomEvent('stacktok:modal', { detail: true }))
    document.body.classList.add('as-dragging')
    const move = (ev: PointerEvent) => { w = clampWidth(w0 + x0 - ev.clientX, row); setWidth(w) }
    const up = () => {
      grip.removeEventListener('pointermove', move)
      grip.removeEventListener('pointerup', up)
      grip.removeEventListener('pointercancel', up)
      document.body.classList.remove('as-dragging')
      window.dispatchEvent(new CustomEvent('stacktok:modal', { detail: false }))
      write('assistWidth', String(w))
    }
    grip.addEventListener('pointermove', move)
    grip.addEventListener('pointerup', up)
    grip.addEventListener('pointercancel', up)
  }
  const resetWidth = () => { const row = panel.current?.parentElement?.clientWidth ?? window.innerWidth; const w = clampWidth(WIDTH.def, row); setWidth(w); write('assistWidth', String(w)) }

  const load = () => call('assist:load', { count, pictures })
  const ask = async (q: string) => {
    const t = q.trim()
    if (!t || busy || !a.canAsk) return
    setText('')
    if ((await call('assist:ask', { text: t })) === undefined) setText(t)
    area.current?.focus()
  }
  const exportTalk = () => copy(a.turns.map((t) => (t.role === 'user' ? '**Вы:** ' : '**Помощник:** ') + t.text).join('\n\n'))

  const savedNote = a.talkSource === 'saved'
    ? `копия переписки от ${a.savedAt ? when(a.savedAt) : '?'}${a.savedMessages ? `, ${a.savedMessages} сообщ.` : ''}`
    : a.talkSource === 'none' ? 'без копии переписки' : ''
  const head = savedNote
    ? <>{a.talkPartner || 'Диалог'}<span className="muted"> · {savedNote}</span></>
    : loaded
    ? <>{a.partner || a.handle || 'Диалог'}<span className="muted"> · {a.messages} сообщ.{a.first ? ` с ${a.first}` : ''}{a.pictures ? ` · ${a.pictures} картинок` : ''}</span></>
    : <span className="muted">Переписка не загружена</span>
  const counts = (
    <div className="as-opt">
      <span className="small muted">Последних сообщений</span>
      <div className="seg">{ASSIST_COUNTS.map((c) => <button key={c} className={count === c ? 'on' : ''} onClick={() => { setCount(c); write('assistCount', String(c)) }}>{COUNT_LABEL[c]}</button>)}</div>
    </div>
  )
  const canLoad = hasKey && signedIn && !busyExport && !busy

  let body: ReactNode
  if (tab === 'history') body = <History a={a} onPick={() => setTab('chat')} />
  else if (a.status === 'loading') body = (
    <div className="as-empty">
      <div className="as-spin" />
      <p>{a.loading ?? 'Загружаю…'}</p>
      <p className="muted small">Можно переключаться между страницами, окно не сворачивайте.</p>
      <button className="btn sm" onClick={() => call('assist:stop')}><Square size={13} />Стоп</button>
    </div>
  )
  else if (!loaded && !a.turns.length) body = (
    <div className="as-empty">
      <div className="orb"><Sparkles size={26} /></div>
      <h4>Помощник по переписке</h4>
      <p className="muted small">Откройте диалог слева и загрузите его. Помощник прочитает сообщения, время ответов, реакции, стикеры и обложки присланных видео и подскажет, что происходит и как ответить вашими словами, как вы обычно пишете.</p>
      {!hasKey && <div className="as-note small">Нужен ключ API: тот же, что для психопортрета. <button className="linkbtn" onClick={toSettings}>Открыть «Настройки»</button></div>}
      {counts}
      <label className="as-check small"><input type="checkbox" checked={pictures} onChange={(e) => { setPictures(e.target.checked); write('assistPictures', e.target.checked ? '1' : '0') }} /><Image size={14} />Смотреть стикеры, фото и обложки видео</label>
      <button className="btn primary" disabled={!canLoad} title={!signedIn ? 'Сначала войдите в аккаунт' : busyExport ? 'Идёт экспорт чата' : ''} onClick={load}>Загрузить переписку</button>
      <Recent a={a} all={() => setTab('history')} />
      <p className="muted small">Переписка уходит только выбранному в «Настройках» провайдеру нейросети. Разговоры с помощником и копия переписки, о которой вы спрашивали, сохраняются в историю зашифрованными, чтобы их можно было продолжить. Больше сообщений — точнее, но дороже.</p>
    </div>
  )
  else body = (
    <>
      <div className="as-list" ref={list}>
        {a.turns.length === 0 && (
          <div className="as-quick">
            <p className="muted small">Спросите что угодно о переписке или выберите вопрос:</p>
            {QUICK.map((q) => <button key={q} className="chip" disabled={busy || !hasKey} onClick={() => ask(q)}>{q}</button>)}
            <Recent a={a} all={() => setTab('history')} />
          </div>
        )}
        {a.turns.map((t, i) => (
          <Fragment key={i}>
            {t.role === 'user' ? (
              <div className="as-msg me">{t.text}</div>
            ) : (
              <div className={'as-msg bot' + (t.error ? ' err' : '')}>
                {t.text ? <Markdown text={t.text} /> : <span className="as-dots"><i /><i /><i /></span>}
                {t.text && !t.error && !(busy && i === a.turns.length - 1) && <button className="as-copy" title="Скопировать ответ" onClick={() => copy(t.text)}><Copy size={12} /></button>}
              </div>
            )}
          </Fragment>
        ))}
      </div>
      {a.talkSource === 'saved' && (
        <div className="as-resume small">
          <span>Продолжаете старый разговор: помощник видит сохранённую копию переписки{a.savedAt ? ` от ${when(a.savedAt)}` : ''}. Новых сообщений в ней нет — чтобы их учесть, откройте этот диалог слева и нажмите «Обновить».</span>
          <div className="row"><button className="btn sm" disabled={!canLoad} onClick={load}><RotateCw size={13} />Обновить из открытого диалога</button></div>
        </div>
      )}
      {a.talkSource === 'none' && (
        <div className="as-resume small">
          <span>Копия переписки для этого разговора не сохранилась (он старше этой функции): помощник помнит только сам разговор. Откройте диалог слева и обновите, чтобы он снова видел переписку.</span>
          <div className="row"><button className="btn sm" disabled={!canLoad} onClick={load}><RotateCw size={13} />Загрузить открытый диалог</button></div>
        </div>
      )}
      <div className="as-input">
        <textarea
          ref={area} className="input" rows={2} value={text} maxLength={8000} placeholder={!hasKey ? 'Сначала сохраните ключ API в «Настройках»' : a.canAsk ? 'Спросите о переписке… (Enter — отправить)' : 'Сначала загрузите переписку'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(text) } }}
        />
        {a.status === 'thinking'
          ? <button className="btn round" title="Остановить ответ" onClick={() => call('assist:stop')}><Square size={14} /></button>
          : <button className="btn primary round" title="Отправить" disabled={!text.trim() || !hasKey || !a.canAsk} onClick={() => ask(text)}><Send size={15} /></button>}
      </div>
      <div className="as-foot small muted">
        {a.model ? a.model : 'модель из «Настроек»'}{a.tokens ? ` · ${a.tokens >= 1000 ? Math.round(a.tokens / 1000) + 'k' : a.tokens} токенов` : ''}{loaded && a.complete ? ' · вся история' : ''}
        {a.status === 'thinking' && <span className="as-live">печатает…</span>}
      </div>
    </>
  )

  return (
    <aside className="glass assist" ref={panel} style={{ width }}>
      <div className="as-grip" title="Потяните, чтобы изменить ширину (двойной щелчок — обычная)" onPointerDown={drag} onDoubleClick={resetWidth} />
      <div className="as-head">
        <div className="as-title"><Sparkles size={16} /><b>Помощник</b></div>
        <span style={{ flex: 1 }} />
        {(loaded || a.talkSource === 'saved' || a.talkSource === 'none') && tab === 'chat' && <button className="btn ghost round sm" title="Обновить переписку из открытого диалога (подтянуть новые сообщения)" disabled={!canLoad} onClick={load}><RotateCw size={15} /></button>}
        {a.turns.length > 0 && tab === 'chat' && <button className="btn ghost round sm" title="Скопировать разговор с помощником" onClick={exportTalk}><Download size={15} /></button>}
        {a.turns.length > 0 && tab === 'chat' && <button className="btn ghost round sm" title="Новый разговор (переписка остаётся загруженной)" disabled={busy} onClick={() => call('assist:reset')}><MessageSquarePlus size={15} /></button>}
        <button className={'btn ghost round sm' + (tab === 'history' ? ' on' : '')} title="История разговоров" onClick={() => setTab(tab === 'history' ? 'chat' : 'history')}><History_ size={15} /></button>
        {loaded && <button className="btn ghost round sm" title="Забыть загруженную переписку (история остаётся)" disabled={busy} onClick={() => call('assist:forget')}><Eraser size={15} /></button>}
        <button className="btn ghost round sm" title="Скрыть помощника" onClick={onClose}><X size={16} /></button>
      </div>
      <div className="as-ctx small">{tab === 'history' ? <span className="muted">История разговоров · {a.history.length}</span> : head}</div>
      {tab === 'chat' && a.warnings.length > 0 && (
        <button className="as-warn small" onClick={() => setShowWarn(!showWarn)}>
          {showWarn ? a.warnings.map((w, i) => <div key={i}>{w}</div>) : `Замечания: ${a.warnings.length} (нажмите, чтобы прочитать)`}
        </button>
      )}
      {body}
    </aside>
  )
}
