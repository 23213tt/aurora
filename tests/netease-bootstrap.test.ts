import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  HANDSHAKE_BACKOFF_MS,
  HANDSHAKE_COOLDOWN_MS,
  isTransientHandshakeFailure
} from '../electron/pure/netease-bootstrap.ts'

/**
 * The retry decision for a failed Netease handshake.
 *
 * This is the fix for a reported bug - "playback does not work and I am not even
 * logged in" - where a single transient connection reset was latched behind a
 * sixty-second cooldown, so subsequent play attempts reported a network problem
 * that had already passed. The decision itself is one predicate, so it is worth
 * pinning down precisely which failures are retried.
 */
test('transient failures are retried', () => {
  assert.equal(isTransientHandshakeFailure('network'), true)
  assert.equal(isTransientHandshakeFailure('rate-limited'), true)
  assert.equal(isTransientHandshakeFailure('service-unavailable'), true)
})

test('settled answers are never retried', () => {
  // Repeating these cannot change them: they describe the account or the track.
  for (const reason of ['login-required', 'vip-required', 'region-limited', 'taken-down', 'trial-only'] as const) {
    assert.equal(isTransientHandshakeFailure(reason), false, reason)
  }
})

test('an unknown failure and no failure at all are both treated as permanent', () => {
  /*
   * Fails safe: an unrecognised reason is not retried, so a future failure mode
   * cannot turn into a retry storm by default. `null` means the handshake had not
   * failed, so there is nothing to retry either.
   */
  assert.equal(isTransientHandshakeFailure('unknown'), false)
  assert.equal(isTransientHandshakeFailure(null), false)
})

test('the retry schedule stays short, and the cooldown stays long', () => {
  /*
   * The two serve opposite purposes and must not converge: the backoff covers a
   * blip, the cooldown prevents a storm. If the backoff ever grew to seconds the
   * user would wait for it; if the cooldown ever shrank to milliseconds every
   * render of the online tab would fire a request.
   */
  assert.ok(HANDSHAKE_BACKOFF_MS.length > 0, 'at least one retry')
  assert.ok(
    HANDSHAKE_BACKOFF_MS.reduce((sum, ms) => sum + ms, 0) < 5_000,
    'total retry wait stays under five seconds'
  )
  assert.ok(HANDSHAKE_COOLDOWN_MS >= 10_000, 'cooldown remains a real gate')
})
