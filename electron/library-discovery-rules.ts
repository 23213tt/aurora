import fs from 'node:fs'
import path from 'node:path'

/**
 * The rules for finding music that is already on this machine.
 *
 * Separate from `library-discovery.ts` on purpose: that file asks Electron where
 * the user's folders are, which means it can only run inside Electron. The
 * decisions - what counts as music, and which folders to keep - are the part
 * worth testing, so they live here with no Electron import at all.
 *
 * The rule is "the first level that contains music wins". That one rule covers
 * both shapes the OS music folder actually has:
 *
 *  - `音乐/` holds loose files or album folders (a curated library) - the folder
 *    itself is the root, and the album folders stay part of it;
 *  - `音乐/` holds nothing but client folders (`音乐/网易云音乐/…`,
 *    `音乐/QQ音乐/…`) - each client folder becomes its own root.
 *
 * It is deliberately not a list of known music-app names: it is a property of how
 * the folder is laid out, so an app nobody has heard of behaves the same way.
 */

/**
 * Every extension Aurora will read.
 *
 * This lives here rather than in the scanner because the scanner imports
 * `settings`, which imports Electron, which makes the scanner impossible to load
 * in a test. The dependency points this way so both the test and the scanner can
 * use one list: two copies would eventually disagree, and the failure would be
 * silent - a folder detected as music that the scanner then reports as empty.
 */
export const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.m4a',
  '.mp4',
  '.aac',
  '.ogg',
  '.oga',
  '.opus',
  '.wav',
  '.wv',
  '.ape',
  '.aif',
  '.aiff',
  '.wma'
])

/** How far to look inside a candidate when deciding whether it holds music. */
const PROBE_DEPTH = 3
/** Cap the walk: a huge folder should be added, not counted to the end first. */
const PROBE_LIMIT = 40

/** True when this is a file the indexer would read. */
export function isAudioFile(name: string): boolean {
  return AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase())
}

/**
 * Roughly how many audio files live under `dir`, stopping early.
 *
 * Stops at the cap because the caller only needs "does music live here", and a
 * 20,000-file folder should not be walked to answer that.
 */
export function countAudio(dir: string, depth = 0): number {
  if (depth > PROBE_DEPTH) return 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }

  let found = 0
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isFile()) {
      if (isAudioFile(entry.name)) {
        found += 1
        if (found >= PROBE_LIMIT) return found
      }
      continue
    }
    if (entry.isDirectory()) {
      found += countAudio(path.join(dir, entry.name), depth + 1)
      if (found >= PROBE_LIMIT) return found
    }
  }
  return found
}

/** Audio files directly inside `dir`, stopping early. */
function countDirectAudio(dir: string): number {
  let found = 0
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && isAudioFile(entry.name)) {
        found += 1
        if (found >= PROBE_LIMIT) break
      }
    }
  } catch {
    return 0
  }
  return found
}

/**
 * The folders worth adding, given the places to start.
 *
 * Exported (and Electron-free) so the rule can be tested against a real
 * temporary directory rather than a mock of the file system.
 */
export function pickMusicRoots(bases: string[]): string[] {
  const picked: string[] = []

  /** Already covered by a folder we added: adding it again would double-index. */
  const covered = (candidate: string): boolean =>
    picked.some((root) => candidate === root || candidate.startsWith(root + path.sep))

  for (const base of bases) {
    if (!base) continue
    let stat: fs.Stats
    try {
      stat = fs.statSync(base)
    } catch {
      continue
    }
    if (!stat.isDirectory() || covered(base)) continue

    // Does this folder itself hold music? Then it is the root, and we stop here
    // so that its album subfolders are not torn out into separate roots.
    if (countDirectAudio(base) > 0) {
      picked.push(base)
      continue
    }

    // Otherwise the music is one level down, one folder per collection.
    let subdirectories: fs.Dirent[] = []
    try {
      subdirectories = fs.readdirSync(base, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of subdirectories) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const child = path.join(base, entry.name)
      if (covered(child)) continue
      if (countAudio(child) > 0) picked.push(child)
    }
  }

  return picked
}
