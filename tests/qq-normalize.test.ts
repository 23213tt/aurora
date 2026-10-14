import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  albumCoverUrl,
  findMembershipFlag,
  mergeTranslation,
  normalizeLyrics,
  normalizeQr,
  normalizeSearch,
  normalizeSong,
  readAccountProbe,
  readQrCheck,
  readVipProbe,
  singerAvatarUrl,
  UNAUTHENTICATED_CODE
} from '../electron/qq/normalize.ts'
import { isQqQuality } from '../electron/qq/types.ts'

/*
 * The upstream -> Aurora mapping, pinned against the payloads the live service
 * actually returns.
 *
 * Every fixture below is a trimmed copy of a real response (see
 * `docs/qq-smoke.md`), not an invented one: the field names are the point of
 * this module, so a fixture that guesses them would test nothing.
 */

const SEARCH_RESPONSE = {
  status: 200,
  body: {
    response: {
      code: 0,
      data: {
        song: {
          curnum: 2,
          totalnum: 600,
          list: [
            {
              songmid: '0037GMG74LpROP',
              songid: 107785182,
              songname: '告白气球',
              interval: 223,
              albummid: '004AD9WG2KSvC0',
              albumname: '告白气球',
              media_mid: '004AD9WG2KSvC0',
              pay: { payplay: 0, paydownload: 1 },
              singer: [{ id: 4558, mid: '0025NhlN2yWrP4', name: '周杰伦' }]
            },
            {
              songmid: '003aAYrm3GE0Ac',
              songid: 449205,
              songname: '稻香',
              interval: 223,
              albummid: '002Neh8l0uciQZ',
              albumname: '魔杰座',
              media_mid: '0020wJDo3cx0j3',
              pay: { payplay: 1 },
              singer: [{ id: 4558, mid: '0025NhlN2yWrP4', name: '周杰伦' }]
            }
          ]
        },
        zhida: {
          type: 2,
          zhida_album: {
            albumID: 8220,
            albumMID: '000MkMni19ClKG',
            albumName: '叶惠美',
            albumPic: 'http://y.gtimg.cn/music/photo_new/T002R180x180M000000MkMni19ClKG.jpg',
            publicTime: '2003-07-31',
            singerName: '周杰伦',
            songNum: 11
          }
        }
      }
    }
  }
}

const SEARCH_WITH_SINGER = {
  status: 200,
  body: {
    response: {
      code: 0,
      data: {
        song: { list: [] },
        zhida: {
          type: 1,
          zhida_singer: {
            singerID: 4558,
            singerMID: '0025NhlN2yWrP4',
            singerName: '周杰伦',
            singerPic: 'http://y.gtimg.cn/music/photo_new/T001R300x300M0000025NhlN2yWrP4.jpg',
            albumNum: 43,
            hotalbum: [
              { albumID: 1458791, albumMID: '003RMaRI1iFoYd', albumName: '周杰伦的床边故事' },
              { albumID: 33021, albumMID: '002eFUFm2XYZ7z', albumName: '我很忙' }
            ]
          }
        }
      }
    }
  }
}

// --- cover art -------------------------------------------------------------

test('album and singer artwork is built from the mid, the way upstream serves it', () => {
  assert.equal(
    albumCoverUrl('004AD9WG2KSvC0'),
    'https://y.gtimg.cn/music/photo_new/T002R300x300M000004AD9WG2KSvC0.jpg'
  )
  assert.equal(
    singerAvatarUrl('0025NhlN2yWrP4'),
    'https://y.gtimg.cn/music/photo_new/T001R300x300M0000025NhlN2yWrP4.jpg'
  )
  assert.equal(albumCoverUrl(''), null)
  assert.equal(albumCoverUrl(undefined), null)
})

// --- songs -----------------------------------------------------------------

test('a song keeps both identities: numeric id for the shared shape, songmid to play', () => {
  const song = normalizeSong(SEARCH_RESPONSE.body.response.data.song.list[0])
  assert.ok(song)
  assert.equal(song.id, 107785182)
  assert.equal(song.songId, 107785182)
  // The playback identity, and its alias for the renderer's shared shape.
  assert.equal(song.songmid, '0037GMG74LpROP')
  assert.equal(song.mid, '0037GMG74LpROP')
  assert.equal(song.mediaMid, '004AD9WG2KSvC0')
})

