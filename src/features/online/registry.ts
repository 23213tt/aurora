import type { Track } from '../../types'
import type { ViewId } from '../../types'
import type {
  OnlineMusicProvider,
  PlaybackSourceRef,
  ProviderCapabilities,
  ProviderId
} from './types'

/**
 * The provider registry: one `Map<ProviderId, OnlineMusicProvider>` and nothing
 * else. Copied from the reference player's `providerRegistry.ts`, minus its
 * runtime register/unregister plumbing (Aurora has no plugin system, so the set
 * is fixed at module load and there is nothing to notify).
 *
 * Everything the interface knows about platforms comes from here. The rail, the
 * search screen's tabs and the settings page each call `useProviders()`; none of
 * them imports a platform module, and none of them names a platform.
 */

const providers = new Map<ProviderId, OnlineMusicProvider>()

/**
 * Registration order is display order.
 *
 * Netease first because it has been here longest, and because the order is used
 * verbatim by the rail and the search tabs - a stable order matters more than an
 * alphabetical one when the list is navigation.
 */
export function registerProvider(provider: OnlineMusicProvider): void {
  providers.set(provider.id, provider)
}

export function getProvider(id: ProviderId): OnlineMusicProvider | null {
  return providers.get(id) ?? null
}

/**
 * A platform's route.
 *
 * The two unions - `ViewId` and the registered provider ids - are tied together by
 * convention: a platform's id *is* its route, which is what lets the rail render a
 * link it can pass straight to the router and lets `App` resolve a route back to a
 * provider by lookup. The cast is the single place that convention is asserted;
 * `platformRouteExists` is what keeps a missing route from becoming a silent blank
 * page in the one build where a platform is present without one.
 */
export function platformView(provider: OnlineMusicProvider): ViewId {
  return provider.id as ViewId
}

/**
 * Every registered provider, in registration order.
 *
 * Not filtered by `available()`: a caller that wants "what can I offer the user"
 * asks for `listAvailableProviders()`, and a caller that wants "what exists"
 * (the settings page lists tiers for platforms the app supports) gets the full
 * set. Collapsing the two is how a disabled platform becomes invisible in a
 * screen that should still explain it.
 */
export function listProviders(): OnlineMusicProvider[] {
  return [...providers.values()]
}

/** The platforms usable right now, in registration order. */
export function listAvailableProviders(): OnlineMusicProvider[] {
  return listProviders().filter((provider) => provider.available())
}

export function providerSupports(
  provider: OnlineMusicProvider | null | undefined,
  capability: keyof ProviderCapabilities
): boolean {
  return Boolean(provider?.capabilities[capability])
}

/**
 * Which platform a track belongs to, or that it is a local file.
 *
 * This is the replacement for the scattered `track.source === 'netease'` checks.
 * It reads `Track.source`, which already exists and is already carried through
 * the player, the queue and the playlists - so a mixed queue and a mixed playlist
 * both answer correctly with no change to `Track` itself.
 *
 * `mediaId` is the platform's own id, taken from the part of the track id after
 * the colon. Ids are minted as `<providerId>:<upstreamId>` for exactly this
 * reason.
 */
export function getPlaybackSourceRef(track: Track | null | undefined): PlaybackSourceRef {
  const source = track?.source
  if (!track || !source || source === 'local') {
    return { kind: 'local', mediaId: track?.path ?? '' }
  }
  return {
    kind: 'online',
    providerId: source,
    mediaId: mediaIdOf(track.id, source)
  }
}

/** The upstream id inside a `<providerId>:<id>` track id. */
 function mediaIdOf(trackId: string, providerId: ProviderId): string {
  const prefix = `${providerId}:`
  return trackId.startsWith(prefix) ? trackId.slice(prefix.length) : trackId
}

/** The provider a track came from, or null for a local file. */
 function providerForTrack(track: Track | null | undefined): OnlineMusicProvider | null {
  const ref = getPlaybackSourceRef(track)
  return ref.kind === 'online' ? getProvider(ref.providerId) : null
}



/**
 * The display name of wherever a track came from, for a row's source label.
 *
 * Returns null for a local file so the caller decides whether "本机" is worth
 * printing; the row shows nothing rather than a label that says nothing.
 */
export function sourceLabelFor(track: Track | null | undefined): string | null {
  return providerForTrack(track)?.shortName ?? providerForTrack(track)?.displayName ?? null
}

