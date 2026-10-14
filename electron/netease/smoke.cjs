/**
 * Netease smoke probe - the end-to-end evidence for the main-process side.
 *
 * Run it after a build so it exercises the real, typechecked code rather than a
 * copy of it:
 *
 *   npm run build:electron
 *   node electron/netease/smoke.cjs
 *
 * It does two things in one process, in this order and for a reason:
 *
 *  1. Bootstraps the upstream package the way `scripts/probe-netease5.cjs`
 *     established: an empty `%TEMP%\anonymous_token` must exist *before* the
 *     first `require`, because the package reads it while its modules load; the
 *     deviceId has to be minted by us and passed to `getXeapiPublicKey`, because
 *     the package's own bootstrap asks for the key before it has an id; and only
 *     then can `register_anonimous` succeed.
 *  2. Loads `dist-electron/netease/client.js` and drives the real API through
 *     search -> playable URL -> a ranged 4KB read -> lyrics, plus the
 *     `aurora-remote:` proxy and its refusals.
 *
 * The JSON report is printed between markers and written to
 * `docs/netease-smoke.md`. Signed stream URLs are masked: they are short-lived
 * but they are still a bearer token for the file, and the evidence lives in the
 * status line and headers, not in the query string.
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..', '..')
const DIST = path.join(REPO, 'dist-electron')
const TMP = os.tmpdir()
const TOKEN_PATH = path.join(TMP, 'anonymous_token')
const DEVICE_PATH = path.join(TMP, 'aurora_device_id')
const KEY_PATH = path.join(TMP, 'xeapi_public_key')
const DOC_PATH = path.join(REPO, 'docs', 'netease-smoke.md')

const KEYWORDS = process.env.SMOKE_KEYWORDS || '周杰伦 晴天'
const CLIP_BYTES = 4096

/**
 * With `--client-only` the probe does not bootstrap at all, so the client has
 * to do the entire sequence itself from a cold `%TEMP%`. That is the path the
 * shipped app takes, and it is the one worth running after deleting the three
 * temp files.
 */
const CLIENT_ONLY = process.argv.includes('--client-only')

const report = { when: new Date().toISOString(), repo: REPO, mode: CLIENT_ONLY ? 'client-only' : 'probe-bootstrap' }
const failures = []

/**
 * Progress goes to stderr as it happens, because the report itself is printed
 * at the end: without these a crash in step 7 would only say "it crashed".
 */
const note = (message) => process.stderr.write(`[smoke] ${message}\n`)

function check(condition, label) {
  if (!condition) failures.push(label)
  return Boolean(condition)
}

/** Keep the host, drop the signed part of the path and query. */
function maskUrl(value) {
  try {
    const url = new URL(value)
    const head = url.pathname.slice(0, 12)
    return `${url.protocol}//${url.host}${head}...(${url.pathname.length + url.search.length} chars masked)`
  } catch {
    return '(unparsable)'
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf-8')
  } catch {
    return ''
  }
}

// --- 1. bootstrap the upstream package -----------------------------------

async function bootstrap() {
  const step = {}

  // The file the package readFileSync's at import time. It must exist first.
  if (!fs.existsSync(TOKEN_PATH)) fs.writeFileSync(TOKEN_PATH, '', 'utf-8')
  step.tokenFilePresent = fs.existsSync(TOKEN_PATH)

  const apiEntry = require.resolve('@neteasecloudmusicapienhanced/api')
  const apiRoot = path.dirname(apiEntry)

  let deviceId = readText(DEVICE_PATH).trim()
  if (!/^[0-9a-fA-F]{52}$/.test(deviceId)) {
    deviceId = crypto.randomBytes(26).toString('hex')
    fs.writeFileSync(DEVICE_PATH, deviceId, 'utf-8')
  }
  global.deviceId = deviceId
  step.deviceIdLength = deviceId.length

  const { getXeapiPublicKey } = require(path.join(apiRoot, 'util', 'xeapiKey.js'))
  const current = (() => {
    try {
      return JSON.parse(readText(KEY_PATH))
    } catch {
      return {}
    }
  })()
  const key = await getXeapiPublicKey(current, deviceId)
  fs.writeFileSync(KEY_PATH, JSON.stringify(key), 'utf-8')
  step.xeapi = { version: key.version, skLength: key.sk ? key.sk.length : 0 }

  const api = require(path.join(apiRoot, 'main.js'))
  const tokenBefore = readText(TOKEN_PATH)
  if (tokenBefore) {
    step.anonymous = { reused: true, tokenBytes: tokenBefore.length }
  } else {
    const anon = await api.register_anonimous({ deviceId })
    const cookie = (anon && anon.body && anon.body.cookie) || ''
    const token = /MUSIC_A=([^;]+)/.exec(cookie)
    if (token) fs.writeFileSync(TOKEN_PATH, token[1], 'utf-8')
    step.anonymous = { reused: false, code: anon && anon.body && anon.body.code, gotToken: Boolean(token) }
  }

  report.bootstrap = step
}

