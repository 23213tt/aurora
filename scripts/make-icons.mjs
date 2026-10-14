/**
 * Generates the application icons from vector definitions.
 *
 * Why not render `scripts/icon.html` with a screenshot tool: a headless page
 * screenshot composites onto white and produces an RGB image with **no alpha
 * channel**, so the rounded corners ship as white blocks. App icons also need
 * several sizes, which one screenshot cannot provide.
 *
 * This rasterises the same design analytically (4x4 supersampling), keeps exact
 * alpha, and writes a multi-size Windows .ico plus a tray icon.
 *
 * Usage: node scripts/make-icons.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/*
 * Two destinations, for two different consumers.
 *
 * `build/` is electron-builder's buildResources directory: it is read at build
 * time to stamp the executable icon and is *not* copied into the packaged app.
 * `assets/icons/` is listed in the `files` config, so it ships inside the asar
 * and `nativeImage.createFromPath` can load it at run time. Putting the tray and
 * thumbnail glyphs in build/ would leave a packaged app with no tray icon.
 */
const buildDir = path.join(root, 'build')
const assetDir = path.join(root, 'assets', 'icons')

// --- PNG encoding ----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed), 0)
  return Buffer.concat([length, typed, crc])
}

/** Encode 8-bit RGBA pixels as a PNG. Filter 0 on every row keeps it simple. */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: truecolour + alpha
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

// --- colour helpers --------------------------------------------------------

const hex = (value) => [
  parseInt(value.slice(1, 3), 16),
  parseInt(value.slice(3, 5), 16),
  parseInt(value.slice(5, 7), 16)
]

/** Piecewise-linear gradient along the axis a -> b, in design coordinates. */
function linearStops(stops) {
  return stops.map(([offset, color, alpha = 1]) => ({ offset, rgb: hex(color), alpha }))
}

function sampleStops(stops, t) {
  const clamped = Math.min(1, Math.max(0, t))
  for (let i = 0; i < stops.length - 1; i += 1) {
    const a = stops[i]
    const b = stops[i + 1]
    if (clamped <= b.offset) {
      const span = b.offset - a.offset || 1
      const k = (clamped - a.offset) / span
      return [
        a.rgb[0] + (b.rgb[0] - a.rgb[0]) * k,
        a.rgb[1] + (b.rgb[1] - a.rgb[1]) * k,
        a.rgb[2] + (b.rgb[2] - a.rgb[2]) * k,
        a.alpha + (b.alpha - a.alpha) * k
      ]
    }
  }
  const last = stops[stops.length - 1]
  return [last.rgb[0], last.rgb[1], last.rgb[2], last.alpha]
}

function gradientAt(stops, from, to, x, y) {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const lengthSq = dx * dx + dy * dy || 1
  return sampleStops(stops, ((x - from[0]) * dx + (y - from[1]) * dy) / lengthSq)
}

// --- geometry --------------------------------------------------------------

/** Cubic bezier flattened to a polyline, as flat [x0,y0,x1,y1,...]. */
function flattenCubic(p0, p1, p2, p3, steps = 40) {
  const points = []
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const u = 1 - t
    points.push(
      u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
      u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]
    )
  }
  return points
}

function polylineBounds(line, pad) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < line.length; i += 2) {
    if (line[i] < minX) minX = line[i]
    if (line[i] > maxX) maxX = line[i]
    if (line[i + 1] < minY) minY = line[i + 1]
    if (line[i + 1] > maxY) maxY = line[i + 1]
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad }
}

function distanceToSegmentSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  let t = lengthSq > 0 ? ((px - ax) * dx + (py - ay) * dy) / lengthSq : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const cx = ax + t * dx
  const cy = ay + t * dy
  return (px - cx) * (px - cx) + (py - cy) * (py - cy)
}

function distanceToPolylineSq(px, py, line) {
  let best = Infinity
  for (let i = 0; i + 3 < line.length; i += 2) {
    const d = distanceToSegmentSq(px, py, line[i], line[i + 1], line[i + 2], line[i + 3])
    if (d < best) best = d
  }
  return best
}

function insideRoundedRect(x, y, size, radius) {
  if (x < 0 || y < 0 || x > size || y > size) return false
  // Nearest point of the "core" rectangle; distance to it decides the corners.
  const limit = size - radius
  const cx = Math.min(Math.max(x, radius), limit)
  const cy = Math.min(Math.max(y, radius), limit)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= radius * radius
}

// --- the icon --------------------------------------------------------------

const DESIGN = 512

