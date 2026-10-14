/**
 * QQ Music smoke probe - the end-to-end evidence for the main-process side.
 *
 * Run it after a build so it drives the real, typechecked code:
 *
 *   npm run build:electron
 *   node electron/qq/smoke.cjs
 *
 * It answers one question: does the shipped client actually play a QQ track on
 * a machine with no account? So it goes through the client the app uses -
 * search, resolve a stream, then fetch it - and separately asks the upstream
 * package directly for the raw per-song codes, so the classification in
 * `reasons.ts` can be checked against the numbers it claims to be based on.
 *
 * The JSON report is printed between markers and written to
 * `docs/qq-smoke.md`. Signed stream URLs are masked: the `vkey` in them is a
 * short-lived bearer token for the file, and the evidence lives in the status
 * line and headers.
 */
const fs = require('node:fs')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'dist-electron')
const DOC_PATH = path.join(REPO, 'docs', 'qq-smoke.md')
const SDK_PATH = path.join(REPO, 'node_modules', '@sansenjian', 'qq-music-api', 'dist', 'sdk.cjs')

const KEYWORDS = process.env.SMOKE_KEYWORDS || '告白气球'
const CLIP_BYTES = 4096

const report = { when: new Date().toISOString(), repo: REPO }
const failures = []

const note = (message) => process.stderr.write(`[smoke] ${message}\n`)

function check(condition, label) {
  if (!condition) failures.push(label)
  return Boolean(condition)
}

/** Keep the host, drop the signed part. */
function maskUrl(value) {
  try {
    const url = new URL(value)
    const head = url.pathname.slice(0, 12)
    return `${url.protocol}//${url.host}${head}...(${url.pathname.length + url.search.length} chars masked)`
  } catch {
    return '(unparsable)'
  }
}

/** The proxy takes a Request; a plain object carrying its three fields is enough. */
function stubRequest(url, range) {
  const headers = new Headers()
  if (range) headers.set('range', range)
  return { url, method: 'GET', headers }
}

async function readRange(url, range) {
  const response = await fetch(url, { headers: range ? { range } : {} })
  const buffer = Buffer.from(await response.arrayBuffer())
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    contentRange: response.headers.get('content-range'),
    acceptRanges: response.headers.get('accept-ranges'),
    cors: response.headers.get('access-control-allow-origin'),
    bytes: buffer.byteLength,
    magic: buffer.subarray(0, 4).toString('hex')
  }
}

