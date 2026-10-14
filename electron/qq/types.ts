import type { QqFailureReason } from './reasons'

/**
 * The QQ Music shapes that cross the bridge.
 *
 * `src/env.d.ts` mirrors these by hand, the same way it mirrors `NeteaseSong`.
 * Changing one without the other is a bug.
 *
 * Three of the shapes here are shaped by the *renderer* rather than by taste,
 * because `src/features/online/` was written in parallel and already reads
 * specific names (`normalize.ts`, `qq-provider.ts`). Where that is true it is
 * called out per field - those aliases are a bridge accommodation, not
 * decoration, and removing them would break a screen that is already written.
 */

export type { QqFailureReason }

/**
 * The shared quality vocabulary, identical to Netease's.
 *
 * QQ names its formats with file prefixes (`M500`/`C400`/`M800`/`F000`/`A000`)
 * and the renderer's settings UI offers four tiers for every platform, so the
 * translation from tier to format happens in `transport.ts` and never reaches
 * the page. That also keeps "what an account can actually get" the client's
 * business: a requested tier may be answered with a lower one, and the reply
 * says which one it got.
 */
export type QqQuality = 'standard' | 'higher' | 'exhigh' | 'lossless'

 const QQ_QUALITIES: readonly QqQuality[] = ['standard', 'higher', 'exhigh', 'lossless']

export function isQqQuality(value: unknown): value is QqQuality {
  return typeof value === 'string' && (QQ_QUALITIES as readonly string[]).includes(value)
}

export interface QqArtist {
  /** Numeric `singerID`, which is what the shared shape carries. */
  id: number
  /** `singerMID`; kept so a future artist page has something to navigate by. */
  mid: string
  name: string
}

export interface QqAlbumRef {
  /** Numeric `albumID`. */
  id: number
  /** `albumMID`. The cover URL is built from it. */
  mid: string
  name: string
  picUrl: string | null
}

export interface QqSong {
  /**
   * Numeric `songid`.
   *
   * The renderer's shared normaliser reads `song.id` as a number
   * (`src/features/online/normalize.ts`), so this is the field that populates
   * its id. It is *not* the playback identity - see below.
   */
  id: number
  /** Alias of `id`; the shared normaliser also looks for `songId`. */
  songId: number
  /**
   * `songmid`, the stable playback identity.
   *
   * `streamUrl()` accepts either this or the numeric id, but only this one is
   * guaranteed to survive a restart, because the vkey request is built from it.
   */
  songmid: string
  /**
   * Alias of `songmid`.
   *
   * The shared shape declares `mid?: string` for exactly this reason ("QQ
   * identifies a track by songmid while the shared shape is numeric"), and its
   * `mediaMidOf()` looks for `mid` first. Emitting it means the round trip
   * works today and keeps working when the renderer forwards it.
   */
  mid: string
  /** `media_mid`: only used to name the file in the vkey request. */
  mediaMid: string
  name: string
  artists: QqArtist[]
  album: QqAlbumRef
  /** Seconds. Upstream reports whole seconds in `interval`. */
  duration: number
  /**
   * Upstream `pay.payplay` as the shared shape's `fee`: 1 when the catalogue
   * lists the track as paywalled, 0 otherwise.
   *
   * A **hint**, never a verdict - the availability contract in
   * `src/features/online/types.ts` is explicit that a payment limit may only be
   * reported as "unknown, restricted", and that the real request decides.
   */
  fee: number
  /** The same hint, under the upstream name, so either reader works. */
  paid: boolean
}

 interface QqStream {
  /** Upstream http(s) URL. Played through `aurora-remote:`, never fetched by the page. */
  url: string
  /** The tier that was asked for. */
  quality: QqQuality
  /**
   * The tier actually delivered.
   *
   * Upstream answers a tier it will not give with an empty `purl`, so a request
   * for `lossless` on a free account lands on a lower tier. Saying which one it
   * landed on is what stops the interface from putting a FLAC badge on a 320k
   * stream.
   */
  level: QqQuality
  /** kbps; 999 is this app's marker for a lossless stream. */
  br: number
  lossless: boolean
  /** Always false: upstream offers no trial fragment for the tracks it refuses. */
  trial: boolean
}

/**
 * A refusal is flat, not nested under `stream` - this is the shape the QQ
 * contract and `src/features/online/qq-provider.ts` both read.
 */
export type QqStreamResult =
  | ({ ok: true } & QqStream)
  | { ok: false; reason: QqFailureReason; message?: string }

export interface QqSearchResult {
  songs: QqSong[]
  /**
   * Upstream has no album *search*: these come from the single "did you mean"
   * album and from the matched artist's hot albums. See `normalize.ts`.
   */
  albums: {
    id: number
    name: string
    artist: string
    picUrl: string | null
    year: number | null
    songCount: number
  }[]
  /** Same limitation: at most the one artist upstream matched for the query. */
  artists: { id: number; name: string; picUrl: string | null; albumCount: number }[]
}

export interface QqAccount {
  /** Numeric uin. */
  id: number
  nickname: string
  avatarUrl: string | null
  /**
   * `null` means "not established", not "not a member".
   *
   * The membership probe can fail for reasons that have nothing to do with the
   * account - a network blip, an upstream field rename - and caching that as
   * `false` would tell a paying user their membership lapsed. Only a probe that
   * actually answered writes this field.
   *
   * Note the renderer currently collapses this to a boolean
   * (`raw.vip === true`), so "unknown" shows as "not a member" in the account
   * chip. That is its call to make; the client does not invent a `false`.
   */
  vip: boolean | null
  /** QQ's own account level, 0 when it was never reported. */
  level: number
}

export interface QqStatusResult {
  ready: boolean
  loggedIn: boolean
  detail?: string
}

/** A pending QR login: the key to poll with plus the PNG to display. */
export interface QqQrSession {
  key: string
  imageDataUrl: string
}

export interface QqQrResult {
  status: 'waiting' | 'scanned' | 'expired' | 'confirmed' | 'failed'
  account?: QqAccount
  message?: string
}
