import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { NeteaseQuality } from './netease/types'

/**
 * The settings surface the renderer sees.
 *
 * Mirrored in `src/env.d.ts` (see the `AppSettings` block there) rather than
 * imported: the renderer and the main process are two TypeScript projects with
 * different module systems, so they share a shape by convention, the same way
 * `electron/netease/types.ts` mirrors its renderer counterpart. Change one and
 * you must change the other.
 */
export interface AppSettings {
  onlineLyrics: boolean
  updateInterval: UpdateInterval
  updateLastCheck: number
  autoInstallUpdates: boolean
  desktopLyrics: { size: number; min: number; max: number }
}

export interface StorageUsage {
  userData: string
  cache: string
  cacheBytes: number | null
  userDataBytes: number | null
}

export type UpdateInterval = 'manual' | 'daily' | 'weekly'

/** Bounds for the desktop lyric strip. `Overlay.tsx` mirrors these. */
export const LYRIC_SIZE_MIN = 18
export const LYRIC_SIZE_MAX = 64

export interface Settings {
  /** Folders the user has added to the library. */
  roots: string[]
  /** Explicitly excluded paths (a `.auroraignore`-style list, kept simple). */
  excluded: string[]
  /** Check GitHub Releases for a newer version at most once a day. */
  autoCheckUpdates: boolean
  /** How often to check for updates. `manual` means only on request. */
  updateInterval: UpdateInterval
  /** Epoch ms of the last completed update check. */
  lastUpdateCheck: number
  /**
   * Download and install updates without asking.
   *
   * Off by default, and the default is the product decision: the installers are
   * unsigned, so turning this on replaces the SmartScreen prompt with nothing.
   * A user who wants that trades a warning for convenience - but they have to
   * say so, because the app cannot verify what it is replacing itself with.
   */
  autoInstallUpdates: boolean
  /**
   * Font size of the desktop lyric strip.
   *
   * Lives here rather than in the overlay window's `localStorage` because the
   * settings page has to be able to read and change it, and `localStorage` is
   * per-window: the two windows would each keep their own answer.
   */
  desktopLyricsSize: number
  /**
   * Allow lyric lookups against lrclib.net.
   *
   * Off by default: Aurora promises the library stays on this machine, and a
   * lookup necessarily sends the track title and artist to a third party, so
   * the user turns it on rather than finding out afterwards.
   */
  onlineLyrics: boolean
  /**
   * Preferred quality for Netease playback.
   *
   * `exhigh` by default, not `lossless`: 320kbps is the best level an account
   * without a membership actually receives, so the default is a promise the
   * app can keep rather than one it silently downgrades.
   */
  neteaseQuality: NeteaseQuality
  /** Last position and size of the desktop lyric strip. */
  lyricsOverlayBounds?: { x: number; y: number; width: number; height: number }
}

const DEFAULTS: Settings = {
  roots: [],
  excluded: [],
  autoCheckUpdates: true,
  updateInterval: 'daily',
  lastUpdateCheck: 0,
  autoInstallUpdates: false,
  desktopLyricsSize: 34,
  onlineLyrics: false,
  neteaseQuality: 'exhigh'
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
      excluded: Array.isArray(raw.excluded) ? raw.excluded : [],
      // Enums and numbers come from a hand-editable JSON file, so they are
      // validated rather than trusted: an unknown interval would silently stop
      // update checks, and a size outside the range would render a strip that
      // cannot be read.
      updateInterval: isUpdateInterval(raw.updateInterval) ? raw.updateInterval : migrateInterval(raw),
      desktopLyricsSize: clampLyricSize(raw.desktopLyricsSize)
    }
  } catch {
    // Missing or corrupt settings are not an error worth surfacing; start clean.
    cache = { ...DEFAULTS }
  }
  return cache
}

/**
 * Carry the old boolean forward.
 *
 * Anyone who had turned the daily check off must not quietly get it back - that
 * would be a network request they had explicitly declined - and anyone who left
 * it on keeps the behaviour they already had.
 */
function migrateInterval(raw: Partial<Settings>): UpdateInterval {
  if (raw.autoCheckUpdates === false) return 'manual'
  return DEFAULTS.updateInterval
}

function isUpdateInterval(value: unknown): value is UpdateInterval {
  return value === 'manual' || value === 'daily' || value === 'weekly'
}

function clampLyricSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULTS.desktopLyricsSize
  return Math.min(LYRIC_SIZE_MAX, Math.max(LYRIC_SIZE_MIN, Math.round(value)))
}

/** The subset the settings page reads, in the shape `src/env.d.ts` declares. */
export function appSettings(): AppSettings {
  const settings = loadSettings()
  return {
    onlineLyrics: settings.onlineLyrics,
    updateInterval: settings.updateInterval,
    updateLastCheck: settings.lastUpdateCheck,
    autoInstallUpdates: settings.autoInstallUpdates,
    desktopLyrics: {
      size: clampLyricSize(settings.desktopLyricsSize),
      min: LYRIC_SIZE_MIN,
      max: LYRIC_SIZE_MAX
    }
  }
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

// --- storage --------------------------------------------------------------

/**
 * Directories inside `userData` that hold nothing but regenerable cache.
 *
 * Verified against a real profile rather than assumed: on Windows, Electron
 * keeps every Chromium cache *inside* `userData`, while `app.getPath('cache')`
 * points at `%LOCALAPPDATA%\aurora-player` - a directory this app never
 * creates. Anything not on this list is left alone, which is what keeps the
 * library index, playlists, profiles, window geometry and the encrypted session
 * cookie out of reach of the "clear cache" button.
 */
const CACHE_DIRS = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'GPUPersistentCache',
  'GrShaderCache',
  'ShaderCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'blob_storage'
] as const

/** Recursive byte count. Symlinks are skipped so a link cannot double-count. */
async function directoryBytes(target: string): Promise<number | null> {
  let total = 0
  try {
    const entries = await fs.promises.readdir(target, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(target, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        const nested = await directoryBytes(full)
        if (nested !== null) total += nested
      } else if (entry.isFile()) {
        try {
          total += (await fs.promises.stat(full)).size
        } catch {
          /* a file that vanished mid-walk contributes nothing */
        }
      }
    }
    return total
  } catch {
    return null
  }
}

async function cacheBytes(): Promise<number | null> {
  const root = app.getPath('userData')
  let total: number | null = null
  for (const name of CACHE_DIRS) {
    const size = await directoryBytes(path.join(root, name))
    if (size === null) continue
    total = (total ?? 0) + size
  }
  return total
}

export async function storageUsage(): Promise<StorageUsage> {
  const userData = app.getPath('userData')
  return {
    userData,
    cache: userData,
    cacheBytes: await cacheBytes(),
    userDataBytes: await directoryBytes(userData)
  }
}

/**
 * Delete the regenerable caches.
 *
 * Deleting a cache directory while Chromium holds files open fails on Windows,
 * so a failure here is not an error to surface: the next launch rebuilds
 * whatever could not be removed. What must never happen is touching a path
 * outside `CACHE_DIRS`, which is why the list is a constant and the removal is
 * driven by it rather than by a caller-supplied path.
 */
export async function clearCache(): Promise<StorageUsage> {
  const root = app.getPath('userData')
  for (const name of CACHE_DIRS) {
    try {
      await fs.promises.rm(path.join(root, name), { recursive: true, force: true, maxRetries: 2 })
    } catch (error) {
      console.error('[aurora] could not clear cache directory', name, error)
    }
  }
  return storageUsage()
}
