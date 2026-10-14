import type { QqArtist, QqSearchResult, QqSong } from './types'

/**
 * QQ upstream responses -> Aurora's shapes. Pure functions, no Electron, no
 * network, no imports at runtime.
 *
 * The field names here were all read off live responses rather than guessed:
 * search returns `body.response.data.song.list[]`, the "did you mean" block is
 * `body.response.data.zhida`, lyrics are `body.response.{lyric,trans}`, and the
 * login QR is `body.{img,ptqrtoken,qrsig}`. Upstream also spells things more
 * than one way (`payplay` in search, `pay_play` elsewhere; `media_mid` and
 * `strMediaMid`), so every reader accepts the alternatives it has actually
 * seen. That tolerance is deliberate - a renamed field should cost one empty
 * line, not a blank screen.
 *
 * Self-contained on purpose: a shared helper module would be a relative runtime
 * import, which Node's ESM resolver rejects without a file extension and `tsc`
 * rejects with one. Each pure module therefore carries its own readers, the
 * same way Folia's per-platform files do.
 */

// --- cover art ----------------------------------------------------------

const ALBUM_COVER_BASE = 'https://y.gtimg.cn/music/photo_new/T002R300x300M000'
/** Singer avatars are the same photo_new rule behind a `T001` prefix. */
const SINGER_AVATAR_BASE = 'https://y.gtimg.cn/music/photo_new/T001R300x300M000'

/**
 * Album art is built from the album mid, not from a URL upstream sends -
 * verified against the live service, and the same rule the classic QQ lyric
 * search has always used. `y.gtimg.cn` sends no CORS header, so this URL is
 * always reached through the `aurora-remote:` proxy.
 */
export function albumCoverUrl(albumMid: unknown): string | null {
  const mid = text(albumMid)
  return mid ? `${ALBUM_COVER_BASE}${mid}.jpg` : null
}

export function singerAvatarUrl(singerMid: unknown): string | null {
  const mid = text(singerMid)
  return mid ? `${SINGER_AVATAR_BASE}${mid}.jpg` : null
}

// --- songs --------------------------------------------------------------

/**
 * One upstream song -> `QqSong`.
 *
 * Returns null when there is no `songmid`: without it the track has no playback
 * identity at all, so it would be a row that can never play.
 */
export function normalizeSong(raw: unknown): QqSong | null {
  const song = record(raw)
  const songmid = text(pick(song, 'songmid', 'mid', 'songMid'))
  if (!songmid) return null

  const songId = integer(pick(song, 'songid', 'songId', 'id'))
  const mediaMid = text(
    pick(song, 'media_mid', 'mediaMid', 'strMediaMid') ??
      pick(record(song.file), 'media_mid', 'mediaMid')
  )
  const album = record(song.album)
  const albumMid = text(
    pick(album, 'mid', 'albummid', 'albumMid', 'albumMID') ??
      pick(song, 'albummid', 'albumMid', 'albumMID')
  )
  const paid = isPaid(song)

  return {
    id: songId,
    songId,
    songmid,
    mid: songmid,
    mediaMid,
    name: text(pick(song, 'songname', 'name', 'title')) || '未知歌曲',
    artists: normalizeArtists(song),
    album: {
      id: integer(pick(album, 'id', 'albumid', 'albumID') ?? pick(song, 'albumid', 'albumID')),
      mid: albumMid,
      name: text(pick(album, 'name', 'albumname', 'title') ?? pick(song, 'albumname', 'albumName')),
      picUrl: text(pick(album, 'picUrl', 'coverUrl', 'albumPic') ?? pick(song, 'albumPic', 'pic')) || albumCoverUrl(albumMid)
    },
    // The search endpoint reports whole seconds in `interval`; nothing in this
    // client's responses is in milliseconds, so no magnitude guessing is needed.
    duration: numberOrZero(pick(song, 'interval', 'duration')),
    fee: paid ? 1 : 0,
    paid
  }
}

