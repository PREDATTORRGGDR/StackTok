import { AccountView } from '@shared/types'
import { AppState, call } from '../api'
import type { Dialog } from '../Dialogs'
import type { Page } from '../App'
import { GROUPS, TOOLS, ToolCtx } from '../tools'
import { Avatar } from '../ui'

/** All features of the app in one place, grouped. What each card does and when it is available comes from the TOOLS list. */
export function ToolsPage({ s, active, go, openDialog }: { s: AppState; active?: AccountView; go: (p: Page) => void; openDialog: (d: Dialog) => void }) {
  const ctx: ToolCtx = { s, acct: active, go, openDialog }
  return (
    <div className="page">
      <div className="page-head">
        <div><h2>Инструменты</h2><p>Всё, что приложение умеет делать с аккаунтом TikTok. Каждое действие запускается только вашей кнопкой.</p></div>
        {s.accounts.length > 0 && (
          <label className="pickacct" title="Аккаунт, с которым работают инструменты">
            {active && <Avatar a={active} size={24} />}
            <select value={active?.id ?? ''} onChange={(e) => call('account:select', { id: e.target.value })}>
              {s.accounts.map((a) => <option key={a.id} value={a.id}>{a.label}{a.username ? ` · @${a.username}` : ''}</option>)}
            </select>
          </label>
        )}
      </div>
      {GROUPS.map((g) => {
        const tools = TOOLS.filter((t) => t.group === g)
        if (!tools.length) return null
        return (
          <section key={g} className="toolgroup">
            <h4>{g}</h4>
            <div className="toolgrid">
              {tools.map((t) => {
                const why = t.blocked?.(ctx) ?? null
                const busy = !!t.busy?.(ctx)
                return (
                  <div key={t.id} className={'glass toolcard' + (why ? ' off' : '')}>
                    <div className="ic">{t.icon}</div>
                    <div className="tt">{t.title}</div>
                    <div className="muted small td">{t.desc}</div>
                    <div className="row" style={{ marginTop: 'auto', width: '100%' }}>
                      <button className="btn primary sm" disabled={!!why || busy} onClick={() => t.run(ctx)}>{busy ? 'Идёт…' : 'Запустить'}</button>
                      {why && <span className="faint small">{why}</span>}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )
      })}
    </div>
  )
}
