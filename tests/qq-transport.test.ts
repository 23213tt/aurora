import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  QUALITY_FORMATS,
  TIER_FORMATS,
  buildPlayUrl,
  cookieValue,
  isSessionCookie,
  joinUrl,
  parseCookie,
  pickSipDomain,
  playInfoOf,
  qualityFilename,
  tierLadder,
  uinDigits
} from '../electron/qq/transport.ts'

/*
 * The wire layer: how a `sip` domain is chosen, how `purl` becomes an address,
 * how the per-song verdict is read, and how a session cookie is taken apart.
 *
 * These are the parts of QQ playback that are *ours* - the package does the
 * HTTP - so they are the parts that can silently go wrong. The fixtures are
 * trimmed live responses.
 */

const LIVE_SIP = ['http://aqqmusic.tc.qq.com/', 'http://sjy6.stream.qqmusic.qq.com/']

// --- domain choice and joining ---------------------------------------------

test('the stream host is chosen exactly as the package chooses it', () => {
  // `http://ws` hosts are streaming servers the package skips first, then https
  // is preferred, then whatever is left. Diverging here would send playback to
  // a host the verified path never used.
  assert.equal(pickSipDomain(LIVE_SIP), 'http://aqqmusic.tc.qq.com/')
  assert.equal(pickSipDomain(['http://ws.stream.qqmusic.qq.com/', 'https://a.cdn/']), 'https://a.cdn/')
  assert.equal(pickSipDomain(['http://ws.stream.qqmusic.qq.com/']), 'http://ws.stream.qqmusic.qq.com/')
  assert.equal(pickSipDomain([]), '')
  assert.equal(pickSipDomain('not-an-array'), '')
  assert.equal(pickSipDomain([null, '', 42]), '')
})

test('joining keeps exactly one slash', () => {
  assert.equal(joinUrl('http://a/', 'b.mp3'), 'http://a/b.mp3')
  assert.equal(joinUrl('http://a', 'b.mp3'), 'http://a/b.mp3')
  assert.equal(joinUrl('http://a/', '/b.mp3'), 'http://a/b.mp3')
  assert.equal(joinUrl('http://a', '/b.mp3'), 'http://a/b.mp3')
  assert.equal(joinUrl('', '/b.mp3'), '')
})

test('a playable address is the chosen host plus the purl', () => {
  const url = buildPlayUrl(LIVE_SIP, 'M500004AD9WG2KSvC0.mp3?guid=1&vkey=ABC')
  assert.equal(url, 'http://aqqmusic.tc.qq.com/M500004AD9WG2KSvC0.mp3?guid=1&vkey=ABC')
  // No purl means no address: upstream refused this tier.
  assert.equal(buildPlayUrl(LIVE_SIP, ''), '')
  assert.equal(buildPlayUrl([], 'x.mp3'), '')
})

// --- reading the play response ---------------------------------------------

test('the play response is read through to the per-song verdict', () => {
  const info = playInfoOf({
    status: 200,
    body: {
      data: {
        code: 0,
        req_0: {
          code: 0,
          data: {
            sip: LIVE_SIP,
            midurlinfo: [
              {
                songmid: '0037GMG74LpROP',
                filename: 'M5000037GMG74LpROP004AD9WG2KSvC0.mp3',
                purl: 'M500004AD9WG2KSvC0.mp3?vkey=ABC',
                result: 0
              }
            ]
          }
        }
      }
    }
  })
  assert.equal(info.envelopeCode, 0)
  assert.equal(info.requestCode, 0)
  assert.equal(info.result, 0)
  assert.equal(info.filename, 'M5000037GMG74LpROP004AD9WG2KSvC0.mp3')
  assert.equal(info.url, 'http://aqqmusic.tc.qq.com/M500004AD9WG2KSvC0.mp3?vkey=ABC')
})

test('a refused tier reads as no address plus the code that explains it', () => {
  const info = playInfoOf({
    status: 200,
    body: {
      data: {
        req_0: {
          code: 0,
          data: { sip: LIVE_SIP, midurlinfo: [{ songmid: 'x', purl: '', result: 104003 }] }
        }
      }
    }
  })
  assert.equal(info.url, '')
  assert.equal(info.purl, '')
  assert.equal(info.result, 104003)
})

test('the identity code for a numeric id is read, so it is never mistaken for a paywall', () => {
  // Verified live: this is the answer when a numeric `songid` is used where a
  // `songmid` belongs.
  const info = playInfoOf({
    body: {
      data: {
        req_0: { code: 0, data: { sip: LIVE_SIP, midurlinfo: [{ purl: '', result: 101404 }] } }
      }
    }
  })
  assert.equal(info.result, 101404)
  assert.equal(info.url, '')
})

test('an empty, malformed or unexpected response is not a crash', () => {
  for (const input of [null, undefined, {}, { body: {} }, { body: { data: { req_0: {} } } }, 'nope']) {
    const info = playInfoOf(input)
    assert.equal(info.url, '', JSON.stringify(input))
    assert.equal(info.purl, '')
    assert.equal(info.result, null)
  }
})

