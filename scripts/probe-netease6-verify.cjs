/**
 * Independent verification probe for the Netease integration (verify-eng).
 *
 * This is deliberately NOT a copy of the author's probe and it does not import a
 * single line of Aurora's own code. Its whole job is to answer one question that
 * unit tests and type checks cannot: does the upstream package, driven exactly
 * the way Aurora drives it, really return live data - or is everything the app
 * shows somehow coming from a mock?
 *
 * Evidence of that distinction:
 *   - the resolved stream URL must point at a real host, not localhost
 *   - a Range request must come back 206 with audio/* and a content-range
 *   - the first bytes must look like audio (ID3 frame or MPEG sync), which a
 *     hand-written fixture would almost certainly not bother to fake
 *   - a known VIP-only track must FAIL, so "it worked" cannot be explained by
 *     a stub that answers OK to everything
 *
 * Run: node scripts/probe-netease6-verify.cjs [keywords]
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const API_ROOT = path.resolve(__dirname, '..', 'node_modules', '@neteasecloudmusicapienhanced', 'api')

const tmp = os.tmpdir()
const keyPath = path.join(tmp, 'xeapi_public_key')
const tokenPath = path.join(tmp, 'anonymous_token')
const devicePath = path.join(tmp, 'aurora_device_id')

const out = { startedAt: new Date().toISOString(), apiRoot: API_ROOT }
const t0 = Date.now()

/** Does this buffer start like an audio file, or is it HTML/JSON/an error page? */
function sniffer(buf) {
  if (buf.length === 0) return 'empty'
  const ascii = buf.subarray(0, 4).toString('latin1')
  if (ascii.startsWith('ID3')) return 'mp3-with-id3'
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mpeg-sync'
  if (ascii.startsWith('fLaC')) return 'flac'
  if (ascii.startsWith('OggS')) return 'ogg'
  if (ascii.startsWith('RIFF')) return 'wav'
  if (ascii.trimStart().startsWith('<') || ascii.trimStart().startsWith('{')) return 'text-not-audio'
  return `unknown(${[...buf.subarray(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' ')})`
}

