import { artworkFor } from '../features/library/source'
import type { Album, Artist, Track } from '../types'
import { Artwork } from './Artwork'
import { Play } from './icons'

interface ArtistListProps {
  artists: Artist[]
  albums: Album[]
  representative: Map<string, Track>
  currentArtistId: string | null
  onOpen(artistId: string): void
  onPlay(artistId: string): void
}

export function ArtistList({
  artists,
  albums,
  representative,
  currentArtistId,
  onOpen,
  onPlay
}: ArtistListProps) {
  const albumsByArtist = new Map<string, Album[]>()
  for (const album of albums) {
    const list = albumsByArtist.get(album.albumArtist)
    if (list) list.push(album)
    else albumsByArtist.set(album.albumArtist, [album])
  }

  return (
    <div className="artists" role="list">
      {artists.map((artist) => {
        const owned = albumsByArtist.get(artist.name) ?? []
        const first = owned[0] ? representative.get(owned[0].id) ?? null : null
        const art = artworkFor(first)
        const isCurrent = artist.id === currentArtistId

        return (
          <div className={`artist${isCurrent ? ' is-current' : ''}`} role="listitem" key={artist.id}>
            <button className="artist__main" onClick={() => onOpen(artist.id)} title={`查看 ${artist.name}`}>
              <span className="artist__portrait">
                <Artwork src={art} fallback={<span>{artist.name.slice(0, 1)}</span>} />
              </span>
              <span className="artist__name">{artist.name}</span>
            </button>

            {/* Two right-aligned numeric columns rather than a dotted meta
                string, so the eye can compare straight down the list. */}
            <span className="artist__stat tnum">
              {owned.length}
              <span className="artist__stat-label">张专辑</span>
            </span>
            <span className="artist__stat tnum">
              {artist.trackCount}
              <span className="artist__stat-label">首</span>
            </span>

            <button
              className="icon-btn artist__play"
              onClick={() => onPlay(artist.id)}
              title={`播放 ${artist.name} 的全部曲目`}
              aria-label={`播放 ${artist.name} 的全部曲目`}
            >
              <Play size={15} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
