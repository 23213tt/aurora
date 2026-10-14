import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyStreamFailure, describeFailure } from './reasons'
import type { NeteaseFailureReason } from './reasons'
import {
  HANDSHAKE_BACKOFF_MS,
  HANDSHAKE_COOLDOWN_MS,
  isTransientHandshakeFailure
} from '../pure/netease-bootstrap'
import { clearCookie, hasCookie, readCookie, writeCookie } from './session'
import { isUsableId } from './types'
import type {
  NeteaseAccount,
  NeteaseAlbum,
  NeteaseAlbumRef,
  NeteaseArtist,
  NeteaseLoginResult,
  NeteaseLyricsResult,
  NeteasePlaylistSummary,
  NeteaseQrResult,
  NeteaseQrSession,
  NeteaseQuality,
  NeteaseSearchResult,
  NeteaseSong,
  NeteaseStatusResult,
  NeteaseStream,
  NeteaseStreamResult
} from './types'

/**
 * The Netease Cloud Music client, wrapped so the rest of Aurora never sees the
 * upstream package.
 *
 * Three things drive the shape of this file.
 *
 * 1. Booting the upstream package is fragile. It reads `%TEMP%\anonymous_token`
 *    with a bare `readFileSync` while its modules load, so the file must exist
 *    before the first `require`, and its own `generateConfig()` asks for an
 *    xeapi key before it has a deviceId to ask with - a circular bootstrap, so
 *    we mint and persist the deviceId ourselves. See `bootstrapOnce`.
 *
 * 2. None of that may stop Aurora from starting. Everything is lazy and every
 *    failure only sets a string: an offline machine opens the player and shows
 *    a "连不上网易云" note on the online tab, it does not crash the app.
 *
 * 3. Upstream responses are as untrusted as a web page. Fields are read through
 *    the narrow helpers below instead of typed as fact, because a single missing
 *    `ar` array would otherwise take down the renderer with a TypeError.
 */

const API_PACKAGE = '@neteasecloudmusicapienhanced/api'

/** How long one upstream call may hang before we call it a network failure. */
const REQUEST_TIMEOUT_MS = 12_000

const TMP = os.tmpdir()
const TOKEN_PATH = path.join(TMP, 'anonymous_token')
const DEVICE_PATH = path.join(TMP, 'aurora_device_id')
const KEY_PATH = path.join(TMP, 'xeapi_public_key')

type Envelope = { status?: number; body?: unknown; cookie?: unknown }
type UpstreamCall = (params: Record<string, unknown>) => Promise<Envelope>

/** Only the endpoints Aurora uses; anything else is not worth exposing. */
interface Upstream {
  cloudsearch: UpstreamCall
  song_url_v1: UpstreamCall
  song_detail: UpstreamCall
  lyric: UpstreamCall
  album: UpstreamCall
  artist_top_song: UpstreamCall
  playlist_track_all: UpstreamCall
  recommend_songs: UpstreamCall
  user_cloud: UpstreamCall
  user_playlist: UpstreamCall
  likelist: UpstreamCall
  login_qr_key: UpstreamCall
  login_qr_create: UpstreamCall
  login_qr_check: UpstreamCall
  login_cellphone: UpstreamCall
  login_status: UpstreamCall
  user_level: UpstreamCall
  logout: UpstreamCall
  register_anonimous: UpstreamCall
}

let upstream: Upstream | null = null

/**
 * Require the upstream package, creating the token file it demands first.
 *
 * The empty file is not a placeholder for later: the package's own `main.js`
 * writes exactly this, and `util/request.js` reads it at import time. Doing it
 * here as well means the first `require` cannot be the thing that throws, no
 * matter which code path reaches the package first.
 */
function loadUpstream(): Upstream {
  if (upstream) return upstream
  if (!fs.existsSync(TOKEN_PATH)) fs.writeFileSync(TOKEN_PATH, '', 'utf-8')
  upstream = require(API_PACKAGE) as Upstream
  return upstream
}

const apiRoot = (): string => path.dirname(require.resolve(API_PACKAGE))

/** The anonymous cookie from the current run, used until a real login exists. */
let anonymousCookie = ''

