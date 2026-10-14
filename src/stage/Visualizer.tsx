import { useEffect, useRef } from 'react'
import type { Palette } from '../library/palette'
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

/** `#rrggbb` (or `#rgb`) to an rgba() string. Alpha is clamped defensively. */
function hexA(hex: string, alpha: number): string {
  let value = hex.trim()
  if (value.startsWith('#')) value = value.slice(1)
  if (value.length === 3) value = value.split('').map((c) => c + c).join('')
  const int = Number.parseInt(value, 16)
  if (!Number.isFinite(int) || value.length !== 6) return `rgba(255,255,255,${alpha})`
  const r = (int >> 16) & 255
  const g = (int >> 8) & 255
  const b = int & 255
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, alpha)).toFixed(3)})`
}

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

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      width = Math.max(1, rect.width)
      height = Math.max(1, rect.height)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
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
      const energy = levels.energy

      ctx.clearRect(0, 0, width, height)

      // --- 1. the light the lyric line casts -------------------------------
      const centreY = height * 0.45
      const glowRadius = (0.34 + levels.bass * 0.26) * Math.max(width, height) * 0.62
      const glow = ctx.createRadialGradient(width / 2, centreY, 0, width / 2, centreY, glowRadius)
      glow.addColorStop(0, hexA(colors[0], 0.17 + energy * 0.2))
      glow.addColorStop(0.5, hexA(colors[1] ?? colors[0], 0.09 + energy * 0.1))
      glow.addColorStop(1, hexA(colors[0], 0))
      ctx.fillStyle = glow
      ctx.fillRect(0, 0, width, height)

      // --- 2. aurora ribbons ----------------------------------------------
      ctx.globalCompositeOperation = 'lighter'
      for (let r = 0; r < RIBBON_COUNT; r += 1) {
        const color = colors[r % colors.length]
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
          ctx.strokeStyle = hexA(color, alpha * (0.45 + energy * 0.85))
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
        ctx.fillStyle = hexA(colors[mote.color % colors.length], Math.min(0.85, brightness))
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
    const onVisibility = () => {
      if (document.hidden) stop()
      else start()
    }

    document.addEventListener('visibilitychange', onVisibility)
    start()

    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
      observer.disconnect()
    }
  }, [])

  return <canvas ref={canvasRef} className={className ? `viz ${className}` : 'viz'} aria-hidden="true" />
}
