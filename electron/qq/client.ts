import {
  mergeTranslation,
  normalizeLyrics,
  normalizeQr,
  normalizeSearch,
  readAccountProbe,
  readQrCheck,
  readVipProbe
} from './normalize'
import { classifyStreamFailure, describeFailure } from './reasons'
import type { QqFailureReason } from './reasons'
import { clearSession, hasSession, readState, writeState } from './session'
import {
  TIER_FORMATS,
  cookieValue,
  loadSdk,
  playInfoOf,
  requestAccount,
  requestLoginQr,
  requestLoginQrCheck,
  requestLyric,
  requestPlay,
  requestSearch,
  requestVipInfo,
  tierLadder,
  uinDigits
} from './transport'
import type {
  QqAccount,
  QqQuality,
  QqQrResult,
  QqQrSession,
  QqSearchResult,
  QqStatusResult,
  QqStreamResult
} from './types'

/**
 * The QQ Music client.
 *
 * Three things shape this file.
 *
 * 1. **The upstream package is loaded lazily.** It is a koa application with its
 *    whole route table and axios behind it, so `require`-ing it at import time
 *    would put that cost in front of Aurora's first window. It is loaded on the
 *    first real call (see `transport.loadSdk`) and never at module load.
 *
 * 2. **Nothing throws at the renderer.** Every exported method answers with the
 *    contract's shape; a transport failure becomes a classified reason. A
 *    rejected `invoke` surfaces in page code as an unhandled rejection in the
 *    middle of a render, which for a player means a blank view.
 *
 * 3. **A refusal is a first-class answer.** Mainstream QQ tracks are paywalled,
 *    so "no address, and here is why" is the *normal* path, not an error path.
 *    It is produced by the tier ladder plus `reasons.ts`, and it is the only
 *    place a membership limit is ever claimed.
 */

/**
 * Which profile's account the next call belongs to.
 *
 * Set by `qq:setProfile` before the renderer asks for anything, because the
 * session cookie, the account and the quality preference are all per profile.
 * Without it every profile would share one account - the same bug
 * `electron/netease/client.ts` documents at length.
 */
let activeProfileId = 'default'

/**
 * Ids seen in this session, so a numeric id can be played.
 *
 * QQ's play route is built from `songmid`: handing it the numeric `songid`
 * answers `result: 101404` with no address (verified live), so a numeric id
 * cannot be played on its own. The renderer's shared song shape is numeric
 * (`src/features/online/normalize.ts`), so every search records the mapping and
 * this is what recovers the mid.
 *
 * The cache is bounded and in-memory: a catalogue that outlives the process can
 * still be played when the renderer passes the mid, which is what `QqSong.mid`
 * is for.
 */
const songIndex = new Map<number, { songmid: string; mediaMid: string; paid: boolean }>()
const SONG_INDEX_LIMIT = 4000

/** How long a membership answer is trusted before it is asked again. */
const VIP_TTL_MS = 10 * 60 * 1000

export function setActiveProfile(profileId: string): boolean {
  const next = String(profileId ?? '').trim() || 'default'
  if (next !== activeProfileId) {
    // Nothing is cached across a switch: the quality, the cookie and the
    // account all belong to the profile that was active when they were read.
    activeProfileId = next
  }
  return true
}

export function activeProfile(): string {
  return activeProfileId
}

export function profileHasSession(profileId: string): boolean {
  return hasSession(profileId)
}

// --- status -------------------------------------------------------------

/** Whether the upstream dependency can be loaded at all. */
let loadDetail = ''

function ensureLoaded(): boolean {
  try {
    loadSdk()
    loadDetail = ''
    return true
  } catch (error) {
    loadDetail = error instanceof Error ? error.message : String(error)
    return false
  }
}

export async function qqStatus(): Promise<QqStatusResult> {
  const ready = ensureLoaded()
  const loggedIn = ready && hasSession(activeProfileId)
  const detail = ready ? '' : `QQ 音乐接口不可用：${loadDetail}`
  return detail ? { ready, loggedIn, detail } : { ready, loggedIn }
}

