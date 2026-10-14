import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { QqQuality } from './types'

/**
 * QQ Music state per local profile, encrypted at rest.
 *
 * Two things live here and not in `settings.json`:
 *
 * 1. **The session cookie.** `qqmusic_key` is a full account session - whoever
 *    holds it can act as the user - so it goes through Electron's `safeStorage`
 *    (DPAPI on Windows) exactly like the Netease cookie does. A working
 *    credential must not sit in a file that ends up in a backup, a sync folder
 *    or a support bundle.
 * 2. **The preferred quality tier.** Upstream quality is per account, and
 *    accounts are per profile, so the preference belongs with the account. It is
 *    also why it is not in `electron/settings.ts`: that file is another task's
 *    write scope, and a preference that is already scoped to a profile does not
 *    need a global key.
 *
 * **Why per profile.** A profile is supposed to be a whole identity - its own
 * library, its own playlists, its own account - which is the same reason
 * `electron/netease/session.ts` was made per profile. Without this, signing in
 * once would show one account's data in every profile.
 *
 * Every path is best-effort. State that cannot be read back means "signed out",
 * never a crash; with no keyring - or outside Electron, as the smoke probe runs
 * - it stays in memory for the session and is never written in the clear.
 */

 interface QqProfileState {
  cookie: string
  uin: string
  /** The encrypted uin upstream returns alongside the session; unused today. */
  euin: string
  nickname: string
  avatarUrl: string | null
  /** `null` means "not established", never "not a member". See `types.ts`. */
  vip: boolean | null
  /**
   * When the membership answer above was obtained.
   *
   * A successful answer is believed for a few minutes rather than being asked
   * again on every screen, which is also what gives a failing probe a grace
   * window instead of a chance to overwrite a good answer.
   */
  vipCheckedAt: number
  level: number
  quality: QqQuality
}

const DEFAULT_QUALITY: QqQuality = 'exhigh'

const EMPTY: QqProfileState = {
  cookie: '',
  uin: '',
  euin: '',
  nickname: '',
  avatarUrl: null,
  vip: null,
  vipCheckedAt: 0,
  level: 0,
  quality: DEFAULT_QUALITY
}

/** In-memory state per profile; used when there is no keyring. */
const memory = new Map<string, QqProfileState>()

/** Reported once per run; a missing keyring is worth one line, not one per call. */
let warned = false

/** Profile ids come from the renderer, so they are treated as untrusted input. */
function safeProfileId(profileId: string): string {
  const trimmed = String(profileId ?? '').trim()
  return /^[A-Za-z0-9_-]{1,64}$/.test(trimmed) ? trimmed : 'default'
}

const stateFile = (profileId: string): string =>
  path.join(app.getPath('userData'), `qq-session.${safeProfileId(profileId)}.bin`)

/** Merge a stored blob over the defaults, ignoring anything of the wrong type. */
function revive(value: unknown): QqProfileState {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const quality = raw.quality
  return {
    cookie: typeof raw.cookie === 'string' ? raw.cookie : '',
    uin: typeof raw.uin === 'string' ? raw.uin : '',
    euin: typeof raw.euin === 'string' ? raw.euin : '',
    nickname: typeof raw.nickname === 'string' ? raw.nickname : '',
    avatarUrl: typeof raw.avatarUrl === 'string' ? raw.avatarUrl : null,
    // A stored boolean stays a boolean; anything else means "not established".
    vip: typeof raw.vip === 'boolean' ? raw.vip : null,
    vipCheckedAt:
      typeof raw.vipCheckedAt === 'number' && Number.isFinite(raw.vipCheckedAt)
        ? raw.vipCheckedAt
        : 0,
    level: typeof raw.level === 'number' && Number.isFinite(raw.level) ? raw.level : 0,
    quality:
      quality === 'standard' || quality === 'higher' || quality === 'exhigh' || quality === 'lossless'
        ? quality
        : DEFAULT_QUALITY
  }
}

export function readState(profileId: string): QqProfileState {
  const key = safeProfileId(profileId)
  const cached = memory.get(key)
  if (cached) return cached

  let state = { ...EMPTY }
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const plain = safeStorage.decryptString(fs.readFileSync(stateFile(key)))
      state = revive(JSON.parse(plain))
    }
  } catch {
    // First run, a rotated OS key, or a truncated file: all mean "signed out",
    // and the quality preference simply falls back to its default.
  }
  memory.set(key, state)
  return state
}

export function writeState(profileId: string, patch: Partial<QqProfileState>): QqProfileState {
  const key = safeProfileId(profileId)
  const next = { ...readState(key), ...patch }
  memory.set(key, next)
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      if (!warned) {
        warned = true
        console.error('[aurora] no OS keyring; the QQ Music session will not survive a restart')
      }
      return next
    }
    fs.mkdirSync(path.dirname(stateFile(key)), { recursive: true })
    fs.writeFileSync(stateFile(key), safeStorage.encryptString(JSON.stringify(next)))
  } catch (error) {
    // Losing the session is an inconvenience; the account itself is untouched.
    console.error('[aurora] could not persist the QQ Music state', error)
  }
  return next
}

/** Forget the session but keep the profile's quality preference. */
export function clearSession(profileId: string): void {
  const key = safeProfileId(profileId)
  writeState(key, {
    cookie: '',
    uin: '',
    euin: '',
    nickname: '',
    avatarUrl: null,
    vip: null,
    vipCheckedAt: 0,
    level: 0
  })
}

/** True when this profile has a session cookie on disk or in memory. */
export function hasSession(profileId: string): boolean {
  return readState(profileId).cookie.length > 0
}
