import { useCallback } from 'react'
import { player } from '../features/player/actions'
import { tracksUnder } from '../features/library/tree'
import { usePlaylists } from '../features/playlists/store'
import type { Album, Track } from '../types'

/**
 * The three "play all of this collection" actions, plus creating a playlist.
 *
 * Each is the same shape - collect the tracks that belong to something, hand them
 * to the transport - and the interesting part is what "belong" means: an album is
 * its own running order, an artist is everything credited to them, a folder is
 * everything beneath it. Grouping them here makes that comparison readable, and
 * keeps `App` about wiring rather than about collection membership.
 */
export function useTrackActions(options: {
  tracks: Track[]
  albums: Album[]
  trackById: Map<string, Track>
  navigate(route: { view: 'playlists'; playlistId: string }): void
}) {
  const { tracks, albums, trackById, navigate } = options

  /** An album plays in its own order, not in library order. */
  const playAlbum = useCallback(
    (albumId: string) => {
      const album = albums.find((item) => item.id === albumId)
      if (!album) return
      const queue = album.trackIds
        .map((id) => trackById.get(id))
        .filter((item): item is Track => Boolean(item))
      player.playQueue(queue, 0)
    },
    [albums, trackById]
  )

  const playArtist = useCallback(
    (artistId: string) => {
      const owned = tracks.filter((item) => item.albumArtist === artistId)
      if (owned.length > 0) player.playQueue(owned, 0)
    },
    [tracks]
  )

  const playFolder = useCallback(
    (folderPath: string) => {
      const owned = tracksUnder(tracks, folderPath)
      if (owned.length > 0) player.playQueue(owned, 0)
    },
    [tracks]
  )

  const createPlaylist = useCallback(
    (name: string) => {
      const created = usePlaylists.getState().create(name)
      navigate({ view: 'playlists', playlistId: created.id })
    },
    [navigate]
  )

  return { playAlbum, playArtist, playFolder, createPlaylist }
}
