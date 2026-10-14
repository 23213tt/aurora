import { getActiveStorageProfile, profileScopedKey } from '../../features/accounts/profile-storage.ts'

/**
 * Which catalogue the search screen looked at last, per profile.
 *
 * Split out of the store so it can be tested: the store imports the platform
 * clients and the bridge, neither of which loads outside a bundler, so anything
 * left inside it is untestable by construction. This module touches only
 * `localStorage` and the profile key derivation.
 *
 * A source is `'local'` or a platform id. It used to be the two-valued
 * `'local' | 'online'`, which could not express "I search QQ, not Netease" - the
 * whole reason the search screen now builds its tabs from the provider registry.
 *
 * The value is profile-scoped like the playlists. A profile here is a whole
 * identity - its own library view, its own accounts - so two people on one machine
 * may reasonably want different defaults, and sharing the setting would be the
 * same class of mistake the profile feature exists to prevent.
 *
 * Failing to read or write is survivable by design: the caller falls back to its
 * default rather than throwing during a keypress or at startup.
 */

/** `'local'`, or a platform id such as `'netease'`. */
export type SearchSource = string

const SOURCE_KEY = 'aurora.search.source'

/** Exported for tests, which assert the slot a write lands in. */
export const searchSourceKey = (): string => profileScopedKey(SOURCE_KEY, getActiveStorageProfile())

/**
 * The source stored before platforms were named.
 *
 * `'online'` meant "the only online platform there was", which was Netease. Read
 * as an alias rather than migrated: a migration would rewrite every profile's
 * stored value on startup to say the same thing it already says, and this is one
 * string comparison.
 */
const LEGACY_ONLINE = 'online'
const LEGACY_ONLINE_MEANS = 'netease'

/**
 * The platform ids a stored value may name.
 *
 * Validated rather than trusted, and validated against the registry rather than
 * against a literal list: a stored value that no longer names a usable platform - a
 * build that dropped a client, or a value written by a newer version - must fall
 * back to the caller's default instead of pointing the screen at a tab that is not
 * drawn. The default is the one platform that has always existed, so a caller that
 * cannot reach the registry (a test) still gets the pre-provider behaviour.
 */
function knownSources(): readonly string[] {
  return ['local', DEFAULT_PLATFORM]
}

const DEFAULT_PLATFORM = 'netease'

function normalize(value: string | null, known: readonly string[] = knownSources()): SearchSource | null {
  if (!value) return null
  const source = value === LEGACY_ONLINE ? LEGACY_ONLINE_MEANS : value
  return known.includes(source) ? source : null
}

/**
 * The source this profile last searched, or null when there is no usable answer.
 *
 * `known` is passed in by the search store from the live provider registry, so a
 * value that names a platform this build cannot serve reads as "nothing
 * remembered" and the caller picks its default.
 */
export function readRememberedSource(known?: readonly string[]): SearchSource | null {
  try {
    return normalize(localStorage.getItem(searchSourceKey()), known)
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

/** Whether a source string names something this build can search. */
export function isKnownSource(source: string, platformIds: readonly string[]): boolean {
  return source === 'local' || platformIds.includes(source)
}
