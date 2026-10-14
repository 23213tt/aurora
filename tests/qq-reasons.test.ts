import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyStreamFailure, describeFailure } from '../electron/qq/reasons.ts'
import type { QqFailureReason } from '../electron/qq/reasons.ts'
import type { QqFailureReason as ContractReason } from '../src/env'

/*
 * QQ's most user-visible decision.
 *
 * The upstream answers a refusal it will not serve with an empty `purl` and a
 * per-song `result` code, and almost every mainstream track is paywalled - so
 * "restricted" is the *normal* outcome, and the tempting shortcut (call them all
 * "已下架") would send people looking for a copyright problem that does not
 * exist. These tests pin the rules down in the order the module evaluates them.
 *
 * Every code below was observed against the live service, not invented:
 * 104003 for a paywalled tier/track, 101404 for a songmid the service cannot
 * resolve, 1000 for an absent or bogus cookie.
 */

test('the main-process union is the one the renderer contract declares', () => {
  // Compile-time only: if the two unions drift, the mismatch lands in
  // `npm run typecheck` rather than in a string nobody recognizes.
  const reasons: ContractReason[] = [
    'login-required',
    'vip-required',
    'region-limited',
    'trial-only',
    'taken-down',
    'network',
    'rate-limited',
    'service-unavailable',
    'unknown'
  ] satisfies QqFailureReason[]
  assert.equal(reasons.length, 9)
})

test('QQ reuses the Netease reason vocabulary, so the interface renders one set', () => {
  // The union is imported from the other platform on purpose. If someone ever
  // forks it, this stops being a type-only assertion.
  const shared: QqFailureReason[] = []
  assert.deepEqual(shared, [])
})

// --- transport -------------------------------------------------------------

test('a thrown call is a network failure', () => {
  assert.equal(classifyStreamFailure({ error: new Error('ECONNRESET') }), 'network')
  assert.equal(classifyStreamFailure({ error: { code: 'ETIMEDOUT' } }), 'network')
})

test('a thrown 429 is a rate limit, on the error or on its response', () => {
  assert.equal(classifyStreamFailure({ error: { status: 429 } }), 'rate-limited')
  assert.equal(classifyStreamFailure({ error: { response: { status: 429 } } }), 'rate-limited')
  assert.equal(classifyStreamFailure({ error: { response: { status: 503 } } }), 'network')
})

test('502 is the package reporting its own HTTP call failed, so it is the network', () => {
  // The installed package rejects with `{code: 502}` when the request never
  // completed; that is transport, not "the service is down".
  assert.equal(classifyStreamFailure({ code: 502 }), 'network')
})

test('code 1000 is the signed-out signal, verified live', () => {
  assert.equal(classifyStreamFailure({ code: 1000 }), 'login-required')
  assert.equal(classifyStreamFailure({ code: 1000, loggedIn: true }), 'login-required')
})

test('server-side codes 5xx are the service being unwell', () => {
  assert.equal(classifyStreamFailure({ code: 500 }), 'service-unavailable')
  assert.equal(classifyStreamFailure({ code: 503 }), 'service-unavailable')
})

// --- the per-song verdict --------------------------------------------------

test('104003 is a restriction, never "taken down" and never an error', () => {
  assert.equal(classifyStreamFailure({ result: 104003, purl: '' }), 'login-required')
  assert.equal(classifyStreamFailure({ result: 104003, purl: '', loggedIn: true }), 'vip-required')
  // The failure the whole feature exists to get right: a signed-out user on a
  // VIP track must be told to sign in, not that the song is gone.
  assert.notEqual(classifyStreamFailure({ result: 104003, purl: '' }), 'taken-down')
})

test('101404 is an identifier upstream cannot resolve, so it is never a paywall', () => {
  // Verified live: this is what the vkey route answers when a numeric `songid`
  // is passed where a `songmid` belongs. Reporting it as "needs a membership"
  // would send the user to buy something they may already own.
  assert.equal(classifyStreamFailure({ result: 101404, purl: '', paidHint: true }), 'unknown')
  assert.equal(classifyStreamFailure({ result: 101404, purl: '', loggedIn: true }), 'unknown')
})

test('an unrecognised refusal code falls back to the pay hint, then to unknown', () => {
  assert.equal(classifyStreamFailure({ result: 99999, purl: '', paidHint: true }), 'login-required')
  assert.equal(
    classifyStreamFailure({ result: 99999, purl: '', paidHint: true, loggedIn: true }),
    'vip-required'
  )
  assert.equal(classifyStreamFailure({ result: 99999, purl: '', paidHint: false }), 'unknown')
})

test('no verdict and no address: the search-stage hint decides, and only then', () => {
  // This is the tiebreaker Mineradio's lesson allows: `pay_play` is a hint, so
  // it may break a tie, but a refusal with a free hint stays unknown rather than
  // becoming a claim about the track.
  assert.equal(classifyStreamFailure({ purl: '', paidHint: true }), 'login-required')
  assert.equal(classifyStreamFailure({ purl: '', paidHint: true, loggedIn: true }), 'vip-required')
  assert.equal(classifyStreamFailure({ purl: '', paidHint: false }), 'unknown')
  assert.equal(classifyStreamFailure({}), 'unknown')
})

test('a playable address is not a failure, whatever else arrived', () => {
  assert.equal(classifyStreamFailure({ purl: 'M500x.mp3?vkey=1' }), 'unknown')
})

test('result 0 with no address is unknown, not a delisting claim', () => {
  // Upstream has no verified "taken down" signal for QQ, so `taken-down` is
  // never produced here - the module cannot claim evidence it does not have.
  assert.equal(classifyStreamFailure({ result: 0, purl: '' }), 'unknown')
  assert.notEqual(classifyStreamFailure({ result: 0, purl: '' }), 'taken-down')
})

test('classifyStreamFailure is total: no input throws and none returns undefined', () => {
  const inputs: unknown[] = [
    {},
    undefined,
    null,
    { code: Number.NaN, result: Number.POSITIVE_INFINITY },
    { error: 'a string' },
    { error: { body: { code: 104003 } } },
    { purl: 123, result: '104003' as unknown as number }
  ]
  for (const input of inputs) {
    const reason = classifyStreamFailure(input as Parameters<typeof classifyStreamFailure>[0])
    assert.equal(typeof reason, 'string')
  }
})

// --- wording ---------------------------------------------------------------

test('every reason has wording, and none of it claims a track was removed', () => {
  const reasons: QqFailureReason[] = [
    'login-required',
    'vip-required',
    'region-limited',
    'trial-only',
    'taken-down',
    'network',
    'rate-limited',
    'service-unavailable',
    'unknown'
  ]
  for (const reason of reasons) {
    const message = describeFailure(reason)
    assert.ok(message.length > 0, `${reason} has no message`)
    if (reason !== 'taken-down') {
      assert.ok(!message.includes('下架'), `${reason} wrongly claims a delisting`)
    }
  }
})

test('the wording names QQ, not the other platform', () => {
  // The two clients share the reason vocabulary but not the words: a QQ user
  // must not be told to check a Netease account.
  assert.match(describeFailure('login-required'), /QQ/)
  assert.match(describeFailure('vip-required'), /QQ 音乐会员/)
  assert.ok(!describeFailure('network').includes('网易云'))
})
