import { describe, expect, it } from 'vitest'
import { sanitize } from '../src/main/store'

describe('store validation', () => {
  it('starts with safe defaults on empty or garbage input', () => {
    for (const raw of [undefined, null, 5, 'x', {}]) {
      const d = sanitize(raw)
      expect(d.accounts).toEqual([])
      expect(d.settings).toMatchObject({ theme: 'dark', accent: 'blue', background: 'aurora', restoreLast: true })
    }
  })

  it('drops malformed accounts and keeps valid ones', () => {
    const d = sanitize({ accounts: [{ id: 'a', label: 'One', verified: true }, { label: 'no id' }, 7, null] })
    expect(d.accounts).toHaveLength(1)
    expect(d.accounts[0]).toMatchObject({ id: 'a', label: 'One', verified: true })
  })

  it('clamps and whitelists settings', () => {
    const d = sanitize({ settings: { theme: 'neon', accent: 'pink', glass: 999, background: 'x', restoreLast: false } })
    expect(d.settings).toMatchObject({ theme: 'dark', accent: 'pink', glass: 100, background: 'aurora', restoreLast: false })
  })

  it('forgets an active account that no longer exists', () => {
    expect(sanitize({ accounts: [{ id: 'a', label: 'A' }], activeAccountId: 'gone' }).activeAccountId).toBeUndefined()
    expect(sanitize({ accounts: [{ id: 'a', label: 'A' }], activeAccountId: 'a' }).activeAccountId).toBe('a')
  })
})
