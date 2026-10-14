import { useMemo } from 'react'
import type { NeteaseSong } from '../../env'
import { rememberNeteaseCover } from '../library/source'
import { streamOf } from './store'
import { neteaseSongId, toTrack } from './track'
import type { Track } from '../../types'

/**
 * Song -> Track, for the view layer.
 *
 * Differs from the pure `toTrack` in two ways: the resolved bitrate is attached
 * when a URL is already cached, so a list shows the quality actually in hand
 * rather than the quality that was requested; and the upstream cover address is
 * handed to the source, because `Track` has nowhere to carry it.
 */
export function toRow(song: NeteaseSong): Track {
  const track = toTrack(song, streamOf(song.id))
  rememberNeteaseCover(track.id, song.album.picUrl)
  return track
}

/**
 * Map a song list to tracks, memoised on the list itself.
 *
 * The store hands back a new array only when the list actually changes, so
 * identity is the right key: `toTrack` stamps `addedAt`, and rebuilding rows on
 * every render would make every row look freshly added.
 */
export function useNeteaseTracks(songs: NeteaseSong[]): Track[] {
  return useMemo(() => songs.map(toRow), [songs])
}

/** The fee flag, in words. A VIP track is not a missing track. */
export function paymentLabel(song: NeteaseSong): string {
  switch (song.fee) {
    case 0:
      return '免费'
    case 1:
      return '需要会员'
    case 4:
      return '需要购买专辑'
    case 8:
      return '免费试听，完整版需要会员'
    default:
      return `付费类型 ${song.fee}`
  }
}

/** Whether this track id belongs to the online source. */
export function isNeteaseTrack(track: Track | null): boolean {
  return track !== null && neteaseSongId(track) !== null
}
