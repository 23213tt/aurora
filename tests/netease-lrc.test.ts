import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mergeTranslation } from '../src/netease/lrc.ts'

/*
 * The upstream returns the lyric and its machine translation as two separate
 * LRC documents keyed by the same timestamps. The lyric view highlights one
 * line per timestamp, so keeping them separate means the translation never
 * lights up with the singing. Merging is what makes a translated song usable,
 * and the failure modes worth pinning down are:
 *
 *   - a translation line with no original must not be dropped silently;
 *   - a missing translation must not change the original at all;
 *   - metadata tags like `[offset:...]` must survive, because dropping the
 *     offset would shift every remaining line against the audio.
 */

const lrc = ['[ti:测试]', '[offset:-500]', '[00:01.00]hello', '[00:10.50]world'].join('\n')
const translation = ['[00:01.00]你好', '[00:10.50]世界'].join('\n')

test('a translation is merged onto the same line as its original', () => {
  const merged = mergeTranslation(lrc, translation)
  assert.ok(merged)
  assert.ok(merged.includes('[00:01.00]hello / 你好'), merged)
  assert.ok(merged.includes('[00:10.50]world / 世界'), merged)
})

test('metadata tags survive the merge', () => {
  const merged = mergeTranslation(lrc, translation)
  assert.ok(merged)
  assert.ok(merged.includes('[ti:测试]'), merged)
  assert.ok(merged.includes('[offset:-500]'), merged)
})

test('a translation line with no original at the same timestamp is appended, not lost', () => {
  const merged = mergeTranslation('[00:01.00]only', '[00:01.00]only-tr\n[00:09.00]orphan')
  assert.ok(merged)
  assert.ok(merged.includes('orphan'), merged)
  assert.ok(merged.includes('only / only-tr'), merged)
})

test('merged output is ordered by time, even when the translation arrives out of order', () => {
  const merged = mergeTranslation('[00:02.00]b\n[00:01.00]a', '[00:01.00]A\n[00:02.00]B')
  assert.ok(merged)
  const lines = merged.split('\n')
  assert.deepEqual(lines, ['[00:01.00]a / A', '[00:02.00]b / B'])
})

test('an identical translation is not duplicated onto the line', () => {
  assert.equal(mergeTranslation('[00:01.00]same', '[00:01.00]same'), '[00:01.00]same')
})

test('no translation returns the original unchanged, so callers need no special case', () => {
  assert.equal(mergeTranslation(lrc, null), lrc)
  assert.equal(mergeTranslation(lrc, ''), lrc)
})

test('no original falls back to the translation rather than returning nothing', () => {
  assert.equal(mergeTranslation(null, translation), translation)
  assert.equal(mergeTranslation('', translation), translation)
})

test('nothing at all is null, not an empty string', () => {
  assert.equal(mergeTranslation(null, null), null)
  assert.equal(mergeTranslation('', ''), null)
})

test('the fraction separator is normalised, so [mm:ss:xx] and [mm:ss.xx] agree', () => {
  // Both spellings are legal LRC and both mean the same instant; if they parsed
  // differently the translation would land on a line the player never shows.
  assert.equal(mergeTranslation('[00:01:50]a', '[00:01.50]A'), '[00:01.50]a / A')
})

test('a three-digit fraction means milliseconds, and matches the hundredths spelling', () => {
  assert.equal(mergeTranslation('[00:01.500]a', '[00:01.50]A'), '[00:01.50]a / A')
})

test('a line with several timestamps is merged at every one of them', () => {
  const merged = mergeTranslation('[00:01.00][00:05.00]chorus', '[00:05.00]副歌')
  assert.ok(merged)
  assert.ok(merged.includes('[00:01.00]chorus'), merged)
  assert.ok(merged.includes('[00:05.00]chorus / 副歌'), merged)
})

test('merging is idempotent: the same inputs give the same text', () => {
  assert.equal(mergeTranslation(lrc, translation), mergeTranslation(lrc, translation))
})

test('a merged document is still parseable as LRC - no bare, untimestamped content lines', () => {
  const merged = mergeTranslation(lrc, translation)
  assert.ok(merged)
  for (const line of merged.split('\n')) {
    assert.ok(line.startsWith('['), `line lost its timestamp: ${line}`)
  }
})