const PLATE = linearStops([
  [0, '#1a212a'],
  [0.55, '#0f1319'],
  [1, '#07090c']
])
const BLOOM = hex('#4fd1c5')
const INK = linearStops([
  [0, '#7ef0c0'],
  [0.45, '#4fd1c5'],
  [1, '#6f9dff']
])

// Same curves as scripts/icon.html.
const ARCS = [
  { c: [[104, 212], [168, 130], [344, 130], [408, 212]], width: 27 },
  { c: [[146, 292], [192, 242], [320, 242], [366, 292]], width: 24 },
  { c: [[198, 372], [218, 344], [294, 344], [314, 372]], width: 21 }
].map((arc) => ({ ...arc, line: flattenCubic(...arc.c) }))

const TRAY_ARCS = [
  { c: [[4.5, 15], [9.5, 8.5], [22.5, 8.5], [27.5, 15]], width: 3.2 },
  { c: [[10, 23.5], [13, 19.8], [19, 19.8], [22, 23.5]], width: 3.2 }
].map((arc) => ({ ...arc, line: flattenCubic(...arc.c, 24) }))

/** Premultiplied one-sample evaluation of the app icon at design coordinates. */
function sampleAppIcon(x, y) {
  const radius = 116
  if (!insideRoundedRect(x, y, DESIGN, radius)) return [0, 0, 0, 0]

  const plate = gradientAt(PLATE, [0, 0], [0.55 * DESIGN, DESIGN], x, y)
  let r = plate[0]
  let g = plate[1]
  let b = plate[2]

  // Radial bloom behind the mark.
  const bx = x - 0.5 * DESIGN
  const by = y - 0.4 * DESIGN
  const bloomRadius = 0.62 * DESIGN
  const bloomT = Math.sqrt(bx * bx + by * by) / bloomRadius
  if (bloomT < 1) {
    const a = 0.4 * (1 - bloomT)
    r += (BLOOM[0] - r) * a
    g += (BLOOM[1] - g) * a
    b += (BLOOM[2] - b) * a
  }

  for (const arc of ARCS) {
    const box = arc.box
    if (x < box.minX || x > box.maxX || y < box.minY || y > box.maxY) continue
    const half = arc.width / 2
    if (distanceToPolylineSq(x, y, arc.line) <= half * half) {
      const ink = gradientAt(INK, [0.1 * DESIGN, 0], [0.9 * DESIGN, DESIGN], x, y)
      r = ink[0]
      g = ink[1]
      b = ink[2]
    }
  }

  return [r, g, b, 255]
}

for (const arc of [...ARCS, ...TRAY_ARCS]) {
  const pad = arc.width / 2 + 1
  arc.box = polylineBounds(arc.line, pad)
}

/**
 * Rasterise with supersampling. Averaging happens in premultiplied space,
 * otherwise the colour of edge pixels bleeds toward black.
 */
function render(size, sampler, designSize = DESIGN) {
  const out = Buffer.alloc(size * size * 4)
  const scale = designSize / size
  const SUB = 4
  const taps = SUB * SUB
  const step = scale / SUB

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let sr = 0
      let sg = 0
      let sb = 0
      let sa = 0

      for (let sy = 0; sy < SUB; sy += 1) {
        const y = py * scale + sy * step + step / 2
        for (let sx = 0; sx < SUB; sx += 1) {
          const x = px * scale + sx * step + step / 2
          const [r, g, b, a] = sampler(x, y)
          if (a === 0) continue
          const w = a / 255
          sr += r * w
          sg += g * w
          sb += b * w
          sa += w
        }
      }

      const index = (py * size + px) * 4
      if (sa > 0) {
        out[index] = Math.round(Math.min(255, sr / sa))
        out[index + 1] = Math.round(Math.min(255, sg / sa))
        out[index + 2] = Math.round(Math.min(255, sb / sa))
        out[index + 3] = Math.round((sa / taps) * 255)
      }
    }
  }

  return out
}

// --- ICO container ---------------------------------------------------------

/** Windows .ico holding PNG payloads (supported since Vista). */
function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  const directory = Buffer.alloc(entries.length * 16)
  let offset = 6 + entries.length * 16

  entries.forEach((entry, i) => {
    const at = i * 16
    directory[at] = entry.size >= 256 ? 0 : entry.size
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size
    directory[at + 2] = 0
    directory[at + 3] = 0
    directory.writeUInt16LE(1, at + 4)
    directory.writeUInt16LE(32, at + 6)
    directory.writeUInt32LE(entry.png.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
  })

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)])
}

