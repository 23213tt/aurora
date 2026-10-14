import type { QqQuality } from './types'

/**
 * The QQ wire layer: the two-step vkey exchange, the file-name rules, the
 * cookie format, and the error codes.
 *
 * The upstream package does the HTTP, so what is left - and what actually
 * matters to Aurora - is everything *around* the request: how a `sip` domain is
 * chosen, how `purl` becomes a URL, how the per-song `result` code is read, and
 * how a session cookie is taken apart. Those are the parts whose behaviour we
 * depend on, so they are written out here in the open where they can be tested,
 * instead of being left to a dependency's internal helper.
 *
 * Why the two-step matters at all: QQ never returns a playable address in one
 * go. `vkey.GetVkeyServer/CgiGetVkey` answers with a `sip` (one or more CDN
 * hosts) plus a `midurlinfo` entry per song, and the playable URL only exists
 * once the two are joined. Dropping the vkey answers 403, and the join is the
 * only place where a wrong assumption shows up as silence rather than an error.
 *
 * The module imports nothing at runtime - the package is required lazily inside
 * the functions, and the readers below are local on purpose. A shared helper
 * module would be a relative runtime import, which Node's ESM resolver rejects
 * without a file extension, and `tsc` rejects *with* one; keeping each pure
 * module self-contained is what makes `node --test` able to load it. Folia's
 * per-platform files do the same thing for the same reason.
 */

// --- quality ------------------------------------------------------------

/** The upstream's own format tokens. */
export type QqFormat = '128' | '320' | 'm4a' | 'flac' | 'ape'

export interface QualityFormat {
  /** The file-name prefix the CDN expects. */
  prefix: string
  suffix: string
  /** True when the format is bit-perfect, i.e. must not be offered as a fallback. */
  lossless: boolean
}

/**
 * Prefix and extension per format, straight from the upstream file-naming
 * scheme (`M500`/`C400`/`M800`/`F000`/`A000`).
 *
 * `m4a` is listed as lossy because it is AAC; upstream publishes no bitrate for
 * it, so nothing here claims one.
 */
export const QUALITY_FORMATS: Record<QqFormat, QualityFormat> = {
  '128': { prefix: 'M500', suffix: '.mp3', lossless: false },
  '320': { prefix: 'M800', suffix: '.mp3', lossless: false },
  m4a: { prefix: 'C400', suffix: '.m4a', lossless: false },
  flac: { prefix: 'F000', suffix: '.flac', lossless: true },
  ape: { prefix: 'A000', suffix: '.ape', lossless: true }
}

/**
 * The shared tiers, mapped onto the formats upstream actually serves.
 *
 * `higher` maps to 128k on purpose: this interface exposes no 192k tier (the
 * package's format table has no `M`-prefix between `M500` and `M800`), and
 * answering it with `m4a` would make it *worse* than `standard`, which is a
 * ladder no user can reason about. The tier therefore resolves to the same
 * stream as `standard`, and the reply reports the achieved level so the
 * interface never claims otherwise.
 */
export const TIER_FORMATS: Record<
  QqQuality,
  { format: QqFormat; bitrate: number; lossless: boolean }
> = {
  standard: { format: '128', bitrate: 128, lossless: false },
  higher: { format: '128', bitrate: 128, lossless: false },
  exhigh: { format: '320', bitrate: 320, lossless: false },
  // 999 is this app's existing marker for a lossless stream; the renderer's own
  // fallback table uses the same number, so the two cannot disagree.
  lossless: { format: 'flac', bitrate: 999, lossless: true }
}

/**
 * The tiers to try for a request, best first.
 *
 * Upstream refuses a tier it will not serve with an empty `purl` rather than an
 * error - verified live: a *free* track answers 320k and FLAC with
 * `result=104003` while 128k succeeds. A client that stopped at the refusal
 * would be silent for every user who has not signed in, and the default tier is
 * `exhigh`. Walking down the ladder is what a real client does, and the reason
 * code stays honest because it is only reported once the last tier is refused
 * too.
 */
export function tierLadder(quality: QqQuality): QqQuality[] {
  const order: QqQuality[] = ['lossless', 'exhigh', 'standard']
  const start = order.indexOf(quality)
  if (start === -1) return ['standard']
  return order.slice(start)
}

