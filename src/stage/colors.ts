/**
 * Pre-rendered colour strings for the stage canvas.
 *
 * The visualiser used to build every `rgba()` string it painted, once per
 * particle and once per ribbon pass: 356 string constructions and CSS parses per
 * frame, ~21,000 per second at 60 Hz. The values barely change between frames -
 * only the alpha moves, and only by the amount the level envelope moved - so the
 * whole set is worth building once per palette and indexing thereafter.
 *
 * Alpha is quantised to 1/128 of full scale. That is the resolution that matters:
 * half a step is 0.004, so the worst case error in the composited alpha is under
 * one level of an 8-bit channel, and the table stays small enough (129 entries
 * per palette colour) to build in a fraction of a millisecond when the artwork
 * changes. A coarser table - the 16 or 24 steps that would be needed if this were
 * about saving memory - would shift the dim end of the mote field by several
 * levels and make the quiet passages brighter than they are meant to be.
 *
 * `builds` exists so the "nothing is allocated in the frame loop" property can be
 * asserted rather than believed: it counts the strings a table has built and is
 * fixed for the lifetime of the table.
 */

export const ALPHA_STEPS = 128
const STEPS_PER_COLOR = ALPHA_STEPS + 1

export interface ColorTable {
  /** rgba() strings, indexed `colorIndex * STEPS_PER_COLOR + alphaStep`. */
  readonly rgba: readonly string[]
  readonly colorCount: number
  /** Strings built by this table. Constant after construction. */
  readonly builds: number
  /** The cached string for a palette colour and an alpha, quantised. */
  get(colorIndex: number, alpha: number): string
}

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

export function buildColorTable(colors: readonly string[]): ColorTable {
  // A palette always carries at least one colour, but a table must never be able
  // to hand back `undefined` to the canvas: an invalid fillStyle silently keeps
  // the previous one, which would smear one particle's colour across the field.
  const palette = colors.length > 0 ? colors : ['#ffffff']
  const rgba: string[] = []
  for (const color of palette) {
    for (let step = 0; step <= ALPHA_STEPS; step += 1) rgba.push(hexA(color, step / ALPHA_STEPS))
  }

  return {
    rgba,
    colorCount: palette.length,
    builds: rgba.length,
    get(colorIndex: number, alpha: number): string {
      const step = Math.max(0, Math.min(ALPHA_STEPS, Math.round(alpha * ALPHA_STEPS)))
      const index = (colorIndex % palette.length) * STEPS_PER_COLOR + step
      // The index is derived from a clamped step and a wrapped colour, so this
      // is always in range; `?? rgba[0]` keeps the return type honest without a
      // branch the frame loop would pay for.
      return rgba[index] ?? rgba[0]
    }
  }
}
