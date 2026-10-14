import { useEffect, useState } from 'react'
import { Close, Lock, Minus, Plus, Unlock } from '../components/icons'
import { bridge } from '../bridge'
import type { OverlayState } from '../env'

/** Font size is a property of this window, so it lives in its own storage. */
const SIZE_KEY = 'aurora.desktopLyrics.size'
const MIN_SIZE = 18
const MAX_SIZE = 64
const DEFAULT_SIZE = 34

const IDLE: OverlayState = { text: null, next: null, title: '', artist: '', playing: false }

/**
 * The desktop lyric strip.
 *
 * Renders in its own transparent, always-on-top window. Two states matter:
 * locked means the window ignores the mouse entirely so it never blocks a click
 * on whatever is underneath; unlocked means it can be dragged and the control
 * strip is reachable.
 */
export function Overlay() {
  const [state, setState] = useState<OverlayState>(IDLE)
  const [locked, setLocked] = useState(true)
  const [size, setSize] = useState(() => {
    const saved = Number.parseInt(localStorage.getItem(SIZE_KEY) ?? '', 10)
    if (!Number.isFinite(saved)) return DEFAULT_SIZE
    return Math.min(MAX_SIZE, Math.max(MIN_SIZE, saved))
  })

  useEffect(() => bridge.overlay.onState(setState), [])

  useEffect(() => {
    void bridge.overlay.getStatus().then((status) => setLocked(status.locked))
  }, [])

  useEffect(() => {
    localStorage.setItem(SIZE_KEY, String(size))
  }, [size])

  const setLock = async (next: boolean) => {
    const applied = await bridge.overlay.setLocked(next)
    setLocked(applied)
  }

  return (
    <div
      className={`stage-lyric${locked ? ' is-locked' : ''}`}
      style={{ ['--lyric-size' as string]: `${size}px` }}
    >
      <div className="stage-lyric__controls">
        <button
          className="stage-lyric__button"
          onClick={() => setSize((value) => Math.max(MIN_SIZE, value - 2))}
          disabled={size <= MIN_SIZE}
          title="缩小字号"
          aria-label="缩小字号"
        >
          <Minus size={14} />
        </button>
        <button
          className="stage-lyric__button"
          onClick={() => setSize((value) => Math.min(MAX_SIZE, value + 2))}
          disabled={size >= MAX_SIZE}
          title="放大字号"
          aria-label="放大字号"
        >
          <Plus size={14} />
        </button>
        <button
          className="stage-lyric__button"
          onClick={() => void setLock(!locked)}
          title={locked ? '解锁（解锁后才能拖动）' : '锁定（锁定后鼠标穿透）'}
          aria-label={locked ? '解锁桌面歌词' : '锁定桌面歌词'}
        >
          {locked ? <Lock size={14} /> : <Unlock size={14} />}
        </button>
        <button
          className="stage-lyric__button"
          onClick={() => void bridge.overlay.close()}
          title="关闭桌面歌词"
          aria-label="关闭桌面歌词"
        >
          <Close size={14} />
        </button>
      </div>

      {state.text ? (
        <>
          <div className="stage-lyric__line">{state.text}</div>
          {state.next ? <div className="stage-lyric__next">{state.next}</div> : null}
        </>
      ) : state.title ? (
        // Lyrics are not the only useful thing to show: this keeps the strip
        // meaningful for instrumentals and untagged files.
        <div className="stage-lyric__idle">
          {state.playing ? '♪ ' : '❙❙ '}
          {state.title}
          {state.artist ? ` — ${state.artist}` : ''}
        </div>
      ) : (
        <div className="stage-lyric__idle">Aurora 桌面歌词</div>
      )}
    </div>
  )
}