// --- search -------------------------------------------------------------

export async function qqSearch(
  keywords: string,
  type: 'song' | 'album' | 'artist',
  limit = 50
): Promise<QqSearchResult> {
  ensureLoaded()
  const response = await requestSearch({ keywords, limit })
  const result = normalizeSearch(response, limit)

  for (const song of result.songs) {
    remember(song.id, song.songmid, song.mediaMid, song.paid)
  }
  // `type` cannot change the upstream query: the service ignores `remoteplace`
  // and always answers one song list plus one "did you mean" block. The
  // parameter is accepted because the contract has it; the sections are the
  // same for every value. See `normalize.normalizeSearch`.
  void type
  return result
}

function remember(songId: number, songmid: string, mediaMid: string, paid: boolean): void {
  if (!songId || !songmid) return
  if (songIndex.size >= SONG_INDEX_LIMIT) {
    const oldest = songIndex.keys().next()
    if (!oldest.done) songIndex.delete(oldest.value)
  }
  songIndex.set(songId, { songmid, mediaMid, paid })
}

/**
 * Recover the `songmid` for whatever the renderer passes.
 *
 * A mid is used as-is; a numeric id is looked up in what this session has seen.
 * Returning '' means "cannot play this", which is answered with an honest
 * message rather than a request that upstream will refuse for the wrong reason.
 */
function resolveSongmid(songId: string | number): string {
  if (typeof songId === 'string' && songId && !/^\d+$/.test(songId)) return songId
  const numeric = typeof songId === 'number' ? songId : Number(songId)
  if (!Number.isFinite(numeric)) return ''
  return songIndex.get(numeric)?.songmid ?? ''
}

// --- playback -----------------------------------------------------------

/**
 * Resolve a playable address.
 *
 * The ladder is the whole point: upstream refuses a tier it will not serve with
 * an empty `purl` and no error, so a request for the default `exhigh` on a
 * signed-out machine is refused even for a free track (verified live: 320k and
 * FLAC answer `result: 104003` while 128k succeeds). Walking down to the free
 * tier is what makes QQ playable at all; the refusal is only reported once the
 * last tier is refused too, which is also when it becomes true that the *track*
 * is restricted rather than the tier.
 */
export async function qqStreamUrl(
  songId: string | number,
  quality?: QqQuality
): Promise<QqStreamResult> {
  const state = readState(activeProfileId)
  const requested = quality ?? state.quality
  const songmid = resolveSongmid(songId)
  if (!songmid) {
    return {
      ok: false,
      reason: 'unknown',
      message: '无法确定这首歌的 QQ 音乐编号，请重新搜索后再播放'
    }
  }

  const known = songIndex.get(typeof songId === 'number' ? songId : Number(songId))
  const mediaMid = known?.mediaMid ?? ''
  const paidHint = known?.paid ?? false
  const loggedIn = state.cookie.length > 0

  let lastReason: QqFailureReason | null = null
  let lastMessage = ''

  for (const tier of tierLadder(requested)) {
    const format = TIER_FORMATS[tier]
    let info
    try {
      info = playInfoOf(
        await requestPlay({ songmid, quality: format.format, mediaMid, cookie: state.cookie })
      )
    } catch (error) {
      // A transport failure is not a tier problem, so walking further down
      // would just repeat the same failure three times.
      const reason = classifyStreamFailure({ error })
      return { ok: false, reason, message: describeFailure(reason) }
    }

    if (info.url) {
      return {
        ok: true,
        url: info.url,
        quality: requested,
        // The tier actually delivered, not the one asked for.
        level: tier,
        br: format.bitrate,
        lossless: format.lossless,
        trial: false
      }
    }

    const reason = classifyStreamFailure({
      code: info.envelopeCode ?? info.requestCode,
      result: info.result,
      purl: info.purl,
      paidHint,
      loggedIn
    })
    lastReason = reason
    lastMessage = describeFailure(reason)
  }

  return {
    ok: false,
    reason: lastReason ?? 'unknown',
    message: lastMessage || describeFailure('unknown')
  }
}

