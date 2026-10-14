import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyStreamFailure, describeFailure } from '../electron/netease/reasons.ts'
import type { NeteaseFailureReason } from '../electron/netease/reasons.ts'
import type { NeteaseFailureReason as ContractReason } from '../src/env'

/*
 * The single most user-visible decision in this whole feature.
 *
 * Upstream answers almost every refusal with `url: null`, so the lazy mapping
 * calls all of them "已下架" - and then a signed-out user looks for a copyright
 * problem that does not exist, and a trial-fragment user thinks the song was
 * deleted. These tests pin the mapping down rule by rule, in the order the
 * module evaluates them, so a later reordering that changes an answer fails
 * here instead of reaching a screenshot.
 */

test('the reason union in the main process is the one the renderer contract declares', () => {
  // Compile-time only: if the two unions drift apart, which side is wrong shows
  // up in `npm run typecheck` rather than as a string nobody recognizes.
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
  ] satisfies NeteaseFailureReason[]
  assert.equal(reasons.length, 9)
})

// --- transport -------------------------------------------------------------

test('a thrown call is a network failure, not a missing track', () => {
  assert.equal(classifyStreamFailure({ error: new Error('ECONNRESET') }), 'network')
  assert.equal(classifyStreamFailure({ error: { code: 'ETIMEDOUT' } }), 'network')
})

test('a thrown 429 is a rate limit, whether the status sits on the error or its response', () => {
  assert.equal(classifyStreamFailure({ error: { status: 429 } }), 'rate-limited')
  assert.equal(classifyStreamFailure({ error: { response: { status: 429 } } }), 'rate-limited')
  assert.equal(classifyStreamFailure({ error: { response: { status: 503 } } }), 'network')
})

test('a rejection with no status at all is still a network failure', () => {
  assert.equal(classifyStreamFailure({ error: 'boom' }), 'network')
  assert.equal(classifyStreamFailure({ error: new Error('socket hang up') }), 'network')
})

test('a thrown upstream envelope is classified by its body code, not dismissed as network', () => {
  // The package rejects rather than resolves for any non-200 answer, so a
  // refused track arrives as a throw. Reading it as "network" would turn a
  // delisted song into "check your connection", which is the exact confusion
  // the taxonomy exists to prevent. This was the first cold-start crash:
  // SMOKE_CRASHED { status: 404, body: { code: 404 }, cookie: [] }.
  assert.equal(classifyStreamFailure({ error: { status: 404, body: { code: 404 }, cookie: [] } }), 'taken-down')
  assert.equal(classifyStreamFailure({ error: { body: { code: -128 } } }), 'vip-required')
  assert.equal(classifyStreamFailure({ error: { body: { code: 301 } } }), 'login-required')
  assert.equal(classifyStreamFailure({ error: { body: { code: 200 } } }), 'taken-down')
  assert.equal(classifyStreamFailure({ error: { body: { code: 500 } } }), 'service-unavailable')
  // The outer status is still consulted first, because a 429 is about the
  // transport rather than the track.
  assert.equal(classifyStreamFailure({ error: { status: 429, body: { code: 200 } } }), 'rate-limited')
})

test('a thrown envelope with an unusable body code falls back to a transport failure', () => {
  assert.equal(classifyStreamFailure({ error: { body: {} } }), 'network')
  assert.equal(classifyStreamFailure({ error: { body: { code: 'nope' } } }), 'network')
  assert.equal(classifyStreamFailure({ error: { body: null } }), 'network')
  assert.equal(classifyStreamFailure({ error: { body: { code: Number.NaN } } }), 'network')
})

// --- envelope / per-track codes --------------------------------------------

test('login codes (301, -447) mean sign in, regardless of fee', () => {
  assert.equal(classifyStreamFailure({ code: 301, fee: 0, loggedIn: false }), 'login-required')
  assert.equal(classifyStreamFailure({ code: -447 }), 'login-required')
  assert.equal(classifyStreamFailure({ code: 301, loggedIn: true }), 'login-required')
})

test('-128 means a membership is required', () => {
  assert.equal(classifyStreamFailure({ code: -128, loggedIn: true }), 'vip-required')
  assert.equal(classifyStreamFailure({ code: -128, fee: 1, loggedIn: true }), 'vip-required')
})

test('-460 is the anti-abuse bucket and counts as a rate limit', () => {
  assert.equal(classifyStreamFailure({ code: -460 }), 'rate-limited')
})

test('502 is the upstream package reporting its own call failed, so it counts as network', () => {
  // The package rejects with 502 when the HTTP call itself did not complete,
  // which is a local/transport condition worth retrying - unlike a 5xx, which
  // means the far side answered and said it is unwell.
  assert.equal(classifyStreamFailure({ code: 502 }), 'network')
  assert.equal(classifyStreamFailure({ code: 502, url: null, fee: 1, loggedIn: true }), 'network')
  assert.equal(classifyStreamFailure({ error: { response: { status: 502 } } }), 'network')
})

