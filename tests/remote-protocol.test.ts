import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, test } from 'node:test'
import { REMOTE_SCHEME, handleRemoteRequest, isPrivateAddress } from '../electron/remote-protocol.ts'
import { remoteImageUrl, remoteStreamUrl } from '../src/player/urls.ts'

/*
 * The proxy is the one place where the renderer can name an address and the
 * main process will fetch it. Without an address check, `aurora-remote:` is a
 * general-purpose request forwarder inside the user's network - the router's
 * admin page, a NAS, or the cloud metadata endpoint that hands out credentials.
 *
 * These tests drive the real handler (the same function `protocol.handle` is
 * wired to), not a copy of its rules, and they use a real loopback HTTP server
 * rather than a mocked fetch. Two properties are being pinned:
 *
 *   1. a private destination is refused *before* the socket is opened - which
 *      is why the server below counts how many requests it actually received;
 *   2. anything that is not an http(s) URL never becomes a target at all.
 *
 * No test here needs the internet: every address is either loopback, a reserved
 * range, or a `.invalid` name that cannot resolve.
 */

// A real server on a real loopback port. If the guard were missing, this server
// would be reached and its counter would move.
let reached = 0
const server = http.createServer((_request, response) => {
  reached += 1
  response.writeHead(200, { 'content-type': 'text/html' })
  response.end('reached')
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as AddressInfo).port
const loopback = `http://127.0.0.1:${port}/x`

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

test('the proxy refuses a loopback destination with 403 and never opens the socket', async () => {
  const before = reached
  const response = await handleRemoteRequest(new Request(remoteStreamUrl(loopback)))
  assert.equal(response.status, 403)
  assert.equal(reached, before, 'the private address was actually fetched')
  // The refusal deliberately does not describe the network it was asked about.
  assert.equal((await response.text()).includes('127.0.0.1'), false)
})

test('the refusal carries CORS headers, so the renderer sees a rejection rather than silence', async () => {
  const response = await handleRemoteRequest(new Request(remoteStreamUrl(loopback)))
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
})

test('localhost and .localhost are refused by name, before any DNS lookup', async () => {
  assert.equal((await handleRemoteRequest(new Request(remoteStreamUrl('http://localhost/x')))).status, 403)
  assert.equal((await handleRemoteRequest(new Request(remoteStreamUrl('http://music.localhost/x')))).status, 403)
})

test('the cloud metadata address is refused', async () => {
  // 169.254.169.254 is the one people mean when they say "SSRF".
  const response = await handleRemoteRequest(
    new Request(remoteStreamUrl('http://169.254.169.254/latest/meta-data/'))
  )
  assert.equal(response.status, 403)
})

test('a private IPv4 destination is refused, in every range the module claims', async () => {
  for (const host of [
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255'
  ]) {
    const response = await handleRemoteRequest(new Request(remoteStreamUrl(`http://${host}/x`)))
    assert.equal(response.status, 403, `${host} was not refused`)
  }
})

test('an IPv6 loopback or unique-local destination is refused', async () => {
  for (const host of ['[::1]', '[::]', '[fe80::1]', '[fd00::1]']) {
    const response = await handleRemoteRequest(new Request(remoteStreamUrl(`http://${host}/x`)))
    assert.equal(response.status, 403, `${host} was not refused`)
  }
})

test('a hex-form IPv4-mapped IPv6 destination is refused, not treated as public', async () => {
  // The WHATWG URL parser normalises `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`,
  // so the guard only ever sees the hex spelling. Every address here is a real
  // private destination wearing an IPv6 costume, and the loopback one is aimed
  // at the server this file is running: if the guard misses it, that server is
  // reached (the counter moves) instead of the request being refused.
  const before = reached
  for (const host of [
    '[::ffff:7f00:1]', // 127.0.0.1
    '[0:0:0:0:0:ffff:127.0.0.1]', // same, spelled out
    '[::ffff:a00:1]', // 10.0.0.1
    '[::ffff:ac10:1]', // 172.16.0.1
    '[::ffff:c0a8:101]' // 192.168.1.1
  ]) {
    const response = await handleRemoteRequest(new Request(remoteStreamUrl(`http://${host}/x`)))
    assert.equal(response.status, 403, `${host} was not refused`)
  }
  assert.equal(reached, before, 'the mapped loopback address was actually fetched')
})

test('a name that cannot resolve is refused rather than forwarded', async () => {
  const response = await handleRemoteRequest(
    new Request(remoteStreamUrl('http://this-host-does-not-exist.invalid/x'))
  )
  assert.equal(response.status, 403)
})

test('a non-http target never becomes a target, whatever the route', async () => {
  for (const target of ['file:///C:/Windows/win.ini', 'data:text/html,hi', 'ftp://example.com/x']) {
    const response = await handleRemoteRequest(new Request(remoteStreamUrl(target)))
    assert.equal(response.status, 400, `${target} was not rejected as a bad target`)
  }
})

test('a malformed or empty target is a 400, not a crash', async () => {
  for (const url of [
    `${REMOTE_SCHEME}://stream/`,
    `${REMOTE_SCHEME}://stream/%E0%A4%A`,
    `${REMOTE_SCHEME}://image/`,
    `${REMOTE_SCHEME}://stream`
  ]) {
    const response = await handleRemoteRequest(new Request(url))
    assert.ok(response.status === 400 || response.status === 404, `${url} gave ${response.status}`)
  }
})

test('only the stream and image routes exist', async () => {
  const response = await handleRemoteRequest(new Request(`${REMOTE_SCHEME}://other/${encodeURIComponent(loopback)}`))
  assert.equal(response.status, 404)
})

test('a CORS preflight is answered without touching the upstream', async () => {
  const before = reached
  const response = await handleRemoteRequest(
    new Request(remoteStreamUrl(loopback), { method: 'OPTIONS' })
  )
  assert.equal(response.status, 204)
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.equal(response.headers.get('accept-ranges'), 'bytes')
  // Range is what makes seeking work, and a preflighted Range request is
  // refused by the browser unless these two headers are present.
  assert.match(response.headers.get('access-control-allow-headers') ?? '', /range/i)
  assert.match(response.headers.get('access-control-expose-headers') ?? '', /content-range/i)
  assert.equal(reached, before)
})

test('a method other than GET/HEAD/OPTIONS is refused', async () => {
  const response = await handleRemoteRequest(new Request(remoteStreamUrl(loopback), { method: 'DELETE' }))
  assert.equal(response.status, 405)
})

test('the image route is refused for a private address too - it is not a separate bypass', async () => {
  const response = await handleRemoteRequest(new Request(remoteImageUrl(loopback)))
  assert.equal(response.status, 403)
})

test('address classification is total: anything that is not a public IP is private', () => {
  // Direct coverage of the classifier, so a range that stops being checked
  // fails here with the address named rather than as a 403 that could have come
  // from the DNS path.
  for (const address of [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '100.127.255.255',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.0.1',
    '192.168.0.1',
    '224.0.0.1',
    '::',
    '::1',
    'fe80::1',
    'fc00::1',
    'fd12::1',
    '::ffff:10.0.0.1',
    'not-an-ip'
  ]) {
    assert.equal(isPrivateAddress(address), true, `${address} should be refused`)
  }
})

test('public addresses are not swept up by the private ranges', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '101.0.0.1', '172.15.0.1', '172.32.0.1', '2001:4860:4860::8888']) {
    assert.equal(isPrivateAddress(address), false, `${address} should be allowed`)
  }
})
