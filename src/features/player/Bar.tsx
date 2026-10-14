import { useCallback, useRef } from 'react'
import { usePlayer } from './store'

/**
 * Resolution at which the transport chrome reads the playhead.
 *
 * One eighth of a second. The reason is geometric: a seek bar is a few hundred
 * pixels wide, so an eighth of a second moves it by far less than a pixel on
 * anything longer than half a minute (a 200 s track on a 600 px bar moves 0.4 px
 * per step; a 30 s track, the worst realistic case, moves 2.5 px at 8 Hz while
 * the knob itself travels 20 px/s, which still reads as motion, not as stepping).
 *
 * Why it matters: zustand compares the selector result with `Object.is`, so
 * quantising here collapses sixty store notifications per second into one
 * re-render per *visible* change. The bar, its knob and the elapsed-time text
 * are then written ~8 times a second instead of ~60, and every one of those
 * writes is sub-pixel.
 *
 * What deliberately does *not* use this: the lyric highlight. A line has to
 * appear within a frame of its timestamp, so `LyricColumn` keeps reading the raw
 * position; that subscription costs nothing because its selector returns a line
 * index and therefore only re-renders at line boundaries.
 */
const PROGRESS_STEP_SECONDS = 1 / 8

/** Playhead position, quantised to {@link PROGRESS_STEP_SECONDS}. */
export function useProgressPosition(): number {
  return usePlayer(
    (state) => Math.round(state.position / PROGRESS_STEP_SECONDS) * PROGRESS_STEP_SECONDS
  )
}

interface BarProps {
  /** Playhead position, 0..1. */
  value: number
  onChange: (value: number) => void
  ariaLabel: string
  disabled?: boolean
  className?: string
}

/**
 * A scrubbable horizontal bar. Uses pointer capture so a drag that leaves the
 * element (which is what happens whenever you drag a seek bar) keeps tracking,
 * and exposes the slider role so keyboard and screen readers work too.
 */
export function Bar({ value, onChange, ariaLabel, disabled, className }: BarProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const pct = Math.min(1, Math.max(0, value)) * 100

  const seekTo = useCallback(
    (clientX: number) => {
      const el = trackRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0) return
      onChange(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)))
    },
    [onChange]
  )

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return
      event.currentTarget.setPointerCapture(event.pointerId)
      seekTo(event.clientX)
    },
    [disabled, seekTo]
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (disabled) return
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
      seekTo(event.clientX)
    },
    [disabled, seekTo]
  )

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (disabled) return
      const step = event.shiftKey ? 0.1 : 0.02
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
        event.preventDefault()
        onChange(Math.min(1, value + step))
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
        event.preventDefault()
        onChange(Math.max(0, value - step))
      } else if (event.key === 'Home') {
        event.preventDefault()
        onChange(0)
      } else if (event.key === 'End') {
        event.preventDefault()
        onChange(1)
      }
    },
    [disabled, onChange, value]
  )

  return (
    <div
      className={className ? `bar ${className}` : 'bar'}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-disabled={disabled || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onKeyDown={onKeyDown}
    >
      <div className="bar__track" ref={trackRef}>
        <div className="bar__fill" style={{ width: `${pct}%` }} />
        <div className="bar__knob" style={{ left: `${pct}%` }} />
      </div>
    </div>
  )
}
