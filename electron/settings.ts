import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

export interface Settings {
  /** Folders the user has added to the library. */
  roots: string[]
  /** Explicitly excluded paths (a `.auroraignore`-style list, kept simple). */
  excluded: string[]
  /** Check GitHub Releases for a newer version at most once a day. */
  autoCheckUpdates: boolean
  /** Epoch ms of the last completed update check. */
  lastUpdateCheck: number
  /**
   * Allow lyric lookups against lrclib.net.
   *
   * Off by default: Aurora promises the library stays on this machine, and a
   * lookup necessarily sends the track title and artist to a third party, so
   * the user turns it on rather than finding out afterwards.
   */
  onlineLyrics: boolean
  /** Last position and size of the desktop lyric strip. */
  lyricsOverlayBounds?: { x: number; y: number; width: number; height: number }
}

const DEFAULTS: Settings = {
  roots: [],
  excluded: [],
  autoCheckUpdates: true,
  lastUpdateCheck: 0,
  onlineLyrics: false
}

let cache: Settings | null = null

const settingsFile = (): string => path.join(app.getPath('userData'), 'settings.json')

export function loadSettings(): Settings {
  if (cache) return cache
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Partial<Settings>
    cache = {
      // Spread first so keys this version does not know about survive a
      // read-write cycle instead of being silently dropped.
      ...DEFAULTS,
      ...raw,
      // Arrays are the only fields where a corrupt value would crash callers.
      roots: Array.isArray(raw.roots) ? raw.roots : [],
      excluded: Array.isArray(raw.excluded) ? raw.excluded : []
    }
  } catch {
    // Missing or corrupt settings are not an error worth surfacing; start clean.
    cache = { ...DEFAULTS }
  }
  return cache
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...loadSettings(), ...patch }
  cache = next
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
    fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2), 'utf8')
  } catch (error) {
    console.error('[aurora] could not persist settings', error)
  }
  return next
}

/**
 * The single authority on what Aurora may read from disk.
 *
 * Every file-serving path (audio streaming, artwork, lyrics) funnels through
 * this, so a compromised or buggy renderer cannot use the app to read files
 * outside the folders the user actually added.
 */
export function isInsideRoots(candidate: string): boolean {
  const resolved = path.resolve(candidate)
  return loadSettings().roots.some((root) => {
    const base = path.resolve(root)
    const withSeparator = base.endsWith(path.sep) ? base : base + path.sep
    return resolved === base || resolved.startsWith(withSeparator)
  })
}
