import type { Album, Artist, Track } from '../types'
import { create } from 'zustand'

/**
 * Library state. Independent of the player: the player plays Track objects, it
 * does not care where they came from, which is what lets a remote provider feed
 * the same queue as the local scanner.
 */
interface LibraryState {
  tracks: Track[]
  roots: string[]
  /** True once the first load (scan or demo seed) has produced a result. */
  ready: boolean
  scanning: boolean
  /** 0..1 across the current scan. */
  progress: number
  /** File currently being read, for the status line. */
  currentScan: string
  error: string | null

  setTracks(tracks: Track[]): void
  setRoots(roots: string[]): void
  setScanning(scanning: boolean): void
  setProgress(progress: number): void
  setCurrentScan(currentScan: string): void
  setError(error: string | null): void
}

export const useLibrary = create<LibraryState>()((set) => ({
  tracks: [],
  roots: [],
  ready: false,
  scanning: false,
  progress: 0,
  currentScan: '',
  error: null,

  setTracks: (tracks) => set({ tracks, ready: true }),
  setRoots: (roots) => set({ roots }),
  setScanning: (scanning) => set({ scanning, progress: scanning ? 0 : 1 }),
  setProgress: (progress) => set({ progress }),
  setCurrentScan: (currentScan) => set({ currentScan }),
  setError: (error) => set({ error, scanning: false })
}))

/** `albumArtist\u0000album` - the natural key for one release. */
export function albumKey(track: Track): string {
  return `${track.albumArtist}\u0000${track.album}`
}

export function groupAlbums(tracks: Track[]): Album[] {
  const map = new Map<string, Album>()

  for (const track of tracks) {
    const id = albumKey(track)
    let album = map.get(id)
    if (!album) {
      album = {
        id,
        name: track.album,
        albumArtist: track.albumArtist,
        year: track.year,
        trackIds: [],
        duration: 0,
        hasArt: false
      }
      map.set(id, album)
    }
    album.trackIds.push(track.id)
    album.duration += track.duration
    album.hasArt ||= track.hasArt
    if (album.year === null && track.year !== null) album.year = track.year
  }

  // Order tracks inside an album the way a CD plays, not the way the disk listed.
  const byId = new Map(tracks.map((t) => [t.id, t]))
  for (const album of map.values()) {
    album.trackIds.sort((a, b) => {
      const left = byId.get(a)
      const right = byId.get(b)
      if (!left || !right) return 0
      if (left.discNo !== right.discNo) return (left.discNo ?? 1) - (right.discNo ?? 1)
      if (left.trackNo !== right.trackNo) {
        if (left.trackNo === null) return 1
        if (right.trackNo === null) return -1
        return left.trackNo - right.trackNo
      }
      return left.title.localeCompare(right.title, 'zh-Hans-CN')
    })
  }

  return [...map.values()].sort((a, b) =>
    a.albumArtist === b.albumArtist
      ? a.name.localeCompare(b.name, 'zh-Hans-CN')
      : a.albumArtist.localeCompare(b.albumArtist, 'zh-Hans-CN')
  )
}

export function groupArtists(tracks: Track[]): Artist[] {
  const albums = groupAlbums(tracks)
  const map = new Map<string, Artist>()

  for (const album of albums) {
    let artist = map.get(album.albumArtist)
    if (!artist) {
      artist = { id: album.albumArtist, name: album.albumArtist, albumIds: [], trackCount: 0 }
      map.set(album.albumArtist, artist)
    }
    artist.albumIds.push(album.id)
    artist.trackCount += album.trackIds.length
  }

  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

/**
 * Rank a track against a free-text query. Title matches beat artist matches beat
 * album matches, and an early match beats a late one, so typing "夜" surfaces
 * 「夜行列车」above a track that merely mentions it in the album name.
 */
export function scoreTrack(track: Track, query: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 1

  const fields: [string, number][] = [
    [track.title, 4],
    [track.artist, 3],
    [track.album, 2],
    [track.genre, 1]
  ]

  let best = 0
  for (const [value, weight] of fields) {
    const haystack = value.toLowerCase()
    const at = haystack.indexOf(q)
    if (at === -1) continue
    const positionBonus = at === 0 ? 1.6 : at < 4 ? 1.2 : 1
    best = Math.max(best, weight * positionBonus)
  }
  return best
}
