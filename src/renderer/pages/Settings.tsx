import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { parseTags } from '@shared/logic'
import { Preset } from '@shared/types'
import { AppState, call } from '../api'

function PresetEditor({ p, s }: { p: Preset | null; s: AppState }) {
  const [name, setName] = useState(p?.name ?? '')
  const [tags, setTags] = useState(p?.tags.join(' ') ?? '')
  const parsed = parseTags(tags)
  const dirty = !p || name !== p.name || parsed.join(' ') !== p.tags.join(' ')
  return (
    <div className="row" style={{ alignItems: 'flex-start' }}>
      <input className="input" style={{ width: 150 }} placeholder="Название набора" value={name} onChange={(e) => setName(e.target.value)} />
      <textarea className="textarea" style={{ minHeight: 34, height: 34 }} placeholder="#тег #другой" value={tags} onChange={(e) => setTags(e.target.value)} />
      <button className="btn" disabled={!name.trim() || !dirty} onClick={async () => { await call('preset:save', { id: p?.id, name, tags: parsed }); if (!p) { setName(''); setTags('') } }}>
        {p ? 'Сохранить' : <><Plus size={14} />Добавить</>}
      </button>
      {p && <button className="btn ghost" aria-label="Удалить набор" onClick={() => call('preset:delete', { id: p.id })}><Trash2 size={14} /></button>}
    </div>
  )
}

export function SettingsPage({ s }: { s: AppState }) {
  const set = (v: object) => call('settings:set', v)
  const st = s.settings
  const toggleDefault = (id: string) => set({ defaultPresetIds: st.defaultPresetIds.includes(id) ? st.defaultPresetIds.filter((x) => x !== id) : [...st.defaultPresetIds, id] })

  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <div className="panel stack">
        <h2>Наборы хэштегов</h2>
        {s.presets.map((p) => <PresetEditor key={p.id} p={p} s={s} />)}
        <PresetEditor p={null} s={s} />
        <span className="muted small">При применении теги очищаются (один «#», без символов) и дубликаты удаляются. Наборы — лишь подсказка и не гарантируют просмотры.</span>
        {s.presets.length > 0 && (
          <div><div className="muted small" style={{ marginBottom: 6 }}>Применять по умолчанию на странице публикации</div>
            <div className="chips">{s.presets.map((p) => <button key={p.id} className={'chip' + (st.defaultPresetIds.includes(p.id) ? ' on' : '')} onClick={() => toggleDefault(p.id)}>{p.name}</button>)}</div></div>
        )}
        {s.accounts.length > 0 && s.presets.length > 0 && (
          <div className="stack" style={{ gap: 6 }}><div className="muted small">Наборы по умолчанию для аккаунтов (добавляются к описанию этого аккаунта)</div>
            {s.accounts.map((a) => (
              <div key={a.id} className="row"><span style={{ width: 150 }}>{a.label}</span>
                <div className="chips">{s.presets.map((p) => {
                  const on = a.defaultPresetIds.includes(p.id)
                  return <button key={p.id} className={'chip' + (on ? ' on' : '')} onClick={() => call('account:presets', { id: a.id, presetIds: on ? a.defaultPresetIds.filter((x) => x !== p.id) : [...a.defaultPresetIds, p.id] })}>{p.name}</button>
                })}</div></div>
            ))}</div>
        )}
      </div>

      {s.templates.length > 0 && (
        <div className="panel stack"><h2>Шаблоны описаний</h2>
          {s.templates.map((t) => <div key={t.id} className="row"><b style={{ width: 150 }}>{t.name}</b><span className="muted small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.text}</span><button className="btn ghost" aria-label="Удалить шаблон" onClick={() => call('template:delete', { id: t.id })}><Trash2 size={14} /></button></div>)}
        </div>
      )}

      <div className="panel stack">
        <h2>Планировщик</h2>
        <label className="row"><input type="checkbox" checked={st.autoRun} onChange={(e) => set({ autoRun: e.target.checked })} /> Выполнять задачи по расписанию, пока StackTok открыт</label>
        <label className="row">Параллельные загрузки (только для разных аккаунтов)
          <select style={{ width: 70 }} value={st.concurrency} onChange={(e) => set({ concurrency: Number(e.target.value) })}>{[1, 2, 3].map((n) => <option key={n}>{n}</option>)}</select></label>
        <label className="row"><input type="checkbox" checked={st.showAutomationWindow} onChange={(e) => set({ showAutomationWindow: e.target.checked })} /> Показывать окно загрузки во время работы (диагностика)</label>
        <span className="muted small">Пока приложение закрыто, публикации не выходят. Задачи, срок которых наступил, ждут вашего решения при следующем запуске. Загрузки в одном аккаунте не пересекаются.</span>
      </div>

      <div className="panel stack">
        <h2>Локальные данные</h2>
        <span className="small muted">Настройки, очередь и профили браузера аккаунтов хранятся здесь:</span>
        <code className="small" style={{ wordBreak: 'break-all' }}>{s.dataPath}</code>
        <div className="row"><button className="btn" onClick={() => call('data:open')}>Открыть папку</button></div>
        <span className="small muted">Для резервной копии закройте StackTok и скопируйте эту папку (в ней сохранены входы — храните её в тайне). При удалении аккаунта профиль сохраняется, если не выбрать его удаление.</span>
      </div>
      <span className="muted small">StackTok {s.version}</span>
    </div>
  )
}
