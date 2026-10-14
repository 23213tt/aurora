import { artworkFor } from '../library/source'
import type { Album, Track } from '../types'
import { Artwork } from './Artwork'
import { Note, Play } from './icons'

interface AlbumGridProps {
  albums: Album[]
  /** Representative track per album id, used to resolve artwork. */
  representative: Map<string, Track>
  currentAlbumId: string | null
  /** Opens the album's own screen. */
  onOpen(album: Album): void
  onPlay(album: Album): void
}

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
        const art = artworkFor(first)
        const isCurrent = album.id === currentAlbumId
        const minutes = Math.round(album.duration / 60)

        return (
          <article className={`card${isCurrent ? ' is-current' : ''}`} key={album.id}>
            {/*
              Two targets, two meanings: the cover opens the album, the disc on
              it plays. A single play target left no way to look before leaping.
              They are siblings inside the cover rather than nested, because a
              button inside a button is not valid and browsers disagree on it.
            */}
            <div className="card__art">
              <button
                className="card__art-open"
                onClick={() => onOpen(album)}
                title={`打开《${album.name}》`}
                aria-label={`打开专辑 ${album.name}`}
              >
                <Artwork
                  src={art}
                  fallback={
                    <span className="card__art-empty">
                      <Note size={26} />
                    </span>
                  }
                />
              </button>

              <button
                className="card__play"
                onClick={() => onPlay(album)}
                title={`播放《${album.name}》`}
                aria-label={`播放专辑 ${album.name}`}
              >
                <Play size={19} />
              </button>
            </div>

            <button className="card__name" onClick={() => onOpen(album)} title={album.name}>
              {album.name}
            </button>
            {/* Artist and size sit as two ends of one row rather than as a
                dotted meta string, so the eye can compare down the column. */}
            <div className="card__meta">
              <span className="card__artist" title={album.albumArtist}>
                {album.albumArtist}
              </span>
              <span className="card__size tnum">
                {album.trackIds.length} 首 · {minutes} 分
              </span>
            </div>
          </article>
        )
      })}
    </div>
  )
}