/**
 * The catalogue's payment hint.
 *
 * Both spellings are in the wild - the search response uses `pay.payplay`, the
 * play response's older shape uses `pay_play`. This is a hint for the list UI
 * only; `reasons.ts` treats it as a tiebreaker and the vkey exchange as the
 * verdict.
 */
function isPaid(song: Record<string, unknown>): boolean {
  const pay = record(song.pay)
  const flag =
    pick(pay, 'payplay', 'payPlay', 'pay_play') ?? pick(song, 'pay_play', 'payplay', 'payPlay')
  return numberOrZero(flag) === 1
}

function normalizeArtists(song: Record<string, unknown>): QqArtist[] {
  const singers = Array.isArray(song.singer)
    ? song.singer
    : Array.isArray(song.singers)
      ? song.singers
      : Array.isArray(song.artists)
        ? song.artists
        : []
  return singers
    .map((entry) => {
      const singer = record(entry)
      return {
        id: integer(pick(singer, 'id', 'singerID')),
        mid: text(pick(singer, 'mid', 'singerMID', 'singermid', 'singerMid')),
        name: text(pick(singer, 'name', 'singerName', 'singername', 'title'))
      }
    })
    .filter((artist) => artist.name.length > 0)
}

// --- search -------------------------------------------------------------

/**
 * The search response -> the three sections the interface shows.
 *
 * A limitation worth stating plainly: **upstream has no album or artist
 * search.** The package's `search()` sends `remoteplace`, and the live service
 * ignores it - every value returns the same song list plus one `zhida` block
 * whose shape depends on the query (a singer for "周杰伦", an album for
 * "叶惠美"). So:
 *
 *  - `songs` is the real song result;
 *  - `artists` is the single artist upstream matched, when it matched one;
 *  - `albums` is that artist's hot albums, or the single matched album.
 *
 * That is everything the upstream will give, and it is honest: the interface
 * shows a short list rather than an empty screen pretending to be a search.
 */
export function normalizeSearch(response: unknown, limit = 50): QqSearchResult {
  const data = record(record(record(response).body).response).data
  const payload = Object.keys(record(data)).length > 0 ? record(data) : record(response)

  const songs = list(record(payload.song).list)
    .map(normalizeSong)
    .filter((song): song is QqSong => song !== null)
    .slice(0, Math.max(0, limit))

  const zhida = record(payload.zhida)
  const singer = record(zhida.zhida_singer)
  const matchedAlbum = record(zhida.zhida_album)

  const artists: QqSearchResult['artists'] = []
  if (text(singer.singerMID) || text(singer.singerName)) {
    const mid = text(singer.singerMID)
    artists.push({
      id: integer(singer.singerID),
      name: text(singer.singerName) || '未知艺术家',
      picUrl: text(singer.singerPic) || singerAvatarUrl(mid),
      albumCount: integer(singer.albumNum)
    })
  }

  const albums: QqSearchResult['albums'] = []
  const pushAlbum = (
    entry: Record<string, unknown>,
    options: { artist: string; year: number | null; songCount: number }
  ): void => {
    const mid = text(pick(entry, 'albumMID', 'albummid', 'albumMid', 'mid'))
    const id = integer(pick(entry, 'albumID', 'albumid', 'id'))
    const name = text(pick(entry, 'albumName', 'albumname', 'name', 'title'))
    if (!mid && !id && !name) return
    albums.push({
      id,
      name: name || '未知专辑',
      artist: options.artist,
      picUrl: text(pick(entry, 'albumPic', 'picUrl', 'pic')) || albumCoverUrl(mid),
      year: options.year,
      songCount: options.songCount
    })
  }

  if (text(matchedAlbum.albumMID) || text(matchedAlbum.albumName)) {
    pushAlbum(matchedAlbum, {
      artist: text(matchedAlbum.singerName),
      year: yearOf(matchedAlbum.publicTime),
      songCount: integer(matchedAlbum.songNum)
    })
  }
  // The matched artist's hot albums: the closest thing to an album result the
  // upstream offers. They carry no date or track count, so both stay "unknown"
  // rather than being invented.
  for (const entry of list(singer.hotalbum)) {
    pushAlbum(record(entry), { artist: text(singer.singerName), year: null, songCount: 0 })
  }

  return { songs, artists, albums }
}

