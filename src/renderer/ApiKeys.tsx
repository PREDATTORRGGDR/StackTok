import { useState } from 'react'
import { Check, KeyRound, Pencil, Plus, RefreshCw, Trash2, Wallet } from 'lucide-react'
import { ApiProfile, PSY_PRESETS, PSY_PRESET_INFO, activeProfile } from '@shared/types'
import { AppState, call } from './api'

const PRESET_LABEL = { anthropic: 'Claude', openai: 'OpenAI', gemini: 'Gemini', openrouter: 'OpenRouter', deepseek: 'DeepSeek', custom: 'Свой адрес' }

/** 1 234 · 45 тыс. · 1,2 млн */
export const tokens = (n: number) =>
  n >= 1e6 ? (n / 1e6).toLocaleString('ru-RU', { maximumFractionDigits: n >= 1e7 ? 0 : 1 }) + ' млн' : n >= 1e4 ? Math.round(n / 1e3) + ' тыс.' : n.toLocaleString('ru-RU')
const day = (ms: number) => new Date(ms).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
const time = (ms: number) => new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="kf"><span className="kf-l">{label}</span>{children}{hint && <span className="hint">{hint}</span>}</label>
}

/** Editing one profile: provider, address, models and its key. Saved field by field (on leaving the field). */
function Editor({ p, s, onDone }: { p: ApiProfile; s: AppState; onDone: () => void }) {
  const [key, setKey] = useState('')
  const info = PSY_PRESET_INFO[p.preset]
  const has = s.apiKeys.includes(p.id)
  const upd = (patch: Partial<ApiProfile>) => call('api:update', { id: p.id, patch })
  const saveKey = async () => { if ((await call('api:key', { id: p.id, key: key.trim() })) !== undefined) { setKey(''); call('api:check', { id: p.id }, true) } }
  const k = p.id + p.preset // fresh placeholders when the provider changes
  return (
    <div className="keyedit">
      <Field label="Название"><input className="input" defaultValue={p.name} maxLength={40} onBlur={(e) => e.target.value.trim() && upd({ name: e.target.value })} /></Field>
      <Field label="Провайдер" hint="Подойдёт любой сервис с форматом OpenAI или Claude: перепродавцы, шлюзы и локальные модели — через «Свой адрес»">
        <div className="seg wrap">{PSY_PRESETS.map((x) => <button key={x} className={p.preset === x ? 'on' : ''} onClick={() => upd({ preset: x })}>{PRESET_LABEL[x]}</button>)}</div>
      </Field>
      {p.preset === 'custom' && <Field label="Адрес API" hint="Например https://api.example.com/v1 (без /chat/completions)"><input className="input" key={'b' + k} defaultValue={p.base} placeholder="https://…/v1" onBlur={(e) => upd({ base: e.target.value })} /></Field>}
      <Field label="Ключ API" hint={has ? 'Сохранён и зашифрован средствами Windows. Приложение его не показывает' : 'Хранится только в зашифрованном виде на этом компьютере'}>
        <div className="row">
          <input className="input" type="password" value={key} placeholder={has ? '•••••••• (вставьте новый, чтобы заменить)' : 'sk-…'} autoComplete="off" onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && key.trim() && saveKey()} />
          <button className="btn" disabled={!key.trim()} onClick={saveKey}>Сохранить</button>
          <button className="btn" disabled={!has} onClick={() => call('api:key', { id: p.id, key: null })}>Убрать</button>
        </div>
      </Field>
      <div className="kgrid">
        <Field label="Модель для картинок" hint="Обложки репостов, стикеры и фото чата: дешёвая, с картинками"><input className="input" key={'v' + k} defaultValue={p.vision} placeholder={info.vision || 'название модели'} onBlur={(e) => upd({ vision: e.target.value })} /></Field>
        <Field label="Модель для портрета" hint="Пишет отчёт: посильнее"><input className="input" key={'s' + k} defaultValue={p.synth} placeholder={info.synth || 'название модели'} onBlur={(e) => upd({ synth: e.target.value })} /></Field>
        <Field label="Модель помощника" hint="Пусто — та же, что для портрета"><input className="input" key={'a' + k} defaultValue={p.assist} placeholder={p.synth || info.synth || 'название модели'} onBlur={(e) => upd({ assist: e.target.value })} /></Field>
      </div>
      <div className="row wrap">
        <button className="btn primary sm" onClick={onDone}><Check size={14} />Готово</button>
        {s.apiUsage[p.id] && <button className="btn sm" onClick={() => call('api:resetUsage', { id: p.id })}>Обнулить счётчик</button>}
        {s.settings.apiProfiles.length > 1 && <button className="btn sm" onClick={() => call('api:remove', { id: p.id })}><Trash2 size={13} />Удалить ключ</button>}
      </div>
    </div>
  )
}

