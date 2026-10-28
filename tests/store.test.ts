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

  it('defaults and whitelists the chat overlay settings', () => {
    expect(sanitize({}).settings).toMatchObject({ chatOverlay: true, chatWallpaper: 'none' })
    expect(sanitize({ settings: { chatOverlay: false, chatWallpaper: 'ocean' } }).settings).toMatchObject({ chatOverlay: false, chatWallpaper: 'ocean' })
    expect(sanitize({ settings: { chatWallpaper: 'http://evil/x.png' } }).settings.chatWallpaper).toBe('none')
  })

  it('clamps and whitelists the chat extras', () => {
    expect(sanitize({}).settings).toMatchObject({ chatDim: 50, chatPrivacy: false, chatTextSize: 'normal' })
    expect(sanitize({ settings: { chatDim: 999, chatPrivacy: true, chatTextSize: 'large' } }).settings).toMatchObject({ chatDim: 100, chatPrivacy: true, chatTextSize: 'large' })
    expect(sanitize({ settings: { chatDim: -5, chatPrivacy: 'yes', chatTextSize: 'huge' } }).settings).toMatchObject({ chatDim: 0, chatPrivacy: false, chatTextSize: 'normal' })
  })

  it('keeps a valid start page per account and falls back to Studio', () => {
    const d = sanitize({ accounts: [{ id: 'a', label: 'A', openIn: 'chats' }, { id: 'b', label: 'B', openIn: 'evil' }, { id: 'c', label: 'C' }] })
    expect(d.accounts.map((a) => a.openIn)).toEqual(['chats', 'studio', 'studio'])
  })

  it('forgets an active account that no longer exists', () => {
    expect(sanitize({ accounts: [{ id: 'a', label: 'A' }], activeAccountId: 'gone' }).activeAccountId).toBeUndefined()
    expect(sanitize({ accounts: [{ id: 'a', label: 'A' }], activeAccountId: 'a' }).activeAccountId).toBe('a')
  })
})
