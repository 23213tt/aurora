import type { ReactNode } from 'react'
import { Artwork } from './Artwork'
import { Note, Play } from './icons'

/**
 * The artwork card, shared by every grid in the app.
 *
 * Local albums, saved playlists, online albums and online artists are four
 * different data sources with one thing in common: they are all "a square cover
 * with a name under it". They used to be drawn by three separate implementations
 * that drifted - different cover sizes, different meta lines, some with a play
 * target and some without - which is most of why the local and online halves of
 * the app read as two applications sharing a window.
 *
 * The structure is deliberately the same one the album wall established:
 *
 *  - the cover is a button that *opens* the thing, and the disc on it *plays* it.
 *    One target for both meanings left no way to look before leaping;
 *  - they are siblings inside the cover rather than nested, because a button
 *    inside a button is invalid and browsers disagree about it;
 *  - artist and count sit at two ends of one row, so the eye can compare down a
 *    column instead of reading a dotted string per card.
 */
export interface ArtCardProps {
  title: string
  /** Optional second line: the artist, the owner, whatever identifies it. */
  subtitle?: string
  /** Optional right-hand end of the meta row: "12 首", "1998". */
  meta?: string
  src: string | null
  /** Icon shown when there is no cover. */
  icon?: ReactNode
  /** Marks the card whose content is currently playing. */
  current?: boolean
  /** Omitted for things that cannot be played as a whole (an artist). */
  onPlay?: () => void
  onOpen: () => void
  /** Extra classes, e.g. a source marker. */
  className?: string
}

export function ArtCard({
  title,
  subtitle,
  meta,
  src,
  icon,
  current = false,
  onPlay,
  onOpen,
  className
}: ArtCardProps) {
  return (
    <article className={`card${current ? ' is-current' : ''}${className ? ` ${className}` : ''}`}>
      <div className="card__art">
        <button className="card__art-open" onClick={onOpen} title={`打开《${title}》`} aria-label={`打开 ${title}`}>
          <Artwork src={src} fallback={<span className="card__art-empty">{icon ?? <Note size={26} />}</span>} />
        </button>

        {onPlay ? (
          <button className="card__play" onClick={onPlay} title={`播放《${title}》`} aria-label={`播放 ${title}`}>
            <Play size={19} />
          </button>
        ) : null}
      </div>

      <button className="card__name" onClick={onOpen} title={title}>
        {title}
      </button>

      <div className="card__meta">
        <span className="card__artist" title={subtitle}>
          {subtitle ?? ''}
        </span>
        {meta ? <span className="card__size tnum">{meta}</span> : null}
      </div>
    </article>
  )
}