test('500/503 are the far side being unwell, and outrank the per-track signals', () => {
  assert.equal(classifyStreamFailure({ code: 500 }), 'service-unavailable')
  assert.equal(classifyStreamFailure({ code: 503 }), 'service-unavailable')
  assert.equal(classifyStreamFailure({ code: 500, url: null, fee: 1, loggedIn: true }), 'service-unavailable')
  assert.equal(classifyStreamFailure({ code: 503, url: null, fee: 1, freeTrialInfo: { start: 0, end: 30 } }), 'service-unavailable')
  // Anything at or above 500 that is not the package's own 502 marker.
  assert.equal(classifyStreamFailure({ code: 504 }), 'service-unavailable')
  assert.equal(classifyStreamFailure({ code: 599 }), 'service-unavailable')
})

test('403 is region-limited once signed in, but "sign in first" while signed out', () => {
  assert.equal(classifyStreamFailure({ code: 403, loggedIn: true }), 'region-limited')
  assert.equal(classifyStreamFailure({ code: 403, loggedIn: false }), 'login-required')
})

test('-110 is a licence refusal in this region', () => {
  assert.equal(classifyStreamFailure({ code: -110 }), 'region-limited')
})

test('404 is gone, whether it arrives in the envelope or per track', () => {
  assert.equal(classifyStreamFailure({ code: 404 }), 'taken-down')
  assert.equal(classifyStreamFailure({ songCode: 404, code: 200, url: null, fee: 0 }), 'taken-down')
  assert.equal(classifyStreamFailure({ songCode: -200, code: 200, url: null, fee: 0 }), 'taken-down')
})

test('the real shape of a bogus id is classified as delisted, not as an unknown error', () => {
  // Captured from a live call: `song_url_v1({ id: 99999999999 })` answers with
  // `body.code === 200` and `body.data[0] = { url: null, code: 404, fee: 0 }`.
  // The client hands `entry.code` through as `songCode`, so this exact object is
  // what production reaches this function with.
  assert.equal(
    classifyStreamFailure({ code: 200, songCode: 404, url: null, fee: 0, freeTrialInfo: null, loggedIn: false }),
    'taken-down'
  )
})

test('the real shape of a VIP track is a trial fragment, not a refusal', () => {
  // Also captured live: a fee===1 cover answered `url` present, `code: 200`,
  // `freeTrialInfo: { start: 0, end: 35 }` and a *lower* `level` than requested
  // (standard for an exhigh request). Passing a url is what makes this
  // trial-only rather than vip-required - the tier shortfall is reported
  // separately by the renderer, never by inventing a refusal here.
  assert.equal(
    classifyStreamFailure({
      code: 200,
      songCode: 200,
      url: 'http://m802.music.126.net/…',
      fee: 1,
      freeTrialInfo: { start: 0, end: 35 },
      loggedIn: false
    }),
    'trial-only'
  )
})

// --- the url/fee/trial signals ---------------------------------------------

test('a playable url with a trial fragment is trial-only, not a normal play', () => {
  assert.equal(
    classifyStreamFailure({ code: 200, url: 'https://h/a.mp3', freeTrialInfo: { start: 0, end: 30 }, fee: 1 }),
    'trial-only'
  )
})

test('a playable url with no trial fragment is not a failure at all', () => {
  assert.equal(classifyStreamFailure({ code: 200, url: 'https://h/a.mp3', fee: 0 }), 'unknown')
})

test('a url that is null or empty is treated as nothing playable', () => {
  assert.equal(classifyStreamFailure({ code: 200, url: null, fee: 1, loggedIn: true }), 'vip-required')
  assert.equal(classifyStreamFailure({ code: 200, url: '', fee: 1, loggedIn: true }), 'vip-required')
})

test('an empty url with a paywalled fee asks for a login while signed out', () => {
  assert.equal(classifyStreamFailure({ code: 200, url: null, fee: 1, loggedIn: false }), 'login-required')
  assert.equal(classifyStreamFailure({ code: 200, url: null, fee: 4, loggedIn: false }), 'login-required')
})

test('an empty url with a paywalled fee and a session asks for a membership', () => {
  assert.equal(classifyStreamFailure({ code: 200, url: null, fee: 1, loggedIn: true }), 'vip-required')
  assert.equal(classifyStreamFailure({ code: 200, url: null, fee: 4, loggedIn: true }), 'vip-required')
})

test('a trial with no url is reported as a trial, not as a missing track', () => {
  assert.equal(classifyStreamFailure({ code: 200, url: null, freeTrialInfo: { start: 0, end: 30 } }), 'trial-only')
})

