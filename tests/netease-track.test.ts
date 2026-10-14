import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toTrack } from '../src/netease/track.ts'
import type { NeteaseSong, NeteaseStream } from '../src/env'

/*
 * What this file is really guarding.
 *
 * A Netease track is the one Track in the app whose audio does not exist yet
 * when the row is built. The engine compares `loadedPath === track.path` to
 * decide whether it has to swap sources, so `path` has to be unique per song or
 * two different songs would be treated as the same one. `duration` has to be
 * seconds because every local track is seconds and the upstream reports
 * milliseconds. And `hasArt` has to be false when there is no cover, because a
 * truthy `hasArt` makes the artwork component request an image that does not
 * exist and paint a broken frame.
 */

const song: NeteaseSong = {
  id: 186016,
  name: '晴天',
  artists: [
    { id: 6452, name: '周杰伦' },
    { id: 1234, name: 'Guest' }
  ],
  album: { id: 185809, name: '叶惠美', picUrl: 'https://p1.music.126.net/cover.jpg' },
  duration: 269,
  fee: 0
}

const noCover: NeteaseSong = {
  id: 42,
  name: '无名',
  artists: [],
  album: { id: 7, name: '', picUrl: null },
  duration: 61,
  fee: 8
}

const stream: NeteaseStream = {
  url: 'https://m801.music.126.net/abc.mp3',
  br: 320000,
  level: 'exhigh',
  duration: 269,
  trial: false
}

test('the id carries the namespace so it can never collide with a local id', () => {
  assert.equal(toTrack(song).id, 'netease:186016')
})

test('path carries the same namespace and is unique per song', () => {
  const a = toTrack(song)
  const b = toTrack(noCover)
  assert.equal(a.path, 'netease:186016')
  assert.notEqual(a.path, b.path)
  assert.equal(a.id, a.path)
})

test('source is set so the library source layer can dispatch on it', () => {
  assert.equal(toTrack(song).source, 'netease')
})

test('artists are joined for display and the first one is the album artist', () => {
  const track = toTrack(song)
  assert.equal(track.artist, '周杰伦 / Guest')
  assert.equal(track.albumArtist, '周杰伦')
})

test('a song with no artists degrades to empty strings instead of undefined', () => {
  const track = toTrack(noCover)
  assert.equal(track.artist, '')
  assert.equal(track.albumArtist, '')
})

test('hasArt is false without a cover url, so nothing requests a missing image', () => {
  assert.equal(toTrack(noCover).hasArt, false)
  assert.equal(toTrack(song).hasArt, true)
})

test('duration stays in seconds - the upstream value is already seconds by the bridge', () => {
  assert.equal(toTrack(song).duration, 269)
})

test('bitrate comes from the resolved stream, and is null before one exists', () => {
  assert.equal(toTrack(song, stream).bitrate, 320000)
  assert.equal(toTrack(song).bitrate, null)
  assert.equal(toTrack(song, null).bitrate, null)
})

test('fields the online source cannot know are explicitly empty, never guessed', () => {
  const track = toTrack(song, stream)
  assert.equal(track.codec, 'mp3')
  assert.equal(track.lossless, false)
  assert.equal(track.sampleRate, null)
  assert.equal(track.channels, 2)
  assert.equal(track.size, 0)
  assert.equal(track.mtimeMs, 0)
  assert.equal(track.genre, '')
  assert.equal(track.year, null)
  assert.equal(track.trackNo, null)
  assert.equal(track.discNo, null)
  assert.equal(track.gainDb, null)
  assert.equal(track.peak, null)
})

test('album name is carried through, including the empty one', () => {
  assert.equal(toTrack(song).album, '叶惠美')
  assert.equal(toTrack(noCover).album, '')
})

test('addedAt is a real timestamp so sorting by "added" has something to sort on', () => {
  const before = Date.now()
  const track = toTrack(song)
  assert.ok(track.addedAt >= before && track.addedAt <= Date.now(), `addedAt was ${track.addedAt}`)
})

test('toTrack is pure: the same song mapped twice differs only in addedAt', () => {
  const a = toTrack(song, stream)
  const b = toTrack(song, stream)
  assert.deepEqual({ ...a, addedAt: 0 }, { ...b, addedAt: 0 })
})

test('a zero-duration upstream payload is passed through rather than invented', () => {
  // The bridge normalises dt -> seconds; a 0 here means the upstream had no dt,
  // and the row should show 0 rather than a fabricated number.
  assert.equal(toTrack({ ...song, duration: 0 }).duration, 0)
})
