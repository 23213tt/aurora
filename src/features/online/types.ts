import type { NeteaseFailureReason, NeteaseQuality } from '../../env'

/**
 * The online-platform contract.
 *
 * Modelled on the reference player's `types/onlineMusic.ts`, and kept to the
 * parts Aurora actually has. Three structural decisions are copied from it
 * deliberately, because each one removes a class of `if (provider === ...)` from
 * the UI:
 *
 * 1. **Capabilities are booleans on the provider.** "This platform has no daily
 *    recommendations" is `recommendations: false`, never a branch on which
 *    platform it is. Each capability then owns one optional sub-interface.
 * 2. **A song carries its own source.** `getPlaybackSourceRef(track)` answers
 *    `{ kind: 'online', providerId }` rather than the caller remembering which
 *    screen it came from. That is also what makes a mixed list legible: a row can
 *    say where it came from without the list knowing anything about platforms.
 * 3. **Availability is not an error.** See `ProviderSongAvailability` below.
 *
 * Deliberately *not* copied: the reference's `MediaId`, `JsonValue`,
 * `providerData` escape hatches and its 30-odd collection/lyrics/diagnostic
 * shapes. Aurora has two providers and no plugin system, so those would be
 * speculative generality with a maintenance cost and no caller.
 */

/** A platform's own identifier. String, not a union, so adding one costs no edits here. */
export type ProviderId = string

/**
 * The failure vocabulary, shared by every platform.
 *
 * The union is the known set, and the `string & {}` member is the escape hatch:
 * a platform whose client invents a reason still produces a typeable value, and
 * `failureText` falls back to a generic sentence for it. A closed union would make
 * every such addition a cross-module edit; an open `string` would lose the
 * exhaustiveness that makes the wording table trustworthy.
 */
export type OnlineFailureReason = NeteaseFailureReason | (string & {})

/** Sound quality tiers, in the upstream names Aurora already uses. */
export type QualityTier = NeteaseQuality

/** Worst to best. A provider may support any subset of this order. */
export const QUALITY_TIERS: QualityTier[] = ['standard', 'higher', 'exhigh', 'lossless']

export const QUALITY_LABELS: Record<QualityTier | 'hires', string> = {
  standard: '标准 128k',
  higher: '较高 192k',
  exhigh: '极高 320k',
  lossless: '无损 FLAC',
  hires: 'Hi-Res'
}

/**
 * The least a platform's song has to expose for the shared UI to render and play
 * it. Everything platform-specific stays in the provider's own module: QQ's
 * `songmid`/`mediaMid`, Netease's `fee` subtleties, and so on.
 *
 * The field names are Netease's because they were here first and the main
 * process already normalises QQ into this shape; renaming them would be churn
 * for both sides of the bridge with nothing gained.
 */
export interface OnlineSong {
  id: number
  name: string
  artists: { id: number; name: string }[]
  album: { id: number; name: string; picUrl: string | null }
  /** Seconds. */
  duration: number
  /** Upstream `fee`: 0 free, 1 vip, 4 paid album, 8 low-quality free. */
  fee: number
  /**
   * A platform's string identifier, when it has one.
   *
   * QQ identifies a track by `songmid` while the shared shape is numeric, so the
   * string rides alongside rather than replacing `id`: everything that indexes by
   * song id keeps working, and the platform adapter can still ask its upstream for
   * the track it actually means.
   */
  mid?: string
}

export interface OnlineAlbumRef {
  id: number
  name: string
  artist: string
  picUrl: string | null
  year: number | null
  songCount: number
}

export interface OnlineArtistRef {
  id: number
  name: string
  picUrl: string | null
  albumCount: number
}

export interface OnlineSearchResult {
  songs: OnlineSong[]
  albums: OnlineAlbumRef[]
  artists: OnlineArtistRef[]
}

export type OnlineSearchKind = 'song' | 'album' | 'artist'

export interface OnlineAccount {
  id: number
  nickname: string
  avatarUrl: string | null
  vip: boolean
  level: number
}

export interface OnlineStatus {
  /** The backend answered and can reach the upstream. */
  ready: boolean
  loggedIn: boolean
  detail?: string
}

export interface OnlinePlaylistSummary {
  id: number
  name: string
  coverUrl: string | null
  trackCount: number
  playCount: number
  creator: string
  subscribed: boolean
}

/** A resolved, playable URL. The renderer proxies it; it never fetches upstream. */
export interface OnlineStream {
  /** Upstream http(s) URL. */
  url: string
  /** kbps, or 0 when the platform does not report one. */
  br: number
  /** The tier actually delivered, which may be below the one requested. */
  level: QualityTier | 'hires'
  /** Seconds of what this URL really delivers (a trial is shorter). */
  duration: number
  trial: boolean
  trialFrom?: number
  trialTo?: number
}

export type OnlineStreamResult =
  | { ok: true; stream: OnlineStream }
  | { ok: false; reason: OnlineFailureReason; message?: string }