// --- simple shape rasteriser, for the transport and tray glyphs -------------

function sign(px, py, ax, ay, bx, by) {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by)
}

function inTriangle(px, py, [a, b, c]) {
  const d1 = sign(px, py, a[0], a[1], b[0], b[1])
  const d2 = sign(px, py, b[0], b[1], c[0], c[1])
  const d3 = sign(px, py, c[0], c[1], a[0], a[1])
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNegative && hasPositive)
}

/** White glyphs on transparent, matching the Windows thumbnail toolbar. */
const GLYPHS = {
  play: [{ type: 'tri', p: [[10, 6.5], [10, 25.5], [24.5, 16]] }],
  pause: [
    { type: 'rect', x: 9.5, y: 6.5, w: 4.5, h: 19 },
    { type: 'rect', x: 18, y: 6.5, w: 4.5, h: 19 }
  ],
  prev: [
    { type: 'rect', x: 6.5, y: 6.5, w: 3.4, h: 19 },
    { type: 'tri', p: [[25.5, 6.5], [25.5, 25.5], [11.5, 16]] }
  ],
  next: [
    { type: 'rect', x: 22.1, y: 6.5, w: 3.4, h: 19 },
    { type: 'tri', p: [[6.5, 6.5], [6.5, 25.5], [20.5, 16]] }
  ]
}

function sampleShapes(shapes, colour, x, y) {
  for (const shape of shapes) {
    let hit = false
    if (shape.type === 'rect') {
      hit = x >= shape.x && x <= shape.x + shape.w && y >= shape.y && y <= shape.y + shape.h
    } else if (shape.type === 'tri') {
      hit = inTriangle(x, y, shape.p)
    } else if (shape.type === 'stroke') {
      const half = shape.width / 2
      hit = distanceToPolylineSq(x, y, shape.line) <= half * half
    }
    if (hit) return [colour[0], colour[1], colour[2], 255]
  }
  return [0, 0, 0, 0]
}

/** The tray mark expressed as strokes so the same sampler can draw it. */
const TRAY_STROKES = TRAY_ARCS.map((arc) => ({
  type: 'stroke',
  line: arc.line,
  width: arc.width
}))

const WHITE = hex('#ffffff')
const TRAY_DARK = hex('#1b2027')

// --- main ------------------------------------------------------------------

fs.mkdirSync(buildDir, { recursive: true })
fs.mkdirSync(assetDir, { recursive: true })

const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const icoEntries = []

for (const size of icoSizes) {
  const pixels = render(size, sampleAppIcon)
  const png = encodePng(size, size, pixels)
  icoEntries.push({ size, png })
  if (size === 256) fs.writeFileSync(path.join(buildDir, 'icon.png'), png)
}

fs.writeFileSync(path.join(buildDir, 'icon.ico'), encodeIco(icoEntries))

/*
 * The tray mark needs to survive both taskbar themes: Windows does not invert
 * an Electron tray image, so a white glyph vanishes on a light taskbar and a
 * dark one vanishes on the dark default. Both variants are generated and the
 * main process picks by `nativeTheme.shouldUseDarkColors`.
 */
for (const [suffix, colour] of [
  ['', WHITE],
  ['-dark', TRAY_DARK]
]) {
  for (const size of [16, 32]) {
    const pixels = render(size, (x, y) => sampleShapes(TRAY_STROKES, colour, x, y), 32)
    const name = size === 16 ? `tray${suffix}.png` : `tray${suffix}@2x.png`
    fs.writeFileSync(path.join(assetDir, name), encodePng(size, size, pixels))
  }
}

/* 16px is what the Windows thumbnail toolbar asks for; 32px covers 200% DPI. */
for (const [name, shapes] of Object.entries(GLYPHS)) {
  for (const size of [16, 32]) {
    const pixels = render(size, (x, y) => sampleShapes(shapes, WHITE, x, y), 32)
    fs.writeFileSync(
      path.join(assetDir, `thumb-${name}${size === 16 ? '' : '@2x'}.png`),
      encodePng(size, size, pixels)
    )
  }
}

const report = (dir, name) => {
  const stat = fs.statSync(path.join(dir, name))
  console.log(`  ${path.relative(root, path.join(dir, name)).padEnd(28)} ${String(stat.size).padStart(7)} bytes`)
}

for (const dir of [buildDir, assetDir]) {
  const names = fs.readdirSync(dir).sort()
  console.log(`${path.relative(root, dir)}/  (${names.length} files)`)
  for (const name of names) report(dir, name)
}