export function formatOf(format: QqFormat): QualityFormat {
  return QUALITY_FORMATS[format]
}

/**
 * The file name to ask the vkey server for.
 *
 * Verified against the live service: `prefix + songmid + mediaMid + suffix` is
 * what upstream expects, and it echoed exactly that back in `midurlinfo[0]`.
 * When `mediaMid` is unknown the songmid is repeated, which upstream still
 * resolves - the field is a refinement, not a requirement.
 */
export function qualityFilename(songmid: string, mediaMid: string, quality: QqFormat): string {
  const format = formatOf(quality)
  return `${format.prefix}${songmid}${mediaMid || songmid}${format.suffix}`
}

// --- url assembly -------------------------------------------------------

/**
 * Choose the CDN host.
 *
 * The same preference the installed package uses (verified by reading its
 * `pickPlayableDomain`): skip the `http://ws` streaming hosts first, then
 * prefer an https entry, then take whatever is left. Duplicating the rule is
 * deliberate - it is one of the two things that decide whether playback works,
 * so it belongs somewhere Aurora can see and test it.
 */
export function pickSipDomain(sip: unknown): string {
  if (!Array.isArray(sip)) return ''
  const urls = sip.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return (
    urls.find((url) => !url.startsWith('http://ws')) ??
    urls.find((url) => url.startsWith('https://')) ??
    urls[0] ??
    ''
  )
}

export function joinUrl(domain: string, path: string): string {
  if (!domain) return ''
  if (domain.endsWith('/') && path.startsWith('/')) return `${domain}${path.slice(1)}`
  if (!domain.endsWith('/') && !path.startsWith('/')) return `${domain}/${path}`
  return `${domain}${path}`
}

/** `sip` + `purl` -> the address the renderer proxies. Empty when there is no purl. */
export function buildPlayUrl(sip: unknown, purl: unknown): string {
  const path = typeof purl === 'string' ? purl : ''
  if (!path) return ''
  return joinUrl(pickSipDomain(sip), path)
}

// --- reading the play response -----------------------------------------

export interface PlayInfo {
  /** `data.code` (or `body.code`): the request-level verdict. */
  envelopeCode: number | null
  /** `data.req_0.code`: the module-level verdict. */
  requestCode: number | null
  /** The playable path, empty when upstream refused. */
  purl: string
  /** Per-song verdict from `midurlinfo[0]`; 0 means "went through". */
  result: number | null
  /** The file name upstream built for us, useful for diagnosing a mismatch. */
  filename: string
  /** The joined address, empty when upstream refused. */
  url: string
}

/**
 * Pull the fields Aurora cares about out of a `resType: 'raw'` play response.
 *
 * Raw rather than the package's cooked `playUrl` shape: the cooked form drops
 * `midurlinfo`, and `midurlinfo[].result` is the only field that distinguishes
 * "needs a membership" from "this went wrong", which is the distinction the
 * whole failure vocabulary rests on.
 */
export function playInfoOf(response: unknown): PlayInfo {
  const body = asRecord(asRecord(response).body)
  // `resType: 'raw'` returns the musicu envelope itself under `data`.
  const data = asRecord(body.data)
  const request = asRecord(data.req_0)
  const requestData = asRecord(request.data)
  const info = asArray(requestData.midurlinfo).map(asRecord)[0] ?? {}

  const purl = asString(info.purl)
  return {
    envelopeCode: numberOrNull(data.code) ?? numberOrNull(body.code),
    requestCode: numberOrNull(request.code),
    purl,
    result: numberOrNull(info.result),
    filename: asString(info.filename),
    url: buildPlayUrl(requestData.sip, purl)
  }
}

// --- cookies ------------------------------------------------------------

export interface CookieJar {
  [name: string]: string
}

export function parseCookie(cookie: unknown): CookieJar {
  const jar: CookieJar = {}
  if (typeof cookie !== 'string' || !cookie) return jar
  for (const part of cookie.split(';')) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const separator = trimmed.indexOf('=')
    if (separator <= 0) continue
    const name = trimmed.slice(0, separator).trim()
    const value = trimmed.slice(separator + 1).trim()
    if (name && value) jar[name] = value
  }
  return jar
}

export function cookieValue(cookie: unknown, ...names: string[]): string {
  const jar = parseCookie(cookie)
  for (const name of names) {
    const value = jar[name]
    if (value) return value
  }
  return ''
}

