import { describe, expect, it } from 'vitest'
import { checkKey } from '../src/main/api-check'
import { sanitize } from '../src/main/store'
import { ApiProfile, activeProfile, newProfile } from '../src/shared/types'

const prof = (x: Partial<ApiProfile>): ApiProfile => ({ ...newProfile('p'), ...x })
/** A fake provider: path → [status, body]. Records what was asked and with which key header. */
const server = (routes: Record<string, [number, unknown]>) => {
  const seen: { url: string; auth: string }[] = []
  const f = (async (url: string, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>
    seen.push({ url, auth: h.authorization ?? h['x-api-key'] ?? '' })
    const r = routes[new URL(url).pathname]
    return r ? new Response(JSON.stringify(r[1]), { status: r[0] }) : new Response('{}', { status: 404 })
  }) as unknown as typeof fetch
  return { f, seen }
}

describe('API key check', () => {
  it('a gateway on one-api/new-api shows the money left from the billing pages', async () => {
    const s = server({ '/v1/models': [200, { data: [{}, {}, {}] }], '/v1/dashboard/billing/subscription': [200, { hard_limit_usd: 10 }], '/v1/dashboard/billing/usage': [200, { total_usage: 325 }] })
    const r = await checkKey(prof({ preset: 'custom', base: 'https://gw.example.com/v1/' }), 'sk-1', s.f)
    expect(r).toMatchObject({ key: 'ok', models: 3, balance: 'остаток $6.75 из $10.00' })
    expect(s.seen.every((x) => x.auth === 'Bearer sk-1')).toBe(true)
  })

  it('new-api token usage when the billing pages are missing', async () => {
    const s = server({ '/v1/models': [200, { data: [] }], '/api/usage/token': [200, { code: true, data: { total_available: 2_500_000, total_used: 500_000 } }] })
    const r = await checkKey(prof({ preset: 'custom', base: 'https://gw.example.com/v1' }), 'k', s.f)
    expect(r.balance).toBe('осталось 2,5 млн ед. квоты (≈ $5.00), потрачено 500 тыс.')
  })

  it('OpenRouter credits and DeepSeek balance', async () => {
    const or = server({ '/api/v1/models': [200, { data: [] }], '/api/v1/credits': [200, { data: { total_credits: 20, total_usage: 4.5 } }] })
    expect((await checkKey(prof({ preset: 'openrouter' }), 'k', or.f)).balance).toBe('остаток $15.50 из $20.00')
    const ds = server({ '/models': [200, { data: [] }], '/user/balance': [200, { balance_infos: [{ currency: 'CNY', total_balance: '12.3' }] }] })
    expect((await checkKey(prof({ preset: 'deepseek' }), 'k', ds.f)).balance).toBe('остаток 12.30 CNY')
  })

  it('a refused key and providers without a balance page', async () => {
    const bad = server({ '/v1/models': [401, { error: 'no' }] })
    expect(await checkKey(prof({ preset: 'anthropic' }), 'sk-ant-x', bad.f)).toMatchObject({ key: 'bad' })
    const ok = server({ '/v1/models': [200, { data: [{}] }] })
    const r = await checkKey(prof({ preset: 'anthropic' }), 'sk-ant-x', ok.f)
    expect(r.key).toBe('ok')
    expect(r.balance).toBeUndefined()
    expect(r.note).toContain('console.anthropic.com')
    expect(ok.seen[0].auth).toBe('sk-ant-x') // Anthropic takes the key in x-api-key
    expect((await checkKey(prof({ preset: 'custom', base: '' }), 'k', ok.f)).note).toContain('адрес')
  })
})

describe('API profiles in settings', () => {
  it('settings from before profiles become the profile «main»', () => {
    const d = sanitize({ settings: { psyPreset: 'custom', psyBase: 'https://gw.example.com/v1', psySynth: 'big', assistModel: 'chat' } })
    expect(d.settings.apiProfiles).toEqual([{ id: 'main', name: 'Основной', preset: 'custom', base: 'https://gw.example.com/v1', vision: '', synth: 'big', assist: 'chat' }])
    expect(d.settings.apiActive).toBe('main')
    expect(d.apiUsage).toEqual({})
  })

  it('drops odd profiles and usage, keeps the active one valid', () => {
    const d = sanitize({
      settings: { apiProfiles: [{ id: 'a', name: 'A', preset: 'nope' }, { id: 'a' }, { id: '../x' }, { id: 'b', name: '', preset: 'deepseek' }], apiActive: 'zzz' },
      apiUsage: { a: { inTok: 10, outTok: 5, requests: 2, since: 1 }, b: 'x', c: { inTok: 1 } }
    })
    expect(d.settings.apiProfiles.map((p) => [p.id, p.preset, p.name])).toEqual([['a', 'anthropic', 'A'], ['b', 'deepseek', 'Ключ']])
    expect(activeProfile(d.settings).id).toBe('a')
    expect(d.apiUsage).toEqual({ a: { inTok: 10, outTok: 5, requests: 2, since: 1 } })
  })
})
