import { useEffect, useState } from 'react'
import { getProvider, listAvailableProviders, listProviders } from './registry'
import type { OnlineMusicProvider, ProviderId } from './types'
import { useOnlineStore, type OnlineStore } from './store'

/**
 * React access to the provider registry.
 *
 * Deliberately *not* `useSyncExternalStore`: its snapshot function has to return
 * a value that is stable while the store is unchanged, and both `listProviders()`
 * and `listAvailableProviders()` build a fresh array on every call - so a
 * snapshot-based hook would either loop forever or have to cache, and a cached
 * list is exactly the staleness this is meant to avoid.
 *
 * A platform's `available()` is a plain synchronous read of the preload bridge,
 * so a component that renders already has the current answer. What it cannot see
 * is that answer *changing*: a backend whose first health check fails and whose
 * second succeeds would leave the rail painted without that platform's entry.
 * `availabilitySignal` is that one missing edge.
 */

/** Raised by the store when a platform's backend reports a new status. */
class AvailabilitySignal {
  private version = 0
  private listeners = new Set<() => void>()

  get snapshot(): number {
    return this.version
  }

  bump = (): void => {
    this.version += 1
    for (const listener of this.listeners) listener()
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

export const availabilitySignal = new AvailabilitySignal()

function useAvailabilityVersion(): number {
  const [version, setVersion] = useState(() => availabilitySignal.snapshot)
  useEffect(() => availabilitySignal.subscribe(() => setVersion(availabilitySignal.snapshot)), [])
  return version
}

/** Every platform the app supports, usable or not. */
export function useProviders(): OnlineMusicProvider[] {
  // The version is read so a backend transition re-runs the list; the list itself
  // is cheap and its identity only has to be stable enough for one render pass.
  useAvailabilityVersion()
  return listProviders()
}

/** Only the platforms that can actually be served in this build. */
export function useAvailableProviders(): OnlineMusicProvider[] {
  useAvailabilityVersion()
  return listAvailableProviders()
}

export function useProvider(id: ProviderId | null): OnlineMusicProvider | null {
  return id ? getProvider(id) : null
}

/**
 * The state of one platform.
 *
 * A platform with no backend is a real case, not an error: the browser preview
 * has no main process at all, and a packaged build may ship without one of the
 * two clients. Callers get `null` and render their own "not available here"
 * state, which is what keeps a single view able to serve both.
 */
export function useOnlineProviderState(id: ProviderId | null): OnlineStore | null {
  if (!id) return null
  return useOnlineStore(id).getState()
}