/**
 * What the user can open inside a platform's screen.
 *
 * A flat list of kinds rather than a per-platform enum: the reference player does
 * the same thing through capability flags, and it is what lets one screen render
 * Netease's four collections and QQ's none without knowing which platform it is
 * looking at.
 */
export type OnlineCollectionKind = 'daily' | 'likes' | 'cloud' | 'playlists'

export interface OnlineCollection {
  kind: OnlineCollectionKind
  label: string
  /** A signed-out visitor is told what signing in would add, rather than shown an error. */
  requiresAccount: boolean
}

export interface ProviderCapabilities {
  search: boolean
  playback: boolean
  lyrics: boolean
  auth: boolean
  playlists: boolean
  albums: boolean
  artists: boolean
  recommendations: boolean
  userCloud: boolean
  likes: boolean
}

/** Where a track's audio comes from. The discriminator the whole layer turns on. */
export type PlaybackSourceRef =
  | { kind: 'online'; providerId: ProviderId; mediaId: string }
  | { kind: 'local'; mediaId: string }

export type SongAvailabilityState = 'playable' | 'unavailable' | 'unknown'
export type SongUnavailableReason = 'taken-down' | 'restricted'

/**
 * Whether a song can be played, as far as the platform can prove without asking.
 *
 * The rule, lifted verbatim from the reference implementation because it is the
 * one that keeps "this is gone" from being confused with "you may not be allowed
 * to play this":
 *
 * > `state 'unavailable'` only ever pairs with `'taken-down'`. Permission, payment
 * > and region limits are `state 'unknown'` + `reason 'restricted'`, left for the
 * > runtime to decide. A runtime failure is never written back here.
 *
 * Concretely: QQ's VIP tracks (upstream `result=104003`) are `unknown` /
 * `restricted`, **not** `unavailable`, and not an error. The interface says the
 * tier needs a membership when the *request* comes back saying so - the one place
 * that knows.
 */
export interface ProviderSongAvailability {
  state: SongAvailabilityState
  label?: string
  reason?: SongUnavailableReason
}

export function playable(): ProviderSongAvailability {
  return { state: 'playable' }
}

export function unknownAvailability(label?: string): ProviderSongAvailability {
  return label ? { state: 'unknown', reason: 'restricted', label } : { state: 'unknown', reason: 'restricted' }
}

/** The only sanctioned way to say a song is gone. */
export function takenDown(label?: string): ProviderSongAvailability {
  return label ? { state: 'unavailable', reason: 'taken-down', label } : { state: 'unavailable', reason: 'taken-down' }
}

export interface ProviderSearchApi {
  search(keywords: string, kind: OnlineSearchKind, limit?: number): Promise<OnlineSearchResult>
  /** Fetch one song's full record, for a row that arrived from somewhere else. */
  songDetail?(ids: number[]): Promise<OnlineSong[]>
}

export interface ProviderPlaybackApi {
  streamUrl(songId: number, quality?: QualityTier): Promise<OnlineStreamResult>
  /** Proves a song is gone, when the platform can. Absent means "unknown", never "gone". */
  getAvailability?(song: OnlineSong): ProviderSongAvailability
}

export interface ProviderLyricsApi {
  /** Raw LRC, translation already merged when the platform supplies one. */
  lyrics(songId: number): Promise<string | null>
}

export interface ProviderAuthApi {
  loginStatus(): Promise<OnlineAccount | null>
  logout(): Promise<void>
  /** Which account a given profile is signed in as, for the profiles screen. */
  accountFor?(profileId: string): Promise<OnlineAccount | null>
  logoutProfile?(profileId: string): Promise<boolean>
}

export interface ProviderCatalogApi {
  album(id: number): Promise<{ id: number; name: string; coverUrl: string | null; songs: OnlineSong[] } | null>
  artistTopSongs(id: number, limit?: number): Promise<OnlineSong[]>
  playlistTracks(id: number): Promise<OnlineSong[]>
  myPlaylists?(): Promise<OnlinePlaylistSummary[]>
}

export interface ProviderRecommendationsApi {
  dailySongs?(): Promise<OnlineSong[]>
  likeList?(): Promise<OnlineSong[]>
  cloudSongs?(): Promise<OnlineSong[]>
}

export interface OnlineMusicProvider {
  id: ProviderId
  displayName: string
  shortName?: string
  /** One line for the sources screen; says what the platform is, not what it costs. */
  summary: string
  /**
   * The honest description of how this platform is reached. Only Netease and QQ
   * exist and both are third-party reverse interfaces, so it is a field rather
   * than a per-platform disclosure buried in a view.
   */
  disclosure: string
  /**
   * What actually works without signing in, in the platform's own words.
   *
   * A field rather than one shared sentence, because the platforms genuinely
   * differ and the shared sentence was wrong for one of them: Netease plays free
   * tracks in full and hands out trial fragments of paid ones, while QQ was
   * measured at only 18.4% playable signed out (free tracks, 128 kbps) - every
   * `payplay === 1` track answers `result=104003`. The screen used to tell both
   * platforms "searching and playback need no sign-in", which for QQ described a
   * catalogue where most clicks do nothing.
   *
   * Shown while signed out, where the decision to sign in is actually made.
   */
  anonymousNote: string
  capabilities: ProviderCapabilities
  /**
   * False when this build has no backend for the platform at all (a browser
   * preview, or an Electron build whose main process has no such client).
   *
   * Read at render time, never cached: the interface must not offer an entry for
   * a platform it cannot serve, and the answer can change when the app is
   * rebuilt or the backend finishes booting.
   */
  available(): boolean

