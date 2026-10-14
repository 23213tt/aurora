import { artworkFor } from '../library/source'
import type { Album, Track } from '../types'
import { Artwork } from './Artwork'
import { TrackList, type TrackMenuRequest } from './TrackList'
import { Note, Play } from './icons'

interface AlbumDetailProps {
  album: Album
  /** The album's tracks, already in disc/track order. */
  tracks: Track[]
  currentId: string | null
  playing: boolean
  onPlayAt(index: number): void
  onPlayAll(): void
  onOpenArtist(artistId: string): void
  onMenu?(request: TrackMenuRequest): void
}

/** Album-length durations read better as hours and minutes than as mm:ss. */
function formatTotal(seconds: number): string {
  const total = Math.round(seconds)
  if (total <= 0) return ''
  const hours = Math.floor(total / 3600)
  const minutes = Math.round((total % 3600) / 60)
  return hours > 0 ? `${hours} 小时 ${minutes} 分` : `${minutes} 分钟`
}

/**
 * One release: the cover, who made it, and the track list.
 *
 * The grid used to jump straight to playback, which meant there was no way to
 * look at an album before deciding to play it. Opening is now the default action
 * on the card and playing is an explicit button - the convention every other
 * player uses, and the only one that lets you browse a library.
 */
export function AlbumDetail({
  album,
  tracks,
  currentId,
  playing,
  onPlayAt,
  onPlayAll,
  onOpenArtist,
  onMenu
}: AlbumDetailProps) {
  const art = artworkFor(tracks[0] ?? null)
  const total = formatTotal(album.duration)

  return (
    <div className="album">
      <header className="album__head">
        <div className="album__art">
          <Artwork
            src={art}
            fallback={
              <span className="album__art-empty">
                <Note size={34} />
              </span>
            }
          />
        </div>

        <div className="album__info">
          <h2 className="album__name">{album.name}</h2>

          <button
            className="album__artist"
            onClick={() => onOpenArtist(album.albumArtist)}
            title={`查看 ${album.albumArtist}`}
          >
            {album.albumArtist}
          </button>

          <p className="album__meta tnum">
            {album.trackIds.length} 首
            {album.year ? ` · ${album.year} 年` : ''}
            {total ? ` · ${total}` : ''}
          </p>

          <div className="album__actions">
            <button className="btn btn--accent" onClick={onPlayAll}>
              <Play size={15} />
              播放
            </button>
          </div>
        </div>
      </header>

      <TrackList
        tracks={tracks}
        currentId={currentId}
        playing={playing}
        onPlayAt={onPlayAt}
        onMenu={onMenu}
      />
    </div>
  )
}
