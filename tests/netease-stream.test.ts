import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  QUALITY_LABEL,
  QUALITY_ORDER,
  failureText,
  isFallback,
  isTransient,
  qualityRank,
  shortDuration,
  streamSummary
} from '../src/netease/stream.ts'
import type { NeteaseFailureReason, NeteaseQuality, NeteaseStream } from '../src/env'

/*
 * Quality is where a music player is most tempted to lie.
 *
 * The upstream does not refuse a `lossless` request - it answers with the best
 * tier this account and track can actually get, which may be 320k, may be a
 * trial fragment, or may be nothing at all. So the rule these tests pin down is:
 * the app reports what it was given and never silently pretends the request was
 * honoured, and it never retries a tier the account is not entitled to (a retry
 * cannot create an entitlement, it only adds load).
 */

const stream = (patch: Partial<NeteaseStream> = {}): NeteaseStream => ({
  url: 'https://m801.music.126.net/a.mp3',
  br: 320,
  level: 'exhigh',
  duration: 269,
  trial: false,
  ...patch
})

test('the tier order is ascending and holds exactly the four selectable tiers', () => {
  assert.deepEqual(QUALITY_ORDER, ['standard', 'higher', 'exhigh', 'lossless'])
})

test('rank is monotonic across the selectable tiers', () => {
  const ranks = QUALITY_ORDER.map((level) => qualityRank(level))
  assert.deepEqual(ranks, [0, 1, 2, 3])
  for (let i = 1; i < ranks.length; i += 1) assert.ok(ranks[i] > ranks[i - 1])
})

test('hires ranks above every selectable tier, so requesting it is never a fallback', () => {
  assert.ok(qualityRank('hires') > qualityRank('lossless'))
  for (const requested of QUALITY_ORDER) assert.equal(isFallback('hires', requested), false)
})

test('a delivered tier below the requested one is a fallback; equal or higher is not', () => {
  assert.equal(isFallback('exhigh', 'lossless'), true)
  assert.equal(isFallback('standard', 'lossless'), true)
  assert.equal(isFallback('lossless', 'lossless'), false)
  assert.equal(isFallback('exhigh', 'exhigh'), false)
  assert.equal(isFallback('higher', 'standard'), false)
})

test('the level string from the upstream is reported verbatim', () => {
  // A resolved stream keeps the upstream's own level word; the app must not
  // rewrite it to the tier that happened to be requested.
  assert.equal(stream({ level: 'higher' }).level, 'higher')
  assert.equal(isFallback(stream({ level: 'higher' }).level, 'lossless'), true)
  assert.equal(isFallback(stream({ level: 'lossless' }).level, 'lossless'), false)
})

test('a trial fragment is a separate axis from the tier, and says so in the summary', () => {
  const trial = stream({ level: 'lossless', br: 999, trial: true, trialFrom: 0, trialTo: 30 })
  // The tier really was lossless, so tier-wise it is not a fallback...
  assert.equal(isFallback(trial.level, 'lossless'), false)
  // ...but the summary must still say the user is hearing 30 seconds.
  const summary = streamSummary(trial, 'lossless')
  assert.ok(summary.includes('试听'), summary)
  assert.ok(summary.includes('0:30'), summary)
  // `trialFrom` is 0 here - a real value, not a missing one. Rendering it as
  // "--:--" would tell the user the fragment starts nowhere.
  assert.ok(summary.includes('0:00'), `trialFrom=0 must print as 0:00, got: ${summary}`)
})

test('a trial whose bounds are unknown still says it is a fragment', () => {
  const summary = streamSummary(stream({ trial: true }), 'exhigh')
  assert.ok(summary.includes('试听片段'), summary)
})

test('the summary names the shortfall when the upstream had no higher tier', () => {
  const summary = streamSummary(stream({ level: 'exhigh', br: 320 }), 'lossless')
  assert.ok(summary.includes(QUALITY_LABEL.exhigh), summary)
  assert.ok(summary.includes('320kbps'), summary)
  assert.ok(summary.includes('低于所选'), summary)
})

test('a full-quality stream carries no apology and no trial wording', () => {
  const summary = streamSummary(stream({ level: 'lossless', br: 1411000 }), 'lossless')
  assert.ok(!summary.includes('试听'), summary)
  assert.ok(!summary.includes('低于所选'), summary)
  assert.ok(summary.includes('无损'), summary)
})

test('every selectable tier has a human label, and hires does too', () => {
  for (const level of [...QUALITY_ORDER, 'hires'] as (NeteaseQuality | 'hires')[]) {
    assert.equal(typeof QUALITY_LABEL[level], 'string')
    assert.ok(QUALITY_LABEL[level].length > 0)
  }
})

test('shortDuration formats mm:ss, pads seconds, and refuses to fake a bogus value', () => {
  // Zero is a real instant - upstream trial fragments start at 0 - so it must
  // print as 0:00; only a negative or non-finite value is unknown.
  assert.equal(shortDuration(0), '0:00')
  assert.equal(shortDuration(-5), '--:--')
  assert.equal(shortDuration(Number.NaN), '--:--')
  assert.equal(shortDuration(Number.POSITIVE_INFINITY), '--:--')
  assert.equal(shortDuration(7), '0:07')
  assert.equal(shortDuration(59.4), '0:59')
  assert.equal(shortDuration(60), '1:00')
  assert.equal(shortDuration(269), '4:29')
  assert.equal(shortDuration(3600), '60:00')
})

const reasons: NeteaseFailureReason[] = [
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

test('every failure reason produces a distinct sentence', () => {
  const texts = reasons.map((reason) => failureText(reason))
  assert.equal(new Set(texts).size, texts.length, `duplicated wording: ${JSON.stringify(texts)}`)
})

test('the wording never collapses a permission problem into "已下架"', () => {
  // This is the whole reason the taxonomy exists: a VIP track labelled "下架"
  // sends the user looking for a copyright problem that does not exist.
  assert.ok(!failureText('vip-required').includes('下架'))
  assert.ok(!failureText('login-required').includes('下架'))
  assert.ok(!failureText('region-limited').includes('下架'))
  assert.ok(failureText('taken-down').includes('下架'))
  assert.ok(failureText('vip-required').includes('会员'))
})

test('a reason outside the typed set still yields a sentence instead of undefined', () => {
  assert.equal(typeof failureText('something-new' as NeteaseFailureReason), 'string')
})

test('only network-side failures are worth retrying', () => {
  assert.equal(isTransient('network'), true)
  assert.equal(isTransient('rate-limited'), true)
  assert.equal(isTransient('service-unavailable'), true)
  for (const reason of ['login-required', 'vip-required', 'region-limited', 'trial-only', 'taken-down'] as NeteaseFailureReason[]) {
    assert.equal(isTransient(reason), false, `${reason} must not be auto-retried`)
  }
})
