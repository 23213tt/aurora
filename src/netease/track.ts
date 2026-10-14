import type { NeteaseSong, NeteaseStream } from '../env'
import type { Track } from '../types'

/**
 * Song -> `Track`, and the cover address that goes with it.
 *
 * Deliberately alone in its own module with nothing but `import type`: this is
 * the one piece of the online source that has no state, no network and no
 * window, so it can be imported and tested on its own. Everything that touches
 * the bridge lives in `./store`, which cannot be loaded outside a bundler.
 */

/**
 * Map an upstream song onto Aurora's track shape.
 *
 * The id and the path are both `netease:<id>`. The engine compares
 * `loadedPath === track.path` to decide whether to re-point its audio element,
 * so the path has to identify the *song* and never the resolved URL: that URL
 * expires and changes between fetches, which would make every replay look like
 * a different track and every repeat look like a new load.
 */
export function toTrack(song: NeteaseSong, stream: NeteaseStream | null = null): Track {
  return {
    id: `netease:${song.id}`,
    path: `netease:${song.id}`,
    source: 'netease',
    title: song.name,
    artist: song.artists.map((artist) => artist.name).join(' / '),
    albumArtist: song.artists[0]?.name ?? '',
    album: song.album.name,
    genre: '',
    year: null,
    trackNo: null,
    discNo: null,
    duration: song.duration,
    bitrate: stream?.br ?? null,
    sampleRate: null,
    // Upstream streams are normalised to two channels by the CDN; a monophonic
    // original would still arrive stereo, so 2 is the honest value here.
    channels: 2,
    codec: 'mp3',
    /*
     * Never lossless. The upstream may hand back a FLAC at the lossless tier,
     * but it does not tell the renderer which codec it actually got, and
     * inferring it from the requested tier would put a FLAC badge on a 320k mp3.
     */
    lossless: false,
    size: 0,
    mtimeMs: 0,
    addedAt: Date.now(),
    hasArt: Boolean(song.album.picUrl),
    gainDb: null,
    peak: null
  }
}

/** Upstream cover URL for a song, or null. */
export function songCover(song: NeteaseSong): string | null {
  return song.album.picUrl
}

/**
 * The numeric song id behind a track, or null when it is not ours.
 *
 * Read from `path` rather than `id` so a caller cannot accidentally accept a
 * local track whose id merely looks similar.
 */
export function neteaseSongId(track: Track): number | null {
  if (track.source !== 'netease') return null
  const id = Number(track.path.slice('netease:'.length))
  return Number.isFinite(id) ? id : null
}
