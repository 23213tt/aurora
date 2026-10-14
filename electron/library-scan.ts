import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type { IAudioMetadata } from 'music-metadata'
import { loadSettings } from './settings'
import { AUDIO_EXTENSIONS } from './pure/library-discovery-rules'
import type { ScanProgress } from './pure/scan-progress'

/**
 * Library scanning and tag reading.
 *
 * Scanning is incremental: a file whose size and mtime are unchanged keeps its
 * cached entry, so a re-scan of a large library only touches what actually
 * changed. That is the difference between a rescan taking a second and taking a
 * minute, and it is why the index stores mtimeMs.
 */

 interface ScannedTrack {
  id: string
  path: string
  title: string
  artist: string
  albumArtist: string
  album: string
  genre: string
  year: number | null
  trackNo: number | null
  discNo: number | null
  duration: number
  bitrate: number | null
  sampleRate: number | null
  channels: number | null
  codec: string
  lossless: boolean
  size: number
  mtimeMs: number
  addedAt: number
  hasArt: boolean
  gainDb: number | null
  peak: number | null
}

export interface LibraryIndex {
  version: number
  scannedAt: number
  roots: string[]
  tracks: ScannedTrack[]
}

/**
 * What a running scan reports.
 *
 * The definition lives in `pure/scan-progress.ts` - the module that decides how
 * often progress is delivered, and the one that must not depend on this file.
 * Re-exported so callers keep importing it from the scanner.
 */
export type { ScanProgress } from './pure/scan-progress'

const INDEX_VERSION = 1

/**
 * Every extension the indexer will read.
 *
 * The list itself lives in `library-discovery-rules.ts`, which has no Electron
 * dependency and is therefore testable; auto-discovery needs the same list to
 * decide whether a folder holds music at all. Re-exported here so callers that
 * only know about the scanner keep working.
 */
export { AUDIO_EXTENSIONS }

const FOLDER_ART_NAMES = [
  'cover.jpg',
  'cover.jpeg',
  'cover.png',
  'cover.webp',
  'folder.jpg',
  'folder.jpeg',
  'folder.png',
  'front.jpg',
  'front.jpeg',
  'front.png',
  'album.jpg',
  'album.jpeg',
  'album.png'
]

/** Directories that are never worth descending into. */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '$recycle.bin',
  'system volume information',
  '.cache'
])

// --- metadata module -------------------------------------------------------

type MetadataModule = typeof import('music-metadata')

let metadataModule: MetadataModule | null = null

/**
 * `music-metadata` is ESM-only, and the main process is CommonJS, so it is
 * loaded through a real dynamic import (preserved as `import()` rather than
 * downlevelled to `require` by `module: nodenext`).
 */
async function metadata(): Promise<MetadataModule> {
  if (!metadataModule) metadataModule = await import('music-metadata')
  return metadataModule
}

// --- walking ---------------------------------------------------------------

async function collectAudioFiles(root: string, onFound: (file: string) => void): Promise<string[]> {
  const found: string[] = []
  const queue: string[] = [root]

  while (queue.length > 0) {
    const directory = queue.pop()
    if (!directory) break

    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true })
    } catch {
      // Permission denied, a dead symlink, a drive that went away: skip it and
      // keep scanning. One unreadable folder must not abort the whole library.
      continue
    }

    for (const entry of entries) {
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name.toLowerCase())) continue
        if (entry.name.startsWith('.')) continue
        queue.push(full)
      } else if (entry.isFile()) {
        if (!AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
        found.push(full)
        onFound(full)
      }
    }
  }

  return found
}

// --- tags ------------------------------------------------------------------

/** Stable id from the file path, so re-scans and moves keep identity. */
function idFor(filePath: string): string {
  const normalised = process.platform === 'win32' ? filePath.toLowerCase() : filePath
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < normalised.length; i += 1) {
    const code = normalised.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 16777619)
    h2 = Math.imul(h2 + code, 2246822519)
  }
  return `${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`
}

