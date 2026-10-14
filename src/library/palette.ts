/**
 * Dominant-colour extraction.
 *
 * This is the mechanism behind the whole visual concept: the interface owns no
 * colour, and takes every chromatic value from the artwork of the track that is
 * playing. Covers are data URIs or local files, both same-origin, so the canvas
 * stays untainted and `getImageData` is safe to call.
 */

export interface Palette {
  /** Primary accent, `#rrggbb`. */
  accent: string
  /** Accent as separated channels, for `rgb(var(--accent-rgb) / a)`. */
  accentRgb: string
  /** Ordered companion colours for ribbons and motes. */
  colors: string[]
}

export const IDLE_PALETTE: Palette = {
  accent: '#7d8899',
  accentRgb: '125 136 153',
  colors: ['#7d8899', '#5d6774', '#939db0']
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

export function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((c) => clamp255(c).toString(16).padStart(2, '0')).join('')}`
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`could not load artwork: ${src.slice(0, 64)}`))
    img.src = src
  })
}

/** Push a colour away from grey so extracted accents stay legible on near-black. */
function saturate(rgb: [number, number, number], amount: number): [number, number, number] {
  const max = Math.max(...rgb)
  const min = Math.min(...rgb)
  const luma = (max + min) / 2
  return rgb.map((c) => clamp255(luma + (c - luma) * amount)) as [number, number, number]
}

function liftForDarkUi(rgb: [number, number, number]): [number, number, number] {
  const max = Math.max(...rgb)
  // Very dark accents vanish against the ink ramp; raise them into view.
  if (max >= 96) return rgb
  const gain = 96 / Math.max(1, max)
  return rgb.map((c) => clamp255(c * gain)) as [number, number, number]
}

/** Resolve the palette for an artwork source. Never throws: falls back to idle. */
export async function extractPalette(src: string): Promise<Palette> {
  let data: Uint8ClampedArray
  try {
    const img = await loadImage(src)
    const size = 48
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return IDLE_PALETTE
    ctx.drawImage(img, 0, 0, size, size)
    data = ctx.getImageData(0, 0, size, size).data
  } catch {
    return IDLE_PALETTE
  }

  // 4 bits per channel: 4096 buckets, enough to separate hues without
  // fragmenting one region across many near-identical bins.
  const buckets = new Map<number, { r: number; g: number; b: number; n: number }>()
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const a = data[i + 3]
    if (a < 128) continue
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const found = buckets.get(key)
    if (found) {
      found.r += r
      found.g += g
      found.b += b
      found.n += 1
    } else {
      buckets.set(key, { r, g, b, n: 1 })
    }
  }

  if (buckets.size === 0) return IDLE_PALETTE

  const scored = [...buckets.values()]
    .map((bucket) => {
      const avg: [number, number, number] = [
        bucket.r / bucket.n,
        bucket.g / bucket.n,
        bucket.b / bucket.n
      ]
      const max = Math.max(...avg)
      const min = Math.min(...avg)
      const saturation = max === 0 ? 0 : (max - min) / max
      const lightness = max / 255
      // Reward saturation and mid lightness; reject mud and blown highlights.
      const midWeight = 1 - Math.abs(lightness - 0.55) * 1.25
      return { avg, weight: bucket.n * (0.28 + saturation * 1.9) * Math.max(0.05, midWeight) }
    })
    .sort((a, b) => b.weight - a.weight)

  const chosen: [number, number, number][] = []
  for (const candidate of scored) {
    // Keep companions separable in hue so ribbons do not collapse into one wash.
    const hue = hueOf(candidate.avg)
    const tooClose = chosen.some((existing) => {
      const delta = Math.abs(hueOf(existing) - hue)
      return Math.min(delta, 360 - delta) < 26
    })
    if (tooClose) continue
    chosen.push(saturate(liftForDarkUi(candidate.avg), 1.28))
    if (chosen.length === 4) break
  }

  if (chosen.length === 0) return IDLE_PALETTE

  const primary = chosen[0]
  return {
    accent: toHex(primary),
    accentRgb: primary.map(clamp255).join(' '),
    colors: chosen.map(toHex)
  }
}

function hueOf([r, g, b]: [number, number, number]): number {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  if (d === 0) return 0
  let hue: number
  if (max === r) hue = ((g - b) / d) % 6
  else if (max === g) hue = (b - r) / d + 2
  else hue = (r - g) / d + 4
  hue *= 60
  return hue < 0 ? hue + 360 : hue
}
