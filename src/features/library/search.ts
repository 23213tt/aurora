import { scoreTrack } from './store'
import type { Track } from '../../types'

/**
 * Searching the tracks already on this machine.
 *
 * One query per source is the shape the search screen uses: the online catalogue
 * is a request you submit, the local library is a list you scan, and both answer
 * the same question. Keeping this here - and tested - means the screen has no
 * opinion about how matching works, and the ranking rule (`scoreTrack`) stays in
 * one place.
 */
export function searchLocalTracks(tracks: Track[], query: string): Track[] {
  const trimmed = query.trim()
  if (!trimmed) return []
  return tracks
    .map((item) => ({ item, score: scoreTrack(item, trimmed) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item)
}