function firstString(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return ''
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

function buildTrack(
  filePath: string,
  stat: fs.Stats,
  meta: IAudioMetadata | null,
  hasArt: boolean
): ScannedTrack {
  const common = meta?.common
  const format = meta?.format
  const stem = path.basename(filePath, path.extname(filePath))

  const title = (common?.title ?? '').trim() || stem
  const artist = firstString(common?.artist).trim() || firstString(common?.artists).trim()
  const albumArtist = (common?.albumartist ?? '').trim() || artist || '未知艺术家'
  const album = (common?.album ?? '').trim() || path.basename(path.dirname(filePath))

  // ReplayGain lives in different tags across taggers; take whichever exists.
  const native = meta?.native ?? {}
  const gainCandidates = ['REPLAYGAIN_TRACK_GAIN', 'replaygain_track_gain', 'TXXX:REPLAYGAIN_TRACK_GAIN']
  const peakCandidates = ['REPLAYGAIN_TRACK_PEAK', 'replaygain_track_peak', 'TXXX:REPLAYGAIN_TRACK_PEAK']

  const pickNative = (keys: string[]): string | null => {
    for (const key of keys) {
      const entry = native[key]
      if (Array.isArray(entry) && entry.length > 0) {
        const value = typeof entry[0] === 'string' ? entry[0] : entry[0]?.value
        if (typeof value === 'string') return value
      }
    }
    return null
  }

  const commonExtras = common as unknown as Record<string, unknown> | undefined
  const gainRaw = pickNative(gainCandidates) ?? commonExtras?.replaygain_track_gain
  const peakRaw = pickNative(peakCandidates) ?? commonExtras?.replaygain_track_peak

  const parseGain = (raw: unknown): number | null => {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw
    if (typeof raw !== 'string') return null
    const parsed = Number.parseFloat(raw.replace(/[^\d.+-]/g, ''))
    return Number.isFinite(parsed) ? parsed : null
  }

  return {
    id: idFor(filePath),
    path: filePath,
    title,
    artist: artist || '未知艺术家',
    albumArtist,
    album,
    genre: firstString(common?.genre).trim(),
    year: toNumber(common?.year),
    trackNo: toNumber(common?.track?.no),
    discNo: toNumber(common?.disk?.no),
    duration: format?.duration ?? 0,
    bitrate: format?.bitrate ? Math.round(format.bitrate) : null,
    sampleRate: format?.sampleRate ?? null,
    channels: format?.numberOfChannels ?? null,
    codec: (format?.codec ?? path.extname(filePath).slice(1)).toUpperCase(),
    lossless: Boolean(format?.lossless),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    addedAt: Date.now() / 1000,
    hasArt,
    gainDb: parseGain(gainRaw),
    peak: parseGain(peakRaw)
  }
}

/**
 * Read one file's tags. Never throws: an unreadable or corrupt file still
 * becomes a playable entry with its filename as the title, because a library
 * that silently drops files is worse than one with a few untitled rows.
 */
async function readTrack(filePath: string, stat: fs.Stats): Promise<ScannedTrack> {
  try {
    const mm = await metadata()
    /*
     * `skipCovers` matters more than it looks.
     *
     * Asking music-metadata for embedded pictures allocates a Buffer holding the
     * full image for every file scanned - hundreds of megabytes across a real
     * library, all of it thrown away immediately after counting the array. The
     * only thing the scan needs is the metadata.
     *
     * Artwork is resolved lazily instead, by the media protocol, and only for
     * tracks that are actually on screen. `hasArt` is therefore optimistic: the
     * UI treats a failed artwork request as "no cover" (see components/Artwork).
     */
    const meta = await mm.parseFile(filePath, { duration: true, skipCovers: true })
    return buildTrack(filePath, stat, meta, true)
  } catch {
    return buildTrack(filePath, stat, null, false)
  }
}

// --- artwork ---------------------------------------------------------------

 interface EmbeddedArt {
  mime: string
  data: Buffer
}

/** Bounded cache: artwork for the visible few albums, not for the whole library. */
const artCache = new Map<string, EmbeddedArt | null>()
const ART_CACHE_LIMIT = 64

export async function readEmbeddedArt(filePath: string): Promise<EmbeddedArt | null> {
  const hit = artCache.get(filePath)
  if (hit !== undefined) return hit

  let result: EmbeddedArt | null = null
  try {
    const mm = await metadata()
    const meta = await mm.parseFile(filePath, { duration: false, skipCovers: false })
    const picture = meta.common.picture?.[0]
    if (picture && picture.data.length > 0) {
      result = { mime: picture.format || 'image/jpeg', data: Buffer.from(picture.data) }
    }
  } catch {
    result = null
  }

  if (artCache.size >= ART_CACHE_LIMIT) {
    const oldest = artCache.keys().next().value
    if (oldest !== undefined) artCache.delete(oldest)
  }
  artCache.set(filePath, result)
  return result
}

const folderArtCache = new Map<string, string | null>()

/** A cover image sitting beside the audio file, which is how most rips ship. */
export async function readFolderArt(filePath: string): Promise<string | null> {
  const directory = path.dirname(filePath)
  const hit = folderArtCache.get(directory)
  if (hit !== undefined) return hit

  let result: string | null = null
  try {
    const entries = await fs.promises.readdir(directory)
    const lower = new Map(entries.map((name) => [name.toLowerCase(), name]))
    for (const candidate of FOLDER_ART_NAMES) {
      const actual = lower.get(candidate)
      if (actual) {
        result = path.join(directory, actual)
        break
      }
    }
  } catch {
    result = null
  }

  if (folderArtCache.size >= ART_CACHE_LIMIT) {
    const oldest = folderArtCache.keys().next().value
    if (oldest !== undefined) folderArtCache.delete(oldest)
  }
  folderArtCache.set(directory, result)
  return result
}

// --- index -----------------------------------------------------------------

 function indexFile(): string {
  return path.join(app.getPath('userData'), 'library.json')
}

export async function loadIndex(): Promise<LibraryIndex> {
  try {
    const raw = JSON.parse(await fs.promises.readFile(indexFile(), 'utf8')) as LibraryIndex
    if (raw.version !== INDEX_VERSION || !Array.isArray(raw.tracks)) {
      return { version: INDEX_VERSION, scannedAt: 0, roots: [], tracks: [] }
    }
    return raw
  } catch {
    return { version: INDEX_VERSION, scannedAt: 0, roots: [], tracks: [] }
  }
}

async function saveIndex(index: LibraryIndex): Promise<void> {
  try {
    await fs.promises.mkdir(path.dirname(indexFile()), { recursive: true })
    await fs.promises.writeFile(indexFile(), JSON.stringify(index), 'utf8')
  } catch (error) {
    console.error('[aurora] could not persist the library index', error)
  }
}

 interface ScanOptions {
  onProgress?: (progress: ScanProgress) => void
  /** Checked between files so a rescan can be abandoned. */
  cancelled?: () => boolean
}

/**
 * Scan every configured root and return the merged index.
 *
 * Concurrency is bounded rather than unbounded: tag parsing is IO- and
 * CPU-heavy, and firing thousands of parallel parses makes the whole scan
 * slower and the machine unusable.
 */
export async function scanLibrary(options: ScanOptions = {}): Promise<LibraryIndex> {
  const roots = loadSettings().roots
  const previous = await loadIndex()
  const cache = new Map(previous.tracks.map((track) => [track.path, track]))
  const { onProgress, cancelled } = options

  const progress: ScanProgress = {
    phase: 'walking',
    found: 0,
    scanned: 0,
    cached: 0,
    current: ''
  }
  const report = (patch: Partial<ScanProgress>) => {
    Object.assign(progress, patch)
    onProgress?.({ ...progress })
  }

  const files: string[] = []
  for (const root of roots) {
    const inRoot = await collectAudioFiles(root, () => {
      report({ found: progress.found + 1 })
    })
    files.push(...inRoot)
  }

  report({ phase: 'reading', current: '' })

  const results: ScannedTrack[] = []
  const CONCURRENCY = 8
  let cursor = 0

  const worker = async (): Promise<void> => {
    while (cursor < files.length) {
      if (cancelled?.()) return
      const index = cursor
      cursor += 1
      const file = files[index]

      let stat: fs.Stats
      try {
        stat = await fs.promises.stat(file)
      } catch {
        continue
      }

      const cached = cache.get(file)
      if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        results.push(cached)
        report({ cached: progress.cached + 1, current: file })
        continue
      }

      results.push(await readTrack(file, stat))
      report({ scanned: progress.scanned + 1, current: file })
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, files.length)) }, worker))

  const index: LibraryIndex = {
    version: INDEX_VERSION,
    scannedAt: Date.now(),
    roots,
    tracks: results
  }
  await saveIndex(index)
  report({ phase: 'done', current: '' })
  return index
}
