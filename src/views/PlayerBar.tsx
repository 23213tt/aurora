import { artworkFor } from '../features/library/source'
import type { RepeatMode, Track } from '../types'
import { Bar, useProgressPosition } from '../features/player/Bar'
import { formatTime } from '../ui/format'
import { Artwork } from '../ui/Artwork'
import {
  DesktopLyrics,
  Lyrics,
  Next,
  Note,
  Pause,
  Play,
  Prev,
  Queue,
  Repeat,
  RepeatOne,
  Shuffle,
  Sliders,
  Volume,
  VolumeMute
} from '../ui/icons'

/**
 * The seek row owns the playhead subscription.
 *
 * Isolating it here is the point: this subtree re-renders whenever the playhead
 * moves, and everything else in the app does not. Measured with the preview
 * render counter, moving the subscription from the app root to this component
 * takes full-tree renders out of the playback path entirely.
 *
 * `useProgressPosition` rather than `usePosition` is the second half of that:
 * the position it returns only changes once the playhead has advanced an eighth
 * of a second, which is under a pixel of travel on this bar, so the inline style
 * that draws the fill and the knob is written roughly eight times a second
 * instead of on every animation frame.
 */
function SeekRow({
  duration,
  disabled,
  onSeekRatio
}: {
  duration: number
  disabled: boolean
  onSeekRatio(ratio: number): void
}) {
  const position = useProgressPosition()
  const ratio = duration > 0 ? Math.min(1, position / duration) : 0

  return (
    <div className="seek">
      <span className="seek__time">{formatTime(position)}</span>
      <Bar
        value={ratio}
        onChange={onSeekRatio}
        disabled={disabled || duration <= 0}
        ariaLabel="播放进度"
      />
      <span className="seek__time seek__time--end">{formatTime(duration)}</span>
    </div>
  )
}

interface PlayerBarProps {
  track: Track | null
  playing: boolean
  loading: boolean
  duration: number
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: RepeatMode
  eqOpen: boolean
  desktopLyricsOpen: boolean
  onToggle(): void
  onNext(): void
  onPrev(): void
  onSeekRatio(ratio: number): void
  onVolume(volume: number): void
  onToggleMute(): void
  onToggleShuffle(): void
  onCycleRepeat(): void
  onOpenStage(): void
  onToggleEq(): void
  onOpenQueue(): void
  onToggleDesktopLyrics(): void
}

export function PlayerBar({
  track,
  playing,
  loading,
  duration,
  volume,
  muted,
  shuffle,
  repeat,
  eqOpen,
  desktopLyricsOpen,
  onToggle,
  onNext,
  onPrev,
  onSeekRatio,
  onVolume,
  onToggleMute,
  onToggleShuffle,
  onCycleRepeat,
  onOpenStage,
  onToggleEq,
  onOpenQueue,
  onToggleDesktopLyrics
}: PlayerBarProps) {
  const effectiveVolume = muted ? 0 : volume
  const art = artworkFor(track)

  return (
    <footer className="player">
      <div className="now">
        {/* Clicking the artwork is the conventional way into an immersive view. */}
        <button
          className="now__art"
          onClick={onOpenStage}
          disabled={!track}
          title={track ? '沉浸模式 (L)' : undefined}
          aria-label="打开沉浸模式"
        >
          <Artwork
            src={art}
            fallback={
              <span className="now__art-empty">
                <Note size={20} />
              </span>
            }
          />
        </button>

        <div className="now__text">
          {track ? (
            <>
              <div className="now__title" title={track.title}>
                {track.title}
              </div>
              <div className="now__artist" title={track.artist}>
                {track.artist}
              </div>
            </>
          ) : (
            <>
              <div className="now__title now__idle">没有在播放</div>
              <div className="now__artist now__idle">从曲库里挑一张专辑</div>
            </>
          )}
        </div>
      </div>

      <div className="transport">
        <div className="transport__row">
          <button
            className={`icon-btn${shuffle ? ' is-on' : ''}`}
            onClick={onToggleShuffle}
            title="随机播放"
            aria-label="随机播放"
            aria-pressed={shuffle}
          >
            <Shuffle size={16} />
          </button>
          <button className="icon-btn" onClick={onPrev} title="上一首" aria-label="上一首">
            <Prev size={19} />
          </button>
          <button
            className="play-btn"
            onClick={onToggle}
            disabled={!track}
            title={playing ? '暂停' : '播放'}
            aria-label={playing ? '暂停' : '播放'}
          >
            {loading && !playing ? (
              <span className="spinner" />
            ) : playing ? (
              <Pause size={18} />
            ) : (
              <Play size={18} />
            )}
          </button>
          <button className="icon-btn" onClick={onNext} title="下一首" aria-label="下一首">
            <Next size={19} />
          </button>
          <button
            className={`icon-btn${repeat !== 'off' ? ' is-on' : ''}`}
            onClick={onCycleRepeat}
            title={repeat === 'off' ? '循环关闭' : repeat === 'all' ? '列表循环' : '单曲循环'}
            aria-label="循环模式"
          >
            {repeat === 'one' ? <RepeatOne size={16} /> : <Repeat size={16} />}
          </button>
        </div>

        <SeekRow duration={duration} disabled={!track} onSeekRatio={onSeekRatio} />
      </div>

      <div className="player__right">
        <button
          className={`icon-btn${desktopLyricsOpen ? ' is-on' : ''}`}
          onClick={onToggleDesktopLyrics}
          title="桌面歌词 (Ctrl+Alt+L)"
          aria-label="桌面歌词"
          aria-pressed={desktopLyricsOpen}
        >
          <DesktopLyrics size={17} />
        </button>
        <button
          className="icon-btn"
          onClick={onOpenQueue}
          title="播放队列"
          aria-label="播放队列"
        >
          <Queue size={17} />
        </button>
        <button
          className={`icon-btn${eqOpen ? ' is-on' : ''}`}
          onClick={onToggleEq}
          title="均衡器 (E)"
          aria-label="均衡器"
          aria-pressed={eqOpen}
        >
          <Sliders size={17} />
        </button>
        <button
          className="icon-btn"
          onClick={onOpenStage}
          disabled={!track}
          title="沉浸模式 (L)"
          aria-label="沉浸模式"
        >
          <Lyrics size={17} />
        </button>
        <button
          className="icon-btn"
          onClick={onToggleMute}
          title={muted ? '取消静音' : '静音'}
          aria-label={muted ? '取消静音' : '静音'}
        >
          {effectiveVolume === 0 ? <VolumeMute size={17} /> : <Volume size={17} />}
        </button>
        <Bar className="volume" value={effectiveVolume} onChange={onVolume} ariaLabel="音量" />
      </div>
    </footer>
  )
}
