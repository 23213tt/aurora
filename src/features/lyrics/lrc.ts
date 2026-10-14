 interface LyricLine {
  /** Seconds from the start of the track. */
  time: number
  text: string
}

export interface Lyrics {
  lines: LyricLine[]
  /** Global offset in seconds, already folded into `lines[].time`. */
  offset: number
  title: string | null
  artist: string | null
  album: string | null
  by: string | null
  /** True when nothing usable was parsed. */
  empty: boolean
}

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
const META_TAG = /^\[(ti|ar|al|by|offset):(.*)\]$/i
const WORD_TAG = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g

/**
 * Parse an LRC file.
 *
 * Handles the parts real files actually contain: multiple timestamps on one
 * line (`[00:12.00][01:20.00]same text`), a signed `[offset:]` in milliseconds,
 * metadata tags, and enhanced-LRC word timings (stripped, since we highlight by
 * line rather than by syllable).
 *
 * Malformed timestamps are skipped rather than throwing: a partially broken
 * lyrics file should still show whatever it does have.
 */
export function parseLrc(raw: string): Lyrics {
  const lines: LyricLine[] = []
  let offsetMs = 0
  let title: string | null = null
  let artist: string | null = null
  let album: string | null = null
  let by: string | null = null

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    const meta = META_TAG.exec(line)
    if (meta) {
      const key = meta[1].toLowerCase()
      const value = meta[2].trim()
      if (key === 'offset') {
        const parsed = Number.parseInt(value, 10)
        if (Number.isFinite(parsed)) offsetMs = parsed
      } else if (key === 'ti') title = value || null
      else if (key === 'ar') artist = value || null
      else if (key === 'al') album = value || null
      else if (key === 'by') by = value || null
      continue
    }

    TIME_TAG.lastIndex = 0
    const stamps: number[] = []
    let match: RegExpExecArray | null
    while ((match = TIME_TAG.exec(line)) !== null) {
      const minutes = Number.parseInt(match[1], 10)
      const seconds = Number.parseInt(match[2], 10)
      const fractionRaw = match[3] ?? ''
      // `.5` means 500ms, `.05` means 50ms, `.005` means 5ms.
      const fraction = fractionRaw ? Number.parseInt(fractionRaw, 10) / 10 ** fractionRaw.length : 0
      stamps.push(minutes * 60 + seconds + fraction)
    }
    if (stamps.length === 0) continue

    const text = line.replace(TIME_TAG, '').replace(WORD_TAG, '').trim()
    for (const time of stamps) lines.push({ time, text })
  }

  const shift = offsetMs / 1000
  for (const line of lines) line.time = Math.max(0, line.time - shift)
  lines.sort((a, b) => a.time - b.time)

  return {
    lines,
    offset: shift,
    title,
    artist,
    album,
    by,
    empty: lines.length === 0
  }
}

export function emptyLyrics(): Lyrics {
  return { lines: [], offset: 0, title: null, artist: null, album: null, by: null, empty: true }
}

/**
 * Index of the line that should be highlighted at `position`, or -1 before the
 * first line begins. Binary search: lyric lookups run on every animation frame.
 */
export function activeLineAt(lines: LyricLine[], position: number): number {
  if (lines.length === 0) return -1
  let low = 0
  let high = lines.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (lines[mid].time <= position) {
      found = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return found
}