// --- lyrics -------------------------------------------------------------

/**
 * The lyric payload -> raw LRC text.
 *
 * The modern `PlayLyricInfo` route (the one the package uses) already decodes
 * the base64 body for us and needs no `Referer`, unlike the classic fcg route
 * that answers `code: -1310` with an empty lyric without one. Verified live:
 * `body.response` comes back as `{retcode, code, lyric, trans}` with plain LRC.
 */
export function normalizeLyrics(response: unknown): { lrc: string | null; translation: string | null } | null {
  const payload = record(record(record(response).body).response)
  const code = numberOrZero(payload.retcode ?? payload.code)
  // 1101 is "no such song"; anything else non-zero is equally not a lyric.
  if (code !== 0) return null

  const lrc = text(payload.lyric) || null
  const translation = text(payload.trans) || null
  if (!lrc && !translation) return null
  return { lrc, translation }
}

const TIME = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g

interface ParsedLine {
  /** Hundredths of a second, so the key is exact and comparable. */
  at: number
  text: string
  /** Tags like `[ti:...]` have no time and are kept as-is. */
  tag: boolean
}

function parseLrc(lrc: string): ParsedLine[] {
  const lines: ParsedLine[] = []
  for (const raw of lrc.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue

    const stamps: number[] = []
    TIME.lastIndex = 0
    let match = TIME.exec(line)
    while (match) {
      const frac = match[3] ? Number(match[3].padEnd(3, '0')) : 0
      stamps.push(Number(match[1]) * 6000 + Number(match[2]) * 100 + Math.round(frac / 10))
      match = TIME.exec(line)
    }

    const body = line.replace(TIME, '').trim()
    if (stamps.length === 0) {
      if (body) lines.push({ at: -1, text: body, tag: true })
      continue
    }
    for (const at of stamps) lines.push({ at, text: body, tag: false })
  }
  return lines
}

function stampOf(hundredths: number): string {
  const min = Math.floor(hundredths / 6000)
  const sec = Math.floor((hundredths % 6000) / 100)
  const frac = hundredths % 100
  return `[${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(frac).padStart(2, '0')}]`
}

/**
 * Merge a translation into the original lyric.
 *
 * The player highlights one line per timestamp, so two documents for one song
 * would mean the translation never lines up with the singing; the merge is done
 * here because the QQ bridge hands the renderer a single finished string.
 *
 * This is the same algorithm as `src/features/netease/lrc.ts` (which does the
 * job for Netease on the renderer side, where the client returns the two
 * documents separately). It is duplicated rather than shared because the main
 * process cannot import from `src/`; the convention it produces -
 * `original / translation` on one line - is the one the lyric view renders.
 */
export function mergeTranslation(lrc: string | null, translation: string | null): string | null {
  if (!lrc && !translation) return null
  if (!translation) return lrc
  if (!lrc) return translation

  const original = parseLrc(lrc)
  const translated = new Map<number, string>()
  for (const line of parseLrc(translation)) {
    if (line.tag || !line.text) continue
    translated.set(line.at, line.text)
  }

  const merged: { at: number; text: string }[] = []
  const used = new Set<number>()
  for (const line of original) {
    if (line.tag) {
      merged.push({ at: line.at, text: line.text })
      continue
    }
    const other = translated.get(line.at)
    used.add(line.at)
    const text = !other || other === line.text ? line.text : `${line.text} / ${other}`
    merged.push({ at: line.at, text: `${stampOf(line.at)}${text}` })
  }

  // Translation lines with no original at the same timestamp are appended
  // rather than dropped: the two documents are generated separately and a few
  // lines genuinely differ by a hundredth of a second.
  for (const [at, text] of translated) {
    if (used.has(at) || at < 0) continue
    merged.push({ at, text: `${stampOf(at)}${text}` })
  }

  merged.sort((a, b) => a.at - b.at)
  return merged.map((line) => line.text).join('\n')
}

