import assert from 'node:assert/strict'
import { test } from 'node:test'

/*
 * Functional proof that a profile isolates data.
 *
 * The switcher looking right says nothing about whether two profiles actually
 * keep separate libraries, and that separation is the entire point of the
 * feature. This drives the real store against a fake localStorage.
 *
 * localStorage has to exist before the store module is evaluated, because
 * zustand's persist middleware hydrates synchronously when the store is created
 * - hence the dynamic import below rather than a static one.
 *
 * Each test uses its own profile ids. Sharing them would make the expectations
 * depend on execution order, which is how a test starts passing for the wrong
 * reason.
 */
const store = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key)
}

const { loadProfilePlaylists, usePlaylists } = await import('../src/playlists/store.ts')

const names = (): string[] => usePlaylists.getState().playlists.map((p) => p.name)

test('profiles keep separate playlist libraries', async () => {
  await loadProfilePlaylists('iso_a')
  assert.deepEqual(names(), [], 'a new profile starts empty')

  usePlaylists.getState().create('A 的歌单', ['t1', 't2'])
  assert.deepEqual(names(), ['A 的歌单'])

  // Switching must not show the other profile's library.
  await loadProfilePlaylists('iso_b')
  assert.deepEqual(names(), [], 'profile B must not see profile A playlists')

  usePlaylists.getState().create('B 的歌单', ['t3'])
  assert.deepEqual(names(), ['B 的歌单'])

  // And switching back must restore, not lose, what A had.
  await loadProfilePlaylists('iso_a')
  assert.deepEqual(names(), ['A 的歌单'], 'switching back restores the original library')

  await loadProfilePlaylists('iso_b')
  assert.deepEqual(names(), ['B 的歌单'])
})

test('a profile that has never saved anything loads empty, not stale', async () => {
  await loadProfilePlaylists('iso_c')
  usePlaylists.getState().create('只属于 C', ['t9'])

  await loadProfilePlaylists('iso_never_used')
  assert.deepEqual(names(), [], 'an untouched profile must not inherit the last library')

  // The untouched profile must also not have overwritten C on the way through.
  await loadProfilePlaylists('iso_c')
  assert.deepEqual(names(), ['只属于 C'])
})

test('deleting a playlist in one profile leaves the other untouched', async () => {
  await loadProfilePlaylists('iso_d')
  usePlaylists.getState().create('D 的歌单', ['t4'])

  await loadProfilePlaylists('iso_e')
  usePlaylists.getState().create('E 的歌单', ['t5'])

  const target = usePlaylists.getState().playlists[0]
  assert.ok(target)
  usePlaylists.getState().remove(target.id)
  assert.deepEqual(names(), [], 'E deleted its own playlist')

  await loadProfilePlaylists('iso_d')
  assert.deepEqual(names(), ['D 的歌单'], 'D is unaffected by a deletion in E')
})

test('renaming a profile does not move or lose its playlists', async () => {
  await loadProfilePlaylists('iso_f')
  usePlaylists.getState().create('F 的歌单', ['t6'])

  // The library is keyed by the account id, which renaming leaves alone, so the
  // data must still be there after switching away and back.
  await loadProfilePlaylists('iso_g')
  await loadProfilePlaylists('iso_f')
  assert.deepEqual(names(), ['F 的歌单'])
})

test('playlists survive a full unload and reload of the profile', async () => {
  await loadProfilePlaylists('iso_h')
  usePlaylists.getState().create('H 的歌单', ['t7', 't8'])

  // Simulate the app restarting: switch elsewhere, drop the in-memory state,
  // then load the profile again from storage.
  await loadProfilePlaylists('iso_i')
  usePlaylists.setState({ playlists: [] })
  await loadProfilePlaylists('iso_h')

  assert.deepEqual(names(), ['H 的歌单'])
  const restored = usePlaylists.getState().playlists[0]
  assert.deepEqual(restored.trackIds, ['t7', 't8'], 'track order survives the round trip')
})
