import { useMemo } from 'react'
import { albumKey, groupAlbums, groupArtists } from '../features/library/store'
import { buildFolderTree } from '../features/library/tree'
import type { Playlist } from '../features/playlists/store'
import type { Album, Artist, Track } from '../types'
import type { Route } from './routing'

/**
 * Everything the views show, derived from the library and the current route.
 *
 * These `useMemo`s used to sit in the middle of `App`, between the effects and
 * the render, where they were the hardest part of the file to read: each one is a
 * small, testable statement about the data ("an album's tracks in running order",
 * "a playlist's ids resolved, with the count that failed to resolve") and none of
 * them needs to know how the app is wired.
 *
 * The missing-entry count is the one worth naming: a playlist stores ids, so a
 * file that was deleted or moved simply does not resolve. That gap is the
 * difference between "empty playlist" and "broken playlist".
 */
export interface LibraryData {
  albums: Album[]
  artists: Artist[]
  folderTree: ReturnType<typeof buildFolderTree>
  trackById: Map<string, Track>
  activePlaylist: Playlist | null
  playlistTracks: { tracks: Track[]; missing: number }
  representative: Map<string, Track>
  band: { artist: Artist | null; albums: Album[]; tracks: Track[] } | null
  currentAlbumId: string | null
  albumDetail: { album: Album; tracks: Track[] } | null
  currentArtistId: string | null
  currentFolder: string | null
}

export function useLibraryData(
  route: Route,
  tracks: Track[],
  playlists: Playlist[],
  currentTrack: Track | null
): LibraryData {
  const albums = useMemo(() => groupAlbums(tracks), [tracks])
  const artists = useMemo(() => groupArtists(tracks), [tracks])
  const folderTree = useMemo(() => buildFolderTree(tracks), [tracks])
  const trackById = useMemo(() => new Map(tracks.map((item) => [item.id, item])), [tracks])

  const activePlaylist = route.playlistId
    ? (playlists.find((playlist) => playlist.id === route.playlistId) ?? null)
    : null

  const playlistTracks = useMemo(() => {
    if (!activePlaylist) return { tracks: [] as Track[], missing: 0 }
    const resolved = activePlaylist.trackIds
      .map((id) => trackById.get(id))
      .filter((item): item is Track => Boolean(item))
    return { tracks: resolved, missing: activePlaylist.trackIds.length - resolved.length }
  }, [activePlaylist, trackById])

  const representative = useMemo(() => {
    const byId = new Map(tracks.map((item) => [item.id, item]))
    const map = new Map<string, Track>()
    for (const album of albums) {
      const first = byId.get(album.trackIds[0])
      if (first) map.set(album.id, first)
    }
    return map
  }, [albums, tracks])

  const band = useMemo(() => {
    if (!route.artistId) return null
    return {
      artist: artists.find((artist) => artist.id === route.artistId) ?? null,
      albums: albums.filter((album) => album.albumArtist === route.artistId),
      tracks: tracks.filter((item) => item.albumArtist === route.artistId)
    }
  }, [route.artistId, artists, albums, tracks])

  /*
   * The album being viewed, with its tracks in the album's own order.
   *
   * `trackIds` is already sorted by disc and track number when the library is
   * grouped, so this preserves running order rather than re-sorting.
   */
  const albumDetail = useMemo(() => {
    if (!route.albumId) return null
    const album = albums.find((item) => item.id === route.albumId)
    if (!album) return null
    const byId = new Map(tracks.map((item) => [item.id, item]))
    const ordered = album.trackIds
      .map((id) => byId.get(id))
      .filter((item): item is Track => Boolean(item))
    return { album, tracks: ordered }
  }, [route.albumId, albums, tracks])

  return {
    albums,
    artists,
    folderTree,
    trackById,
    activePlaylist,
    playlistTracks,
    representative,
    band,
    currentAlbumId: currentTrack ? albumKey(currentTrack) : null,
    albumDetail,
    currentArtistId: currentTrack?.albumArtist ?? null,
    currentFolder: currentTrack ? currentTrack.path.replace(/[\\/][^\\/]*$/, '') : null
  }
}
