import { useEffect, useRef } from 'react'
import type { Palette } from '../features/library/palette'
import { useWindowVisibility } from '../visibility'
import { buildColorTable, type ColorTable } from './colors'
import { createLevelReader } from './levels'

interface VisualizerProps {
  getSpectrum: () => Uint8Array | null
  palette: Palette
  className?: string
}

interface Mote {
  x: number
  y: number
  z: number
  vy: number
  drift: number
  phase: number
  color: number
}

const MOTE_COUNT = 340
const RIBBON_COUNT = 5

/**
 * Ceiling on the canvas backing store, in device pixels.
 *
 * The stage is a soft field of gradients and 1-3 px dots, and its cost is almost
 * entirely fill rate: at 1600x900 a super-sampled backing store (devicePixelRatio
 * 2) is 5.76M pixels and the drawing costs about three times what it costs at
 * 1.44M (measured: 16.03 ms/frame against 5.31 ms/frame of renderer CPU per
 * frame). So the device pixel ratio is only honoured up to this budget and then
 * scaled back by the square root of the overshoot, because the cost is
 * proportional to area, not to either dimension.
 *
 * Two deliberate limits:
 *  - the scale never drops below 1. At or below it the canvas would be rendering
 *    fewer pixels than it is displayed at, i.e. visibly soft, and that is a
 *    change to the picture rather than to its cost. A 4K window at 100% scaling
 *    therefore keeps its full backing store and this budget simply does not
 *    apply to it.
 *  - the ratio is capped at 2, exactly as before, so on an ordinary display the
 *    computed scale is still `min(devicePixelRatio, 2)` - the budget only ever
 *    trims super-sampling.
 */
const PIXEL_BUDGET = 4_000_000
const MIN_RENDER_SCALE = 1
const MAX_RENDER_SCALE = 2

/**
 * Below this broadband level the frame is already in its quiet shape.
 *
 * Every energy-driven term is scaled by it (glow alpha 0.2, ribbon alpha 0.85,
 * mote brightness 0.26-0.86), so at 0.02 the largest deviation any of them can
 * have from the silence value is 0.017 of alpha - about 1% of the strongest
 * ribbon pass, i.e. within the quantisation of the composited 8-bit result. The
 * threshold is not raised to, say, 0.05 for two reasons: at 0.05 the core ribbon
 * pass would swing by ~7/255 between "quiet" and "silent", and quiet *music* -
 * a fade, a bridge, a muted player - would already be treated as idle, where the
 * thing being given up is motion smoothness, not brightness.
 */
const CALM_ENERGY = 0.02

/**
 * How long the level must stay below {@link CALM_ENERGY} before the frame rate is
 * halved. The envelope's release constant is 0.045 per frame, so a track that
 * stops decays through the threshold in about 1.2 s; requiring a second of dwell
 * therefore costs at most one extra second of full-rate drawing and keeps a
 * momentary gap in the music from switching modes.
 */
const CALM_DWELL_MS = 1000

/**
 * The visual bed behind the lyric stage.
 *
 * Three layers, back to front: a soft light centred where the lyric sits (the
 * line reads as the light source for everything else), drifting aurora ribbons
 * whose amplitude follows the low end, and rising motes lit by the high end.
 *
 * A screenshot cannot show motion, so the composition has to hold still: the
 * ribbons stay legible at zero energy and the motes never drop below a visible
 * floor. A paused player should look calm, not broken.
 */
