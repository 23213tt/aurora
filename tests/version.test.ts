import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isNewer, parseVersion } from '../electron/version.ts'

test('parses tags with and without a v prefix', () => {
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3])
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3])
  assert.deepEqual(parseVersion('  v0.10.2  '), [0, 10, 2])
})

test('pads short versions with zeros', () => {
  assert.deepEqual(parseVersion('1.2'), [1, 2])
  assert.deepEqual(parseVersion('2'), [2])
})

test('treats a pre-release suffix as the same release', () => {
  // A beta tag must not outrank the release it precedes.
  assert.deepEqual(parseVersion('1.2.3-beta.1'), [1, 2, 3])
  assert.equal(isNewer('1.2.3-beta.1', '1.2.3'), false)
})

test('survives a malformed tag instead of throwing', () => {
  assert.deepEqual(parseVersion('nightly'), [0])
  assert.deepEqual(parseVersion(''), [0])
})

test('detects a newer patch, minor and major', () => {
  assert.equal(isNewer('1.0.1', '1.0.0'), true)
  assert.equal(isNewer('1.1.0', '1.0.9'), true)
  assert.equal(isNewer('2.0.0', '1.99.99'), true)
})

test('compares numerically, not as strings', () => {
  // '0.10.0' < '0.9.0' as strings, which is the classic version-compare bug.
  assert.equal(isNewer('0.10.0', '0.9.0'), true)
  assert.equal(isNewer('1.0.10', '1.0.9'), true)
  assert.equal(isNewer('0.9.0', '0.10.0'), false)
})

test('reports no update when versions match or are older', () => {
  assert.equal(isNewer('1.0.0', '1.0.0'), false)
  assert.equal(isNewer('1.0.0', '1.0.1'), false)
  assert.equal(isNewer('v1.2.3', '1.2.3'), false)
})

test('handles missing segments on either side', () => {
  assert.equal(isNewer('1.2', '1.1.9'), true)
  assert.equal(isNewer('1.2.0', '1.2'), false)
})