// --- lyrics -------------------------------------------------------------

/**
 * Lyrics, with the translation already merged.
 *
 * The bridge hands the renderer one string (`src/features/online/qq-provider.ts`
 * says so explicitly: "The client returns finished LRC text, translation already
 * merged"), because the lyric view highlights one line per timestamp and two
 * documents would never line up.
 */
export async function qqLyrics(songId: string | number): Promise<string | null> {
  const state = readState(activeProfileId)
  const songmid = resolveSongmid(songId)
  const numeric = typeof songId === 'number' ? songId : Number(songId)

  try {
    const response = await requestLyric({
      // The lyric route accepts either identifier, unlike the play route.
      songmid,
      songid: songmid ? '' : Number.isFinite(numeric) ? String(numeric) : '',
      cookie: state.cookie
    })
    const payload = normalizeLyrics(response)
    if (!payload) return null
    return mergeTranslation(payload.lrc, payload.translation)
  } catch (error) {
    console.error('[aurora] qq lyric lookup failed', error instanceof Error ? error.message : error)
    return null
  }
}

// --- login --------------------------------------------------------------

/**
 * The pending QR code, keyed by an opaque token.
 *
 * The renderer only ever sees `key`, so the `ptqrtoken`/`qrsig` pair the poll
 * needs never has to survive a round trip through the page. One login at a time
 * is all the interface can start, so this is a single slot rather than a map.
 */
let pendingQr: { key: string; ptqrtoken: string; qrsig: string; at: number } | null = null
const QR_TTL_MS = 5 * 60 * 1000

export async function qqQrCreate(): Promise<QqQrSession> {
  ensureLoaded()
  const response = await requestLoginQr()
  const qr = normalizeQr(response)
  if (!qr) return { key: '', imageDataUrl: '' }

  const key = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  pendingQr = { key, ptqrtoken: qr.ptqrtoken, qrsig: qr.qrsig, at: Date.now() }
  return { key, imageDataUrl: qr.imageDataUrl }
}

export async function qqQrCheck(key: string): Promise<QqQrResult> {
  const pending = pendingQr
  if (!pending || pending.key !== key) {
    // A key this process never issued, or one from a previous run.
    return { status: 'expired', message: '二维码已失效，请重新获取' }
  }
  if (Date.now() - pending.at > QR_TTL_MS) {
    pendingQr = null
    return { status: 'expired', message: '二维码已过期，请重新获取' }
  }

  const checked = readQrCheck(await requestLoginQrCheck(pending))
  if (checked.confirmed) {
    pendingQr = null
    const cookie = checked.session?.cookie ?? ''
    const uin = checked.session?.uin ?? cookieValue(cookie, 'uin', 'qqmusic_uin')
    writeState(activeProfileId, {
      cookie,
      uin: uinDigits(uin),
      euin: checked.session?.euin ?? '',
      // A fresh login invalidates any membership answer from the previous one.
      vip: null,
      vipCheckedAt: 0
    })
    const account = await qqLoginStatus()
    return { status: 'confirmed', account: account ?? undefined }
  }
  if (checked.expired) {
    pendingQr = null
    return { status: 'expired', message: checked.message || '二维码已过期，请重新获取' }
  }
  /*
   * Upstream only reports "logged in", "expired" and "not scanned yet" - there
   * is no separate "scanned, waiting for the phone" state - so `scanned` is
   * never produced for QQ. The message upstream sent is passed through so the
   * interface can still say something specific.
   */
  return { status: 'waiting', message: checked.message }
}

/**
 * Who this profile is signed in as.
 *
 * Three outcomes, and keeping them apart is the point:
 *  - upstream answers a profile        -> that account, merged into the session
 *  - upstream answers "not signed in"  -> null, but the cookie is *kept*. Only
 *    `logout()` forgets a credential; a rejected probe is not proof the user
 *    wants to be signed out, and deleting on a bad probe would log people out
 *    over a network blip.
 *  - the probe fails for any other reason -> whatever was already known, so a
 *    blip cannot make the account disappear.
 */
