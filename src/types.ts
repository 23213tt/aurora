/**
 * Domain model. These shapes are shared with the main process over IPC, so
 * they are deliberately plain data - no class instances, no Dates.
 */

export type ViewId =
  | 'albums'
  | 'artists'
  | 'songs'
  | 'folders'
  | 'playlists'
  | 'accounts'
  | 'sources'
  | 'settings'

export type SortKey = 'title' | 'artist' | 'album' | 'added' | 'year' | 'duration'

export interface Track {
  /** Stable hash of the file path; survives re-scans and library moves. */
  id: string
  path: string
  /**
   * Which `TrackSource` owns this track. Absent means the local library, which
   * is why adding a remote source never touches existing code paths.
   */
  source?: string
  title: string
  artist: string
  /** Falls back to `artist` when the tag is absent, so grouping never breaks. */
  albumArtist: string
  album: string
  genre: string
  year: number | null
  trackNo: number | null
  discNo: number | null
  /** Seconds. */
  duration: number
  bitrate: number | null
  sampleRate: number | null
  channels: number | null
  codec: string
  lossless: boolean
  size: number
  /** File mtime, used to skip unchanged files on a re-scan. */
  mtimeMs: number
  addedAt: number
  /**
   * Whether artwork is expected to exist.
   *
   * Optimistic: the scanner does not decode embedded pictures (that would cost
   * a Buffer per file), so this is "assume yes" and the artwork request decides
   * for real. Renderers must fall back to a placeholder on load failure.
   */
  hasArt: boolean
  /** ReplayGain, when the tags carry it. */
  gainDb: number | null
  peak: number | null
}

export interface Album {
  /** `albumArtist\u0000album` - the natural key for a release. */
  id: string
  name: string
  albumArtist: string
  year: number | null
  trackIds: string[]
  duration: number
  hasArt: boolean
}

export interface Artist {
  id: string
  name: string
  albumIds: string[]
  trackCount: number
}

export interface Playlist {
  id: string
  name: string
  trackIds: string[]
  createdAt: number
  updatedAt: number
}

export interface LibraryIndex {
  version: number
  scannedAt: number
  roots: string[]
  tracks: Track[]
}

export type RepeatMode = 'off' | 'all' | 'one'
