import { useLibrary } from '../features/library/store'
import type { Track } from '../types'

/**
 * Preview-only stress harness.
 *
 * The demo library is 27 rows, which cannot answer "what does a real library
 * cost" - a personal library runs to thousands. This seeds the store with that
 * many synthetic tracks so DOM node count, grouping cost and scroll behaviour can
 * be measured on the real components rather than on a benchmark that reimplements
 * them.
 *
 * It lives outside `App.tsx` and is reached through `import()` in `App` (see the
 * stress branch there) so that it is a separate chunk. A production build never
 * fetches that chunk, which is the point: `App.tsx` must not carry measurement
 * code that only an `isNative` guard keeps out of the app. A guard can be
 * refactored away by accident; an unrequested chunk cannot be.
 *
 * Used by scripts/measure-dom.mjs, which sets `window.__AURORA_STRESS` before the
 * bundle runs.
 */
export function seedStressLibrary(count: number): void {
  const tracks: Track[] = []
  for (let i = 0; i < count; i += 1) {
    // Twelve tracks per album so grouping produces a plausible album/artist tree
    // rather than one album with 5,000 entries.
    const album = Math.floor(i / 12)
    tracks.push({
      id: `stress-${i}`,
      path: `C:\\stress\\album-${album}\\track-${i}.flac`,
      title: `压力测试曲目 ${i}`,
      artist: `艺术家 ${i % 200}`,
      albumArtist: `艺术家 ${i % 200}`,
      album: `专辑 ${album}`,
      genre: '',
      year: 2024,
      trackNo: (i % 12) + 1,
      discNo: 1,
      duration: 180 + (i % 120),
      bitrate: 900,
      sampleRate: 44100,
      channels: 2,
      codec: 'FLAC',
      lossless: true,
      size: 30_000_000,
      mtimeMs: 0,
      addedAt: 0,
      hasArt: false,
      gainDb: null,
      peak: null
    })
  }
  useLibrary.getState().setTracks(tracks)
}
