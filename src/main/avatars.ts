// Account photos: TikTok's CDN links expire and the user can change the photo, so the stored link is refreshed from time to time.

/** One account is asked at most this often, however many times it is opened. */
export const AVATAR_EVERY = 30 * 60_000
export const AVATAR_SWEEP = 60 * 60_000

/** The photo link from a TikTok page's embedded state, only if the signed-in user there is the confirmed account. */
export function pickAvatar(html: string | null, username?: string): string | undefined {
  const m = html?.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/)
  if (!m) return
  try {
    const u = JSON.parse(m[1]).__DEFAULT_SCOPE__?.['webapp.app-context']?.user
    if (!u || (username && String(u.uniqueId ?? '').toLowerCase() !== username.toLowerCase())) return
    const url = Array.isArray(u.avatarUri) ? u.avatarUri[0] : undefined
    return typeof url === 'string' && /^https:\/\//.test(url) && url.length <= 2000 ? url : undefined
  } catch {
    return
  }
}
