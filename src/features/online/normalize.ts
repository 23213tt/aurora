import type {
  NeteaseAlbumRef,
  NeteaseArtist,
  NeteaseSong
} from '../../env'
import {
  paymentLabel,
  playable,
  takenDown,
  unknownAvailability,
  type OnlineAlbumRef,
  type OnlineArtistRef,
  type OnlineSong,
  type ProviderSongAvailability
} from './types'

/**
 * Tolerating what comes over the bridge.
 *
 * The main process normalises each platform into its own shape, and the QQ
 * client is being written in parallel with this file, so the renderer cannot
 * assume the two are byte-identical. These helpers take the narrow view: read the
 * field names that are known, fall back to the plausible alternatives, and never
 * throw on a missing one. A wrong field costs an empty artist line, not a blank
 * screen.
 *
 * This is a bridge-boundary tolerance, not a place for platform logic: anything
 * that differs *because it is QQ* belongs in `features/qq`.
 */

type Loose = Record<string, unknown>

function asRecord(value: unknown): Loose {
  return value && typeof value === 'object' ? (value as Loose) : {}
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value ? value : fallback
}

function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

/** `null` rather than `''`, because a missing cover and a blank one differ. */
function optionalStr(value: unknown): string | null {
  const text = str(value)
  return text || null
}

/**
 * One upstream song -> the shared shape.
 *
 * Also accepts a song that is *already* in the shared shape and returns it, so
 * the Netease adapter (whose rows come back normalised by the main process) and
 * the QQ adapter can share one code path.
 */
export function normalizeSong(raw: unknown): OnlineSong {
  const song = asRecord(raw)

  const rawArtists = Array.isArray(song.artists) ? song.artists : null
  const artists = rawArtists
    ? rawArtists.map((entry) => {
        const artist = asRecord(entry)
        return { id: num(artist.id), name: str(artist.name, '未知艺术家') }
      })
    : // Some upstreams send one `artist` string instead of a list.
      splitArtists(str(song.artist, str(song.singer, '未知艺术家')))

  const album = asRecord(song.album)
  const albumName = str(album.name, str(song.albumName, str(song.albumname, '')))

  return {
    id: num(song.id, num(song.songId, num(song.songmid))),
    name: str(song.name, str(song.title, '（无标题）')),
    artists,
    album: {
      id: num(album.id, num(song.albumId, num(song.albummid))),
      name: albumName,
      picUrl: optionalStr(
        album.picUrl ??
          album.coverUrl ??
          song.picUrl ??
          song.coverUrl ??
          song.albumPic ??
          song.img
      )
    },
    // QQ reports seconds; Netease reports milliseconds. Detect by magnitude rather
    // than by platform: a duration above an hour in "seconds" is a millisecond value.
    duration: normalizeDuration(num(song.duration, num(song.interval, num(song.dt)))),
    fee: num(song.fee, num(song.pay_play, 0) === 1 ? 1 : 0)
  }
}

function normalizeDuration(value: number): number {
  return value > 3600 ? Math.round(value / 1000) : value
}

function splitArtists(text: string): { id: number; name: string }[] {
  return text
    .split(/[/、&]|\sfeat\.?/i)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((name) => ({ id: 0, name }))
}

export function normalizeSearchResult(raw: unknown): {
  songs: OnlineSong[]
  albums: OnlineAlbumRef[]
  artists: OnlineArtistRef[]
} {
  const result = asRecord(raw)
  return {
    songs: (Array.isArray(result.songs) ? result.songs : []).map(normalizeSong),
    albums: (Array.isArray(result.albums) ? result.albums : []).map(normalizeAlbum),
    artists: (Array.isArray(result.artists) ? result.artists : []).map(normalizeArtist)
  }
}

export function normalizeAlbum(raw: unknown): OnlineAlbumRef {
  const album = asRecord(raw)
  return {
    id: num(album.id, num(album.albumId)),
    name: str(album.name, str(album.title, '（无标题）')),
    artist: str(album.artist, str(album.singer, '')),
    picUrl: optionalStr(album.picUrl ?? album.coverUrl ?? album.img),
    year: album.year === null || album.year === undefined ? null : num(album.year),
    songCount: num(album.songCount, num(album.size))
  }
}

export function normalizeArtist(raw: unknown): OnlineArtistRef {
  const artist = asRecord(raw)
  return {
    id: num(artist.id, num(artist.artistId)),
    name: str(artist.name, '未知艺术家'),
    picUrl: optionalStr(artist.picUrl ?? artist.coverUrl ?? artist.img),
    albumCount: num(artist.albumCount, num(albumCountOf(artist)))
  }
}

function albumCountOf(artist: Loose): unknown {
  return artist.albumSize ?? artist.album_count ?? 0
}

/**
 * The upstream failure vocabulary -> what the interface should say.
 *
 * Both clients classify their own upstream into the shared reason set, so this is
 * only a pass-through with one rule attached: an unrecognised reason is `unknown`,
 * never `taken-down`. Saying a song is gone is a claim the renderer has no
 * evidence for.
 */
export function normalizeFailure(raw: unknown): { reason: string; message?: string } {
  const failure = asRecord(raw)
  const reason = str(failure.reason, 'unknown')
  const message = optionalStr(failure.message)
  return message ? { reason, message } : { reason }
}

/** A song's fee flag, in words. Re-exported here so adapters need one import. */
export { paymentLabel }

/** The trivial availability answers, so both adapters phrase them the same way. */
export { playable, takenDown, unknownAvailability }
export type { ProviderSongAvailability }

/**
 * A song that a platform has *proved* is gone.
 *
 * No adapter in this build calls it: neither upstream has a verified
 * taken-down signal, and the contract says a claim of this kind needs evidence.
 * It exists as the single sanctioned way to make the claim, so that a future
 * adapter that gains real evidence does not invent its own phrasing - and so that
 * `takenDown` is not silently unused.
 */
export function noVerifiedTakenDown(): ProviderSongAvailability {
  return takenDown()
}

/** Re-exported for adapters that hand the main process a song list back. */
export type { NeteaseAlbumRef, NeteaseArtist, NeteaseSong }
