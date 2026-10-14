import assert from 'node:assert/strict'
import { test } from 'node:test'
import { identityOrder, reconcile, shuffledOrder, step } from '../src/player/queue.ts'

test('identityOrder is the natural order', () => {
  assert.deepEqual(identityOrder(3), [0, 1, 2])
  assert.deepEqual(identityOrder(0), [])
})

test('shuffledOrder is a permutation that keeps the current track first', () => {
  const order = shuffledOrder(6, 3)
  assert.equal(order.length, 6)
  assert.deepEqual([...order].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5])
  // Enabling shuffle must never interrupt what is playing.
  assert.equal(order[0], 3)
})

test('stepping forward advances one place', () => {
  assert.deepEqual(step([0, 1, 2], 0, 1, 'off'), { index: 1, play: true })
  assert.deepEqual(step([0, 1, 2], 1, 1, 'off'), { index: 2, play: true })
})

test('running off the end with repeat off stops playback', () => {
  // Null is the signal to stop, as opposed to a result that plays something.
  assert.equal(step([0, 1, 2], 2, 1, 'off'), null)
})

test('running off the end with repeat all wraps around', () => {
  assert.deepEqual(step([0, 1, 2], 2, 1, 'all'), { index: 0, play: true })
})

test('going back from the first track with repeat all wraps to the end', () => {
  assert.deepEqual(step([0, 1, 2], 0, -1, 'all'), { index: 2, play: true })
})

test('going back from the first track with repeat off restarts the queue', () => {
  assert.deepEqual(step([0, 1, 2], 0, -1, 'off'), { index: 0, play: true })
})

test('repeat one holds the current track when moving forward', () => {
  assert.deepEqual(step([0, 1, 2], 1, 1, 'one'), { index: 1, play: true })
})

test('repeat one still allows an explicit step backwards', () => {
  assert.deepEqual(step([0, 1, 2], 1, -1, 'one'), { index: 0, play: true })
})

test('stepping an empty order reports nowhere to go', () => {
  assert.equal(step([], 0, 1, 'all'), null)
})

test('a current index missing from the order falls back to the front', () => {
  assert.deepEqual(step([2, 0, 1], 9, 1, 'off'), { index: 2, play: true })
})

test('stepping follows the shuffle order, not the queue order', () => {
  // With order [3,1,0,2], being on track 3 means the next is track 1.
  assert.deepEqual(step([3, 1, 0, 2], 3, 1, 'off'), { index: 1, play: true })
})

test('reconcile drops indices that no longer exist', () => {
  const queue = [{}, {}] as never[]
  const result = reconcile(queue, [0, 5, 1, 9], 0)
  assert.deepEqual(result.order, [0, 1])
})

test('reconcile appends indices missing from the order', () => {
  const queue = [{}, {}, {}] as never[]
  const result = reconcile(queue, [0], 0)
  assert.deepEqual([...result.order].sort((a, b) => a - b), [0, 1, 2])
})

test('reconcile re-points an out-of-range current index', () => {
  const queue = [{}, {}] as never[]
  assert.equal(reconcile(queue, [0, 1], 7).index, 0)
})

test('reconcile keeps a valid current index', () => {
  const queue = [{}, {}, {}] as never[]
  assert.equal(reconcile(queue, [0, 1, 2], 2).index, 2)
})
