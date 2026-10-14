import { activeLineAt, type Lyrics } from '../lyrics/lrc'
import type { Palette } from '../library/palette'
import type { Track } from '../types'
import { formatTime } from '../components/Bar'
import { ChevronLeft, Pause, Play } from '../components/icons'
import { usePlayer } from '../player/store'
import { usePosition } from '../player/hooks'
import { Visualizer } from './Visualizer'

/** Lines shown above and below the active one. Fixed, so centring is exact. */
const SPAN = 4
const SLOTS = SPAN * 2 + 1

interface LyricColumnProps {
  lyrics: Lyrics
  onSeek(seconds: number): void
}

/**
 * The lyric window.
 *
 * This is where performance matters most in the whole app: the visualizer canvas
 * and the control chrome must not re-render sixty times a second just because
 * the playhead moved.
 *
 * Subscribing to a *derived number* rather than to `position` is what does it.
 * The selector returns the index of the highlighted line, so sixty position
 * ticks per second collapse into one re-render each time the lyric actually
 * advances - a handful per song.
 */
function LyricColumn({ lyrics, onSeek }: LyricColumnProps) {
  const active = usePlayer((state) => activeLineAt(lyrics.lines, state.position))
  // Before the first line starts, anchor on it so the stage is never blank.
  const anchor = active < 0 ? 0 : active

  const slots = Array.from({ length: SLOTS }, (_, i) => {
    const lineIndex = anchor - SPAN + i
    const line = lyrics.lines[lineIndex]
    const distance = Math.abs(i - SPAN)
    return {
      key: lineIndex,
      line,
      distance,
      isActive: active >= 0 && lineIndex === active,
      // Before the first timestamp there is nothing to highlight; the centre
      // slot holds the upcoming line but must not read as "currently playing".
      isPending: active < 0 && distance === 0
    }
  })

  return (
    <div className="stage__lyrics" role="list" aria-live="off">
      {slots.map((slot) => (
        <div
          key={slot.key}
          role="listitem"
          className={`lyr lyr--d${Math.min(slot.distance, 4)}${slot.isActive ? ' is-active' : ''}${slot.isPending ? ' is-pending' : ''}`}
        >
          {slot.line ? (
            <button
              type="button"
              className="lyr__text"
              onClick={() => onSeek(slot.line.time)}
              title={`跳到 ${formatTime(slot.line.time)}`}
            >
              {slot.line.text || '·'}
            </button>
          ) : (
            <span className="lyr__text lyr__text--empty" />
          )}
        </div>
      ))}
    </div>
  )
}

/** Small enough that a per-frame re-render costs nothing. */
function StageProgress({
  duration,
  onSeekRatio
}: {
  duration: number
  onSeekRatio(ratio: number): void
}) {
  const position = usePosition()
  const ratio = duration > 0 ? Math.min(1, position / duration) : 0

  return (
    <div className="stage__progress">
      <span className="stage__time">{formatTime(position)}</span>
      <div
        className="stage__track"
        role="slider"
        tabIndex={0}
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          if (rect.width <= 0) return
          onSeekRatio((event.clientX - rect.left) / rect.width)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight') onSeekRatio(Math.min(1, ratio + 0.02))
          else if (event.key === 'ArrowLeft') onSeekRatio(Math.max(0, ratio - 0.02))
        }}
      >
        <div className="stage__track-fill" style={{ width: `${ratio * 100}%` }} />
      </div>
      <span className="stage__time">{formatTime(duration)}</span>
    </div>
  )
}

interface LyricsStageProps {
  track: Track | null
  lyrics: Lyrics
  duration: number
  playing: boolean
  palette: Palette
  getSpectrum: () => Uint8Array | null
  /** Whether online lyric lookup is allowed, so the empty state can offer it. */
  onlineEnabled: boolean
  onEnableOnline(): void
  onSeek(seconds: number): void
  onSeekRatio(ratio: number): void
  onToggle(): void
  onClose(): void
}

export function LyricsStage({
  track,
  lyrics,
  duration,
  playing,
  palette,
  getSpectrum,
  onlineEnabled,
  onEnableOnline,
  onSeek,
  onSeekRatio,
  onToggle,
  onClose
}: LyricsStageProps) {
  return (
    <div className="stage">
      <Visualizer getSpectrum={getSpectrum} palette={palette} />

      <header className="stage__top">
        <button className="stage__back" onClick={onClose} aria-label="退出沉浸模式">
          <ChevronLeft size={18} />
          <span>退出</span>
        </button>
        <div className="stage__meta">
          {track ? (
            <>
              <span className="stage__album">{track.album}</span>
              <span className="stage__artist">{track.artist}</span>
            </>
          ) : (
            <span className="stage__artist">没有在播放</span>
          )}
        </div>
      </header>

      {lyrics.empty ? (
        <div className="stage__lyrics">
          <div className="stage__nolyrics">
            <p>没有歌词</p>

            {onlineEnabled ? null : (
              <>
                <button className="btn stage__nolyrics-action" onClick={onEnableOnline}>
                  在线搜索
                </button>
                {/* The one place a lyric lookup leaves the machine, so the
                    consequence is stated before the switch, not after. Kept to
                    one line on purpose. */}
                <p className="stage__nolyrics-hint">会把歌名和艺术家发送到 lrclib.net</p>
              </>
            )}
          </div>
        </div>
      ) : (
        <LyricColumn lyrics={lyrics} onSeek={onSeek} />
      )}

      <footer className="stage__bottom">
        <button
          className="stage__play"
          onClick={onToggle}
          disabled={!track}
          aria-label={playing ? '暂停' : '播放'}
        >
          {playing ? <Pause size={20} /> : <Play size={20} />}
        </button>

        <StageProgress duration={duration} onSeekRatio={onSeekRatio} />
      </footer>
    </div>
  )
}
