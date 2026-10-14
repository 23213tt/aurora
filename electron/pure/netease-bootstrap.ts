/**
 * When a failed Netease handshake is worth retrying.
 *
 * Extracted from the client so the decision can be tested without the upstream
 * package, the filesystem or the network - and because it is the fix for a
 * reported bug: one transient `ECONNRESET` used to be latched behind a
 * sixty-second cooldown, so the next several play attempts returned the stale
 * failure without contacting upstream at all. The same call succeeded seconds
 * later when retried by hand, which means a blip was being shown to the user as a
 * persistent outage.
 *
 * Zero imports: `electron/pure/` is loaded in bare Node for tests, so it must not
 * pull in anything that requires Electron.
 */

/** Failures the client can report from a handshake attempt. */
 type HandshakeFailure =
  | 'login-required'
  | 'vip-required'
  | 'region-limited'
  | 'taken-down'
  | 'trial-only'
  | 'rate-limited'
  | 'network'
  | 'service-unavailable'
  | 'unknown'
  | null

/**
 * Whether repeating the handshake could plausibly produce a different answer.
 *
 * An allow-list on purpose: a reason added later is treated as permanent until
 * someone decides otherwise, which fails safe. Retrying a settled answer would be
 * pointless - no amount of repetition turns "you need a membership" into a
 * playable track - while *not* retrying a transient one is what produced the bug
 * this exists to prevent.
 */
export function isTransientHandshakeFailure(reason: HandshakeFailure): boolean {
  return reason === 'network' || reason === 'rate-limited' || reason === 'service-unavailable'
}

/**
 * Backoff between retries, in milliseconds. Its length is also the number of
 * retries, so the two cannot drift apart.
 *
 * Short: these cover a connection reset or a momentary DNS failure, not an outage.
 * A handshake that fails three times in about two seconds is reported as failed,
 * and the caller's longer cooldown takes over from there.
 */
export const HANDSHAKE_BACKOFF_MS = [400, 1200]

/** How long a settled failure is trusted before another attempt is allowed. */
export const HANDSHAKE_COOLDOWN_MS = 60_000