async function main() {
  const keywords = process.argv[2] || '周杰伦 晴天'

  // --- 1. bootstrap, in the order the contract requires -------------------
  if (!fs.existsSync(tokenPath)) fs.writeFileSync(tokenPath, '', 'utf-8')
  out.bootstrap = { tokenFileExistedBeforeRequire: true }

  const { generateDeviceId } = require(path.join(API_ROOT, 'util', 'index.js'))
  const { getXeapiPublicKey } = require(path.join(API_ROOT, 'util', 'xeapiKey.js'))
  const api = require(API_ROOT)

  let deviceId = ''
  try {
    deviceId = fs.readFileSync(devicePath, 'utf-8').trim()
  } catch {}
  const deviceWasStable = Boolean(deviceId)
  if (!deviceId) {
    deviceId = generateDeviceId()
    fs.writeFileSync(devicePath, deviceId, 'utf-8')
  }
  global.deviceId = deviceId
  out.bootstrap.deviceId = { length: deviceId.length, hex: /^[0-9a-f]{52}$/.test(deviceId), reused: deviceWasStable }

  let current = {}
  try {
    current = JSON.parse(fs.readFileSync(keyPath, 'utf-8'))
  } catch {}
  const key = await getXeapiPublicKey(current, deviceId)
  fs.writeFileSync(keyPath, JSON.stringify(key), 'utf-8')
  out.bootstrap.xeapiKey = { version: key.version, skLength: key.sk ? key.sk.length : 0, hasPublicKey: Boolean(key.publicKey) }

  try {
    const anon = await api.register_anonimous({ deviceId })
    const cookie = anon?.body?.cookie ?? ''
    const token = /MUSIC_A=([^;]+)/.exec(cookie)?.[1] ?? ''
    if (token) fs.writeFileSync(tokenPath, token, 'utf-8')
    out.bootstrap.anonymous = { code: anon?.body?.code, tokenLength: token.length }
  } catch (error) {
    out.bootstrap.anonymous = { error: String(error?.message).slice(0, 200) }
  }

  // --- 2. search: public, no account --------------------------------------
  const search = await api.cloudsearch({ keywords, type: 1, limit: 8 })
  const songs = search?.body?.result?.songs ?? []
  out.search = {
    keywords,
    bodyCode: search?.body?.code,
    count: songs.length,
    first: songs.slice(0, 5).map((s) => ({
      id: s.id,
      name: s.name,
      artists: (s.ar ?? []).map((a) => a.name),
      album: s.al?.name ?? null,
      fee: s.fee
    }))
  }
  if (!songs.length) throw new Error('search returned no songs - cannot verify anything downstream')

  // --- 3. stream URL + Range fetch, byte-sniffed --------------------------
  const pick = songs[0]
  const resolved = await api.song_url_v1({ id: pick.id, level: 'exhigh' })
  const data = resolved?.body?.data?.[0] ?? null
  out.stream = {
    bodyCode: resolved?.body?.code,
    song: { id: pick.id, name: pick.name },
    url: data?.url ? data.url.slice(0, 120) + (data.url.length > 120 ? '…' : '') : null,
    urlHost: data?.url ? new URL(data.url).host : null,
    br: data?.br ?? null,
    size: data?.size ?? null,
    level: data?.level ?? null,
    fee: data?.fee ?? null,
    trial: Boolean(data?.freeTrialInfo),
    code: data?.code ?? null
  }

  if (!data?.url) {
    // Not fatal for the probe: a song can legitimately be unavailable. But it
    // means the strongest piece of evidence could not be collected.
    out.range = { skipped: 'no url resolved' }
  } else {
    const host = new URL(data.url).host
    if (/^(localhost|127\.|\[::1\])/.test(host)) out.range = { error: `url host looks local: ${host}` }
    else {
      const started = Date.now()
      const res = await fetch(data.url, { headers: { range: 'bytes=0-4095' } })
      const buf = Buffer.from(await res.arrayBuffer())
      out.range = {
        ms: Date.now() - started,
        status: res.status,
        bytes: buf.byteLength,
        contentType: res.headers.get('content-type'),
        contentRange: res.headers.get('content-range'),
        contentLength: res.headers.get('content-length'),
        acceptRanges: res.headers.get('accept-ranges'),
        magic: sniffer(buf)
      }
      fs.writeFileSync(path.join(tmp, 'aurora-verify-clip.bin'), buf)
    }
  }

  // --- 4. the honest negative: a VIP-only track must not resolve ----------
  const vipSong = songs.find((s) => s.fee === 1) ?? null
  if (vipSong) {
    const vr = await api.song_url_v1({ id: vipSong.id, level: 'exhigh' })
    const vd = vr?.body?.data?.[0] ?? null
    out.vipControl = {
      id: vipSong.id,
      name: vipSong.name,
      url: vd?.url ? String(vd.url).slice(0, 80) + '…' : null,
      code: vd?.code ?? null,
      freeTrial: Boolean(vd?.freeTrialInfo),
      trialFrom: vd?.freeTrialInfo?.start ?? null,
      trialTo: vd?.freeTrialInfo?.end ?? null,
      verdict: vd?.url && !vd?.freeTrialInfo ? 'VIP TRACK RETURNED A FULL URL - classification must not claim vip-required blindly' : 'restricted as expected'
    }
  } else {
    out.vipControl = { skipped: 'no fee===1 track in this result page' }
  }

  // --- 5. an id that cannot exist: the classifier needs a real not-found ---
  const ghost = await api.song_url_v1({ id: 99999999999, level: 'exhigh' })
  out.ghostId = {
    bodyCode: ghost?.body?.code ?? null,
    data: ghost?.body?.data?.[0] ?? null,
    message: String(ghost?.body?.message ?? '').slice(0, 160)
  }

  // --- 6. lyrics, detail, and cover host ---------------------------------
  const lyric = await api.lyric({ id: pick.id })
  out.lyrics = {
    bodyCode: lyric?.body?.code,
    lrcLength: (lyric?.body?.lrc?.lyric ?? '').length,
    translationLength: (lyric?.body?.tlyric?.lyric ?? '').length,
    firstLine: (lyric?.body?.lrc?.lyric ?? '').split('\n')[0] ?? null
  }

  const detail = await api.song_detail({ ids: String(pick.id) })
  const ds = detail?.body?.songs?.[0] ?? null
  out.detail = ds
    ? {
        id: ds.id,
        album: ds.al?.name ?? null,
        picUrlHost: ds.al?.picUrl ? new URL(ds.al.picUrl).host : null,
        coverBytes: ds.al?.picUrl ? (await coverSize(ds.al.picUrl)) : null,
        durationMs: ds.dt ?? null
      }
    : null

  out.elapsedMs = Date.now() - t0
  console.log(JSON.stringify(out, null, 2))
}

/** Prove the cover URL is a real fetchable image, not just a plausible string. */
async function coverSize(url) {
  try {
    const res = await fetch(url, { headers: { range: 'bytes=0-63' } })
    const buf = Buffer.from(await res.arrayBuffer())
    return { status: res.status, bytes: buf.byteLength, contentType: res.headers.get('content-type'), magic: sniffer(buf) }
  } catch (error) {
    return { error: String(error?.message).slice(0, 120) }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error('PROBE FAILED:', error)
    console.error(JSON.stringify(out, null, 2))
    process.exit(1)
  }
)