// --- 2. the real client --------------------------------------------------

/** The proxy takes a Request; a plain object carrying its three fields is enough. */
function stubRequest(url, range) {
  const headers = new Headers()
  if (range) headers.set('range', range)
  return { url, method: 'GET', headers }
}

async function readRange(url, range) {
  const response = await fetch(url, { headers: { range } })
  const buffer = Buffer.from(await response.arrayBuffer())
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    contentRange: response.headers.get('content-range'),
    acceptRanges: response.headers.get('accept-ranges'),
    cors: response.headers.get('access-control-allow-origin'),
    bytes: buffer.byteLength
  }
}

async function run() {
  if (CLIENT_ONLY) {
    report.bootstrap = { skipped: true, note: 'client.js performed the whole sequence itself' }
  } else {
    await bootstrap()
  }

  const client = require(path.join(DIST, 'netease', 'client.js'))
  const { handleRemoteRequest } = require(path.join(DIST, 'remote-protocol.js'))

  note('diagnostics')
  report.diagnostics = await client.upstreamDiagnostics()

  note('status')
  const status = await client.neteaseStatus()
  report.status = status

  note(`search "${KEYWORDS}"`)
  const search = await client.neteaseSearch(KEYWORDS, 'song', 5)
  report.search = {
    keywords: KEYWORDS,
    count: search.songs.length,
    songs: search.songs.map((song) => ({
      id: song.id,
      name: song.name,
      artists: song.artists.map((artist) => artist.name),
      album: song.album.name,
      hasCover: Boolean(song.album.picUrl),
      duration: song.duration,
      fee: song.fee
    }))
  }
  if (!check(search.songs.length > 0, 'search returned no songs')) return

  const song = search.songs[0]
  note(`stream url for ${song.id}`)
  const result = await client.neteaseStreamUrl(song.id, 'exhigh')
  report.stream = result.ok
    ? {
        ok: true,
        url: maskUrl(result.stream.url),
        br: result.stream.br,
        level: result.stream.level,
        duration: result.stream.duration,
        trial: result.stream.trial,
        trialFrom: result.stream.trialFrom,
        trialTo: result.stream.trialTo
      }
    : { ok: false, reason: result.reason, message: result.message }
  if (!check(result.ok, `stream unresolved: ${result.reason}`)) return

  // The upstream address itself: this is what proves the URL is a real direct
  // link and that a ranged read works against it.
  note('upstream ranged read')
  report.upstreamRange = await readRange(result.stream.url, `bytes=0-${CLIP_BYTES - 1}`)
  check(report.upstreamRange.status === 206, 'upstream range did not answer 206')
  check(
    String(report.upstreamRange.contentType || '').startsWith('audio/'),
    'upstream range is not audio'
  )
  check(report.upstreamRange.bytes === CLIP_BYTES, `upstream returned ${report.upstreamRange.bytes} bytes`)

  // The same read through our own proxy: this is the path the renderer uses,
  // and it is where the CORS and accept-ranges headers are added.
  note('proxy ranged read')
  const proxiedUrl = `aurora-remote://stream/${encodeURIComponent(result.stream.url)}`
  const proxied = await handleRemoteRequest(stubRequest(proxiedUrl, `bytes=0-${CLIP_BYTES - 1}`))
  const proxiedBody = Buffer.from(await proxied.arrayBuffer())
  report.proxyRange = {
    status: proxied.status,
    contentType: proxied.headers.get('content-type'),
    contentRange: proxied.headers.get('content-range'),
    acceptRanges: proxied.headers.get('accept-ranges'),
    cors: proxied.headers.get('access-control-allow-origin'),
    exposeHeaders: proxied.headers.get('access-control-expose-headers'),
    bytes: proxiedBody.byteLength
  }
  check(report.proxyRange.status === 206, 'proxy range did not answer 206')
  check(report.proxyRange.acceptRanges === 'bytes', 'proxy did not advertise accept-ranges')
  check(report.proxyRange.cors === '*', 'proxy did not send access-control-allow-origin')
  check(report.proxyRange.contentRange !== null, 'proxy did not pass content-range through')
  check(report.proxyRange.bytes === CLIP_BYTES, `proxy returned ${report.proxyRange.bytes} bytes`)

  // The refusals: the proxy is a request forwarder inside the user's network
  // unless it says no to these.
  const blocked = [
    'http://127.0.0.1:1/audio.mp3',
    'http://10.0.0.1/audio.mp3',
    'http://172.16.5.4/audio.mp3',
    'http://192.168.1.1/audio.mp3',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/audio.mp3',
    'http://[fe80::1]/audio.mp3',
    'file:///C:/Windows/win.ini',
    'ftp://example.com/audio.mp3'
  ]
  report.refusals = []
  note('refusals')
  for (const target of blocked) {
    const response = await handleRemoteRequest(
      stubRequest(`aurora-remote://stream/${encodeURIComponent(target)}`)
    )
    report.refusals.push({ target, status: response.status })
    check(response.status === 403 || response.status === 400, `proxy did not refuse ${target}`)
  }

  note('lyrics')
  const lyrics = await client.neteaseLyrics(song.id)
  report.lyrics = lyrics
    ? {
        hasLrc: Boolean(lyrics.lrc),
        lrcChars: (lyrics.lrc || '').length,
        hasTranslation: Boolean(lyrics.translation),
        translationChars: (lyrics.translation || '').length,
        head: (lyrics.lrc || '').split('\n').slice(0, 4).join('\n')
      }
    : null
  check(Boolean(lyrics && lyrics.lrc), 'no lyrics returned')

  const albumSearch = await client.neteaseSearch(KEYWORDS, 'album', 1)
  report.albumSearch = albumSearch.albums[0] || null

  note('metadata and signed-out lists')
  const detail = await client.neteaseSongDetail([song.id])
  report.songDetail = detail[0] || null

  const album = await client.neteaseAlbum(song.album.id)
  report.album = album ? { id: album.id, name: album.name, artist: album.artist, songs: album.songs.length, year: album.year } : null

  // Search results for cover uploads list an artist with no id (0), and
  // upstream answers artist 0 with a 404 envelope, so the artist page needs an
  // id from an artist search instead.
  const artistSearch = await client.neteaseSearch('周杰伦', 'artist', 1)
  const found = artistSearch.artists[0]
  const top = await client.neteaseArtistTopSongs(found ? found.id : 0, 3)
  report.artistTopSongs = {
    artistId: found ? found.id : 0,
    artistName: found ? found.name : null,
    count: top.length,
    names: top.map((entry) => entry.name)
  }
  check(top.length > 0, 'artist top songs came back empty for a real artist id')

  // A nonsense id must come back empty rather than throwing the upstream's
  // 404 envelope into an unhandled rejection.
  const invalidStream = await client.neteaseStreamUrl(0)
  report.invalidIds = {
    artistTopSongs: (await client.neteaseArtistTopSongs(0)).length,
    album: await client.neteaseAlbum(0),
    lyrics: await client.neteaseLyrics(0),
    playlistTracks: (await client.neteasePlaylistTracks(0)).length,
    streamReason: invalidStream.ok ? 'ok' : invalidStream.reason
  }
  check(report.invalidIds.streamReason !== 'ok', 'a zero song id produced a stream')

  // Signed out: these must be empty lists, not errors.
  report.signedOutLists = {
    myPlaylists: (await client.neteaseMyPlaylists()).length,
    dailySongs: (await client.neteaseDailySongs()).length,
    cloudSongs: (await client.neteaseCloudSongs()).length,
    likeList: (await client.neteaseLikeList()).length
  }
}