// --- account, membership, login -----------------------------------------

/**
 * The signed-out code.
 *
 * Verified live: `getUserDetail` answers `response.code: 1000` for a bogus
 * cookie, for a cookie with no key, and for no cookie at all. It is the one
 * code that reliably means "sign in", which is why `reasons.ts` maps it to
 * `login-required` and the client treats it as the only logout signal.
 */
export const UNAUTHENTICATED_CODE = 1000

export interface AccountProbe {
  /** False when upstream said "not signed in" rather than "here is the account". */
  authenticated: boolean
  nickname: string
  avatarUrl: string | null
  level: number | null
}

export function readAccountProbe(response: unknown): AccountProbe {
  const payload = record(record(record(response).body).response)
  const code = numberOrZero(payload.code ?? payload.subcode)
  if (code === UNAUTHENTICATED_CODE) {
    return { authenticated: false, nickname: '', avatarUrl: null, level: null }
  }

  const data = record(payload.data)
  // The profile has been seen under both `data` and the payload itself.
  const profile = Object.keys(record(data.profile)).length > 0 ? record(data.profile) : data
  return {
    authenticated: code === 0,
    nickname: text(pick(profile, 'nickname', 'nick', 'name', 'userName')),
    // The avatar is a complete URL upstream; the field is `logo` in some
    // payloads and `avatarUrl` in others.
    avatarUrl: text(pick(profile, 'avatarUrl', 'logo', 'headpic')) || null,
    level: integerOrNull(pick(profile, 'level', 'vipLevel', 'musicLevel'))
  }
}

/** Keys that have historically carried a membership flag, best first. */
const VIP_KEYS = [
  'vip',
  'isVip',
  'isVIP',
  'vipType',
  'vip_type',
  'svip',
  'memberType',
  'member_type',
  'membership',
  'green',
  'luxury'
]

/** Fallback for a renamed key, in the spirit of Mineradio's deep probe. */
const VIP_KEY_PATTERN = /vip|member|membership|green|luxury|associator/i

/**
 * Whether the payload says this account is a member, or `null` when it does not
 * say.
 *
 * Two passes: the known key names first, then a bounded walk looking for any
 * key that *looks* like a membership flag. The second pass exists because
 * upstream renames fields, and the failure mode of a single-key check is
 * silent - the account simply stops looking like a member.
 *
 * `null` is a real answer and must not be turned into `false`: the caller keeps
 * the previous value instead, so a network blip cannot tell a paying user their
 * membership lapsed.
 */
export function findMembershipFlag(payload: unknown, maxDepth = 6): boolean | null {
  const direct = directMembershipFlag(payload)
  if (direct !== null) return direct
  return scanMembershipFlag(payload, maxDepth, 0)
}

function directMembershipFlag(payload: unknown): boolean | null {
  const root = record(payload)
  const candidates: Record<string, unknown>[] = [root]
  // The membership fields have been seen one and two levels down, under
  // `identity` and under the musicu envelope's `req_1.data`.
  for (const container of [record(root.data), record(record(root.data).identity), record(root.identity)]) {
    if (Object.keys(container).length > 0) candidates.push(container)
  }
  for (const candidate of candidates) {
    for (const key of VIP_KEYS) {
      if (!(key in candidate)) continue
      const verdict = asFlag(candidate[key])
      if (verdict !== null) return verdict
    }
  }
  return null
}

function scanMembershipFlag(value: unknown, maxDepth: number, depth: number): boolean | null {
  if (depth > maxDepth) return null
  if (Array.isArray(value)) {
    for (const entry of value) {
      const verdict = scanMembershipFlag(entry, maxDepth, depth + 1)
      if (verdict !== null) return verdict
    }
    return null
  }
  if (!value || typeof value !== 'object') return null

  let sawNegative = false
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (VIP_KEY_PATTERN.test(key)) {
      const verdict = asFlag(entry)
      if (verdict === true) return true
      if (verdict === false) sawNegative = true
    }
    const nested = scanMembershipFlag(entry, maxDepth, depth + 1)
    if (nested === true) return true
    if (nested === false) sawNegative = true
  }
  return sawNegative ? false : null
}

