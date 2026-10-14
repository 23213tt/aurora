import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createProfileScopedStorage,
  getActiveStorageProfile,
  profileScopedKey,
  setActiveStorageProfile,
  shouldAdoptLegacy
} from '../src/features/accounts/profile-storage.ts'

const BASE = 'aurora.playlists'

test('different profiles derive different keys', () => {
  assert.notEqual(profileScopedKey(BASE, 'acc_a'), profileScopedKey(BASE, 'acc_b'))
})

test('the same profile is stable across calls', () => {
  assert.equal(profileScopedKey(BASE, 'acc_a'), profileScopedKey(BASE, 'acc_a'))
})

test('a missing profile falls back to a single shared slot', () => {
  const fallback = profileScopedKey(BASE, null)
  assert.equal(profileScopedKey(BASE, undefined), fallback)
  assert.equal(profileScopedKey(BASE, ''), fallback)
  assert.equal(profileScopedKey(BASE, '   '), fallback)
})

test('the base name is preserved so slices stay separate', () => {
  assert.notEqual(profileScopedKey(BASE, 'acc_a'), profileScopedKey('aurora.other', 'acc_a'))
})

test('an owner containing the separator cannot collide with another base', () => {
  /*
   * Without sanitising the owner these two would both be "a::b::c", and two
   * different profiles would read and write the same slot.
   */
  assert.notEqual(profileScopedKey('a::b', 'c'), profileScopedKey('a', 'b::c'))
})

test('surrounding whitespace in an id does not create a second slot', () => {
  assert.equal(profileScopedKey(BASE, '  acc_a  '), profileScopedKey(BASE, 'acc_a'))
})

test('legacy data is adopted only when the profile has none of its own', () => {
  assert.equal(shouldAdoptLegacy('{"playlists":[]}', null), true)
  // The profile already has data: adopting would overwrite it.
  assert.equal(shouldAdoptLegacy('{"playlists":[]}', '{"playlists":[1]}'), false)
  // Nothing legacy to adopt.
  assert.equal(shouldAdoptLegacy(null, null), false)
})

test('the active profile is tracked and can be cleared', () => {
  setActiveStorageProfile('acc_a')
  assert.equal(getActiveStorageProfile(), 'acc_a')
  setActiveStorageProfile(null)
  assert.equal(getActiveStorageProfile(), null)
})

/*
 * The storage adapter is the part that actually decides where data lands, so it
 * is exercised against a fake localStorage rather than left to the middleware.
 */
function withFakeStorage(run: (store: Map<string, string>) => void): void {
  const previous = (globalThis as { localStorage?: unknown }).localStorage
  const map = new Map<string, string>()
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key)
  }
  try {
    run(map)
  } finally {
    ;(globalThis as { localStorage?: unknown }).localStorage = previous
    setActiveStorageProfile(null)
  }
}

test('writes go to the active profile slot', () => {
  withFakeStorage((map) => {
    setActiveStorageProfile('acc_a')
    const storage = createProfileScopedStorage()
    storage.setItem(BASE, 'A')

    setActiveStorageProfile('acc_b')
    storage.setItem(BASE, 'B')

    assert.equal(map.get(profileScopedKey(BASE, 'acc_a')), 'A')
    assert.equal(map.get(profileScopedKey(BASE, 'acc_b')), 'B')
    // What one profile writes must never be what another reads.
    assert.equal(storage.getItem(BASE), 'B')
  })
})

test('a profile with nothing saved reads back nothing', () => {
  withFakeStorage(() => {
    setActiveStorageProfile('acc_new')
    assert.equal(createProfileScopedStorage().getItem(BASE), null)
  })
})

test('legacy shared data is adopted once there is a profile to adopt it', () => {
  withFakeStorage((map) => {
    map.set(BASE, 'legacy')

    setActiveStorageProfile('acc_a')
    const storage = createProfileScopedStorage()
    assert.equal(storage.getItem(BASE), 'legacy')

    // Moved, not copied: the shared key must not linger and be adopted again by
    // the next profile.
    assert.equal(map.has(BASE), false)
    assert.equal(map.get(profileScopedKey(BASE, 'acc_a')), 'legacy')

    setActiveStorageProfile('acc_b')
    assert.equal(storage.getItem(BASE), null)
  })
})

test('legacy data is not adopted before a profile exists', () => {
  withFakeStorage((map) => {
    map.set(BASE, 'legacy')
    setActiveStorageProfile(null)

    // The store hydrates once before any profile exists. Adopting then would
    // strand the data in a slot no profile ever reads.
    assert.equal(createProfileScopedStorage().getItem(BASE), null)
    assert.equal(map.get(BASE), 'legacy')
  })
})

test('a profile that already has data never adopts the legacy key', () => {
  withFakeStorage((map) => {
    setActiveStorageProfile('acc_a')
    map.set(BASE, 'legacy')
    map.set(profileScopedKey(BASE, 'acc_a'), 'mine')

    assert.equal(createProfileScopedStorage().getItem(BASE), 'mine')
    assert.equal(map.get(BASE), 'legacy')
  })
})
