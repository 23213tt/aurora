import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { resolveAppAsset } from '../electron/pure/app-paths.ts'

/*
 * Every case here is an attempt to read something outside the renderer bundle.
 * The protocol handler serves whatever this function returns, so a miss is an
 * arbitrary file read.
 */
const root = path.resolve('C:/app/dist')

test('resolves a normal asset inside the root', () => {
  assert.equal(resolveAppAsset(root, '/assets/index-abc.js'), path.join(root, 'assets', 'index-abc.js'))
})

test('an empty path falls back to index.html', () => {
  assert.equal(resolveAppAsset(root, '/'), path.join(root, 'index.html'))
  assert.equal(resolveAppAsset(root, ''), path.join(root, 'index.html'))
})

test('rejects parent-directory traversal', () => {
  assert.equal(resolveAppAsset(root, '/../secret.txt'), null)
  assert.equal(resolveAppAsset(root, '/assets/../../secret.txt'), null)
  assert.equal(resolveAppAsset(root, '/..\\..\\secret.txt'), null)
})

test('rejects percent-encoded traversal', () => {
  // The check has to happen after decoding, not before.
  assert.equal(resolveAppAsset(root, '/%2e%2e/secret.txt'), null)
  assert.equal(resolveAppAsset(root, '/assets/%2e%2e%2f%2e%2e%2fsecret.txt'), null)
})

test('rejects an absolute path that would escape the root', () => {
  assert.equal(resolveAppAsset(root, 'C:/Windows/System32/drivers/etc/hosts'), null)
  // After stripping leading slashes this is still a rooted path on Windows.
  assert.equal(resolveAppAsset(root, '/C:/Windows/win.ini'), null)
})

test('rejects a NUL byte in the path', () => {
  assert.equal(resolveAppAsset(root, '/index.html%00.png'), null)
})

test('rejects malformed percent-encoding instead of throwing', () => {
  assert.equal(resolveAppAsset(root, '/%E0%A4%A'), null)
})

test('rejects the root directory itself', () => {
  assert.equal(resolveAppAsset(root, '/.'), null)
})

test('allows a sibling-looking name that only shares a prefix', () => {
  // "dist-other" must not be reachable through "dist".
  assert.equal(resolveAppAsset(root, '/../dist-other/x.js'), null)
})

test('keeps a legitimate nested asset', () => {
  assert.equal(
    resolveAppAsset(root, '/assets/nested/deep/file.css'),
    path.join(root, 'assets', 'nested', 'deep', 'file.css')
  )
})