/**
 * Which profile's account the next call belongs to.
 *
 * Set by `netease:setProfile` before the renderer asks for anything, because the
 * session lives in the main process while the notion of "who is using the app"
 * lives in the renderer. A module-level value is safe here: the renderer sets it
 * once on switch and then reads sequentially, so calls cannot interleave across
 * two profiles.
 */
let activeProfileId = 'default'

export function setActiveProfile(profileId: string): boolean {
  const next = String(profileId ?? '').trim() || 'default'
  if (next !== activeProfileId) {
    /*
     * Switching profiles must not leave the previous account's answers behind.
     * The account cache is the dangerous one: it holds "who is signed in", and
     * reusing it would attribute one profile's account to another.
     */
    activeProfileId = next
    invalidateAccount()
  }
  return true
}

export function activeProfile(): string {
  return activeProfileId
}

interface BootstrapState {
  ready: boolean
  deviceId: string
  /** Non-secret one-line reason, surfaced by `neteaseStatus`. */
  detail: string
  /** Why the bootstrap failed, so callers can report it honestly. */
  failure: NeteaseFailureReason | null
  keyVersion: string
  hasAnonymousToken: boolean
  /** Whether this run obtained a fresh MUSIC_A, as opposed to reusing one. */
  registered: boolean
}

let bootstrapping: Promise<BootstrapState> | null = null

/**
 * At most one failed handshake per minute - but only for failures that retrying
 * cannot fix.
 *
 * The distinction was learned from a real report: "playback does not work, and I
 * am not even logged in". The bootstrap had failed once with a transient
 * `ECONNRESET`, and because *every* failure was gated behind a 60 s cooldown, the
 * next minute of playback requests returned that stale failure without ever
 * contacting upstream. The same call succeeded seconds later when retried
 * directly, so a single network blip was being presented to the user as a
 * persistent outage.
 *
 * So: a transient failure is retried immediately with a short backoff, while a
 * settled answer (`login-required`, `vip-required`, `region-limited`,
 * `taken-down`) is not retried at all - no amount of repeating turns "you need a
 * membership" into a playable track. The one-minute gate stays for those, and for
 * when the retries are exhausted, so that rerendering the online tab cannot become
 * a request storm.
 *
 * Both policies live in `electron/pure/netease-bootstrap.ts` so they can be tested
 * without the upstream package.
 */
const RETRY_AFTER_MS = HANDSHAKE_COOLDOWN_MS

/** 二维码生成的重试次数与间隔。用户正开着弹窗等，所以比握手策略更短。 */
const QR_ATTEMPTS = 3
const QR_BACKOFF_MS = [500, 1200]

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let failedAt = 0
let lastFailed: BootstrapState = {
  ready: false,
  deviceId: '',
  detail: '',
  failure: null,
  keyVersion: '',
  hasAnonymousToken: false,
  registered: false
}

/**
 * The startup sequence, run once per process while it succeeds, never throwing.
 *
 * Order matters and mirrors `scripts/probe-netease5.cjs`, which is the sequence
 * verified against the live service: empty token file, then our own deviceId,
 * then the xeapi key fetched *with* that deviceId, and only then the anonymous
 * registration. Fetching the key without a deviceId returns a public key with
 * no `sk`, which is what upstream reports later as "xeapi public key is
 * missing" - the circular failure this order exists to avoid.
 *
 * A *successful* bootstrap is cached for the life of the process; a failed one
 * is not. Caching the failure would mean that launching the app before the
 * network is up leaves the online source dead until the next restart, which is
 * a worse outcome than one cheap retry.
 */
async function bootstrapOnce(): Promise<BootstrapState> {
  if (!bootstrapping) {
    if (failedAt && Date.now() - failedAt < RETRY_AFTER_MS) return lastFailed
    bootstrapping = runBootstrap()
  }

  let state = await bootstrapping

  /*
   * Retry a transient failure in place, before anyone sees it.
   *
   * This is the part that was missing: one blip used to be latched for a minute,
   * so the user's next several play attempts all reported a network problem that
   * had already passed. Retrying here rather than in the caller keeps every
   * entry point (search, stream, lyrics) fixed at once.
   */
  for (let attempt = 0; !state.ready && isTransientHandshakeFailure(state.failure) && attempt < HANDSHAKE_BACKOFF_MS.length; attempt += 1) {
    await sleep(HANDSHAKE_BACKOFF_MS[attempt])
    /*
     * Publish the new attempt on the shared slot before awaiting it, so a parallel
     * caller that arrives during the sleep joins this attempt instead of starting
     * a second one. That is what keeps the retry from becoming a storm.
     */
    bootstrapping = runBootstrap()
    state = await bootstrapping
  }

  if (state.ready) return state
  failedAt = Date.now()
  lastFailed = state
  bootstrapping = null
  return state
}