test('song fields map: seconds stay seconds, artists and album come through', () => {
  const song = normalizeSong(SEARCH_RESPONSE.body.response.data.song.list[0])
  assert.ok(song)
  assert.equal(song.name, '告白气球')
  assert.equal(song.duration, 223)
  assert.deepEqual(song.artists, [{ id: 4558, mid: '0025NhlN2yWrP4', name: '周杰伦' }])
  assert.equal(song.album.id, 0)
  assert.equal(song.album.mid, '004AD9WG2KSvC0')
  assert.equal(song.album.name, '告白气球')
  assert.equal(
    song.album.picUrl,
    'https://y.gtimg.cn/music/photo_new/T002R300x300M000004AD9WG2KSvC0.jpg'
  )
})

test('the pay flag becomes the shared fee hint, in both spellings', () => {
  const free = normalizeSong(SEARCH_RESPONSE.body.response.data.song.list[0])
  const paid = normalizeSong(SEARCH_RESPONSE.body.response.data.song.list[1])
  assert.ok(free && paid)
  assert.equal(free.paid, false)
  assert.equal(free.fee, 0)
  assert.equal(paid.paid, true)
  // The shared shape compares fee against 0 for its availability hint.
  assert.equal(paid.fee, 1)
})

test('the older pay_play spelling is read too, because both are in the wild', () => {
  const song = normalizeSong({ songmid: 'x', pay_play: 1, songname: 'y' })
  assert.ok(song)
  assert.equal(song.paid, true)
  assert.equal(normalizeSong({ songmid: 'x', payplay: 1 })?.paid, true)
})

test('a song without a songmid is dropped, not rendered as an unplayable row', () => {
  assert.equal(normalizeSong({ songid: 1, songname: 'no mid' }), null)
  assert.equal(normalizeSong(null), null)
})

test('songname/name/title are all accepted, and a nameless song still gets a row', () => {
  assert.equal(normalizeSong({ songmid: 'a', name: 'n1' })?.name, 'n1')
  assert.equal(normalizeSong({ songmid: 'a', title: 'n2' })?.name, 'n2')
  assert.equal(normalizeSong({ songmid: 'a' })?.name, '未知歌曲')
})

// --- search ----------------------------------------------------------------

test('search maps the song list and honours the limit', () => {
  const result = normalizeSearch(SEARCH_RESPONSE, 1)
  assert.equal(result.songs.length, 1)
  assert.equal(result.songs[0].songmid, '0037GMG74LpROP')
  assert.equal(normalizeSearch(SEARCH_RESPONSE, 50).songs.length, 2)
})

test('search reads the "did you mean" album, with its year', () => {
  const result = normalizeSearch(SEARCH_RESPONSE)
  assert.equal(result.albums.length, 1)
  assert.deepEqual(result.albums[0], {
    id: 8220,
    name: '叶惠美',
    artist: '周杰伦',
    picUrl: 'http://y.gtimg.cn/music/photo_new/T002R180x180M000000MkMni19ClKG.jpg',
    year: 2003,
    songCount: 11
  })
})

test('search reads the matched artist and their hot albums', () => {
  const result = normalizeSearch(SEARCH_WITH_SINGER)
  assert.deepEqual(result.artists, [
    {
      id: 4558,
      name: '周杰伦',
      picUrl: 'http://y.gtimg.cn/music/photo_new/T001R300x300M0000025NhlN2yWrP4.jpg',
      albumCount: 43
    }
  ])
  assert.equal(result.albums.length, 2)
  assert.equal(result.albums[0].name, '周杰伦的床边故事')
  assert.equal(result.albums[0].artist, '周杰伦')
  // Upstream sends no date or track count for these, so they stay unknown
  // rather than being filled with a plausible-looking number.
  assert.equal(result.albums[0].year, null)
  assert.equal(result.albums[0].songCount, 0)
})

