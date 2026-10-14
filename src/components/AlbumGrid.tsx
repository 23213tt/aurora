import { artworkFor } from '../features/library/source'
import type { Album, Track } from '../types'
import { ArtCard } from './ArtCard'

interface AlbumGridProps {
  albums: Album[]
  /** Representative track per album id, used to resolve artwork. */
  representative: Map<string, Track>
  currentAlbumId: string | null
  /** Opens the album's own screen. */
  onOpen(album: Album): void
  onPlay(album: Album): void
}

/**
 * The album wall.
 *
 * Drawn through `ArtCard` so that a local album and an online one are the same
 * object to look at - which is the whole point of sharing it.
 */
export function AlbumGrid({
  albums,
  representative,
  currentAlbumId,
  onOpen,
  onPlay
}: AlbumGridProps) {
  return (
    <div className="grid">
      {albums.map((album) => {
        const first = representative.get(album.id) ?? null
        const minutes = Math.round(album.duration / 60)

        return (
          <ArtCard
            key={album.id}
            title={album.name}
            subtitle={album.albumArtist}
            meta={`${album.trackIds.length} 首 · ${minutes} 分`}
            src={artworkFor(first)}
            current={album.id === currentAlbumId}
            onOpen={() => onOpen(album)}
            onPlay={() => onPlay(album)}
          />
        )
      })}
    </div>
  )
}