async function runBootstrap(): Promise<BootstrapState> {
  const state: BootstrapState = {
    ready: false,
    deviceId: '',
    detail: '',
    failure: null,
    keyVersion: '',
    hasAnonymousToken: false,
    registered: false
  }

  try {
    const api = loadUpstream()

    // A deviceId of our own, 52 hex characters, persisted so the xeapi key that
    // is bound to it stays valid across restarts.
    const deviceId = readOrCreateDeviceId()
    state.deviceId = deviceId
    ;(globalThis as unknown as { deviceId?: string }).deviceId = deviceId

    // The key service only answers with `sk` when the request carries a
    // deviceId, so this call is the whole point of minting one first.
    const { getXeapiPublicKey } = require(path.join(apiRoot(), 'util', 'xeapiKey.js')) as {
      getXeapiPublicKey: (
        current: Record<string, unknown>,
        deviceId: string
      ) => Promise<Record<string, unknown>>
    }
    const key = await getXeapiPublicKey(readJson(KEY_PATH), deviceId)
    fs.writeFileSync(KEY_PATH, JSON.stringify(key), 'utf-8')
    state.keyVersion = asString(key.version)

    // Anonymous registration last: it is itself xeapi-signed, so it only works
    // now that the key above exists. A token from an earlier run is reused
    // rather than replaced, because request.js caches the file at import time
    // and re-registering would leave the two out of step for no benefit.
    const existingToken = readText(TOKEN_PATH)
    if (existingToken) {
      state.hasAnonymousToken = true
    } else {
      const anon = await api.register_anonimous({ deviceId })
      const body = asRecord(anon.body)
      const cookie = asString(body.cookie)
      const token = /MUSIC_A=([^;]+)/.exec(cookie)?.[1] ?? ''
      if (token) {
        fs.writeFileSync(TOKEN_PATH, token, 'utf-8')
        state.hasAnonymousToken = true
        state.registered = true
      } else {
        // Upstream throttles repeated anonymous registrations and answers 400
        // with no cookie when it does. That is not fatal: `song_url_v1` is
        // signed with the xeapi key above, which is why anonymous playback
        // still works with an empty token file.
        console.error(
          '[aurora] netease anonymous registration returned no token, code',
          asNumber(body.code)
        )
      }
      // Keep the anonymous cookie in memory too: request.js captured the empty
      // token file when it loaded, so the file alone would not reach this
      // process's requests.
      if (cookie) anonymousCookie = cookie
    }

    state.ready = true
  } catch (error) {
    state.detail = readable(error)
    state.failure = classifyStreamFailure({ error })
    console.error('[aurora] netease bootstrap failed', state.detail)
  }

  return state
}

function readOrCreateDeviceId(): string {
  const existing = readText(DEVICE_PATH).trim()
  if (/^[0-9a-fA-F]{52}$/.test(existing)) return existing
  // crypto.randomBytes gives the 52 hex characters the key service expects and
  // does not depend on the upstream package's own generator being reachable.
  const created = crypto.randomBytes(26).toString('hex')
  fs.writeFileSync(DEVICE_PATH, created, 'utf-8')
  return created
}

const readText = (file: string): string => {
  try {
    return fs.readFileSync(file, 'utf-8')
  } catch {
    return ''
  }
}

const readJson = (file: string): Record<string, unknown> => {
  try {
    return asRecord(JSON.parse(readText(file)))
  } catch {
    return {}
  }
}

/** The cookie to send, or '' when only the anonymous token applies. */
function cookieForCall(): string {
  return readCookie(activeProfileId) || anonymousCookie
}

