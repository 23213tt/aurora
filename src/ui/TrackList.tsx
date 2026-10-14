import { useEffect, useRef } from 'react'
import { formatTime } from './format'
import { Note } from './icons'
import type { Track } from '../types'

export interface TrackMenuRequest {
  track: Track
  x: number
  y: number
}

interface TrackListProps {
  tracks: Track[]
  currentId: string | null
  playing: boolean
  /** Starts the whole list at this position, so "next" continues down the list. */
  onPlayAt(index: number): void
  /** Opens the per-track actions menu. Omit to leave the affordance out. */
  onMenu?(request: TrackMenuRequest): void
}

/**
 * The dense view. A personal library runs to thousands of rows, so rows are
 * short, columns are aligned on tabular figures, and everything that is not the
 * title is quiet enough to skim past.
 */
export function TrackList({ tracks, currentId, playing, onPlayAt, onMenu }: TrackListProps) {
  const currentRow = useRef<HTMLDivElement | null>(null)

  /*
   * Keep the playing track on screen.
   *
   * Keyed on the track id, not on render, so this fires when the track actually
   * changes. `block: 'nearest'` is the important part: a row that is already
   * visible does not move at all, which means this never fights someone who is
   * scrolling through the list themselves - it only reacts when the queue
   * advances past the edge of the viewport.
   *
   * The jump is instant rather than smooth. Smooth scrolling is driven by
   * requestAnimationFrame, so it stalls whenever the compositor is not animating
   * (a minimised window, a reduced-motion setting), and a track you cannot find
   * is worse than a scroll that does not glide.
   */
  useEffect(() => {
    if (!currentId) return
    currentRow.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  }, [currentId])

  const openMenu = (track: Track, x: number, y: number) => {
    onMenu?.({ track, x, y })
  }

  return (
    <div className="tracks" role="table" aria-label="歌曲">
      <div className="tracks__head" role="row">
        <span className="tracks__idx" role="columnheader">
          #
        </span>
        <span role="columnheader">标题</span>
        <span role="columnheader">艺术家</span>
        <span className="tracks__album" role="columnheader">
          专辑
        </span>
        <span className="tracks__time" role="columnheader">
          时长
        </span>
        <span role="columnheader" aria-label="操作" />
      </div>

      {tracks.map((track, index) => {
        const isCurrent = track.id === currentId
        return (
          <div
            key={track.id}
            role="row"
            // Only the playing row holds the ref; React clears it from the row
            // that stopped being current.
            ref={isCurrent ? currentRow : undefined}
            className={`trk${isCurrent ? ' is-current' : ''}`}
          >
            {/*
              The whole row is one click target, so it stays a plain overlay
              button rather than something nested. The actions button lives
              beside it and sits above it in the stacking order.
            */}
            <button
              className="trk__hit"
              onClick={() => onPlayAt(index)}
              onContextMenu={(event) => {
                if (!onMenu) return
                event.preventDefault()
                openMenu(track, event.clientX, event.clientY)
              }}
              title={`播放 ${track.title}`}
              aria-label={`播放 ${track.title}`}
            />

            <span className="tracks__idx" role="cell">
              {isCurrent ? (
                <span className={`eq${playing ? ' is-live' : ''}`} aria-label="正在播放">
                  <i />
                  <i />
                  <i />
                </span>
              ) : (
                <span className="tnum">{index + 1}</span>
              )}
            </span>
            <span className="trk__title" role="cell">
              <span className="trk__title-text">{track.title || '（无标题）'}</span>
              {track.lossless ? <span className="badge" title={`${track.codec} 无损`}>FLAC</span> : null}
            </span>
            <span className="trk__muted" role="cell">
              {track.artist}
            </span>
            <span className="trk__muted tracks__album" role="cell" title={track.album}>
              {track.album}
            </span>
            <span className="tracks__time tnum" role="cell">
              {formatTime(track.duration)}
            </span>

            {onMenu ? (
              <button
                className="trk__more"
                onClick={(event) => {
                  // Anchor the menu to the button rather than the pointer, so a
                  // keyboard activation opens it somewhere sensible too.
                  const rect = event.currentTarget.getBoundingClientRect()
                  openMenu(track, rect.right - 6, rect.bottom + 4)
                }}
                title="更多操作"
                aria-label={`${track.title} 的更多操作`}
              >
                ⋯
              </button>
            ) : (
              <span />
            )}
          </div>
        )
      })}

      {tracks.length === 0 ? (
        <div className="tracks__empty">
          <Note size={18} />
          没有匹配的歌曲
        </div>
      ) : null}
    </div>
  )
}
