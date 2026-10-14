import { getActiveStorageProfile, profileScopedKey } from '../../features/accounts/profile-storage.ts'

/**
 * Which catalogue the search screen looked at last, per profile.
 *
 * Split out of the store so it can be tested: the store imports the Netease
 * client and the bridge, neither of which loads outside a bundler, so anything
 * left inside it is untestable by construction. This module touches only
 * `localStorage` and the profile key derivation.
 *
 * The value is profile-scoped like the playlists. A profile here is a whole
 * identity - its own library view, its own Netease account - so two people on one
 * machine may reasonably want different defaults, and sharing the setting would be
 * the same class of mistake the profile feature exists to prevent.
 *
 * Failing to read or write is survivable by design: the caller falls back to its
 * default, rather than throwing during a keypress or at startup.
 */
export type SearchSource = 'local' | 'online'

const SOURCE_KEY = 'aurora.search.source'

/** Exported for tests, which assert the slot a write lands in. */
export const searchSourceKey = (): string => profileScopedKey(SOURCE_KEY, getActiveStorageProfile())

function isSource(value: unknown): value is SearchSource {
  return value === 'local' || value === 'online'
}

export function readRememberedSource(): SearchSource | null {
  try {
    const value = localStorage.getItem(searchSourceKey())
    return isSource(value) ? value : null
  } catch {
    return null
  }
}

export function rememberSource(source: SearchSource): void {
  try {
    localStorage.setItem(searchSourceKey(), source)
  } catch {
    // Storage unavailable (opaque origin, disabled storage): the choice applies to
    // this session only, which is better than losing the click.
  }
}

/** The key an arbitrary profile would use, for tests and reasoning. */
export function sourceKeyFor(profileId: string | null): string {
  return profileScopedKey(SOURCE_KEY, profileId)
}
