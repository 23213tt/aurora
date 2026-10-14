import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Track } from '../src/types.ts'
import { buildM3u, normalisePath, parseM3u, resolveEntries } from '../src/playlists/m3u.ts'

function track(id: string, path: string, title = id, artist = '某人'): Track {
  return {
    id,
    path,
    title,
    artist,
    albumArtist: artist,
    album: '专辑',
    genre: '',
    year: null,
    trackNo: null,
    discNo: null,
    duration: 200,
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

test('buildM3u writes a header and an EXTINF per track', () => {
  const text = buildM3u([track('a', 'C:\\M\\a.flac', '标题', '歌手')])
  const lines = text.split('\r\n')
  assert.equal(lines[0], '#EXTM3U')
  assert.equal(lines[1], '#EXTINF:200,歌手 - 标题')
  assert.equal(lines[2], 'C:\\M\\a.flac')
})

test('buildM3u drops the artist prefix when it is unknown', () => {
  const text = buildM3u([track('a', 'C:\\M\\a.flac', '标题', '未知艺术家')])
  assert.equal(text.split('\r\n')[1], '#EXTINF:200,标题')
})

test('parseM3u reads paths and EXTINF labels', () => {
  const entries = parseM3u('#EXTM3U\n#EXTINF:180,歌手 - 标题\nC:\\M\\a.flac\nD:\\b.mp3\n')
  assert.equal(entries.length, 2)
  assert.deepEqual(entries[0], { path: 'C:\\M\\a.flac', title: '歌手 - 标题' })
  assert.deepEqual(entries[1], { path: 'D:\\b.mp3', title: null })
})

test('parseM3u ignores unknown directives and blanks', () => {
  const entries = parseM3u('#EXTM3U\n#EXTENC:UTF-8\n\n# 注释\n\nC:\\a.mp3\n')
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ['C:\\a.mp3']
  )
})

test('parseM3u tolerates an EXTINF with no label', () => {
  const entries = parseM3u('#EXTINF:120\nC:\\a.mp3')
  assert.deepEqual(entries[0], { path: 'C:\\a.mp3', title: null })
})

test('normalisePath makes separators and case insignificant', () => {
  assert.equal(normalisePath('C:/Music/A.FLAC'), 'c:\\music\\a.flac')
  assert.equal(normalisePath('C:\\\\Music\\\\a.flac'), 'c:\\music\\a.flac')
  assert.equal(normalisePath('  C:\\Music\\a.flac  '), 'c:\\music\\a.flac')
})

test('resolveEntries matches regardless of separator style or case', () => {
  const library = [track('a', 'C:\\Music\\Album\\01 Song.flac')]
  const { ids, missing } = resolveEntries(
    [{ path: 'c:/music/album/01 song.FLAC', title: null }],
    library,
    null
  )
  assert.deepEqual(ids, ['a'])
  assert.equal(missing, 0)
})

test('resolveEntries follows playlist order, not library order', () => {
  const library = [track('a', 'C:\\M\\a.flac'), track('b', 'C:\\M\\b.flac')]
  const { ids } = resolveEntries(
    [{ path: 'C:\\M\\b.flac', title: null }, { path: 'C:\\M\\a.flac', title: null }],
    library,
    null
  )
  assert.deepEqual(ids, ['b', 'a'])
})

test('resolveEntries resolves relative paths against the playlist directory', () => {
  const library = [track('a', 'C:\\Music\\Album\\01.flac')]
  const { ids, missing } = resolveEntries(
    [{ path: 'Album\\01.flac', title: null }],
    library,
    'C:\\Music'
  )
  assert.deepEqual(ids, ['a'])
  assert.equal(missing, 0)
})

test('resolveEntries ignores the base directory for absolute entries', () => {
  const library = [track('a', 'C:\\Music\\a.flac')]
  const { ids } = resolveEntries([{ path: 'C:\\Music\\a.flac', title: null }], library, 'D:\\Other')
  assert.deepEqual(ids, ['a'])
})

test('resolveEntries drops duplicates and counts misses', () => {
  const library = [track('a', 'C:\\M\\a.flac')]
  const { ids, missing } = resolveEntries(
    [
      { path: 'C:\\M\\a.flac', title: null },
      { path: 'C:\\M\\a.flac', title: null },
      { path: 'C:\\Gone\\x.flac', title: null }
    ],
    library,
    null
  )
  assert.deepEqual(ids, ['a'])
  assert.equal(missing, 1)
})

test('resolveEntries returns nothing for an unreadable playlist', () => {
  const { ids, missing } = resolveEntries([], [track('a', 'C:\\M\\a.flac')], null)
  assert.deepEqual(ids, [])
  assert.equal(missing, 0)
})
