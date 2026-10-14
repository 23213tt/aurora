import type { Track } from '../types'
import { engineHooks } from './engine'
import { driver } from './driver'
import { step } from './queue'
import { usePlayer } from './store'

/**
 * User intents. Components call these; they mutate the store and drive the
 * driver. Keeping them out of the store is what stops the store from depending
 * on the audio graph.
 */

function loadCurrent(autoplay: boolean): void {
  const track = usePlayer.getState().current()
  if (!track) return
  void driver.load(track, autoplay)
}

/** Standard transport behaviour: back within 3s restarts rather than rewinds. */
const PREV_RESTART_WINDOW = 3

export const player = {
  playQueue(tracks: Track[], startAt = 0): void {
    usePlayer.getState().setQueue(tracks, startAt)
    loadCurrent(true)
  },

  playTrack(track: Track): void {
    player.playQueue([track], 0)
  },

  addToQueue(tracks: Track[], position: 'next' | 'end' = 'end'): void {
    const before = usePlayer.getState().queue.length
    usePlayer.getState().enqueue(tracks, position)
    const after = usePlayer.getState()
    // Adding to an idle player should start it.
    if (before === 0 && after.queue.length > 0) loadCurrent(true)
  },

  toggle(): void {
    const { playing, current } = usePlayer.getState()
    if (!current()) return
    if (playing) driver.pause()
    else void driver.play()
  },

  play(): void {
    const state = usePlayer.getState()
    if (!state.current()) return
    void driver.play()
  },

  pause(): void {
    driver.pause()
  },

  next(fromEnd = false): void {
    const state = usePlayer.getState()
    const target = step(state.order, state.index, 1, state.repeat)

    if (!target) {
      // Queue exhausted with repeat off: stop cleanly at the end.
      if (fromEnd) {
        driver.pause()
        driver.seek(0)
        return
      }
      // A manual "next" on the last track restarts the queue from the top.
      if (state.queue.length > 0) {
        state.jumpTo(state.order[0] ?? 0)
        loadCurrent(true)
      }
      return
    }

    state.jumpTo(target.index)
    loadCurrent(true)
  },

  prev(): void {
    const state = usePlayer.getState()
    if (state.position > PREV_RESTART_WINDOW) {
      driver.seek(0)
      return
    }
    const target = step(state.order, state.index, -1, state.repeat)
    if (!target) {
      driver.seek(0)
      return
    }
    state.jumpTo(target.index)
    loadCurrent(true)
  },

  jumpTo(orderPosition: number): void {
    const state = usePlayer.getState()
    if (orderPosition < 0 || orderPosition >= state.order.length) return
    state.jumpTo(state.order[orderPosition])
    loadCurrent(true)
  },

  seekTo(seconds: number): void {
    driver.seek(seconds)
  },

  seekRatio(ratio: number): void {
    const { duration } = usePlayer.getState()
    if (duration <= 0) return
    driver.seek(ratio * duration)
  },

  nudge(seconds: number): void {
    const { position } = usePlayer.getState()
    driver.seek(position + seconds)
  },

  setVolume(volume: number): void {
    usePlayer.getState().setVolume(volume)
    driver.setVolume()
  },

  toggleMute(): void {
    usePlayer.getState().setMuted(!usePlayer.getState().muted)
    driver.setVolume()
  },

  toggleShuffle(): void {
    usePlayer.getState().setShuffle(!usePlayer.getState().shuffle)
  },

  cycleRepeat(): void {
    const { repeat } = usePlayer.getState()
    usePlayer.getState().setRepeat(repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off')
  },

  setEqEnabled(enabled: boolean): void {
    usePlayer.getState().setEqEnabled(enabled)
    driver.setEq()
  },

  setEqGains(gains: number[]): void {
    usePlayer.getState().setEqGains(gains)
    driver.setEq()
  },

  resetEq(): void {
    usePlayer.getState().setEqGains(usePlayer.getState().eqGains.map(() => 0))
    driver.setEq()
  }
}

// --- wiring ----------------------------------------------------------------

engineHooks.next = (fromEnd) => player.next(fromEnd)
engineHooks.prev = () => player.prev()

/**
 * The queue index is the single trigger for loading a track: wherever the index
 * moves - a click, a double-click, a media key - the engine follows.
 */
let lastIndex = usePlayer.getState().index
usePlayer.subscribe((state) => {
  if (state.index === lastIndex) return
  const wasIdle = lastIndex === -1
  lastIndex = state.index
  // Advancing an already-playing queue keeps rolling; selecting the first track
  // of an idle player starts it.
  if (state.playing || wasIdle) loadCurrent(true)
})
