import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Netease sessions, one per local profile, encrypted at rest.
 *
 * `MUSIC_U` is a full account session: whoever holds it can act as the user, and
 * it does not expire quickly. Writing it as plain text next to `settings.json`
 * would put a working credential in any file backup, sync folder or support
 * bundle, so it goes through Electron's `safeStorage` (DPAPI on Windows) - the
 * same reasoning as a password manager using the OS keyring rather than its own
 * file encryption.
 *
 * **Why per profile.** A profile is supposed to be a whole identity: its own
 * library, its own playlists, its own account. This file used to hold a single
 * machine-wide session, so signing in once meant every profile showed the same
 * online playlists - which contradicted what the app says a profile is. The
 * session is now keyed by profile id, and the client is told which profile is
 * active before it makes a call.
 *
 * Every path here is best-effort. A cookie that cannot be read back is treated
 * as "signed out", never as a crash, and when no keyring is available - or when
 * this module is loaded outside Electron, as the smoke probe does - the cookie
 * lives in memory for the session only. It is never written in the clear.
 */

/** In-memory sessions, keyed by profile id; used when there is no keyring. */
const memory = new Map<string, string>()

/** Reported once per run; a missing keyring is worth one line, not one per call. */
let warned = false

/** Profile ids come from the renderer, so they are treated as untrusted input. */
function safeProfileId(profileId: string): string {
  const trimmed = String(profileId ?? '').trim()
  return /^[A-Za-z0-9_-]{1,64}$/.test(trimmed) ? trimmed : 'default'
}

const cookieFile = (profileId: string): string =>
  path.join(app.getPath('userData'), `netease-session.${safeProfileId(profileId)}.bin`)

export function readCookie(profileId: string): string {
  const key = safeProfileId(profileId)
  const cached = memory.get(key)
  if (cached) return cached
  try {
    if (!safeStorage.isEncryptionAvailable()) return ''
    const value = safeStorage.decryptString(fs.readFileSync(cookieFile(key)))
    memory.set(key, value)
    return value
  } catch {
    // First run, a rotated OS key, or a truncated file: all mean "signed out".
    return ''
  }
}

export function writeCookie(profileId: string, cookie: string): void {
  if (!cookie) return
  const key = safeProfileId(profileId)
  memory.set(key, cookie)
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      if (!warned) {
        warned = true
        console.error('[aurora] no OS keyring; netease sessions will not survive a restart')
      }
      return
    }
    fs.mkdirSync(path.dirname(cookieFile(key)), { recursive: true })
    fs.writeFileSync(cookieFile(key), safeStorage.encryptString(cookie))
  } catch (error) {
    // Losing the session is an inconvenience; the account itself is untouched.
    console.error('[aurora] could not persist the netease session', error)
  }
}

/** True when this profile has a session on disk or in memory. */
export function hasCookie(profileId: string): boolean {
  return readCookie(profileId).length > 0
}

export function clearCookie(profileId: string): void {
  const key = safeProfileId(profileId)
  memory.delete(key)
  try {
    fs.rmSync(cookieFile(key), { force: true })
  } catch {
    // Nothing to remove is the normal case for a signed-out profile.
  }
}