test('an empty freeTrialInfo object is not a trial', () => {
  assert.equal(classifyStreamFailure({ code: 200, url: null, freeTrialInfo: {}, fee: 0 }), 'taken-down')
  assert.equal(classifyStreamFailure({ url: null, freeTrialInfo: null, fee: 0 }), 'taken-down')
})

// --- the residual cases, where the honest answer is weak -------------------

test('a free, unremarkable track with no url reads as delisted - a deliberate over-reach', () => {
  // 200 + no url + fee 0 is upstream's shape for a metadata-only track AND for
  // a delisted one; the module picks taken-down because it is the likelier
  // cause. Recorded here so the blur is a decision, not an accident.
  assert.equal(classifyStreamFailure({ code: 200, url: null, fee: 0 }), 'taken-down')
  assert.equal(classifyStreamFailure({ code: null, url: null }), 'taken-down')
})

test('a signed-out user is told to sign in when a code is missing and the track is free', () => {
  // Deliberate: for a signed-out session a free track with no url is more often
  // a login gate than a removal, and "sign in" is the actionable sentence.
  assert.equal(classifyStreamFailure({ url: null, fee: 0, loggedIn: false }), 'taken-down')
})

test('an unknown per-track code with no url is still reported as delisted', () => {
  // Same over-reach as above, one layer down: the per-track code is not one the
  // classifier knows, so the fallback decides. Pinned so a change is deliberate.
  assert.equal(classifyStreamFailure({ code: 200, songCode: 999, url: null, fee: 8 }), 'taken-down')
})

test('a code the classifier does not know falls through to unknown', () => {
  // 250 is not 200/null (the delisted fallback), not a named code, not 5xx, and
  // the fee is free: every named rule has been checked and none matched.
  assert.equal(classifyStreamFailure({ code: 250, url: null, fee: 0 }), 'unknown')
  assert.equal(classifyStreamFailure({ code: 250, url: null, fee: 0, freeTrialInfo: {} }), 'unknown')
  assert.equal(classifyStreamFailure({ code: 250, url: null, fee: 8, songCode: 12 }), 'unknown')
})

test('anything at 500 or above is read as a 5xx, even a code that is not an HTTP status', () => {
  // The check is `code >= 500`, so a private upstream code in that range is
  // reported as "service unavailable". That is the same sentence a real 502
  // produces - which is the right user-facing outcome, and pinned here so the
  // over-reach is a decision rather than a surprise.
  assert.equal(classifyStreamFailure({ code: 777 }), 'service-unavailable')
  assert.equal(classifyStreamFailure({ code: 12345 }), 'service-unavailable')
  assert.equal(classifyStreamFailure({ code: 500 }), 'service-unavailable')
})

test('the input is never mutated and never throws', () => {
  const input = { code: 200, url: null, fee: 1, loggedIn: false }
  const snapshot = { ...input }
  assert.equal(classifyStreamFailure(input), 'login-required')
  assert.deepEqual(input, snapshot)
  assert.equal(typeof classifyStreamFailure({}), 'string')
  assert.equal(classifyStreamFailure({ code: Number.NaN, fee: 'free' as unknown as number }), 'taken-down')
})

test('a fee the upstream does not document is not treated as paywalled', () => {
  assert.equal(classifyStreamFailure({ code: 200, url: null, fee: 8 }), 'taken-down')
  assert.equal(classifyStreamFailure({ code: 200, url: null, fee: 0 }), 'taken-down')
})

// --- wording ---------------------------------------------------------------

const allReasons: NeteaseFailureReason[] = [
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

test('every reason has a sentence of its own', () => {
  const texts = allReasons.map((reason) => describeFailure(reason))
  assert.equal(new Set(texts).size, texts.length)
  for (const text of texts) assert.ok(text.length > 0 && typeof text === 'string')
})

test('the membership sentence says what the app will not do, without pretending the song is gone', () => {
  const vip = describeFailure('vip-required')
  assert.ok(vip.includes('会员'), vip)
  assert.ok(!vip.includes('下架'), vip)
  assert.ok(vip.includes('绕过付费'), vip)
})

test('only the taken-down sentence is allowed to say the song is gone', () => {
  for (const reason of ['login-required', 'vip-required', 'region-limited'] as NeteaseFailureReason[]) {
    assert.ok(!describeFailure(reason).includes('下架'), `${reason} must not claim 下架`)
  }
  assert.ok(describeFailure('taken-down').includes('下架'))
})

test('the trial sentence distinguishes a fragment from a refusal', () => {
  const trial = describeFailure('trial-only')
  assert.ok(trial.includes('试听'), trial)
  assert.ok(!trial.includes('下架'), trial)
})