/**
 * One upstream call, with the session cookie and a hard timeout attached.
 *
 * The timeout is not optional: without it a request to a blackholed host sits
 * on the UI thread's promise for as long as the OS lets it, and the user sees a
 * spinner instead of an error.
 */
async function call(name: keyof Upstream, params: Record<string, unknown>): Promise<Envelope> {
  const api = loadUpstream()
  const fn = api[name]
  if (typeof fn !== 'function') throw new Error(`netease: upstream is missing ${name}`)

  const payload: Record<string, unknown> = { ...params, timeout: REQUEST_TIMEOUT_MS }
  const cookie = cookieForCall()
  if (cookie) payload.cookie = cookie
  return await fn(payload)
}

// --- untrusted-response readers -------------------------------------------

type Json = Record<string, unknown>

function asRecord(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

const asNullableString = (value: unknown): string | null => asString(value) || null

/** `body.data` when upstream wraps its payload, otherwise `body` itself. */
function payloadOf(body: unknown): Json {
  const record = asRecord(body)
  const data = record.data
  return data && typeof data === 'object' && !Array.isArray(data) ? asRecord(data) : record
}

function readable(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

// --- normalisation --------------------------------------------------------

/**
 * Upstream spells the same song three ways depending on the endpoint
 * (`ar`/`al` on search and detail, `artists`/`album` on older routes, and
 * `simpleSong` on cloud files), so everything funnels through one mapper.
 */
function toSong(value: unknown): NeteaseSong | null {
  const raw = asRecord(value)
  const id = asNumber(raw.id)
  if (!id) return null

  const artistSource = asArray(raw.ar).length > 0 ? asArray(raw.ar) : asArray(raw.artists)
  const artists: NeteaseArtist[] = artistSource
    .map((entry) => ({ id: asNumber(asRecord(entry).id), name: asString(asRecord(entry).name) }))
    .filter((artist) => artist.name.length > 0)

  const albumSource = asRecord(raw.al ?? raw.album)
  const album: NeteaseAlbumRef = {
    id: asNumber(albumSource.id),
    name: asString(albumSource.name),
    picUrl: asNullableString(albumSource.picUrl)
  }

  return {
    id,
    name: asString(raw.name) || '未知歌曲',
    artists,
    album,
    // Upstream durations are milliseconds everywhere; the contract is seconds.
    duration: Math.round(asNumber(raw.dt) / 1000),
    fee: asNumber(raw.fee)
  }
}

function toSongs(value: unknown): NeteaseSong[] {
  return asArray(value)
    .map(toSong)
    .filter((song): song is NeteaseSong => song !== null)
}

const joinArtists = (value: unknown): string =>
  asArray(value)
    .map((entry) => asString(asRecord(entry).name))
    .filter(Boolean)
    .join(' / ')

const yearOf = (publishTime: unknown): number | null => {
  const ms = asNumber(publishTime)
  if (ms <= 0) return null
  const year = new Date(ms).getFullYear()
  return Number.isFinite(year) ? year : null
}

const clamp = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : min

// --- status --------------------------------------------------------------

/**
 * Begin the bootstrap without waiting for it.
 *
 * Called once when the app is ready: the first real Netease call would
 * otherwise pay for the whole device/key/token handshake on the user's click.
 * The result is deliberately discarded - a failure sets `detail`, which
 * `neteaseStatus` reports later, and it must never delay app startup.
 */
export async function neteaseWarmUp(): Promise<void> {
  await bootstrapOnce()
}

export async function neteaseStatus(): Promise<NeteaseStatusResult> {
  const state = await bootstrapOnce()
  if (!state.ready) return { ready: false, loggedIn: false, detail: state.detail }
  const account = await safeAccount()
  return { ready: true, loggedIn: account !== null, detail: state.detail || undefined }
}


// --- search and metadata -------------------------------------------------

export async function neteaseSearch(
  keywords: string,
  type: 'song' | 'album' | 'artist',
  limit = 30
): Promise<NeteaseSearchResult> {
  const API_TYPE = { song: 1, album: 10, artist: 100 } as const
  const res = await call('cloudsearch', {
    keywords,
    type: API_TYPE[type],
    limit: clamp(limit, 1, 100)
  })

  const result = asRecord(asRecord(res.body).result)
  const songs = toSongs(result.songs)

  const albums = asArray(result.albums).map((entry) => {
    const raw = asRecord(entry)
    return {
      id: asNumber(raw.id),
      name: asString(raw.name),
      artist: joinArtists(raw.artists) || asString(asRecord(raw.artist).name),
      picUrl: asNullableString(raw.picUrl),
      year: yearOf(raw.publishTime),
      songCount: asNumber(raw.size)
    }
  })

  const artists = asArray(result.artists).map((entry) => {
    const raw = asRecord(entry)
    return {
      id: asNumber(raw.id),
      name: asString(raw.name),
      picUrl: asNullableString(raw.picUrl),
      albumCount: asNumber(raw.albumSize)
    }
  })

  return { songs, albums, artists }
}

export async function neteaseSongDetail(ids: number[]): Promise<NeteaseSong[]> {
  const unique = Array.from(new Set(ids)).slice(0, 1000)
  if (unique.length === 0) return []
  // song_detail splits this string itself, so it must be a comma-separated
  // string rather than an array.
  const res = await call('song_detail', { ids: unique.join(',') })
  return toSongs(asRecord(res.body).songs)
}

export async function neteaseAlbum(id: number): Promise<NeteaseAlbum | null> {
  if (!isUsableId(id)) return null
  const res = await call('album', { id })
  const body = asRecord(res.body)
  const raw = asRecord(body.album)
  const albumId = asNumber(raw.id)
  if (!albumId) return null

  return {
    id: albumId,
    name: asString(raw.name),
    artist: joinArtists(raw.artists) || asString(asRecord(raw.artist).name),
    coverUrl: asNullableString(raw.picUrl),
    year: yearOf(raw.publishTime),
    songs: toSongs(body.songs)
  }
}

export async function neteaseArtistTopSongs(id: number, limit = 50): Promise<NeteaseSong[]> {
  if (!isUsableId(id)) return []
  const res = await call('artist_top_song', { id })
  return toSongs(asRecord(res.body).songs).slice(0, clamp(limit, 1, 50))
}

export async function neteaseLyrics(songId: number): Promise<NeteaseLyricsResult | null> {
  if (!isUsableId(songId)) return null
  const res = await call('lyric', { id: songId })
  const body = asRecord(res.body)
  const lrc = asNullableString(asRecord(body.lrc).lyric)
  const translation = asNullableString(asRecord(body.tlyric).lyric)
  // Instrumentals are a real answer, not an error: no lyric at all is `null`,
  // and a lyric with no translation is a lyric.
  if (!lrc && !translation) return null
  return { lrc, translation }
}

// --- playable stream -----------------------------------------------------

const QUALITY_LEVELS = new Set(['standard', 'higher', 'exhigh', 'lossless', 'hires'])

function levelOf(value: unknown, requested: NeteaseQuality): NeteaseQuality | 'hires' {
  const level = asString(value)
  if (QUALITY_LEVELS.has(level)) return level as NeteaseQuality | 'hires'
  return requested
}

/**
 * Resolve a playable URL, classifying every refusal instead of collapsing it.
 *
 * `song_url_v1` reports "no" through a per-track `url: null` and sometimes an
 * empty `fee`, so when there is nothing playable the fee is looked up
 * separately - that one field is what separates "buy a membership" from "this
 * track is gone", and guessing between them is exactly what the contract
 * forbids.
 */
export async function neteaseStreamUrl(
  songId: number,
  quality: NeteaseQuality = 'exhigh'
): Promise<NeteaseStreamResult> {
  if (!isUsableId(songId)) {
    return { ok: false, reason: 'unknown', message: '歌曲 ID 无效' }
  }
  try {
    const state = await bootstrapOnce()
    // A failed bootstrap is not the track's fault, and `song_url_v1` would only
    // report it as a confusing upstream error. Say what actually went wrong.
    if (!state.ready) {
      const reason = state.failure ?? 'service-unavailable'
      return { ok: false, reason, message: state.detail || describeFailure(reason) }
    }

    const res = await call('song_url_v1', { id: songId, level: quality })
    const body = asRecord(res.body)
    const entry = asRecord(asArray(body.data)[0])

    const url = asString(entry.url)
    const trialInfo = asRecord(entry.freeTrialInfo)
    const trial = Object.keys(trialInfo).length > 0

    if (url) {
      const from = trial ? asNumber(trialInfo.start) : 0
      const to = trial ? asNumber(trialInfo.end) : 0
      const served = Math.round(asNumber(entry.time) / 1000)
      const stream: NeteaseStream = {
        url,
        br: asNumber(entry.br),
        level: levelOf(entry.level, quality),
        // `time` is the length of the file this URL actually serves, which is
        // the only honest duration for a trial fragment.
        duration: served > 0 ? served : to > from ? to - from : 0,
        trial
      }
      if (trial) {
        stream.trialFrom = from
        stream.trialTo = to
      }
      return { ok: true, stream }
    }

    const loggedIn = readCookie(activeProfileId).length > 0
    const fee = typeof entry.fee === 'number' ? entry.fee : await feeOf(songId)
    const reason = classifyStreamFailure({
      code: asNumber(body.code),
      songCode: typeof entry.code === 'number' ? entry.code : null,
      url: null,
      freeTrialInfo: entry.freeTrialInfo,
      fee,
      loggedIn
    })
    return { ok: false, reason, message: describeFailure(reason) }
  } catch (error) {
    const reason = classifyStreamFailure({ error })
    // Never log the URL or the cookie, only the shape of the failure.
    console.error('[aurora] netease stream lookup failed', reason, readable(error))
    return { ok: false, reason, message: describeFailure(reason) }
  }
}

/** The `fee` of one song, or 0 when even that lookup fails. */
async function feeOf(songId: number): Promise<number> {
  try {
    const songs = await neteaseSongDetail([songId])
    return songs[0]?.fee ?? 0
  } catch {
    return 0
  }
}

// --- login ---------------------------------------------------------------

export async function neteaseQrCreate(): Promise<NeteaseQrSession> {
  await bootstrapOnce()

  // 这个调用会间歇失败（实测 login_qr_key 回 502 ECONNRESET，稍后即成功），所以重试。
  const attempt = async (): Promise<{ key: string; url: string; imageDataUrl: string }> => {
    const keyRes = await call('login_qr_key', {})
    const key = asString(asRecord(payloadOf(keyRes.body)).unikey)
    if (!key) throw new Error('netease: no qr key')

    // `qrimg` is what makes the package render the PNG data URL for us; without
    // it the response carries only the URL and the renderer would need a QR
    // encoder of its own.
    const created = await call('login_qr_create', { key, qrimg: true })
    const data = asRecord(payloadOf(created.body))
    const imageDataUrl = asString(data.qrimg)
    // 空图片就是失败：界面拿到空字符串就是一个空白框。
    if (!imageDataUrl) throw new Error('netease: qr image missing')
    return {
      key,
      url: asString(data.qrurl) || `https://music.163.com/login?codekey=${key}`,
      imageDataUrl
    }
  }

  let lastError: unknown = null
  for (let i = 0; i < QR_ATTEMPTS; i += 1) {
    try {
      return await attempt()
    } catch (error) {
      lastError = error
      // Only transport failures are worth repeating; a rejected key is not.
      if (!isTransientHandshakeFailure(classifyStreamFailure({ error }))) throw error
      if (i < QR_ATTEMPTS - 1) await sleep(QR_BACKOFF_MS[i] ?? 800)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('netease: qr create failed')
}

export async function neteaseQrCheck(key: string): Promise<NeteaseQrResult> {
  const res = await call('login_qr_check', { key })
  const body = asRecord(res.body)
  const code = asNumber(body.code)

  if (code === 800) return { status: 'expired', message: '二维码已过期，请重新获取' }
  if (code === 801) return { status: 'waiting' }
  if (code === 802) return { status: 'scanned', message: '已扫码，请在手机上确认' }
  if (code === 803) {
    const cookie = asString(body.cookie)
    if (cookie) writeCookie(activeProfileId, cookie)
    invalidateAccount()
    return { status: 'confirmed', account: (await safeAccount()) ?? undefined }
  }
  return { status: 'failed', message: asString(body.message) || '登录失败，请重试' }
}

export async function neteaseLoginCellphone(
  phone: string,
  password: string
): Promise<NeteaseLoginResult> {
  await bootstrapOnce()
  // The password is handed to upstream, which hashes it, and is never logged,
  // stored or put into an error message. Errors below go out by code only.
  const res = await call('login_cellphone', { phone, password })
  const body = asRecord(res.body)
  const code = asNumber(body.code)

  if (code !== 200) return { ok: false, message: loginMessage(code) }

  const cookie = asString(body.cookie)
  if (cookie) writeCookie(activeProfileId, cookie)
  invalidateAccount()
  return { ok: true, account: (await safeAccount()) ?? undefined }
}

/** Upstream's login codes, in the wording the user needs rather than the number. */
function loginMessage(code: number): string {
  switch (code) {
    case 400:
      return '手机号或密码不正确'
    case 501:
      return '该手机号尚未注册网易云'
    case 502:
      return '密码错误'
    case 503:
      return '请求过于频繁，请稍后再试'
    case 504:
      return '该账号存在安全风险，请先在网易云客户端完成验证'
    case 509:
      return '该账号已被限制登录，请稍后再试'
    case 250:
      return '需要先完成人机验证，请改用二维码登录'
    default:
      return '登录失败，请重试'
  }
}

export async function neteaseLoginStatus(): Promise<NeteaseAccount | null> {
  await bootstrapOnce()
  return await safeAccount()
}

export async function neteaseLogout(): Promise<boolean> {
  try {
    await call('logout', {})
  } catch (error) {
    // The account is signed out locally either way; a failed upstream call
    // only means the server keeps a session nobody here can use.
    console.error('[aurora] netease logout did not reach upstream', readable(error))
  }
  clearCookie(activeProfileId)
  invalidateAccount()
  anonymousCookie = ''
  return true
}

/**
 * Sign a *specific* profile out, without disturbing the active one.
 *
 * The profiles screen has to be able to unbind an account from a profile that is
 * not the one currently in use, so this reads the session by id rather than
 * through the module-level pointer.
 */
export function neteaseLogoutProfile(profileId: string): boolean {
  clearCookie(profileId)
  if (profileId === activeProfileId) {
    invalidateAccount()
    anonymousCookie = ''
  }
  return true
}

/** Whether a profile has a session at all; no upstream call. */
export function profileHasSession(profileId: string): boolean {
  return hasCookie(profileId)
}

/**
 * The account a *specific* profile is signed in as, for the profiles screen.
 *
 * Reads that profile's session, so it works whether or not that profile is the
 * active one. `invalidateAccount` runs on both edges of the switch, so the
 * shared cache cannot answer with the wrong profile's identity.
 */
export async function neteaseAccountFor(profileId: string): Promise<NeteaseAccount | null> {
  const previous = activeProfileId
  try {
    setActiveProfile(profileId)
    if (!readCookie(activeProfileId)) return null
    await bootstrapOnce()
    return await safeAccount()
  } catch (error) {
    console.error('[aurora] could not read the account of another profile', readable(error))
    return null
  } finally {
    setActiveProfile(previous)
  }
}

/**
 * Who is signed in, cached briefly.
 *
 * Opening the "my music" page asks for playlists, the daily list, cloud files
 * and likes in one go, and every one of them needs the uid first. Without this
 * that is four extra round trips that all return the same answer.
 */
let accountCache: { value: NeteaseAccount | null; at: number } | null = null
const ACCOUNT_TTL_MS = 30_000

function invalidateAccount(): void {
  accountCache = null
}

async function safeAccount(): Promise<NeteaseAccount | null> {
  if (accountCache && Date.now() - accountCache.at < ACCOUNT_TTL_MS) return accountCache.value

  let value: NeteaseAccount | null = null
  try {
    const res = await call('login_status', {})
    const body = asRecord(res.body)
    const payload = payloadOf(body)
    const profile = asRecord(payload.profile)
    const userId = asNumber(profile.userId)
    if (userId) {
      value = {
        userId,
        nickname: asString(profile.nickname) || '网易云用户',
        avatarUrl: asNullableString(profile.avatarUrl),
        vip: asNumber(profile.vipType) > 0,
        level: await levelOfUser()
      }
    }
  } catch {
    // Signed out, offline or an expired cookie all look the same from here.
  }

  accountCache = { value, at: Date.now() }
  return value
}

async function levelOfUser(): Promise<number> {
  try {
    const res = await call('user_level', {})
    // `body.data.level` on the v1 route, `body.level` on the fallback.
    return asNumber(payloadOf(asRecord(res.body)).level)
  } catch {
    return 0
  }
}

// --- personal music ------------------------------------------------------

/**
 * Personal music answers with empty lists rather than errors when signed out:
 * the online tab must look empty, not broken, and a thrown rejection would
 * surface as an unhandled failure in the page.
 */
export async function neteaseMyPlaylists(): Promise<NeteasePlaylistSummary[]> {
  await bootstrapOnce()
  const account = await safeAccount()
  if (!account) return []

  const res = await call('user_playlist', { uid: account.userId, limit: 1000, offset: 0 })
  return asArray(asRecord(res.body).playlist)
    .map((entry) => {
      const raw = asRecord(entry)
      return {
        id: asNumber(raw.id),
        name: asString(raw.name),
        coverUrl: asNullableString(raw.coverImgUrl),
        trackCount: asNumber(raw.trackCount),
        playCount: asNumber(raw.playCount),
        creator: asString(asRecord(raw.creator).nickname),
        subscribed: Boolean(raw.subscribed)
      }
    })
    .filter((playlist) => playlist.id > 0)
}

export async function neteasePlaylistTracks(id: number): Promise<NeteaseSong[]> {
  if (!isUsableId(id)) return []
  const res = await call('playlist_track_all', { id })
  return toSongs(asRecord(res.body).songs)
}

export async function neteaseDailySongs(): Promise<NeteaseSong[]> {
  await bootstrapOnce()
  if (!(await safeAccount())) return []
  const res = await call('recommend_songs', {})
  // The v3 route nests the list, the older one does not.
  const body = asRecord(res.body)
  const data = asRecord(body.data)
  return toSongs(asArray(data.dailySongs).length > 0 ? data.dailySongs : body.recommend)
}

export async function neteaseCloudSongs(): Promise<NeteaseSong[]> {
  await bootstrapOnce()
  if (!(await safeAccount())) return []

  // Paged, because the cloud list has no upper bound and a single 100k request
  // would hang the tab. 200 a page up to 1000 covers real libraries.
  const songs: NeteaseSong[] = []
  const pageSize = 200
  for (let offset = 0; offset < 1000; offset += pageSize) {
    const res = await call('user_cloud', { limit: pageSize, offset })
    const page = asArray(asRecord(res.body).data)
    const mapped = page
      .map((entry) => {
        const raw = asRecord(entry)
        // Cloud entries carry the song either nested or as loose fields.
        const nested = toSong(raw.simpleSong ?? raw.song)
        if (nested) return nested
        const id = asNumber(raw.songId)
        if (!id) return null
        return {
          id,
          name: asString(raw.songName) || '未知歌曲',
          artists: asArray(raw.artist)
            .map((name) => ({ id: 0, name: asString(name) }))
            .filter((artist) => artist.name),
          album: { id: 0, name: asString(raw.album) || '', picUrl: null },
          duration: Math.round(asNumber(raw.duration) / 1000),
          fee: 0
        } satisfies NeteaseSong
      })
      .filter((song): song is NeteaseSong => song !== null)
    songs.push(...mapped)
    if (page.length < pageSize) break
  }
  return songs
}

export async function neteaseLikeList(): Promise<NeteaseSong[]> {
  await bootstrapOnce()
  const account = await safeAccount()
  if (!account) return []

  const res = await call('likelist', { uid: account.userId })
  const ids = asArray(asRecord(res.body).ids)
    .map(asNumber)
    .filter((id) => id > 0)
  if (ids.length === 0) return []

  // song_detail caps a single request at 1000 ids; chunk so a large like list
  // cannot silently come back truncated.
  const songs: NeteaseSong[] = []
  for (let index = 0; index < ids.length; index += 500) {
    songs.push(...(await neteaseSongDetail(ids.slice(index, index + 500))))
  }
  return songs
}