export function Visualizer({ getSpectrum, palette, className }: VisualizerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // Held in refs so changing artwork or driver never restarts the animation loop.
  const paletteRef = useRef(palette)
  const spectrumRef = useRef(getSpectrum)
  paletteRef.current = palette
  spectrumRef.current = getSpectrum

  /*
   * Whether anything this window draws can reach the screen.
   *
   * `useWindowVisibility` rather than `document.hidden`: inside Electron the page
   * can still report itself visible after the window was sent to the tray
   * (`backgroundThrottling: false` means nothing else throttles it either), so
   * the main process answers with Electron's own `isVisible()/isMinimized()`.
   * Idle-on-unfocused is deliberately not part of it - an unfocused window is
   * still on screen and keeps running at full rate. In a plain browser the hook
   * falls back to `document.hidden`, which is the accurate answer there, so the
   * preview behaves exactly as it did.
   */
  const { visible } = useWindowVisibility()
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  // Start/stop without tearing the effect down: rebuilding the canvas would
  // re-seed the mote field and make the whole stage jump on every tab switch.
  const loopRef = useRef<{ sync(): void } | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const read = createLevelReader(112)
    const motes: Mote[] = []
    let width = 1
    let height = 1
    let frame = 0
    let running = false
    let lastTime = performance.now()
    /// Palette colours the current table was built from; identity changes per track.
    let tableColors: readonly string[] | null = null
    let table: ColorTable = buildColorTable(paletteRef.current.colors)
    let calmSince = 0
    let skipped = false

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const requested = Math.min(window.devicePixelRatio || 1, MAX_RENDER_SCALE)
      width = Math.max(1, rect.width)
      height = Math.max(1, rect.height)
      const budgeted = Math.sqrt(PIXEL_BUDGET / (width * height))
      const scale = Math.min(requested, Math.max(MIN_RENDER_SCALE, budgeted))
      canvas.width = Math.round(width * scale)
      canvas.height = Math.round(height * scale)
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      seed()
    }

    const seed = () => {
      motes.length = 0
      for (let i = 0; i < MOTE_COUNT; i += 1) {
        motes.push({
          x: Math.random() * width,
          y: Math.random() * height,
          z: 0.25 + Math.random() * 0.75,
          vy: 7 + Math.random() * 26,
          drift: 0.4 + Math.random() * 1.5,
          phase: Math.random() * Math.PI * 2,
          color: i % 4
        })
      }
    }

    const observer = new ResizeObserver(resize)
    observer.observe(canvas)
    resize()

    const draw = (now: number) => {
      if (!running) return
      const dt = Math.min(0.05, (now - lastTime) / 1000)
      lastTime = now
      const t = now / 1000

      const levels = read(spectrumRef.current())
      const colors = paletteRef.current.colors
      if (colors !== tableColors) {
        table = buildColorTable(colors)
        tableColors = colors
      }
      const energy = levels.energy

      /*
       * Calm mode: with no audio energy the frame is already in its quiet shape,
       * so drawing it every other animation frame halves the cost of an idle or
       * paused stage without changing a single pixel of what a frame contains.
       * Halving rather than a fixed 30 fps keeps it a division of the display's
       * own refresh rate, and the mode is only ever entered from a level that is
       * indistinguishable from silence (see CALM_ENERGY).
       */
      if (energy < CALM_ENERGY) {
        if (calmSince === 0) calmSince = now
      } else {
        calmSince = 0
      }
      const calm = calmSince !== 0 && now - calmSince >= CALM_DWELL_MS
      if (calm) {
        skipped = !skipped
        if (skipped) {
          frame = requestAnimationFrame(draw)
          return
        }
      }

      ctx.clearRect(0, 0, width, height)

      // --- 1. the light the lyric line casts -------------------------------
      const centreY = height * 0.45
      const glowRadius = (0.34 + levels.bass * 0.26) * Math.max(width, height) * 0.62
      const glow = ctx.createRadialGradient(width / 2, centreY, 0, width / 2, centreY, glowRadius)
      glow.addColorStop(0, table.get(0, 0.17 + energy * 0.2))
      glow.addColorStop(0.5, table.get(1, 0.09 + energy * 0.1))
      glow.addColorStop(1, table.get(0, 0))
      ctx.fillStyle = glow
      /*
       * Only the gradient's own circle is painted: the outer stop is fully
       * transparent, so everything outside the radius composites to nothing.
       * Covering its bounding box instead of the whole canvas is therefore
       * pixel-identical and about three times less gradient work at this size
       * (0.66M of the 1.44M device pixels at 1600x900).
       */
      ctx.fillRect(
        width / 2 - glowRadius,
        centreY - glowRadius,
        glowRadius * 2,
        glowRadius * 2
      )

      // --- 2. aurora ribbons ----------------------------------------------
      ctx.globalCompositeOperation = 'lighter'
      for (let r = 0; r < RIBBON_COUNT; r += 1) {
        const baseY = height * (0.16 + r * 0.155)
        const amp = (10 + levels.bass * 120 + levels.mid * 62) * (0.55 + r * 0.18)
        const freq = 0.0015 + r * 0.00085
        const speed = 0.2 + r * 0.12
        const phase = r * 1.7
        const scale = 1 - r * 0.13

        ctx.beginPath()
        for (let x = -8; x <= width + 8; x += 10) {
          const y =
            baseY +
            Math.sin(x * freq + t * speed + phase) * amp +
            Math.sin(x * freq * 2.7 - t * speed * 0.66 + phase) * amp * 0.32
          if (x <= -8) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }

        // Three passes of one path: a cheap, stable glow that avoids
        // shadowBlur, which is far too slow to run per frame at this size.
        const passes: [number, number][] = [
          [32 * scale, 0.07],
          [11 * scale, 0.1],
          [1.6, 0.62]
        ]
        for (const [lineWidth, alpha] of passes) {
          ctx.strokeStyle = table.get(r, alpha * (0.45 + energy * 0.85))
          ctx.lineWidth = lineWidth
          ctx.stroke()
        }
      }

      // --- 3. rising motes -------------------------------------------------
      for (const mote of motes) {
        mote.y -= mote.vy * mote.z * dt
        mote.x += Math.sin(t * mote.drift + mote.phase) * 7 * dt
        if (mote.y < -14) {
          mote.y = height + 14
          mote.x = Math.random() * width
        }
        // Never fully dark: a paused stage should still read as a field.
        const brightness =
          (0.08 + levels.treble * 0.6 + energy * 0.26) * mote.z + 0.06 * mote.z
        ctx.fillStyle = table.get(mote.color, Math.min(0.85, brightness))
        ctx.beginPath()
        ctx.arc(mote.x, mote.y, 0.8 + mote.z * 2.6, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
      frame = requestAnimationFrame(draw)
    }

    const start = () => {
      if (running) return
      running = true
      // Reset the clock so the first frame after resuming does not see a
      // multi-second delta and jump the whole field.
      lastTime = performance.now()
      // A resume after silence should not carry the previous calm dwell over.
      calmSince = 0
      frame = requestAnimationFrame(draw)
    }

    const stop = () => {
      running = false
      cancelAnimationFrame(frame)
      frame = 0
    }

    /*
     * The window is created with `backgroundThrottling: false` so playback is
     * not throttled when minimised - which also means requestAnimationFrame
     * keeps firing. Without this the visualiser would go on compositing a canvas
     * nobody can see, which is pure battery.
     */
    const sync = () => {
      if (visibleRef.current) start()
      else stop()
    }

    loopRef.current = { sync }
    sync()

    return () => {
      loopRef.current = null
      stop()
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    loopRef.current?.sync()
  }, [visible])

  return <canvas ref={canvasRef} className={className ? `viz ${className}` : 'viz'} aria-hidden="true" />
}
