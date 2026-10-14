import type { Track } from '../src/types.ts'

/** Minimal Track factory, so tests only state the fields they care about. */
export function makeTrack(id: string, path: string, overrides: Partial<Track> = {}): Track {
  return {
    id,
    path,
    title: id,
    artist: '某人',
    albumArtist: '某人',
    album: '专辑',
    genre: '',
    year: null,
    trackNo: null,
    discNo: null,
    duration: 200,
    bitrate: null,
    sampleRate: null,
    channels: null,
    codec: 'FLAC',
    lossless: true,
    size: 0,
    mtimeMs: 0,
    addedAt: 0,
    hasArt: false,
    gainDb: null,
    peak: null,
    ...overrides
  }
}
