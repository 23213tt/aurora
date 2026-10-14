/**
 * LRC merging. Text in, text out - no store, no DOM.
 *
 * The upstream returns the original lyric and a machine translation as two
 * separate LRC documents keyed by the same timestamps. The player's lyric view
 * highlights one line per timestamp, so two documents for one song would mean
 * the translation never lines up with the singing. Merging them into one line
 * is therefore the only shape the rest of the app can use.
 */

const TIME = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g

interface ParsedLine {
  /** Hundredths of a second, so the key is exact and comparable. */
  at: number
  /** Everything after the timestamps, without the trailing newline. */
  text: string
  /** Tags like `[ti:...]` and `[offset:...]` have no time and are kept as-is. */
  tag: boolean
}

function parse(lrc: string): ParsedLine[] {
  const lines: ParsedLine[] = []
  for (const raw of lrc.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue

    const stamps: number[] = []
    TIME.lastIndex = 0
    let match = TIME.exec(line)
    while (match) {
      const min = Number(match[1])
      const sec = Number(match[2])
      // `[mm:ss.xx]` is hundredths; a 3-digit fraction is milliseconds.
      const frac = match[3] ? Number(match[3].padEnd(3, '0')) : 0
      stamps.push(min * 6000 + sec * 100 + Math.round(frac / 10))
      match = TIME.exec(line)
    }

    const text = line.replace(TIME, '').trim()
    if (stamps.length === 0) {
      // Metadata survives verbatim: dropping `[offset:...]` would shift every
      // remaining line against the audio.
      if (text) lines.push({ at: -1, text, tag: true })
      continue
    }
    for (const at of stamps) lines.push({ at, text, tag: false })
  }
  return lines
}

function stampOf(hundredths: number): string {
  const min = Math.floor(hundredths / 6000)
  const sec = Math.floor((hundredths % 6000) / 100)
  const frac = hundredths % 100
  return `[${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(frac).padStart(2, '0')}]`
}

/**
 * Merge a translation into the original lyric.
 *
 * Returns the original untouched when there is nothing to merge, so a caller
 * never has to distinguish "no translation" from "merged nothing".
 */
export function mergeTranslation(lrc: string | null, translation: string | null): string | null {
  if (!lrc && !translation) return null
  if (!translation) return lrc
  if (!lrc) return translation

  const original = parse(lrc)
  const translated = new Map<number, string>()
  for (const line of parse(translation)) {
    if (line.tag || !line.text) continue
    translated.set(line.at, line.text)
  }

  const merged: { at: number; text: string }[] = []
  const used = new Set<number>()

  for (const line of original) {
    if (line.tag) {
      merged.push({ at: line.at, text: line.text })
      continue
    }
    const other = translated.get(line.at)
    used.add(line.at)
    if (!other || other === line.text) {
      merged.push({ at: line.at, text: `${stampOf(line.at)}${line.text}` })
      continue
    }
    // Both on one LRC line, separated by the app's lyric-line convention for a
    // paired translation. A second line at the same timestamp would be dropped
    // by any player that indexes lyrics by time.
    merged.push({ at: line.at, text: `${stampOf(line.at)}${line.text} / ${other}` })
  }

  /*
   * Translation lines with no original at the same timestamp are appended rather
   * than discarded: the two documents are generated separately and a handful of
   * lines genuinely differ by a hundredth of a second. Losing a translated line
   * silently is worse than showing it slightly out of order.
   */
  for (const [at, text] of translated) {
    if (used.has(at) || at < 0) continue
    merged.push({ at, text: `${stampOf(at)}${text}` })
  }

  merged.sort((a, b) => a.at - b.at)
  return merged.map((line) => line.text).join('\n')
}
