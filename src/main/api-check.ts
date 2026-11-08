// Checks a model API key: does the provider accept it, and how much is left on it, when the provider says so.
// Pure: no Electron. Reads only (model lists and balance pages), never spends tokens.
import { ApiCheck, ApiProfile, PSY_PRESET_INFO } from '../shared/types'

type Json = Record<string, any>
const money = (v: number, cur = 'USD') => (cur === 'USD' ? '$' + v.toFixed(2) : `${v.toFixed(2)} ${cur}`)
const big = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace('.', ',') + ' млн' : n >= 1e4 ? Math.round(n / 1e3) + ' тыс.' : String(Math.round(n)))

/** The API address of a profile: the preset's own, or the one typed in for «Свой адрес». */
export const baseOf = (p: ApiProfile) => (p.preset === 'custom' ? p.base : PSY_PRESET_INFO[p.preset].base).trim().replace(/\/+$/, '')

async function getJson(f: typeof fetch, url: string, headers: Record<string, string>): Promise<{ status: number; body: Json | null }> {
  try {
    const r = await f(url, { headers, signal: AbortSignal.timeout(15000) })
    const body = await r.json().catch(() => null)
    return { status: r.status, body: body && typeof body === 'object' ? body : null }
  } catch { return { status: 0, body: null } }
}

/** OpenRouter: `/key` gives the key's own limit and usage, `/credits` the account's money. */
async function openrouter(f: typeof fetch, base: string, h: Record<string, string>): Promise<string | undefined> {
  const c = await getJson(f, base + '/credits', h)
  const d = c.body?.data
  if (c.status === 200 && typeof d?.total_credits === 'number') return `остаток ${money(d.total_credits - (d.total_usage ?? 0))} из ${money(d.total_credits)}`
  const k = await getJson(f, base + '/key', h)
  const x = k.body?.data
  if (k.status === 200 && x) return typeof x.limit_remaining === 'number' ? `лимит ключа: осталось ${money(x.limit_remaining)}` : `потрачено ${money(Number(x.usage) || 0)}, лимита у ключа нет`
}

/** DeepSeek: `/user/balance`. */
async function deepseek(f: typeof fetch, base: string, h: Record<string, string>): Promise<string | undefined> {
  const r = await getJson(f, base + '/user/balance', h)
  const list = r.body?.balance_infos
  if (r.status === 200 && Array.isArray(list) && list.length) return 'остаток ' + list.map((b: Json) => money(Number(b.total_balance) || 0, String(b.currency ?? 'USD'))).join(', ')
}

/**
 * Gateways and resellers: most are built on one-api/new-api and answer the old OpenAI billing pages with the key itself,
 * or new-api's `/api/usage/token`. Whatever answers first wins.
 */
async function gateway(f: typeof fetch, base: string, h: Record<string, string>): Promise<string | undefined> {
  const sub = await getJson(f, base + '/dashboard/billing/subscription', h)
  const limit = Number(sub.body?.hard_limit_usd ?? sub.body?.system_hard_limit_usd)
  if (sub.status === 200 && Number.isFinite(limit)) {
    const end = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
    const use = await getJson(f, `${base}/dashboard/billing/usage?start_date=2020-01-01&end_date=${end}`, h)
    const used = Number(use.body?.total_usage) / 100 // cents
    if (limit >= 1e8) return Number.isFinite(used) ? `без лимита, потрачено ${money(used)}` : 'без лимита'
    return Number.isFinite(used) ? `остаток ${money(Math.max(0, limit - used))} из ${money(limit)}` : `лимит ${money(limit)}`
  }
  const origin = new URL(base).origin
  const tok = await getJson(f, origin + '/api/usage/token', h)
  const d = tok.body?.data
  if (tok.status === 200 && d && (typeof d.total_available === 'number' || typeof d.total_used === 'number')) {
    if (d.unlimited_quota) return `без лимита, потрачено ${big(d.total_used ?? 0)} ед. квоты`
    return `осталось ${big(d.total_available ?? 0)} ед. квоты (≈ ${money((d.total_available ?? 0) / 500000)}), потрачено ${big(d.total_used ?? 0)}`
  }
}

/** One check. A 401/403 on the model list means the key is not taken; balance is shown only when the provider has a page for it. */
export async function checkKey(p: ApiProfile, key: string, f: typeof fetch = fetch): Promise<ApiCheck> {
  const at = Date.now()
  const base = baseOf(p)
  if (!/^https?:\/\//.test(base)) return { key: 'unknown', note: 'Не указан адрес API.', at }
  const anthropic = PSY_PRESET_INFO[p.preset].kind === 'anthropic'
  const h: Record<string, string> = anthropic ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { authorization: 'Bearer ' + key }
  const models = await getJson(f, base + (anthropic ? '/v1/models' : '/models'), h)
  const count = Array.isArray(models.body?.data) ? models.body!.data.length : undefined
  const state: ApiCheck['key'] = models.status === 401 || models.status === 403 ? 'bad' : models.status === 200 ? 'ok' : 'unknown'
  if (state === 'bad') return { key: 'bad', note: 'Провайдер не принял ключ.', at }
  let balance: string | undefined
  if (p.preset === 'openrouter') balance = await openrouter(f, base, h)
  else if (p.preset === 'deepseek') balance = await deepseek(f, base, h)
  else if (p.preset === 'custom' || p.preset === 'openai') balance = await gateway(f, base, h)
  const note = balance ? undefined
    : anthropic ? 'Anthropic не показывает баланс по ключу: он виден на console.anthropic.com.'
    : p.preset === 'openai' ? 'OpenAI не показывает баланс по ключу: он виден на platform.openai.com.'
    : p.preset === 'gemini' ? 'Google не показывает баланс по ключу: он виден в Google AI Studio.'
    : 'Провайдер не отдаёт баланс по ключу. Посмотрите его в личном кабинете сервиса.'
  return { key: state, models: count, balance, note: state === 'unknown' ? `Список моделей не ответил (${models.status || 'нет связи'}). ` + (note ?? '') : note, at }
}