/** Digits of a uin, whether upstream wrote it as `123456` or `o123456`. */
export function uinDigits(value: unknown): string {
  const text = typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
  const match = /\d{3,}/.exec(text)
  return match ? match[0] : ''
}

/** Whether a cookie carries the two names QQ treats as the login session. */
export function isSessionCookie(cookie: unknown): boolean {
  return Boolean(cookieValue(cookie, 'qqmusic_key', 'qm_keyst'))
}

// --- local readers ------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// --- the upstream package ----------------------------------------------

/**
 * The slice of `@sansenjian/qq-music-api` this client uses.
 *
 * Required lazily, inside the functions below, for the same reason
 * `electron/netease/client.ts` does it: the package pulls in koa, axios and the
 * whole route table, so loading it must not be part of starting Aurora.
 */
interface QqSdk {
  search: (params: Record<string, unknown>) => Promise<unknown>
  getPlayUrl: (params: Record<string, unknown>) => Promise<unknown>
  lyric: (params: Record<string, unknown>) => Promise<unknown>
  getQQLoginQr: () => Promise<unknown>
  checkQQLoginQr: (params: Record<string, unknown>) => Promise<unknown>
}

interface QqServices {
  getUserDetail: (params: Record<string, unknown>) => Promise<unknown>
  getVipInfo: (params: Record<string, unknown>) => Promise<unknown>
}

const SDK_PACKAGE = '@sansenjian/qq-music-api/sdk'
const SERVICES_PACKAGE = '@sansenjian/qq-music-api/services'

let sdk: QqSdk | null = null
let services: QqServices | null = null

/**
 * Load the SDK, once.
 *
 * Exported so `status()` can report "the dependency is missing or broken" as a
 * detail string instead of every call failing with an unrelated message.
 */
export function loadSdk(): QqSdk {
  if (!sdk) sdk = require(SDK_PACKAGE) as QqSdk
  return sdk
}

/**
 * Load the service bundle, once.
 *
 * `./services` is already in memory by the time `./sdk` is loaded - the SDK is
 * a thin wrapper over it - so this costs nothing extra. It is used for the two
 * calls the SDK does not wrap: the account lookup that doubles as a login
 * liveness probe, and the membership endpoint.
 */
export function loadServices(): QqServices {
  if (!services) services = require(SERVICES_PACKAGE) as QqServices
  return services
}

export async function requestSearch(params: {
  keywords: string
  limit: number
  page?: number
}): Promise<unknown> {
  return await loadSdk().search({ key: params.keywords, limit: params.limit, page: params.page ?? 1 })
}

export async function requestPlay(params: {
  songmid: string
  quality: QqFormat
  mediaMid: string
  cookie: string
}): Promise<unknown> {
  return await loadSdk().getPlayUrl({
    songmid: params.songmid,
    quality: params.quality,
    // `raw` keeps `midurlinfo` (and therefore `result`) in the response; the
    // default `play` mode throws it away. See `playInfoOf`.
    resType: 'raw',
    mediaId: params.mediaMid,
    cookie: params.cookie
  })
}

export async function requestLyric(params: {
  songmid: string
  /** Used only when the mid is unknown; the lyric route accepts either. */
  songid: string
  cookie: string
}): Promise<unknown> {
  // `isFormat` stays off so upstream hands back the LRC text itself rather than
  // a parsed line array, which is what the renderer's lyric parser expects.
  return await loadSdk().lyric({
    songmid: params.songmid,
    songid: params.songid,
    cookie: params.cookie
  })
}

export async function requestLoginQr(): Promise<unknown> {
  return await loadSdk().getQQLoginQr()
}

export async function requestLoginQrCheck(params: {
  ptqrtoken: string
  qrsig: string
}): Promise<unknown> {
  return await loadSdk().checkQQLoginQr({ ptqrtoken: params.ptqrtoken, qrsig: params.qrsig })
}

export async function requestAccount(params: { uin: string; cookie: string }): Promise<unknown> {
  return await loadServices().getUserDetail({ uin: params.uin, cookie: params.cookie })
}

export async function requestVipInfo(params: { cookie: string }): Promise<unknown> {
  return await loadServices().getVipInfo({ cookie: params.cookie })
}
