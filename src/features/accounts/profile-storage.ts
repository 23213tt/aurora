/**
 * Profile-scoped renderer storage.
 *
 * A profile that isolates nothing is a decorative label, so each profile gets
 * its own storage slot per slice. The key is derived at call time from the
 * currently active profile rather than captured at store creation, which is what
 * lets a single store serve every profile just by rehydrating against a
 * different key.
 *
 * The one thing this must never get wrong is uniqueness: if two profiles
 * derived the same key they would silently share a playlist library, which is
 * exactly the bug the feature exists to prevent.
 */

/** Used when no profile is active yet, e.g. before the first one is created. */
const FALLBACK_PROFILE = 'default'

/** Separator that cannot appear in a generated account id. */
const SEPARATOR = '::'

export function profileScopedKey(base: string, profileId: string | null | undefined): string {
  const raw = typeof profileId === 'string' && profileId.trim() ? profileId.trim() : FALLBACK_PROFILE
  // The owner must never contain the separator, or `base='a::b', owner='c'` and
  // `base='a', owner='b::c'` would derive the same key and two profiles would
  // silently share one library.
  const owner = raw.split(SEPARATOR).join('_')
  return `${base}${SEPARATOR}${owner}`
}

/**
 * Whether a legacy, unscoped value should be adopted by a profile.
 *
 * Earlier builds wrote one shared key. Adopting it only when the profile has
 * nothing of its own means an upgrade keeps its playlists, while a second launch
 * cannot overwrite real per-profile data with the stale shared copy.
 */
export function shouldAdoptLegacy(legacy: string | null, scoped: string | null): boolean {
  return legacy !== null && scoped === null
}

let activeProfile: string | null = null

export function setActiveStorageProfile(id: string | null): void {
  activeProfile = id
}

export function getActiveStorageProfile(): string | null {
  return activeProfile
}

export interface ProfileStorage {
  getItem(name: string): string | null
  setItem(name: string, value: string): void
  removeItem(name: string): void
}

/** Zustand-persist storage backed by the active profile's slot. */
export function createProfileScopedStorage(): ProfileStorage {
  return {
    getItem(name) {
      const scopedKey = profileScopedKey(name, activeProfile)

      let scoped: string | null = null
      try {
        scoped = localStorage.getItem(scopedKey)
      } catch {
        // Storage can be unavailable (opaque origin, disabled storage). Losing
        // persistence is survivable; throwing during hydration is not.
        return null
      }
      if (scoped !== null) return scoped

      /*
       * Adoption happens only once a real profile is active.
       *
       * The store hydrates once at creation, before any profile exists. Adopting
       * the legacy key then would file it under the placeholder slot, where no
       * profile would ever look for it - so the upgrade would appear to have
       * deleted the user's playlists.
       */
      if (activeProfile === null) return null

      const legacy = localStorage.getItem(name)
      if (!shouldAdoptLegacy(legacy, scoped)) return null

      localStorage.setItem(scopedKey, legacy as string)
      localStorage.removeItem(name)
      return legacy
    },

    setItem(name, value) {
      localStorage.setItem(profileScopedKey(name, activeProfile), value)
    },

    removeItem(name) {
      localStorage.removeItem(profileScopedKey(name, activeProfile))
    }
  }
}
