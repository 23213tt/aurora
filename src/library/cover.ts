/**
 * Deterministic placeholder artwork.
 *
 * Used for design previews and screenshots so the interface can be judged with
 * a populated library before any real files exist. Real artwork always wins:
 * this is only a fallback for the demo dataset.
 *
 * Each cover is one soft wash for depth plus a crisp geometric subject. The
 * crisp layer is the point - all-blurred gradient blobs read as generated filler
 * rather than as artwork, and the dominant-colour extractor needs real edge
 * colours to have anything interesting to find.
 */

function hashOf(seed: string): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const LAYOUTS = 3

export function coverFor(seed: string, size = 512): string {
  const h = hashOf(seed)
  const hue = h % 360
  const layout = (h >> 9) % LAYOUTS
  const s = size
  const round = (value: number) => value.toFixed(1)

  const strong = `hsl(${hue} 76% 58%)`
  const mid = `hsl(${(hue + 34) % 360} 70% 46%)`
  const deep = `hsl(${(hue + 316) % 360} 64% 24%)`
  const pale = `hsl(${(hue + 12) % 360} 82% 76%)`

  const washBlur = `<filter id="wash" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="${round(s * 0.11)}"/>
    </filter>`

  const washX = 0.24 + ((h >> 17) % 50) / 100
  const washY = 0.2 + ((h >> 21) % 55) / 100
  const wash = `<g filter="url(#wash)">
      <circle cx="${round(s * washX)}" cy="${round(s * washY)}" r="${round(s * 0.34)}" fill="${strong}"/>
      <circle cx="${round(s * (1 - washX))}" cy="${round(s * (1 - washY))}" r="${round(s * 0.27)}" fill="${mid}"/>
    </g>`

  const stroke = round(s * 0.009)
  let subject = ''

  if (layout === 0) {
    // Concentric rings, cropped by the frame.
    const cx = s * (0.34 + ((h >> 5) % 32) / 100)
    const cy = s * (0.4 + ((h >> 7) % 26) / 100)
    subject =
      `<g fill="none" stroke="${pale}" stroke-width="${stroke}" opacity="0.9">` +
      `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(s * 0.3)}"/>` +
      `<circle cx="${round(cx)}" cy="${round(cy)}" r="${round(s * 0.2)}" opacity="0.55"/>` +
      `</g>` +
      `<circle cx="${round(s * 0.73)}" cy="${round(s * 0.3)}" r="${round(s * 0.045)}" fill="${pale}"/>`
  } else if (layout === 1) {
    // A horizon: solid mass at the base, a disc above it.
    const horizon = s * (0.58 + ((h >> 6) % 12) / 100)
    const discR = s * (0.09 + ((h >> 11) % 8) / 100)
    subject =
      `<rect x="0" y="${round(horizon)}" width="${s}" height="${round(s - horizon)}" fill="${deep}"/>` +
      `<circle cx="${round(s * 0.68)}" cy="${round(horizon - discR * 0.7)}" r="${round(discR)}" fill="${pale}"/>` +
      `<g stroke="${pale}" stroke-width="${stroke}" opacity="0.6">` +
      `<line x1="0" y1="${round(horizon)}" x2="${s}" y2="${round(horizon)}"/>` +
      `<line x1="0" y1="${round(horizon + s * 0.055)}" x2="${round(s * 0.62)}" y2="${round(horizon + s * 0.055)}"/>` +
      `</g>`
  } else {
    // A column set: seven bars, aligned to a common baseline.
    const bars = 7
    const gap = s * 0.028
    const barW = (s * 0.72 - gap * (bars - 1)) / bars
    const left = s * 0.14
    const baseline = s * 0.86
    let rects = ''
    for (let i = 0; i < bars; i += 1) {
      const t = ((h >> (i + 3)) % 9) / 8
      const barH = s * (0.16 + t * 0.54)
      rects +=
        `<rect x="${round(left + i * (barW + gap))}" y="${round(baseline - barH)}" ` +
        `width="${round(barW)}" height="${round(barH)}" rx="${round(barW * 0.16)}" ` +
        `fill="${i % 2 === 0 ? pale : mid}" opacity="${(0.7 + t * 0.3).toFixed(2)}"/>`
    }
    subject = rects
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">` +
    `<defs>${washBlur}` +
    `<linearGradient id="base" x1="0" y1="0" x2="0.65" y2="1">` +
    `<stop offset="0" stop-color="${deep}"/>` +
    `<stop offset="1" stop-color="#07090c"/>` +
    `</linearGradient>` +
    `<radialGradient id="vig" cx="0.5" cy="0.42" r="0.8">` +
    `<stop offset="0.5" stop-color="#000" stop-opacity="0"/>` +
    `<stop offset="1" stop-color="#000" stop-opacity="0.5"/>` +
    `</radialGradient>` +
    `</defs>` +
    `<rect width="${s}" height="${s}" fill="url(#base)"/>` +
    wash +
    subject +
    `<rect width="${s}" height="${s}" fill="url(#vig)"/>` +
    `</svg>`

  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}