async function run() {
  const client = require(path.join(DIST, 'qq', 'client.js'))
  const { handleRemoteRequest } = require(path.join(DIST, 'remote-protocol.js'))
  const { albumCoverUrl } = require(path.join(DIST, 'qq', 'normalize.js'))

  note('status')
  report.status = await client.qqStatus()
  // No account on this machine is the interesting case, not a limitation.
  check(report.status.ready, 'the QQ client did not load')

  note(`search "${KEYWORDS}"`)
  const search = await client.qqSearch(KEYWORDS, 'song', 10)
  report.search = {
    keywords: KEYWORDS,
    songs: search.songs.length,
    albums: search.albums.length,
    artists: search.artists.length,
    first: search.songs.slice(0, 3).map((song) => ({
      id: song.id,
      songmid: song.songmid,
      mediaMid: song.mediaMid,
      name: song.name,
      artists: song.artists.map((artist) => artist.name),
      album: song.album.name,
      hasCover: Boolean(song.album.picUrl),
      duration: song.duration,
      fee: song.fee
    })),
    albumSample: search.albums[0] ?? null,
    artistSample: search.artists[0] ?? null
  }
  if (!check(search.songs.length > 0, 'search returned no songs')) return

  const free = search.songs.find((song) => song.fee === 0)
  const paid = search.songs.find((song) => song.fee === 1)
  report.picked = { free: free ? free.songmid : null, paid: paid ? paid.songmid : null }

  // --- the free track: resolve, then actually read it ---------------------

  if (free) {
    note(`stream url for ${free.songmid} (asked for exhigh)`)
    // The numeric id on purpose: that is what the renderer's shared shape
    // carries, and the client has to resolve it back to the songmid.
    const stream = await client.qqStreamUrl(free.id, 'exhigh')
    report.stream = stream.ok
      ? {
          ok: true,
          url: maskUrl(stream.url),
          quality: stream.quality,
          level: stream.level,
          br: stream.br,
          lossless: stream.lossless,
          trial: stream.trial
        }
      : { ok: false, reason: stream.reason, message: stream.message }
    check(stream.ok, `stream unresolved: ${stream.reason}`)

    if (stream.ok) {
      note('upstream ranged read')
      report.upstreamRange = await readRange(stream.url, `bytes=0-${CLIP_BYTES - 1}`)
      check(report.upstreamRange.status === 206, 'upstream range did not answer 206')
      check(
        String(report.upstreamRange.contentType || '').startsWith('audio/'),
        'upstream range is not audio'
      )
      check(report.upstreamRange.bytes === CLIP_BYTES, `upstream returned ${report.upstreamRange.bytes} bytes`)

      note('proxy ranged read')
      const proxied = await handleRemoteRequest(
        stubRequest(`aurora-remote://stream/${encodeURIComponent(stream.url)}`, `bytes=0-${CLIP_BYTES - 1}`)
      )
      const body = Buffer.from(await proxied.arrayBuffer())
      report.proxyRange = {
        status: proxied.status,
        contentType: proxied.headers.get('content-type'),
        contentRange: proxied.headers.get('content-range'),
        acceptRanges: proxied.headers.get('accept-ranges'),
        cors: proxied.headers.get('access-control-allow-origin'),
        bytes: body.byteLength
      }
      check(report.proxyRange.status === 206, 'the proxy did not answer 206')
      // `y.gtimg.cn` sends no CORS header and the CDN sends no `accept-ranges`,
      // so both have to come from the proxy for the page to accept the stream.
      check(report.proxyRange.cors === '*', 'the proxy did not send access-control-allow-origin')
      check(report.proxyRange.acceptRanges === 'bytes', 'the proxy did not advertise accept-ranges')
    }

    note(`lyrics for ${free.songmid}`)
    const lyrics = await client.qqLyrics(free.id)
    report.lyrics = lyrics
      ? { chars: lyrics.length, head: lyrics.split('\n').slice(0, 4).join('\n') }
      : null
    check(Boolean(lyrics), 'no lyrics returned')
  } else {
    note('no free track in this search; the stream section is skipped')
  }

  // --- cover art ----------------------------------------------------------
  //
  // `y.gtimg.cn` sends no CORS header at all, so artwork can only be shown
  // through the proxy - which makes this worth proving rather than assuming.
  // The track that happened to be free often has no album mid (uploads and
  // covers do not), so the cover is taken from whichever result has one.
  const withCover = search.songs.find((song) => song.album.mid)
  note('cover art through the proxy')
  report.cover = withCover ? { songmid: withCover.songmid, url: albumCoverUrl(withCover.album.mid) } : null
  if (report.cover?.url) {
    const proxiedCover = await handleRemoteRequest(
      stubRequest(`aurora-remote://image/${encodeURIComponent(report.cover.url)}`)
    )
    const coverBody = Buffer.from(await proxiedCover.arrayBuffer())
    report.cover.proxy = {
      status: proxiedCover.status,
      contentType: proxiedCover.headers.get('content-type'),
      cors: proxiedCover.headers.get('access-control-allow-origin'),
      bytes: coverBody.byteLength
    }
    check(report.cover.proxy.status === 200, 'the cover did not come back')
    check(
      String(report.cover.proxy.contentType || '').startsWith('image/'),
      'the cover is not an image'
    )
    check(report.cover.proxy.cors === '*', 'the cover proxy did not send a CORS header')
  } else {
    failures.push('no search result carried an album mid, so the cover path is unproven')
  }

  // --- the paid track: the refusal must be a reason, not an error ---------

  if (paid) {
    note(`stream url for the paywalled ${paid.songmid}`)
    const refused = await client.qqStreamUrl(paid.id, 'standard')
    report.refusal = refused.ok
      ? { ok: true, unexpected: 'a paywalled track resolved' }
      : { ok: false, reason: refused.reason, message: refused.message }
    if (refused.ok) {
      failures.push('a paywalled track produced a stream')
    } else {
      // The whole point of the vocabulary: a restriction must not be reported
      // as a delisting, and must not be an error.
      check(
        refused.reason === 'login-required' || refused.reason === 'vip-required',
        `a paywalled track was reported as ${refused.reason}`
      )
      check(Boolean(refused.message), 'a refusal came back with no wording')
    }
  }

  // --- the raw codes, straight from the package --------------------------

  note('raw upstream codes for the same tracks')
  const sdk = require(SDK_PATH)
  const raw = {}
  for (const song of [free, paid].filter(Boolean)) {
    for (const quality of ['128', '320', 'flac']) {
      const response = await sdk.getPlayUrl({
        songmid: song.songmid,
        quality,
        resType: 'raw',
        mediaId: song.mediaMid
      })
      const data = response.body?.data ?? {}
      const info = data.req_0?.data?.midurlinfo?.[0] ?? {}
      raw[`${song.songmid}/${quality}`] = {
        requestCode: data.req_0?.code ?? null,
        result: info.result ?? null,
        hasPurl: Boolean(info.purl),
        filename: info.filename ?? null
      }
    }
  }
  // And the code a numeric id earns when it is used as an identifier, which is
  // why `streamUrl` resolves ids through what this session has seen.
  const wrongId = await sdk.getPlayUrl({
    songmid: String(free.songid),
    quality: '128',
    resType: 'raw',
    mediaId: free.mediaMid
  })
  raw.numericIdAsSongmid = {
    result: wrongId.body?.data?.req_0?.data?.midurlinfo?.[0]?.result ?? null,
    hasPurl: Boolean(wrongId.body?.data?.req_0?.data?.midurlinfo?.[0]?.purl)
  }
  report.rawUpstream = raw
  check(raw.numericIdAsSongmid.hasPurl === false, 'a numeric id unexpectedly resolved')
}

