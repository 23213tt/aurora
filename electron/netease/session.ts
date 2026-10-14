import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The Netease session cookie, encrypted at rest.
 *
 * `MUSIC_U` is a full account session: whoever holds it can act as the user,
 * and it does not expire quickly. Writing it as plain text next to
 * `settings.json` would put a working credential in any file backup, sync
 * folder or support bundle, so it goes through Electron's `safeStorage`
 * (DPAPI on Windows) instead - the same reasoning as a password manager using
 * the OS keyring rather than its own file encryption.
 *
 * Every path here is best-effort. A cookie that cannot be read back is treated
 * as "signed out", never as a crash, and when no keyring is available - or when
 * this module is loaded outside Electron, as the smoke probe does - the cookie
 * lives in memory for the session only. It is never written in the clear.
 */

let memory = ''

/** Reported once per run; a missing keyring is worth one line, not one per call. */
let warned = false

const cookieFile = (): string => path.join(app.getPath('userData'), 'netease-session.bin')

export function readCookie(): string {
  if (memory) return memory
  try {
    if (!safeStorage.isEncryptionAvailable()) return ''
    memory = safeStorage.decryptString(fs.readFileSync(cookieFile()))
  } catch {
    // First run, a rotated OS key, or a truncated file: all mean "signed out".
  }
  return memory
}

export function writeCookie(cookie: string): void {
  if (!cookie) return
  memory = cookie
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      if (!warned) {
        warned = true
        console.error('[aurora] no OS keyring; the netease session will not survive a restart')
      }
      return
    }
    fs.mkdirSync(path.dirname(cookieFile()), { recursive: true })
    fs.writeFileSync(cookieFile(), safeStorage.encryptString(cookie))
  } catch (error) {
    // Losing the session is an inconvenience; the account itself is untouched.
    console.error('[aurora] could not persist the netease session', error)
  }
}

export function clearCookie(): void {
  memory = ''
  try {
    fs.rmSync(cookieFile(), { force: true })
  } catch {
    // Nothing to remove is the normal case for a signed-out user.
  }
}