test('search never invents a section: an unknown shape yields three empty lists', () => {
  assert.deepEqual(normalizeSearch(null), { songs: [], albums: [], artists: [] })
  assert.deepEqual(normalizeSearch({ body: { response: { data: {} } } }), {
    songs: [],
    albums: [],
    artists: []
  })
  /*
   * The input is the upstream envelope, not a result that has already been
   * normalised: unlike the song mapper (which upstream feeds back through other
   * endpoints), nothing here is ever handed its own output, so an already-flat
   * `{songs}` object is an unknown shape and yields nothing rather than being
   * silently treated as upstream data.
   */
  assert.deepEqual(normalizeSearch({ songs: [{ songmid: 'm', songname: 'n' }] }), {
    songs: [],
    albums: [],
    artists: []
  })
})

// --- lyrics ----------------------------------------------------------------

test('lyrics come back as plain LRC, and only for a successful code', () => {
  const payload = normalizeLyrics({
    body: { response: { retcode: 0, code: 0, lyric: '[00:01.00]a\n', trans: '' } }
  })
  // Surrounding whitespace is trimmed; a lyric is a document, and a trailing
  // newline is not part of it.
  assert.deepEqual(payload, { lrc: '[00:01.00]a', translation: null })
})

test('a failed lyric lookup is null, not an empty string', () => {
  // 1101 is "no such song", verified live against a bogus mid.
  assert.equal(normalizeLyrics({ body: { response: { code: 1101, lyric: '' } } }), null)
  assert.equal(normalizeLyrics({ body: { response: { retcode: 0, code: 0 } } }), null)
  assert.equal(normalizeLyrics(null), null)
})

test('mergeTranslation pairs lines by timestamp and keeps tags', () => {
  const merged = mergeTranslation('[ti:x]\n[00:01.00]hello\n[00:02.00]bye', '[00:01.00]你好\n[00:03.00]extra')
  assert.ok(merged)
  const lines = merged.split('\n')
  assert.equal(lines[0], '[ti:x]')
  assert.equal(lines[1], '[00:01.00]hello / 你好')
  assert.equal(lines[2], '[00:02.00]bye')
  // A translated line with no original is appended rather than dropped.
  assert.equal(lines[3], '[00:03.00]extra')
})

test('mergeTranslation returns the original untouched when there is nothing to merge', () => {
  assert.equal(mergeTranslation('[00:01.00]a', null), '[00:01.00]a')
  assert.equal(mergeTranslation(null, '[00:01.00]a'), '[00:01.00]a')
  assert.equal(mergeTranslation(null, null), null)
  // An identical translation is not duplicated.
  assert.equal(mergeTranslation('[00:01.00]a', '[00:01.00]a'), '[00:01.00]a')
})

// --- login -----------------------------------------------------------------

test('the QR payload carries a usable PNG data URL', () => {
  const qr = normalizeQr({ body: { img: 'data:image/png;base64,iVBORw0KGgo', ptqrtoken: '123', qrsig: 'abc' } })
  assert.deepEqual(qr, { ptqrtoken: '123', qrsig: 'abc', imageDataUrl: 'data:image/png;base64,iVBORw0KGgo' })
  assert.equal(normalizeQr({ body: { img: 'x' } }), null)
})

test('a confirmed QR scan yields the session, and the other states do not', () => {
  const confirmed = readQrCheck({
    body: { isOk: true, message: '登录成功', session: { cookie: 'uin=o1; qqmusic_key=k', uin: 'o1', euin: 'e' } }
  })
  assert.equal(confirmed.confirmed, true)
  assert.equal(confirmed.session?.cookie, 'uin=o1; qqmusic_key=k')
  assert.equal(confirmed.session?.uin, 'o1')

  const waiting = readQrCheck({ body: { isOk: false, refresh: false, message: '未扫描二维码' } })
  assert.equal(waiting.confirmed, false)
  assert.equal(waiting.expired, false)

  const expired = readQrCheck({ body: { isOk: false, refresh: true, message: '二维码已失效' } })
  assert.equal(expired.expired, true)
  // Upstream has no "scanned, waiting for confirmation" state at all.
  assert.equal('scanned' in waiting, false)
})