/** `true`/`1`/`"1"` -> member, `false`/`0`/`"0"` -> not, anything else -> no answer. */
function asFlag(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    return value > 0
  }
  if (typeof value === 'string') {
    const trimmed = value.trim().toLowerCase()
    if (trimmed === 'true' || trimmed === '1') return true
    if (trimmed === 'false' || trimmed === '0' || trimmed === '') return false
  }
  return null
}

export interface VipProbe {
  /** Whether upstream actually answered the membership question. */
  answered: boolean
  vip: boolean | null
  level: number | null
}

/**
 * Read the membership endpoint.
 *
 * The endpoint answers `code: 0` even to a bogus cookie (verified live) - it is
 * a public configuration blob - so a successful response is *not* evidence that
 * the session is alive. The caller only trusts it while signed in, and only
 * writes `vip` when `answered` is true.
 */
export function readVipProbe(response: unknown): VipProbe {
  const body = record(record(response).body)
  const payload = Object.keys(record(body.response)).length > 0 ? record(body.response) : body
  const request = record(payload.req_1)
  const answered = numberOrZero(request.code ?? payload.code) === 0
  if (!answered) return { answered: false, vip: null, level: null }

  const data = record(request.data)
  const identity = record(data.identity)
  return {
    answered: true,
    vip: findMembershipFlag({ identity, data }),
    level: integerOrNull(pick(identity, 'level', 'vipLevel'))
  }
}

/**
 * The QR payload -> what the renderer displays and what polling needs.
 *
 * `img` arrives as a complete `data:image/png;base64,…` URL (verified live,
 * HTTP 200 with a real PNG), so it can go straight into an `<img src>`.
 */
export function normalizeQr(response: unknown): {
  ptqrtoken: string
  qrsig: string
  imageDataUrl: string
} | null {
  const body = record(record(response).body)
  const qrsig = text(body.qrsig)
  const ptqrtoken = text(body.ptqrtoken)
  const imageDataUrl = text(pick(body, 'img', 'image', 'qrimg'))
  if (!qrsig || !ptqrtoken) return null
  return { ptqrtoken, qrsig, imageDataUrl }
}

export interface QrCheck {
  confirmed: boolean
  /** Upstream said the code expired and a new one is needed. */
  expired: boolean
  message: string
  session: { cookie: string; uin: string; euin: string } | null
}

/**
 * The QR poll result.
 *
 * On success the package hands back a finished session: the full cookie string
 * (carrying `uin` and `qqmusic_key`) plus the encrypted uin. The three states it
 * can report are "logged in", "expired" and "not scanned yet"; it has no
 * separate "scanned, waiting for confirmation" state, which is why the bridge
 * never reports `scanned` for QQ.
 */
export function readQrCheck(response: unknown): QrCheck {
  const body = record(record(response).body)
  const session = record(body.session)
  const confirmed = body.isOk === true
  if (!confirmed) {
    return {
      confirmed: false,
      expired: body.refresh === true,
      message: text(body.message),
      session: null
    }
  }
  return {
    confirmed: true,
    expired: false,
    message: text(body.message),
    session: {
      cookie: text(pick(session, 'cookie', 'cookieString')),
      uin: text(session.uin) || text(record(session.cookieObject).uin),
      euin: text(session.euin)
    }
  }
}

// --- local readers ------------------------------------------------------

function pick(source: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function numberOrZero(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

function integer(value: unknown): number {
  return Math.trunc(numberOrZero(value))
}

function integerOrNull(value: unknown): number | null {
  const parsed = numberOrZero(value)
  return parsed > 0 ? Math.trunc(parsed) : null
}

function yearOf(value: unknown): number | null {
  const textValue = text(value)
  const match = /\d{4}/.exec(textValue)
  if (!match) return null
  const year = Number(match[0])
  return year >= 1900 && year <= 2200 ? year : null
}
