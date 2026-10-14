import { useCallback, useRef } from 'react'
import { EQ_BANDS } from '../features/player/store'
import { Close, Wave } from '../ui/icons'

const MIN_DB = -12
const MAX_DB = 12

 interface EqPreset {
  name: string
  gains: number[]
}

/**
 * Presets are written against the band layout in `player/store.ts`
 * (32 64 125 250 500 1k 2k 4k 8k 16k). They are starting points, not claims
 * about correctness: an EQ curve depends entirely on the headphones or speakers
 * in front of you.
 */
 const EQ_PRESETS: EqPreset[] = [
  { name: '平直', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  { name: '低频加强', gains: [6, 5, 3, 1, 0, 0, 0, 0, 0, 0] },
  { name: '人声', gains: [-2, -1, 0, 2, 4, 4, 3, 1, 0, 0] },
  { name: '器乐', gains: [4, 3, 1, 0, -1, -1, 0, 1, 2, 3] },
  { name: '降低齿音', gains: [0, 0, 0, 0, 0, -1, -2, -3, -2, 0] }
]

function formatFreq(hz: number): string {
  return hz >= 1000 ? `${hz / 1000}k` : String(hz)
}

interface BandProps {
  freq: number
  gain: number
  disabled: boolean
  onChange(gain: number): void
}

function Band({ freq, gain, disabled, onChange }: BandProps) {
  const trackRef = useRef<HTMLDivElement>(null)

  const fromClientY = useCallback(
    (clientY: number) => {
      const element = trackRef.current
      if (!element) return
      const rect = element.getBoundingClientRect()
      if (rect.height <= 0) return
      const ratio = 1 - (clientY - rect.top) / rect.height
      const clamped = Math.min(1, Math.max(0, ratio))
      onChange(Math.round(MIN_DB + clamped * (MAX_DB - MIN_DB)))
    },
    [onChange]
  )

  const percent = ((gain - MIN_DB) / (MAX_DB - MIN_DB)) * 100
  const zero = ((0 - MIN_DB) / (MAX_DB - MIN_DB)) * 100
  // The fill grows out of the 0 dB line in both directions, the way a hardware
  // fader reads, rather than always filling from the bottom.
  const fillBottom = gain >= 0 ? zero : percent
  const fillHeight = Math.abs(percent - zero)

  return (
    <div className="band">
      <div
        className="band__track"
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={`${freq} 赫兹`}
        aria-valuemin={MIN_DB}
        aria-valuemax={MAX_DB}
        aria-valuenow={gain}
        aria-valuetext={`${gain > 0 ? '+' : ''}${gain} 分贝`}
        aria-disabled={disabled || undefined}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          fromClientY(event.clientY)
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
          fromClientY(event.clientY)
        }}
        onDoubleClick={() => onChange(0)}
        onKeyDown={(event) => {
          const step = event.shiftKey ? 3 : 1
          if (event.key === 'ArrowUp') {
            event.preventDefault()
            onChange(Math.min(MAX_DB, gain + step))
          } else if (event.key === 'ArrowDown') {
            event.preventDefault()
            onChange(Math.max(MIN_DB, gain - step))
          } else if (event.key === 'Home') {
            event.preventDefault()
            onChange(MIN_DB)
          } else if (event.key === 'End') {
            event.preventDefault()
            onChange(MAX_DB)
          } else if (event.key === '0') {
            event.preventDefault()
            onChange(0)
          }
        }}
      >
        <div className="band__rail" />
        <div className="band__zero" />
        <div className="band__fill" style={{ bottom: `${fillBottom}%`, height: `${fillHeight}%` }} />
        <div className="band__knob" style={{ bottom: `${percent}%` }} />
      </div>
      <div className="band__value tnum">{gain > 0 ? `+${gain}` : gain}</div>
      <div className="band__freq">{formatFreq(freq)}</div>
    </div>
  )
}

interface EqPanelProps {
  open: boolean
  enabled: boolean
  gains: number[]
  onToggle(enabled: boolean): void
  onGain(index: number, gain: number): void
  onPreset(gains: number[]): void
  onClose(): void
}

export function EqPanel({ open, enabled, gains, onToggle, onGain, onPreset, onClose }: EqPanelProps) {
  if (!open) return null

  const isFlat = gains.every((gain) => gain === 0)

  return (
    <aside className="panel" aria-label="均衡器">
      <header className="panel__head">
        <h2 className="panel__title">均衡器</h2>
        <button
          className={`switch${enabled ? ' is-on' : ''}`}
          role="switch"
          aria-checked={enabled}
          onClick={() => onToggle(!enabled)}
          title={enabled ? '关闭均衡器' : '开启均衡器'}
        >
          <span className="switch__dot" />
        </button>
        <button className="icon-btn" onClick={onClose} title="关闭" aria-label="关闭均衡器">
          <Close size={16} />
        </button>
      </header>

      <div className="panel__presets">
        {EQ_PRESETS.map((preset) => {
          const active = preset.gains.every((gain, i) => gain === (gains[i] ?? 0))
          return (
            <button
              key={preset.name}
              className={`chip${active ? ' is-active' : ''}`}
              onClick={() => onPreset(preset.gains)}
            >
              {preset.name}
            </button>
          )
        })}
      </div>

      <div className="panel__bands">
        {EQ_BANDS.map((freq, index) => (
          <Band
            key={freq}
            freq={freq}
            gain={gains[index] ?? 0}
            disabled={!enabled}
            onChange={(gain) => onGain(index, gain)}
          />
        ))}
      </div>

      <footer className="panel__foot">
        <button className="btn" onClick={() => onPreset(EQ_BANDS.map(() => 0))} disabled={isFlat}>
          <Wave size={15} />
          重置为平直
        </button>
      </footer>
    </aside>
  )
}
