import { app, net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Online lyric lookup against LRCLIB (lrclib.net).
 *
 * LRCLIB is an open, community-run lyrics database that publishes a documented
 * public API and asks for no credentials. That is why it is the one online lyric
 * source here: unlike a commercial streaming platform's undocumented endpoints,
 * this is a service that exists to be queried.
 *
 * Default-off. Aurora's promise is that the library stays on the machine, and a
 * lyric lookup necessarily sends the track title and artist to a third party, so
 * the user turns it on rather than discovering it afterwards.
 *
 * Results are cached on disk, which makes a second play instant and keeps the
 * lyrics readable offline.
 */

export interface LyricsQuery {
  title: string
  artist: string
  album: string
  /** Seconds; LRCLIB matches on this, so an accurate duration matters. */
  duration: number
}

export interface LyricsHit {
  text: string
  /** Where this result came from, so the UI can say so honestly. */
  origin: 'cache' | 'lrclib'
  trackName: string
  artistName: string
  synced: boolean
}

const REQUEST_TIMEOUT_MS = 9000
const CACHE_LIMIT_BYTES = 4 * 1024 * 1024

const cacheDir = (): string => path.join(app.getPath('userData'), 'lyrics-cache')

function cacheKey(query: LyricsQuery): string {
  const raw = `${query.artist}\u0000${query.title}\u0000${Math.round(query.duration)}`
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    h1 = Math.imul(h1 ^ code, 16777619)
    h2 = Math.imul(h2 + code, 2246822519)
  }
  return `${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`
}

function cacheFile(query: LyricsQuery, extension: string): string {
  return path.join(cacheDir(), `${cacheKey(query)}${extension}`)
}

function readCache(query: LyricsQuery): LyricsHit | null {
  for (const extension of ['.lrc', '.txt']) {
    const file = cacheFile(query, extension)
    try {
      const text = fs.readFileSync(file, 'utf8')
      if (!text.trim()) continue
      return {
        text,
        origin: 'cache',
        trackName: query.title,
        artistName: query.artist,
        synced: extension === '.lrc'
      }
    } catch {
      /* not cached under this extension */
    }
  }
  return null
}

function writeCache(query: LyricsQuery, text: string, synced: boolean): void {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true })
    // One extension per shape: the `.lrc` reader only understands timestamps.
    const file = cacheFile(query, synced ? '.lrc' : '.txt')
    fs.writeFileSync(file, text, 'utf8')
    pruneCache()
  } catch (error) {
    console.error('[aurora] could not cache lyrics', error)
  }
}

/** Keep the cache from growing without bound across years of listening. */
function pruneCache(): void {
  try {
    const dir = cacheDir()
    const entries = fs
      .readdirSync(dir)
      .map((name) => {
        const full = path.join(dir, name)
        const stat = fs.statSync(full)
        return { full, size: stat.size, atime: stat.atimeMs }
      })
      .sort((a, b) => b.atime - a.atime)

    let total = 0
    for (const entry of entries) {
      total += entry.size
      if (total > CACHE_LIMIT_BYTES) fs.rmSync(entry.full, { force: true })
    }
  } catch {
    /* pruning is best-effort */
  }
}

interface LrclibRecord {
  trackName?: string
  artistName?: string
  duration?: number
  instrumental?: boolean
  plainLyrics?: string | null
  syncedLyrics?: string | null
}

async function request(url: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await net.fetch(url, {
      headers: {
        // LRCLIB asks clients to identify themselves.
        'user-agent': `Aurora/${app.getVersion()} (https://github.com/; desktop music player)`,
        accept: 'application/json'
      },
      signal: controller.signal
    })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function toHit(record: LrclibRecord | null | undefined): LyricsHit | null {
  if (!record || record.instrumental) return null

  // Prefer the synchronised version: it drives the lyric stage line by line.
  const synced = (record.syncedLyrics ?? '').trim()
  if (synced) {
    return {
      text: synced,
      origin: 'lrclib',
      trackName: record.trackName ?? '',
      artistName: record.artistName ?? '',
      synced: true
    }
  }

  const plain = (record.plainLyrics ?? '').trim()
  if (!plain) return null

  /*
   * Wrap unsynchronised text in a synthetic LRC. Without timings there is no
   * honest way to highlight a line, so every line is given the same timestamp
   * and the stage shows the text as a block rather than pretending to follow it.
   */
  const stamped = plain
    .split(/\r?\n/)
    .map((line) => `[00:00.00]${line}`)
    .join('\n')

  return {
    text: stamped,
    origin: 'lrclib',
    trackName: record.trackName ?? '',
    artistName: record.artistName ?? '',
    synced: false
  }
}

/**
 * Look up lyrics for a track. Never throws: a lookup failure is an ordinary
 * outcome (offline, unknown track) and must not disturb playback.
 */
export async function lookupLyrics(query: LyricsQuery): Promise<LyricsHit | null> {
  const cached = readCache(query)
  if (cached) return cached

  const artist = query.artist.trim()
  const title = query.title.trim()
  if (!title) return null

  const duration = Math.round(query.duration)
  const direct = new URL('https://lrclib.net/api/get')
  direct.searchParams.set('track_name', title)
  if (artist && artist !== '未知艺术家') direct.searchParams.set('artist_name', artist)
  if (query.album.trim()) direct.searchParams.set('album_name', query.album.trim())
  if (duration > 0) direct.searchParams.set('duration', String(duration))

  const exact = toHit((await request(direct.toString())) as LrclibRecord | null)
  if (exact) {
    writeCache(query, exact.text, exact.synced)
    return exact
  }

  // Fall back to search: tags rarely match LRCLIB's spelling exactly, and an
  // exact-duration lookup misses on any rip whose duration is off by a second.
  const search = new URL('https://lrclib.net/api/search')
  search.searchParams.set('track_name', title)
  if (artist && artist !== '未知艺术家') search.searchParams.set('artist_name', artist)

  const results = (await request(search.toString())) as LrclibRecord[] | null
  if (!Array.isArray(results)) return null

  // Prefer a synchronised match, then the one closest in duration.
  const ranked = results
    .map((record) => ({ record, hit: toHit(record) }))
    .filter((entry): entry is { record: LrclibRecord; hit: LyricsHit } => entry.hit !== null)
    .sort((a, b) => {
      if (a.hit.synced !== b.hit.synced) return a.hit.synced ? -1 : 1
      if (duration > 0 && a.record.duration && b.record.duration) {
        return Math.abs(a.record.duration - duration) - Math.abs(b.record.duration - duration)
      }
      return 0
    })

  const best = ranked[0]
  if (!best) return null
  writeCache(query, best.hit.text, best.hit.synced)
  return best.hit
}
