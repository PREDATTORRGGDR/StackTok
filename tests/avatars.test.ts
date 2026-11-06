import { describe, expect, it } from 'vitest'
import { pickAvatar } from '../src/main/avatars'

const page = (user: unknown) => `<html><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.app-context': { user } } })}</script></html>`

describe('pickAvatar', () => {
  const url = 'https://p16.tiktokcdn.com/a.jpeg?x=1'
  it('takes the link of the confirmed account', () => {
    expect(pickAvatar(page({ uniqueId: 'Me', avatarUri: [url, 'https://x/b'] }), 'me')).toBe(url)
  })
  it('ignores another account', () => {
    expect(pickAvatar(page({ uniqueId: 'other', avatarUri: [url] }), 'me')).toBeUndefined()
  })
  it('ignores bad pages', () => {
    expect(pickAvatar(null, 'me')).toBeUndefined()
    expect(pickAvatar('<html></html>', 'me')).toBeUndefined()
    expect(pickAvatar('<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__">{oops</script>', 'me')).toBeUndefined()
    expect(pickAvatar(page(undefined), 'me')).toBeUndefined()
    expect(pickAvatar(page({ uniqueId: 'me', avatarUri: [] }), 'me')).toBeUndefined()
    expect(pickAvatar(page({ uniqueId: 'me', avatarUri: ['http://x/a.jpg'] }), 'me')).toBeUndefined()
    expect(pickAvatar(page({ uniqueId: 'me', avatarUri: ['javascript:alert(1)'] }), 'me')).toBeUndefined()
  })
})
