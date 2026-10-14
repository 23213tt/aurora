import { useCallback, useRef } from 'react'

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

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => n.toString().padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