// --- report --------------------------------------------------------------

function renderMarkdown() {
  const passed = failures.length === 0
  const lines = [
    '# 网易云主进程探针（netease-smoke）',
    '',
    `> 由 \`electron/netease/smoke.cjs\` 生成，运行于 ${report.when}。`,
    `> 模式：\`${report.mode}\`。`,
    '> 复现：`npm run build:electron && node electron/netease/smoke.cjs`；',
    '> 冷启动（把 %TEMP% 里的 anonymous_token / xeapi_public_key / aurora_device_id',
    '> 三个文件一起删掉，再让客户端自己从零引导）：`node electron/netease/smoke.cjs --client-only`。',
    '>',
    '> 默认模式下探针先按 `scripts/probe-netease5.cjs` 的顺序在本进程里引导一遍；',
    '> `--client-only` 模式下探针完全不碰引导，`%TEMP%` 里的空 token 文件、deviceId、',
    '> xeapi key 与匿名 MUSIC_A 全部由 `dist-electron/netease/client.js` 自己建立。',
    '> 两种模式驱动的都是**编译产物**（`client.js` 与 `remote-protocol.js`），',
    '> 所以下面的数字来自真正参与构建的主进程代码，而不是另抄的一份逻辑。',
    '',
    passed ? '**结果：全部通过。**' : `**结果：${failures.length} 项失败。**`,
    ''
  ]
  if (!passed) lines.push(...failures.map((item) => `- 失败：${item}`), '')
  lines.push('```json', JSON.stringify(report, null, 2), '```', '')
  return lines.join('\n')
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