/** Connected model APIs: several keys, one active; tokens spent through the app and the balance where the provider shows it. */
export function ApiKeys({ s }: { s: AppState }) {
  const st = s.settings
  const active = activeProfile(st)
  const [editing, setEditing] = useState<string | null>(() => (s.apiKeys.length ? null : active.id))
  const [checking, setChecking] = useState<string | null>(null)
  const check = async (id: string) => { setChecking(id); await call('api:check', { id }); setChecking(null) }
  const add = async () => { const id = await call<string>('api:add'); if (id) setEditing(id) }

  return (
    <div className="glass group">
      <h4>Нейросеть: ключи API</h4>
      <div className="hint" style={{ padding: '0 0 10px' }}>Психопортрет и помощник по чату работают через активный ключ. Можно подключить несколько (разные сервисы или запасной) и переключаться одним нажатием.</div>
      <div className="keys">
        {st.apiProfiles.map((p) => {
          const has = s.apiKeys.includes(p.id)
          const u = s.apiUsage[p.id]
          const c = s.apiChecks[p.id]
          const on = p.id === active.id
          return (
            <div key={p.id} className={'keycard' + (on ? ' on' : '')}>
              <div className="kc-top">
                <KeyRound size={16} />
                <b>{p.name}</b>
                <span className="pill">{PRESET_LABEL[p.preset]}</span>
                <span className={'pill' + (has ? (c?.key === 'bad' ? ' bad' : ' ok') : '')}>{has ? (c?.key === 'bad' ? 'ключ не принят' : c?.key === 'ok' ? 'ключ работает' : 'ключ сохранён') : 'нет ключа'}</span>
                <span style={{ flex: 1 }} />
                {on ? <span className="pill accent"><Check size={12} />Активный</span> : <button className="btn sm" onClick={() => call('api:use', { id: p.id })}>Сделать активным</button>}
                <button className="btn ghost round sm" title="Изменить" onClick={() => setEditing(editing === p.id ? null : p.id)}><Pencil size={14} /></button>
              </div>
              <div className="kc-line small">
                <span className="muted">Потрачено через StackTok:</span>{' '}
                {u ? <><b>{tokens(u.inTok + u.outTok)} токенов</b> <span className="muted">(вход {tokens(u.inTok)}, ответы {tokens(u.outTok)}, запросов {u.requests.toLocaleString('ru-RU')}, с {day(u.since)})</span></> : <span className="muted">пока ничего</span>}
              </div>
              <div className="kc-line small">
                <Wallet size={13} />
                {c?.balance ? <span><span className="muted">Баланс:</span> <b>{c.balance}</b></span> : <span className="muted">{c ? c.note : 'Баланс не проверялся'}</span>}
                {c && <span className="muted"> · {c.models ? `${c.models} моделей · ` : ''}проверено в {time(c.at)}</span>}
                <span style={{ flex: 1 }} />
                <button className="btn ghost sm" disabled={!has || checking === p.id} onClick={() => check(p.id)}><RefreshCw size={13} className={checking === p.id ? 'spin' : ''} />{checking === p.id ? 'Проверяю…' : 'Проверить'}</button>
              </div>
              {editing === p.id && <Editor p={p} s={s} onDone={() => setEditing(null)} />}
            </div>
          )
        })}
      </div>
      <div className="row" style={{ padding: '10px 0 4px' }}>
        <button className="btn" onClick={add}><Plus size={15} />Добавить ключ</button>
      </div>
      <div className="hint" style={{ padding: '6px 0 14px' }}>Токены считаются по ответам провайдера для запросов из этого приложения. Баланс показывают OpenRouter, DeepSeek и многие перепродавцы; Claude, OpenAI и Gemini — только в своём кабинете. Проверка не тратит токены. При портрете провайдеру уходят обложки и подписи репостов, в помощнике — загруженная переписка и описания её картинок.</div>
    </div>
  )
}
