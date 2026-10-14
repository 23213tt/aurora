import { setMissingStreamHandler } from '../library/source'
import { setNeteaseResume, useNetease } from '../netease/store'
import type { Track } from '../../types'
import { driver } from './driver'
import { usePlayer } from './store'

/**
 * Playback wiring for the online source.
 *
 * There is a genuine circular dependency here: the source needs the transport
 * to re-load a track whose URL arrived late, and the transport is what asks the
 * source for a URL in the first place. It is broken the same way
 * `engineHooks` breaks it - this module imports both sides and plugs them in,
 * so neither has to know about the other. It is imported once, for its side
 * effects, by the app entry point.
 *
 * Nothing here is Netease-specific logic beyond the two callbacks: no other
 * part of the player learns that an online source exists.
 */

/** How many upcoming tracks to resolve ahead of the playhead. */
const PREFETCH_AHEAD = 3

/**
 * Re-load whatever the engine currently believes is playing.
 *
 * Called after a late-arriving URL. `load` is the same entry point the engine
 * was reached through the first time, so the track is re-pointed with the URL
 * now cached; seeking to zero keeps the playhead off the previous track's
 * position, since the element never got far enough to have one of its own.
 */
function reloadCurrent(): void {
  const track = usePlayer.getState().current()
  if (!track) return
  driver.seek(0)
  void driver.load(track, true)
}

setNeteaseResume(reloadCurrent)

/*
 * The engine asked the source for a URL and the cache had none - the URL
 * expired, or playback advanced into a track nobody prefetched. Resolving it
 * here means the next attempt succeeds; the store calls `reloadCurrent` through
 * the callback above as soon as the fetch lands.
 */
setMissingStreamHandler((songId) => {
  void useNetease.getState().ensureStream(songId)
})
/**
 * Resolve the opening of the next few tracks while the current one plays.
 *
 * Without this, every advance into an unfetched track would present a moment of
 * silence and a dead play button while a network round trip completed. Only URL
 * resolution is done here - buffering is the audio element's business - so the
 * cost is a metadata request, not a second stream.
 */
let lastPrefetchIndex = -1
usePlayer.subscribe((state) => {
  if (state.index === lastPrefetchIndex) return
  lastPrefetchIndex = state.index
  if (state.index < 0 || state.queue.length === 0) return

  const upcoming: Track[] = []
  for (let i = state.index; i < state.queue.length && upcoming.length < PREFETCH_AHEAD; i += 1) {
    const track = state.queue[state.order[i] ?? i]
    if (track) upcoming.push(track)
  }
  useNetease.getState().prefetch(upcoming)
})
