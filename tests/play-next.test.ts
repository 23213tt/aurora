import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Track } from '../src/types.ts'

/*
 * localStorage must exist before the store module is evaluated: zustand's
 * persist middleware hydrates synchronously at creation.
 */
const store = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key)
}

const { usePlayer } = await import('../src/features/player/store.ts')

function track(id: string): Track {
  return {
    id,
    path: `C:\\music\\${id}.flac`,
    title: id,
    artist: 'x',
    albumArtist: 'x',
    album: 'x',
    genre: '',
    year: null,
    trackNo: null,
    discNo: null,
    duration: 100,
    bitrate: null,
    sampleRate: null,
    channels: null,
    codec: 'FLAC',
    lossless: true,
    size: 0,
    mtimeMs: 0,
    addedAt: 0,
    hasArt: false,
    gainDb: null,
    peak: null
  }
}

const ids = (): string[] => usePlayer.getState().queue.map((t) => t.id)

/**
 * "Play next" has to be correct in play order, not just in the queue array.
 * With shuffle on those are different things, and inserting into only one of them
 * is the classic way this feature silently does nothing.
 */
test('play next inserts directly after the current track', () => {
  usePlayer.getState().setShuffle(false)
  usePlayer.getState().setQueue([track('a'), track('b'), track('c')], 0)

  usePlayer.getState().enqueue([track('x')], 'next')

  assert.deepEqual(ids(), ['a', 'x', 'b', 'c'])
  assert.equal(usePlayer.getState().index, 0, 'the playing track does not change')
})

test('play next lands after the current track in play order, not queue order', () => {
  usePlayer.getState().setQueue([track('a'), track('b'), track('c'), track('d'), track('e')], 2)
  usePlayer.getState().setShuffle(true)

  const before = usePlayer.getState()
  const current = before.index
  const at = before.order.indexOf(current)
  assert.ok(at >= 0, 'the playing track must be somewhere in the play order')

  usePlayer.getState().enqueue([track('x')], 'next')

  const after = usePlayer.getState()
  const stillAt = after.order.indexOf(current)
  const nextUp = after.order[stillAt + 1]

  assert.equal(after.queue[nextUp].id, 'x', 'the next track in play order is the queued one')
  assert.equal(stillAt, at, 'the playing track keeps its place in the order')
})

test('the queue length and order stay consistent after inserting', () => {
  usePlayer.getState().setQueue([track('a'), track('b'), track('c')], 1)
  usePlayer.getState().setShuffle(false)

  usePlayer.getState().enqueue([track('x'), track('y')], 'next')

  const state = usePlayer.getState()
  assert.deepEqual(ids(), ['a', 'b', 'x', 'y', 'c'])
  assert.equal(state.order.length, state.queue.length, 'order must cover every queue slot')
  assert.deepEqual([...state.order].sort((m, n) => m - n), [0, 1, 2, 3, 4], 'order is a permutation')
})

test('play next on an empty queue starts that track', () => {
  usePlayer.getState().clearQueue()
  usePlayer.getState().enqueue([track('solo')], 'next')

  const state = usePlayer.getState()
  assert.deepEqual(ids(), ['solo'])
  assert.equal(state.index, 0, 'something has to become current or nothing plays')
})

test('queueing the same file twice is allowed and keeps both entries', () => {
  usePlayer.getState().setQueue([track('a'), track('b')], 0)
  usePlayer.getState().enqueue([track('a')], 'next')

  // A queue is a sequence, not a set: playing a track "next" twice is a
  // legitimate thing to ask for.
  assert.deepEqual(ids(), ['a', 'a', 'b'])
})