function renderMarkdown() {
  const passed = failures.length === 0
  return [
    '# QQ 音乐主进程探针（qq-smoke）',
    '',
    `> 由 \`electron/qq/smoke.cjs\` 生成，运行于 ${report.when}。`,
    '> 复现：`npm run build:electron && node electron/qq/smoke.cjs`。',
    '> 探针驱动**编译产物** `dist-electron/qq/client.js` 与',
    '> `dist-electron/remote-protocol.js`，并另起一段直接问上游包要原始 `result` 码，',
    '> 所以下面的数字既来自真正参与构建的代码，也能与 `reasons.ts` 的判定对照。',
    '> 本机**没有 QQ 音乐账号**：所以 320k / FLAC 需要登录这一档无法在真机上验证，',
    '> 探针只记录实测到的部分。',
    '',
    passed ? '**结果：全部通过。**' : `**结果：${failures.length} 项失败。**`,
    '',
    ...(passed ? [] : failures.map((item) => `- 失败：${item}`)),
    ...(passed ? [] : ['']),
    '```json',
    JSON.stringify(report, null, 2),
    '```',
    ''
  ].join('\n')
}

run().then(
  () => {
    const json = JSON.stringify(report, null, 2)
    process.stdout.write(`\nSMOKE_JSON_BEGIN\n${json}\nSMOKE_JSON_END\n`)
    try {
      fs.mkdirSync(path.dirname(DOC_PATH), { recursive: true })
      fs.writeFileSync(DOC_PATH, renderMarkdown(), 'utf-8')
      process.stdout.write(`\nwrote ${DOC_PATH}\n`)
    } catch (error) {
      failures.push(`could not write ${DOC_PATH}: ${error.message}`)
    }
    process.stdout.write(failures.length === 0 ? '\nSMOKE_OK\n' : `\nSMOKE_FAILED\n${failures.join('\n')}\n`)
    process.exit(failures.length === 0 ? 0 : 1)
  },
  (error) => {
    console.error('SMOKE_CRASHED', error instanceof Error ? error.stack : error)
    process.exit(1)
  }
)
