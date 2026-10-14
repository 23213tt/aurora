import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setActiveStorageProfile } from '../src/features/accounts/profile-storage.ts'
import {
  readRememberedSource,
  rememberSource,
  sourceKeyFor
} from '../src/app/search/remembered-source.ts'

/**
 * The search screen remembers which catalogue you last searched.
 *
 * Worth locking down because the value is stored under a profile-derived key: if
 * the key were not profile-scoped, two profiles on one machine would share the
 * setting - the same class of mistake the profile feature exists to prevent, and
 * invisible until someone noticed their default had changed by itself.
 *
 * Tested through the pure module rather than the store, because the store imports
 * the Netease client and cannot be loaded outside Vite at all.
 */
function withStorage(run: (map: Map<string, string>) => void): void {
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

test('nothing remembered yet reads as null, so the caller can pick a default', () => {
  withStorage(() => {
    setActiveStorageProfile('acc_a')
    assert.equal(readRememberedSource(), null)
  })
})

test('a choice survives, and lands only in that profile slot', () => {
  withStorage((map) => {
    setActiveStorageProfile('acc_a')
    rememberSource('local')
    assert.equal(readRememberedSource(), 'local')

    // Same base key, different owner id: must be a different slot.
    assert.equal(map.get(sourceKeyFor('acc_a')), 'local')
    assert.equal(map.has(sourceKeyFor('acc_b')), false)

    setActiveStorageProfile('acc_b')
    assert.equal(readRememberedSource(), null, 'another profile must not inherit it')
    rememberSource('online')
    assert.equal(readRememberedSource(), 'online')

    // And the first profile still has its own answer.
    setActiveStorageProfile('acc_a')
    assert.equal(readRememberedSource(), 'local')
  })
})

test('a corrupt or unknown stored value is ignored rather than trusted', () => {
  withStorage((map) => {
    setActiveStorageProfile('acc_a')
    map.set(sourceKeyFor('acc_a'), 'not-a-source')
    assert.equal(readRememberedSource(), null)

    // A value from an older shape must not become the active source either.
    map.set(sourceKeyFor('acc_a'), '{"source":"local"}')
    assert.equal(readRememberedSource(), null)
  })
})

test('storage being unavailable does not throw', () => {
  const previous = (globalThis as { localStorage?: unknown }).localStorage
  ;(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => {
      throw new Error('opaque origin')
    },
    setItem: () => {
      throw new Error('opaque origin')
    },
    removeItem: () => undefined
  }
  try {
    setActiveStorageProfile('acc_a')
    assert.equal(readRememberedSource(), null)
    // Remembering is best-effort: losing persistence is better than losing a click.
    rememberSource('local')
  } finally {
    ;(globalThis as { localStorage?: unknown }).localStorage = previous
    setActiveStorageProfile(null)
  }
})
