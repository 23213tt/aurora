import { isNative } from '../bridge'
import { artUrl, mediaUrl } from '../player/urls'
import type { Track } from '../types'
import { demoCoverFor, demoLyricsFor } from './demo'

/**
 * The library-source seam.
 *
 * Everything that answers "where does this track's audio, artwork and lyrics
 * come from" goes through here, so the player core never learns whether a track
 * is a file on disk or something a server handed us. Adding a source means
 * adding one object to `SOURCES` and giving its tracks a `source` id; no change
 * to the engine, the queue, or the views.
 *
 * Only `local` is implemented. A remote source (Subsonic, Jellyfin, an official
 * streaming SDK) would implement this same interface.
 */
export interface TrackSource {
  id: string
  name: string
  /** One line for the sources screen. */
  summary: string
  online: boolean
  /** Playable URL for this track, or null when the source cannot serve it. */
  streamUrl(track: Track): string | null
  /** Artwork URL, or null. Must stay same-origin or CORS-clean for Web Audio. */
  artUrl(track: Track): string | null
  /** Raw LRC text, or null. */
  lyrics(track: Track): Promise<string | null>
}

/**
 * Files the user added to the library.
 *
 * In Electron this returns URLs on the private `aurora-media:` scheme, served
 * by the main process with range support. In the browser harness there is no
 * filesystem, so artwork comes from the generated demo covers and audio is
 * handled by the synthetic driver instead.
 */
export const localSource: TrackSource = {
  id: 'local',
  name: '本地文件夹',
  summary: '扫描你添加的文件夹，直接播放磁盘上的文件，不联网',
  online: false,

  streamUrl: (track) => (isNative ? mediaUrl(track.path) : null),

  artUrl: (track) => {
    if (!track.hasArt) return null
    return isNative ? artUrl(track.path) : demoCoverFor(track)
  },

  lyrics: async (track) => {
    if (!isNative) return demoLyricsFor(track)

    // A sidecar file the user placed next to the audio always wins: it is their
    // own file, and it is the one that matches this exact recording.
    const local = (await window.aurora?.library.readLyrics(track.path)) ?? null
    if (local) return local

    // Online lookup is opt-in. The main process refuses when the setting is off,
    // so this call is safe to make unconditionally.
    const hit = await window.aurora?.lyrics.lookup({
      title: track.title,
      artist: track.artist,
      album: track.album,
      duration: track.duration
    })
    return hit?.text ?? null
  }
}

export const SOURCES: TrackSource[] = [localSource]

export const DEFAULT_SOURCE_ID = localSource.id

/** Resolve the source responsible for a track. */
export function sourceFor(track: Track | null): TrackSource {
  if (!track) return localSource
  return SOURCES.find((source) => source.id === track.source) ?? localSource
}

/**
 * Artwork for a track, or null.
 *
 * Null is a meaningful answer rather than an error: callers render a neutral
 * placeholder instead of a broken image.
 */
export function artworkFor(track: Track | null): string | null {
  if (!track) return null
  return sourceFor(track).artUrl(track)
}
