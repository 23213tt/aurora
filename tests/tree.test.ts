import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ancestorPaths, buildFolderTree, tracksUnder } from '../src/library/tree.ts'
import { makeTrack } from './fixtures.ts'

test('builds a nested tree from track paths', () => {
  const tree = buildFolderTree([makeTrack('a', 'C:\\Music\\Album\\01.flac')])
  assert.equal(tree.length, 1)

  const root = tree[0]
  // A bare drive letter reads as a drive, not as a letter.
  assert.equal(root.name, 'C:\\')
  assert.equal(root.totalCount, 1)
  assert.equal(root.directCount, 0)

  const users = root.children[0]
  assert.equal(users.name, 'Music')
  assert.equal(users.totalCount, 1)

  const album = users.children[0]
  assert.equal(album.name, 'Album')
  // The file itself is directly here, so this one counts as direct.
  assert.equal(album.directCount, 1)
  assert.equal(album.totalCount, 1)
  assert.deepEqual(album.children, [])
})

test('totalCount includes descendants while directCount does not', () => {
  const tree = buildFolderTree([
    makeTrack('a', 'C:\\Music\\Albums\\A\\1.flac'),
    makeTrack('b', 'C:\\Music\\Albums\\B\\1.flac'),
    makeTrack('c', 'C:\\Music\\loose.flac')
  ])
  const music = tree[0].children[0]
  assert.equal(music.name, 'Music')
  assert.equal(music.directCount, 1)
  assert.equal(music.totalCount, 3)

  const albums = music.children[0]
  assert.equal(albums.name, 'Albums')
  assert.equal(albums.directCount, 0)
  assert.equal(albums.totalCount, 2)
})

test('children are ordered by how much they contain, then by name', () => {
  const tree = buildFolderTree([
    makeTrack('a', 'C:\\Music\\Small\\1.flac'),
    makeTrack('b', 'C:\\Music\\Big\\1.flac'),
    makeTrack('c', 'C:\\Music\\Big\\2.flac')
  ])
  const music = tree[0].children[0]
  assert.deepEqual(
    music.children.map((child) => child.name),
    ['Big', 'Small']
  )
})

test('handles several roots', () => {
  const tree = buildFolderTree([
    makeTrack('a', 'C:\\Music\\a.flac'),
    makeTrack('b', 'D:\\Audio\\b.flac')
  ])
  assert.deepEqual(
    tree.map((node) => node.name),
    ['C:\\', 'D:\\']
  )
})

test('a single-file directory is counted once', () => {
  const tree = buildFolderTree([makeTrack('a', 'C:\\a.flac')])
  assert.equal(tree[0].totalCount, 1)
  assert.equal(tree[0].directCount, 1)
})

test('ignores paths with no directory part', () => {
  assert.deepEqual(buildFolderTree([makeTrack('a', 'bare-file.flac')]), [])
})

test('tracksUnder returns the folder and everything below it', () => {
  const tracks = [
    makeTrack('a', 'C:\\Music\\Albums\\A\\1.flac'),
    makeTrack('b', 'C:\\Music\\Albums\\B\\1.flac'),
    makeTrack('c', 'C:\\Music\\loose.flac'),
    makeTrack('d', 'D:\\Other\\x.flac')
  ]

  assert.deepEqual(
    tracksUnder(tracks, 'C:\\Music').map((track) => track.id),
    ['a', 'b', 'c']
  )
  assert.deepEqual(
    tracksUnder(tracks, 'C:\\Music\\Albums').map((track) => track.id),
    ['a', 'b']
  )
  assert.deepEqual(
    tracksUnder(tracks, 'C:\\Music\\Albums\\A').map((track) => track.id),
    ['a']
  )
  assert.deepEqual(tracksUnder(tracks, 'E:\\Nothing'), [])
})

test('tracksUnder does not mistake a sibling prefix for a descendant', () => {
  // "C:\Music2" must not be caught by a search for "C:\Music".
  const tracks = [makeTrack('a', 'C:\\Music\\a.flac'), makeTrack('b', 'C:\\Music2\\b.flac')]
  const found = tracksUnder(tracks, 'C:\\Music')
  assert.deepEqual(
    found.map((track) => track.id),
    ['a']
  )
})

test('ancestorPaths walks down the hierarchy', () => {
  assert.deepEqual(ancestorPaths('C:\\Music\\Albums\\A'), ['C:', 'C:\\Music', 'C:\\Music\\Albums', 'C:\\Music\\Albums\\A'])
})
