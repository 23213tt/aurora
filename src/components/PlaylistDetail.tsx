import { useState } from 'react'
import type { Playlist } from '../playlists/store'
import type { Track } from '../types'
import { formatTime } from './Bar'
import { Play, Trash, Wave } from './icons'

interface PlaylistDetailProps {
  playlist: Playlist
  /** Resolved tracks, in playlist order. Files no longer in the library are absent. */
  tracks: Track[]
  missingCount: number
  currentId: string | null
  playing: boolean
  onPlayAt(index: number): void
  onMove(from: number, to: number): void
  onRemoveAt(index: number): void
  onExport(): void
  onRename(name: string): void
}

export function PlaylistDetail({
  playlist,
  tracks,
  missingCount,
  currentId,
  playing,
  onPlayAt,
  onMove,
  onRemoveAt,
  onExport,
  onRename
}: PlaylistDetailProps) {
  const [draft, setDraft] = useState(playlist.name)
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)

  const total = tracks.reduce((sum, track) => sum + track.duration, 0)

  const commitName = () => {
    const next = draft.trim()
    if (next && next !== playlist.name) onRename(next)
    else setDraft(playlist.name)
  }

  return (
    <div className="pl-detail">
      <div className="pl-detail__bar">
        <input
          className="pl-detail__name"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitName}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') {
              setDraft(playlist.name)
              event.currentTarget.blur()
            }
          }}
          aria-label="播放列表名字"
          maxLength={80}
        />

        <span className="pl-detail__meta tnum">
          {tracks.length} 首
          {total > 0 ? `，${formatTime(total)}` : ''}
        </span>

        <div className="pl-detail__actions">
          <button
            className="btn btn--accent"
            onClick={() => onPlayAt(0)}
            disabled={tracks.length === 0}
          >
            <Play size={15} />
            播放全部
          </button>
          <button className="btn" onClick={onExport} disabled={tracks.length === 0}>
            导出 m3u
          </button>
        </div>
      </div>

      {missingCount > 0 ? (
        <div className="pl-detail__warn">有 {missingCount} 个条目在曲库里找不到</div>
      ) : null}

      {tracks.length === 0 ? (
        <div className="empty">
          <div className="empty__art">
            <Wave size={30} />
          </div>
          <h2>这个播放列表还是空的</h2>
        </div>
      ) : (
        <ol className="pl-tracks">
          {tracks.map((track, index) => {
            const isCurrent = track.id === currentId
            const classes = [
              'pl-track',
              isCurrent ? 'is-current' : '',
              dragFrom === index ? 'is-dragging' : '',
              dragOver === index && dragFrom !== index ? 'is-over' : ''
            ]
              .filter(Boolean)
              .join(' ')

            return (
              <li
                key={`${track.id}-${index}`}
                className={classes}
                draggable
                onDragStart={(event) => {
                  setDragFrom(index)
                  event.dataTransfer.effectAllowed = 'move'
                  // Firefox and Chromium both require some payload to start a drag.
                  event.dataTransfer.setData('text/plain', String(index))
                }}
                onDragOver={(event) => {
                  event.preventDefault()
                  event.dataTransfer.dropEffect = 'move'
                  setDragOver(index)
                }}
                onDrop={(event) => {
                  event.preventDefault()
                  const raw = event.dataTransfer.getData('text/plain')
                  const from = dragFrom ?? Number.parseInt(raw, 10)
                  if (Number.isFinite(from)) onMove(from, index)
                  setDragFrom(null)
                  setDragOver(null)
                }}
                onDragEnd={() => {
                  setDragFrom(null)
                  setDragOver(null)
                }}
              >
                <span className="pl-track__grip" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>

                <button
                  className="pl-track__main"
                  onClick={() => onPlayAt(index)}
                  onKeyDown={(event) => {
                    // Keyboard equivalent of dragging, so reordering is not
                    // mouse-only.
                    if (!event.altKey) return
                    if (event.key === 'ArrowUp' && index > 0) {
                      event.preventDefault()
                      onMove(index, index - 1)
                    } else if (event.key === 'ArrowDown' && index < tracks.length - 1) {
                      event.preventDefault()
                      onMove(index, index + 1)
                    }
                  }}
                  title={`播放 ${track.title}（Alt + 上下方向键可调整顺序）`}
                >
                  <span className="pl-track__index tnum">{index + 1}</span>
                  <span className="pl-track__title">
                    {isCurrent && playing ? (
                      <span className="eq is-live" aria-label="正在播放">
                        <i />
                        <i />
                        <i />
                      </span>
                    ) : null}
                    <span className="pl-track__title-text">{track.title || '（无标题）'}</span>
                  </span>
                  <span className="pl-track__muted">{track.artist}</span>
                  <span className="pl-track__muted pl-track__album">{track.album}</span>
                  <span className="pl-track__time tnum">{formatTime(track.duration)}</span>
                </button>

                <button
                  className="icon-btn pl-track__remove"
                  onClick={() => onRemoveAt(index)}
                  title="从这个列表里移除"
                  aria-label={`从播放列表移除 ${track.title}`}
                >
                  <Trash size={15} />
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
