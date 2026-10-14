import type { Track } from '../../types'

/**
 * M3U read and write.
 *
 * Absolute paths are used on export: that is what every desktop player
 * understands, and it survives the file being moved anywhere on the disk. On
 * import, relative entries are resolved against the playlist's own directory,
 * which is how playlists exported from portable installs look.
 */

 interface M3uEntry {
  path: string
  /** From the `#EXTINF` line, when present. */
  title: string | null
}

export function buildM3u(tracks: Track[]): string {
  const lines = ['#EXTM3U']
  for (const track of tracks) {
    const seconds = Math.max(0, Math.round(track.duration))
    const label =
      track.artist && track.artist !== '未知艺术家'
        ? `${track.artist} - ${track.title}`
        : track.title
    lines.push(`#EXTINF:${seconds},${label}`)
    lines.push(track.path)
  }
  // CRLF: the format's heritage is Windows, and players on every platform cope.
  return `${lines.join('\r\n')}\r\n`
}

export function parseM3u(text: string): M3uEntry[] {
  const entries: M3uEntry[] = []
  let pendingTitle: string | null = null

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#EXTM3U') || line.startsWith('#EXTENC')) continue
    if (line.startsWith('#EXTINF:')) {
      const comma = line.indexOf(',')
      pendingTitle = comma === -1 ? null : line.slice(comma + 1).trim() || null
      continue
    }
    if (line.startsWith('#')) continue
    entries.push({ path: line, title: pendingTitle })
    pendingTitle = null
  }

  return entries
}

/** Windows path comparison: separators and case are both insignificant. */
export function normalisePath(value: string): string {
  return value.replace(/\//g, '\\').replace(/\\{2,}/g, '\\').trim().toLowerCase()
}

const ABSOLUTE = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/

/**
 * Resolve entries to library track ids, preserving playlist order and dropping
 * duplicates. Files that are not in the library are skipped rather than
 * reported: importing a playlist that references an un-scanned folder should
 * still bring in the tracks that do match.
 */
export function resolveEntries(
  entries: M3uEntry[],
  tracks: Track[],
  baseDir: string | null
): { ids: string[]; missing: number } {
  const byPath = new Map<string, string>()
  for (const track of tracks) byPath.set(normalisePath(track.path), track.id)

  const ids: string[] = []
  const seen = new Set<string>()
  let missing = 0

  for (const entry of entries) {
    const candidates = [entry.path]
    if (baseDir && !ABSOLUTE.test(entry.path)) {
      candidates.push(`${baseDir.replace(/[\\/]+$/, '')}\\${entry.path}`)
    }

    let id: string | undefined
    for (const candidate of candidates) {
      id = byPath.get(normalisePath(candidate))
      if (id) break
    }

    if (!id) {
      missing += 1
      continue
    }
    if (seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }

  return { ids, missing }
}