test('the envelope code is found whether it sits on data or on the body', () => {
  assert.equal(playInfoOf({ body: { data: { code: 502 } } }).envelopeCode, 502)
  assert.equal(playInfoOf({ body: { code: 1000 } }).envelopeCode, 1000)
})

// --- quality ---------------------------------------------------------------

test('the tier ladder walks down to the free tier and never past it', () => {
  // The default tier is `exhigh`, and a signed-out machine is refused 320k even
  // for a free track, so the ladder is what makes QQ playable at all.
  assert.deepEqual(tierLadder('lossless'), ['lossless', 'exhigh', 'standard'])
  assert.deepEqual(tierLadder('exhigh'), ['exhigh', 'standard'])
  assert.deepEqual(tierLadder('higher'), ['standard'])
  assert.deepEqual(tierLadder('standard'), ['standard'])
})

test('every tier maps to a format upstream serves, and the ladder is monotonic', () => {
  assert.equal(TIER_FORMATS.standard.format, '128')
  assert.equal(TIER_FORMATS.exhigh.format, '320')
  assert.equal(TIER_FORMATS.lossless.format, 'flac')
  // `higher` deliberately resolves to the same stream as `standard`: this
  // interface exposes no 192k tier, and answering it with m4a would be worse
  // than `standard`.
  assert.equal(TIER_FORMATS.higher.format, TIER_FORMATS.standard.format)
  assert.equal(TIER_FORMATS.lossless.lossless, true)
  assert.equal(TIER_FORMATS.exhigh.lossless, false)
})

test('the lossless bitrate uses the number the renderer already uses for it', () => {
  // `bitrateForLevel()` in `src/features/online/qq-provider.ts` answers 999 for
  // lossless, so reporting anything else would make the same stream show two
  // different bitrates depending on who filled the field.
  assert.equal(TIER_FORMATS.lossless.bitrate, 999)
  assert.equal(TIER_FORMATS.exhigh.bitrate, 320)
  assert.equal(TIER_FORMATS.standard.bitrate, 128)
})

test('the file name is what upstream expects, and falls back to the mid twice', () => {
  // Lives up to the live echo: `M500` + songmid + mediaMid + `.mp3`.
  assert.equal(
    qualityFilename('0037GMG74LpROP', '004AD9WG2KSvC0', '128'),
    'M5000037GMG74LpROP004AD9WG2KSvC0.mp3'
  )
  // Unknown mediaMid: upstream still resolves it, verified live.
  assert.equal(qualityFilename('0037GMG74LpROP', '', '128'), 'M5000037GMG74LpROP0037GMG74LpROP.mp3')
  assert.equal(qualityFilename('m', 'x', 'flac'), 'F000mx.flac')
  assert.equal(qualityFilename('m', 'x', 'ape'), 'A000mx.ape')
  assert.equal(qualityFilename('m', 'x', 'm4a'), 'C400mx.m4a')
  assert.equal(QUALITY_FORMATS.m4a.lossless, false)
})

// --- cookies ---------------------------------------------------------------

test('a cookie string becomes a jar, dropping nameless and valueless parts', () => {
  const jar = parseCookie('uin=o123; qqmusic_key=abc; ; nodots; empty=; =x')
  assert.deepEqual(jar, { uin: 'o123', qqmusic_key: 'abc' })
  assert.deepEqual(parseCookie(''), {})
  assert.deepEqual(parseCookie(null), {})
})

test('cookie lookups accept every name the session has been seen under', () => {
  assert.equal(cookieValue('uin=o1; qqmusic_key=k', 'qqmusic_key', 'qm_keyst'), 'k')
  assert.equal(cookieValue('uin=o1; qm_keyst=k2', 'qqmusic_key', 'qm_keyst'), 'k2')
  assert.equal(cookieValue('uin=o1', 'qqmusic_key'), '')
})

test('a session cookie is the one carrying a music key, not merely a uin', () => {
  assert.equal(isSessionCookie('uin=o1; qqmusic_key=k'), true)
  assert.equal(isSessionCookie('uin=o1; qm_keyst=k'), true)
  // A bare uin is what the anonymous search sets; it is not a session.
  assert.equal(isSessionCookie('uin=o1'), false)
  assert.equal(isSessionCookie(''), false)
})

test('the uin is reduced to digits, with or without the "o" prefix', () => {
  // Upstream writes `o1234567890` in cookies and `1234567890` in requests, and
  // `parseInt('o123…')` is NaN - which is exactly how an account lookup ends up
  // silently asking about uin 0.
  assert.equal(uinDigits('o1234567890'), '1234567890')
  assert.equal(uinDigits('1234567890'), '1234567890')
  assert.equal(uinDigits(1234567890), '1234567890')
  assert.equal(uinDigits('o'), '')
  assert.equal(uinDigits(''), '')
  assert.equal(uinDigits(null), '')
  assert.equal(uinDigits('o12'), '')
})