  search?: ProviderSearchApi
  playback?: ProviderPlaybackApi
  lyrics?: ProviderLyricsApi
  auth?: ProviderAuthApi
  catalog?: ProviderCatalogApi
  recommendations?: ProviderRecommendationsApi

  /** Collections this platform offers, in the order they should be listed. */
  collections?: OnlineCollection[]

  /** The quality tiers this platform accepts, best-last, matching `QUALITY_TIERS`. */
  qualityTiers?: QualityTier[]

  /** The user's current tier for this platform. The main process owns the value. */
  getQuality?(): Promise<QualityTier>
  setQuality?(quality: QualityTier): Promise<QualityTier>

  /**
   * The functions the shared store drives this platform with.
   *
   * Not part of the reference player's contract, and deliberately separate from
   * the capability interfaces above: those describe what the *interface* may ask
   * for, while the backend is what the shared state machine actually calls. Keeping
   * them apart means a provider can declare a capability and still have the store
   * refuse to drive it (see `providerHas`), instead of the two silently diverging.
   */
  backend?: unknown
}

/**
 * Quality arithmetic, shared by every platform because the tiers are the same
 * vocabulary even when the upstream names differ.
 */
export function qualityRank(level: QualityTier | 'hires'): number {
  const at = QUALITY_TIERS.indexOf(level as QualityTier)
  return at === -1 ? QUALITY_TIERS.length : at
}

/** Whether what arrived is below what was asked for. Reported, never retried. */
export function isQualityFallback(level: QualityTier | 'hires', requested: QualityTier): boolean {
  return qualityRank(level) < qualityRank(requested)
}

/**
 * Whether asking again is worth anything.
 *
 * Account-side and catalogue-side refusals are final for this session; a network
 * fault, a rate limit or a backend that has not bootstrapped are not. Anything
 * unrecognised is treated as worth one retry - the recovery is bounded by the
 * cache's own TTL, so a wrong guess costs a request rather than a loop.
 */
export function isTransientFailure(reason: OnlineFailureReason): boolean {
  return reason === 'network' || reason === 'rate-limited' || reason === 'service-unavailable'
}

/**
 * One sentence per failure reason, platform-neutral.
 *
 * The reason taxonomy exists so that "you are not signed in", "you have no
 * membership" and "this is gone" are three different sentences. The platform's own
 * name is supplied by the caller, so one table serves every provider.
 */
export function failureText(reason: OnlineFailureReason, platform = '在线平台'): string {
  switch (reason) {
    case 'login-required':
      return '这首歌需要登录后才能获取播放地址'
    case 'vip-required':
      return '这首歌需要会员，当前账号没有权限'
    case 'region-limited':
      return '这首歌在你所在地区没有版权'
    case 'trial-only':
      return '只能试听片段，完整版需要会员'
    case 'taken-down':
      return '这首歌已下架或没有版权'
    case 'network':
      return '网络请求失败，请检查连接后重试'
    case 'rate-limited':
      return '请求太频繁了，稍等一下再试'
    case 'service-unavailable':
      return `${platform}接口暂时不可用`
    default:
      return '播放失败，原因未知'
  }
}

/** The UI's one-line description of a delivered stream. */
export function streamSummary(stream: OnlineStream, requested: QualityTier): string {
  const parts = [QUALITY_LABELS[stream.level]]
  if (stream.br > 0) parts.push(`${stream.br}kbps`)
  if (stream.trial) {
    parts.push(
      stream.trialFrom !== undefined && stream.trialTo !== undefined
        ? `试听 ${shortDuration(stream.trialFrom)}–${shortDuration(stream.trialTo)}`
        : '试听片段'
    )
  } else if (isQualityFallback(stream.level, requested)) {
    parts.push(`低于所选 ${QUALITY_LABELS[requested]}，上游没有更高档`)
  }
  return parts.join(' · ')
}

/**
 * Seconds -> `3:07`.
 *
 * Zero is a real time point, not a missing one: a free trial almost always runs
 * from 0. Only a negative or non-finite value means "unknown".
 */
export function shortDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const total = Math.round(seconds)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * The fee flag in words.
 *
 * Platform-neutral on purpose: both upstreams express entitlement this way, and a
 * platform that does not simply never reports a fee.
 */
export function paymentLabel(song: { fee: number }): string {
  switch (song.fee) {
    case 0:
      return '免费'
    case 1:
      return '需要会员'
    case 4:
      return '需要购买专辑'
    case 8:
      return '免费试听，完整版需要会员'
    default:
      return `付费类型 ${song.fee}`
  }
}
