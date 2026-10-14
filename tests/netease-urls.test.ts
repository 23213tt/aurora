import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REMOTE_SCHEME, remoteImageUrl, remoteStreamUrl } from '../src/player/urls.ts'

/*
 * The online source has to hand the audio element and the <img> tag a
 * same-origin URL, because the production CSP allows no external origins and a
 * cross-origin media element routed through Web Audio plays silence. These two
 * builders are the whole translation layer, so the properties that matter are:
 *
 *   1. the scheme is `aurora-remote:` and the kind is the first path segment,
 *      because the main-process handler routes on exactly that;
 *   2. the upstream URL survives as ONE path segment, byte for byte, no matter
 *      what it contains - query strings with `&`, `?`, `+`, spaces, non-ASCII,
 *      a fragment, even another scheme;
 *   3. the result parses as a URL at all, so nothing downstream has to
 *      defensively string-match it.
 *
 * Note what is NOT tested here and why: rejecting localhost and private
 * addresses is done by the protocol handler in the main process, not by these
 * builders (they have no opinion about the address). That check is covered in
 * tests/remote-protocol.test.ts against the real handler logic.
 */

function parse(url: string): { scheme: string; kind: string; upstream: string } {
  const parsed = new URL(url)
  return {
    scheme: parsed.protocol.replace(/:$/, ''),
    kind: parsed.host,
    upstream: decodeURIComponent(parsed.pathname.replace(/^\//, ''))
  }
}

test('the scheme matches the privileged scheme the main process registers', () => {
  assert.equal(REMOTE_SCHEME, 'aurora-remote')
  assert.ok(remoteStreamUrl('https://x/y').startsWith(`${REMOTE_SCHEME}://`))
})

test('stream urls route on the "stream" host', () => {
  const url = remoteStreamUrl('https://m801.music.126.net/20240101/abc.mp3')
  assert.equal(parse(url).kind, 'stream')
  assert.equal(parse(url).scheme, 'aurora-remote')
})

test('image urls route on the "image" host', () => {
  const url = remoteImageUrl('https://p1.music.126.net/cover.jpg')
  assert.equal(parse(url).kind, 'image')
})

const upstreams = [
  'https://m801.music.126.net/20240101/abcdef.mp3',
  'http://m801.music.126.net/a/b/c.flac',
  'https://m801.music.126.net/x.mp3?auth=AABB&token=zz&x=1',
  'https://p1.music.126.net/cover.jpg?param=300y300',
  'https://m801.music.126.net/%E4%B8%AD%E6%96%87.mp3',
  'https://m801.music.126.net/a b+c.mp3',
  'https://m801.music.126.net/a.mp3#fragment',
  'https://user:pass@m801.music.126.net/a.mp3',
  'https://m801.music.126.net/a.mp3?redirect=https%3A%2F%2Fevil.example%2Fx',
  'https://[2001:db8::1]/a.mp3',
  'https://m801.music.126.net/a.mp3?q=%26%3D%3F%23'
]

for (const upstream of upstreams) {
  test(`round-trips exactly: ${upstream.slice(0, 60)}`, () => {
    assert.equal(parse(remoteStreamUrl(upstream)).upstream, upstream)
    assert.equal(parse(remoteImageUrl(upstream)).upstream, upstream)
  })
}

test('the upstream survives even though the result stays a single path segment', () => {
  const url = remoteStreamUrl('https://h/x.mp3?a=1&b=2')
  // Only the scheme's own `//host/` introduces a slash; the upstream's own
  // slashes are encoded, so a handler cannot mistake part of the upstream for
  // a route of ours.
  assert.equal(new URL(url).pathname.split('/').length, 2)
  assert.ok(!url.includes('&'), 'an unencoded ampersand would look like a parameter of ours')
  assert.ok(!url.includes('?'), 'an unencoded query string would be split off by URL parsing')
})

test('non-ASCII upstreams are percent-encoded, not left to the URL parser', () => {
  const url = remoteStreamUrl('https://h/中文 歌.mp3')
  assert.ok(url.includes('%E4%B8%AD%E6%96%87'))
  assert.equal(parse(url).upstream, 'https://h/中文 歌.mp3')
})

test('a double-encoded upstream is not double-decoded on the way back', () => {
  // %2520 is the encoding of "%20"; it must come back as "%20", not as a space.
  const upstream = 'https://h/a%2520b.mp3'
  assert.equal(parse(remoteStreamUrl(upstream)).upstream, upstream)
})

test('the two builders are distinguishable, so a cover can never be played as audio', () => {
  const upstream = 'https://h/x.mp3'
  assert.notEqual(remoteStreamUrl(upstream), remoteImageUrl(upstream))
})

test('the builders are pure: the same upstream gives the same string', () => {
  assert.equal(remoteStreamUrl('https://h/x'), remoteStreamUrl('https://h/x'))
})