export async function qqLoginStatus(): Promise<QqAccount | null> {
  return await accountOf(activeProfileId)
}

async function accountOf(profileId: string): Promise<QqAccount | null> {
  const state = readState(profileId)
  if (!state.cookie) return null

  const stored = accountFrom(state)
  const uin = state.uin || uinDigits(cookieValue(state.cookie, 'uin', 'qqmusic_uin'))
  if (!uin) return stored

  try {
    const probe = readAccountProbe(await requestAccount({ uin, cookie: state.cookie }))
    if (!probe.authenticated) return null

    const patch: Parameters<typeof writeState>[1] = {
      nickname: probe.nickname || state.nickname,
      avatarUrl: probe.avatarUrl ?? state.avatarUrl,
      uin
    }
    if (probe.level !== null) patch.level = probe.level

    // The membership answer is asked separately and merged only when it really
    // answered: a failed probe must never overwrite the last known value.
    const vip = await membershipOf(state.cookie, state.vip, state.vipCheckedAt)
    if (vip.vip !== null) {
      patch.vip = vip.vip
      patch.vipCheckedAt = vip.checkedAt
    }

    const next = writeState(profileId, patch)
    return accountFrom(next)
  } catch (error) {
    console.error(
      '[aurora] qq account probe failed, keeping the stored account',
      error instanceof Error ? error.message : error
    )
    return stored
  }
}

/**
 * The membership flag, with a grace window.
 *
 * Mineradio's lesson, applied: a membership check that fails must not be cached,
 * because caching "not a member" turns one bad request into a paying user being
 * told their membership lapsed. So the answer is only *written* when upstream
 * actually answered, and a successful answer is believed for ten minutes before
 * it is asked again.
 */
async function membershipOf(
  cookie: string,
  previous: boolean | null,
  checkedAt: number
): Promise<{ vip: boolean | null; checkedAt: number }> {
  if (previous !== null && Date.now() - checkedAt < VIP_TTL_MS) {
    return { vip: previous, checkedAt }
  }
  try {
    const probe = readVipProbe(await requestVipInfo({ cookie }))
    // `answered` is what keeps a blip from becoming an answer: the endpoint is
    // a public configuration blob that answers `code: 0` even to a bogus
    // cookie, so only its own request code decides whether it spoke.
    if (!probe.answered || probe.vip === null) return { vip: previous, checkedAt }
    return { vip: probe.vip, checkedAt: Date.now() }
  } catch {
    return { vip: previous, checkedAt }
  }
}

/** The account a *specific* profile is signed in as, for the profiles screen. */
export async function qqAccountFor(profileId: string): Promise<QqAccount | null> {
  const previous = activeProfileId
  try {
    setActiveProfile(profileId)
    return await accountOf(activeProfileId)
  } finally {
    activeProfileId = previous
  }
}

export async function qqLogout(): Promise<boolean> {
  clearSession(activeProfileId)
  // A pending QR belongs to the account that was just signed out.
  pendingQr = null
  return true
}

/** Sign a specific profile out without disturbing the active one. */
export function qqLogoutProfile(profileId: string): boolean {
  clearSession(profileId)
  if (profileId === activeProfileId) pendingQr = null
  return true
}

// --- quality ------------------------------------------------------------

export function qqGetQuality(): QqQuality {
  return readState(activeProfileId).quality
}

export function qqSetQuality(quality: QqQuality): QqQuality {
  return writeState(activeProfileId, { quality }).quality
}

// --- helpers ------------------------------------------------------------

function accountFrom(state: {
  uin: string
  nickname: string
  avatarUrl: string | null
  vip: boolean | null
  level: number
}): QqAccount {
  return {
    id: Number(uinDigits(state.uin)) || 0,
    nickname: state.nickname || 'QQ 音乐用户',
    avatarUrl: state.avatarUrl,
    vip: state.vip,
    level: state.level
  }
}