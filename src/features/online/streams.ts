import { isTransientFailure, type OnlineStream, type ProviderId, type QualityTier } from './types'

/**
 * Resolved stream URLs, per platform.
 *
 * Every online platform has the same three problems and they are the same three
 * problems the Netease screen already solved, so they are solved once here rather
 * than once per platform:
 *
 * - **A URL expires.** Both upstreams sign their CDN links with a TTL, so a
 *   cached URL is handed out only inside a window and re-resolved after it.
 * - **A resolution can be refused.** Refusals are remembered briefly, because the
 *   upstreams rate-limit and a user clicking a dead row repeatedly must not turn
 *   into a burst of requests.
 * - **A refusal is not one condition.** Whether to retry depends on *why*:
 *   a network fault is worth another try in a minute, "needs a membership" is not
 *   worth another try at all.
 *
 * Deliberately not reactive state: the engine asks for a URL synchronously while
 * it loads a track, and a cache that renders is a cache that can flicker.
 */

/** Signed CDN links live roughly twenty minutes upstream; eight is a safe read. */
const STREAM_TTL_MS = 8 * 60 * 1000

/** How long a refusal is remembered, by whether asking again can help. */
const TRANSIENT_FAILURE_TTL_MS = 45 * 1000
const FINAL_FAILURE_TTL_MS = 5 * 60 * 1000

/** After a load found no URL, how long a late arrival may still auto-recover it. */
export const RECOVER_WINDOW_MS = 20 * 1000


 interface CachedFailure {
  reason: string
  message?: string
  expiresAt: number
}

interface Entry {
  fetchedAt: number
  expiresAt: number
  stream?: OnlineStream
  failure?: CachedFailure
}

const cache = new Map<string, Entry>()
const inFlight = new Map<string, Promise<void>>()

function key(providerId: ProviderId, songId: number): string {
  return `${providerId}:${songId}`
}

/** The URL for a song, or null when there is none usable right now. */
export function cachedStream(providerId: ProviderId, songId: number): OnlineStream | null {
  const entry = cache.get(key(providerId, songId))
  if (!entry || entry.expiresAt <= Date.now()) return null
  return entry.stream ?? null
}

/** A remembered refusal, so the interface can name the reason without re-asking. */
export function cachedFailure(providerId: ProviderId, songId: number): CachedFailure | null {
  const entry = cache.get(key(providerId, songId))
  if (!entry || entry.expiresAt <= Date.now()) return null
  return entry.failure ?? null
}

export function rememberStream(
  providerId: ProviderId,
  songId: number,
  stream: OnlineStream,
  fetchedAt = Date.now()
): void {
  cache.set(key(providerId, songId), {
    fetchedAt,
    expiresAt: fetchedAt + STREAM_TTL_MS,
    stream
  })
}

export function rememberFailure(
  providerId: ProviderId,
  songId: number,
  reason: string,
  message?: string
): void {
  const now = Date.now()
  cache.set(key(providerId, songId), {
    fetchedAt: now,
    expiresAt: now + (isTransientFailure(reason as never) ? TRANSIENT_FAILURE_TTL_MS : FINAL_FAILURE_TTL_MS),
    failure: { reason, message, expiresAt: now + TRANSIENT_FAILURE_TTL_MS }
  })
}

/** Called when the tier changes: none of the cached links were signed for it. */
export function clearStreams(providerId?: ProviderId): void {
  if (!providerId) {
    cache.clear()
    return
  }
  for (const entryKey of [...cache.keys()]) {
    if (entryKey.startsWith(`${providerId}:`)) cache.delete(entryKey)
  }
}

/**
 * Resolve-once-at-a-time.
 *
 * Two callers asking for the same song - the row the user clicked and the
 * prefetch that was already running - must produce one request, not two. The
 * second caller awaits the first job instead of starting its own.
 */
export function dedupe<T>(providerId: ProviderId, songId: number, job: () => Promise<T>): Promise<T> {
  const provider = `${providerId}:${songId}`
  const running = inFlight.get(provider) as Promise<T> | undefined
  if (running) return running

  const started = job()
  inFlight.set(
    provider,
    started.then(
      () => undefined,
      () => undefined
    )
  )
  return started.finally(() => inFlight.delete(provider))
}

/**
 * The default tier for a platform whose backend cannot answer yet.
 *
 * `exhigh` (320k) rather than lossless: it is the highest tier that does not
 * require a paid account on either upstream, so the default never fails purely
 * because of the preference the user has not set yet.
 */
export const DEFAULT_QUALITY: QualityTier = 'exhigh'