test('the account probe treats code 1000 as signed out and never as an account', () => {
  // Verified live: a bogus cookie, a cookie with no key, and no cookie at all
  // all answer this way.
  const probe = readAccountProbe({ body: { response: { code: UNAUTHENTICATED_CODE, subcode: 1000 } } })
  assert.equal(probe.authenticated, false)
  assert.equal(probe.nickname, '')
  assert.equal(probe.avatarUrl, null)
})

test('an authenticated account probe reads the profile wherever it is nested', () => {
  const nested = readAccountProbe({
    body: { response: { code: 0, data: { profile: { nickname: 'nick', avatarUrl: 'https://a', level: 9 } } } }
  })
  assert.deepEqual(nested, { authenticated: true, nickname: 'nick', avatarUrl: 'https://a', level: 9 })

  const flat = readAccountProbe({
    body: { response: { code: 0, data: { name: 'n2', logo: 'https://b' } } }
  })
  assert.equal(flat.authenticated, true)
  assert.equal(flat.nickname, 'n2')
  assert.equal(flat.avatarUrl, 'https://b')
})

// --- membership ------------------------------------------------------------

test('membership is read from the known key names first', () => {
  assert.equal(findMembershipFlag({ identity: { vip: 1 } }), true)
  assert.equal(findMembershipFlag({ identity: { vip: 0 } }), false)
  assert.equal(findMembershipFlag({ data: { identity: { vipType: 1 } } }), true)
  assert.equal(findMembershipFlag({ vip: true }), true)
  assert.equal(findMembershipFlag({ isVip: '1' }), true)
  assert.equal(findMembershipFlag({ svip: 0 }), false)
})

test('a renamed membership key is still found, which is the whole point', () => {
  // Mineradio's lesson: upstream renames these fields, and a single-key check
  // fails silently - the account simply stops looking like a member.
  assert.equal(findMembershipFlag({ entitlements: { greenVipFlag: 1 } }), true)
  assert.equal(findMembershipFlag({ a: { b: { c: { luxuryMember: 'true' } } } }), true)
  assert.equal(findMembershipFlag({ a: { b: { c: { d: { membershipType: 2 } } } } }), true)
})

test('membership that was not reported is null, never false', () => {
  // The value the caller must not cache as "not a member".
  assert.equal(findMembershipFlag({}), null)
  assert.equal(findMembershipFlag({ hello: 'world' }), null)
  assert.equal(findMembershipFlag(null), null)
  // Depth is bounded, so a deep flag is genuinely "not found" rather than a
  // hang on a cyclic-looking payload.
  assert.equal(findMembershipFlag({ a: { b: { c: { d: { e: { f: { g: { vip: 1 } } } } } } } }, 3), null)
})

test('the membership endpoint only counts as answered when its own request code said so', () => {
  // Verified live: this endpoint answers `code: 0` even to a bogus cookie, so a
  // successful response on its own is not evidence of anything.
  const answered = readVipProbe({
    body: { response: { code: 0, req_1: { code: 0, data: { identity: { vip: 1, level: 7 } } } } }
  })
  assert.equal(answered.answered, true)
  assert.equal(answered.vip, true)
  assert.equal(answered.level, 7)

  const refused = readVipProbe({ body: { response: { code: 0, req_1: { code: 1000 } } } })
  assert.equal(refused.answered, false)
  assert.equal(refused.vip, null)

  // An answered request that carries no membership field is "unknown", not
  // "not a member".
  const silent = readVipProbe({ body: { response: { req_1: { code: 0, data: {} } } } })
  assert.equal(silent.answered, true)
  assert.equal(silent.vip, null)
})

// --- the quality vocabulary ------------------------------------------------

test('QQ accepts exactly the four shared tiers and nothing else', () => {
  for (const tier of ['standard', 'higher', 'exhigh', 'lossless']) {
    assert.equal(isQqQuality(tier), true, tier)
  }
  for (const bad of ['128', '320', 'm4a', 'flac', 'ape', 'hires', '', null, 128, undefined]) {
    assert.equal(isQqQuality(bad), false, String(bad))
  }
})
