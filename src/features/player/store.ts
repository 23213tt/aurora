import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { RepeatMode, Track } from '../../types'
/*
 * Explicit `.ts` extension: tests import this module directly and run under Node,
 * whose ESM resolver does not guess extensions the way Vite does. See
 * tests/play-next.test.ts.
 */
import { identityOrder, reconcile, shuffledOrder } from './queue.ts'

export const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const
export const EQ_FLAT: number[] = EQ_BANDS.map(() => 0)

/**
 * Pure state. Nothing here touches the audio engine - the engine subscribes to
 * this store for *intent* and writes back *observations*, which keeps the data
 * flow one-directional and avoids action/report feedback loops.
 */
export interface PlayerState {
  queue: Track[]
  order: number[]
  index: number
  /** Whether the transport is rolling. Observation, owned by the engine. */
  playing: boolean
  /** Seconds. Observation. */
  position: number
  /** Seconds. Observation. */
  duration: number
  /** True while the engine is buffering a track. */
  loading: boolean
  volume: number
  muted: boolean
  shuffle: boolean
  repeat: RepeatMode
  eqEnabled: boolean
  eqGains: number[]
  /** Crossfade length in seconds; 0 disables it. */
  crossfadeSec: number

  current(): Track | null
  setQueue(queue: Track[], startAt?: number): void
  enqueue(tracks: Track[], position?: 'next' | 'end'): void
  removeAt(queueIndex: number): void
  clearQueue(): void
  jumpTo(queueIndex: number): void
  setPosition(position: number): void
  setDuration(duration: number): void
  setPlaying(playing: boolean): void
  setLoading(loading: boolean): void
  setVolume(volume: number): void
  setMuted(muted: boolean): void
  setShuffle(shuffle: boolean): void
  setRepeat(repeat: RepeatMode): void
  setEqEnabled(enabled: boolean): void
  setEqGains(gains: number[]): void
  setCrossfade(seconds: number): void
}

/** Fisher-Yates. `sort(() => Math.random() - 0.5)` is not a shuffle. */
function shuffleInPlace<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[items[i], items[j]] = [items[j], items[i]]
  }
  return items
}

export const usePlayer = create<PlayerState>()(
  persist(
    (set, get) => ({
      queue: [],
      order: [],
      index: -1,
      playing: false,
      position: 0,
      duration: 0,
      loading: false,
      volume: 0.85,
      muted: false,
      shuffle: false,
      repeat: 'off',
      eqEnabled: false,
      eqGains: [...EQ_FLAT],
      crossfadeSec: 0,

      current() {
        const { queue, index } = get()
        return index >= 0 && index < queue.length ? queue[index] : null
      },

      setQueue(queue, startAt = 0) {
        const index = queue.length === 0 ? -1 : Math.min(Math.max(0, startAt), queue.length - 1)
        set({
          queue,
          index,
          order: get().shuffle ? shuffledOrder(queue.length, index) : identityOrder(queue.length),
          position: 0,
          duration: 0
        })
      },

      enqueue(tracks, position = 'end') {
        const { queue, index, order, shuffle } = get()
        if (tracks.length === 0) return

        if (position === 'next' && queue.length > 0 && index >= 0) {
          const insertAt = index + 1
          // Every existing index at or after the insertion point shifts up.
          const shifted = order.map((i) => (i >= insertAt ? i + tracks.length : i))
          // The new tracks land directly after whatever is playing.
          const at = shifted.indexOf(index)
          const added = tracks.map((_, k) => insertAt + k)
          set({
            queue: [...queue.slice(0, insertAt), ...tracks, ...queue.slice(insertAt)],
            order: [...shifted.slice(0, at + 1), ...added, ...shifted.slice(at + 1)]
          })
          return
        }

        const offset = queue.length
        const added = tracks.map((_, k) => offset + k)
        set({
          queue: [...queue, ...tracks],
          index: index === -1 && added.length > 0 ? added[0] : index,
          order: [...order, ...(shuffle ? shuffleInPlace([...added]) : added)]
        })
      },

      removeAt(queueIndex) {
        const { queue, index, order } = get()
        if (queueIndex < 0 || queueIndex >= queue.length) return
        const nextQueue = queue.filter((_, i) => i !== queueIndex)
        if (nextQueue.length === 0) {
          set({ queue: [], order: [], index: -1, position: 0, duration: 0, playing: false })
          return
        }
        // Anything after the removed slot shifts down by one.
        const remappedOrder = order
          .filter((i) => i !== queueIndex)
          .map((i) => (i > queueIndex ? i - 1 : i))
        const nextIndex =
          queueIndex === index ? Math.min(index, nextQueue.length - 1)
          : queueIndex < index ? index - 1
          : index
        const fixed = reconcile(nextQueue, remappedOrder, nextIndex)
        set({ queue: nextQueue, order: fixed.order, index: fixed.index })
      },

      clearQueue() {
        set({ queue: [], order: [], index: -1, position: 0, duration: 0, playing: false })
      },

      jumpTo(queueIndex) {
        const { queue } = get()
        if (queueIndex < 0 || queueIndex >= queue.length) return
        set({ index: queueIndex, position: 0 })
      },

      setPosition: (position) => set({ position }),
      setDuration: (duration) => set({ duration }),
      setPlaying: (playing) => set({ playing }),
      setLoading: (loading) => set({ loading }),
      setVolume: (volume) => set({ volume: Math.min(1, Math.max(0, volume)), muted: false }),

      setMuted(muted) {
        set({ muted })
      },

      setShuffle(shuffle) {
        const { queue, index } = get()
        set({
          shuffle,
          order: shuffle ? shuffledOrder(queue.length, index) : identityOrder(queue.length)
        })
      },

      setRepeat: (repeat) => set({ repeat }),
      setEqEnabled: (eqEnabled) => set({ eqEnabled }),
      setEqGains: (eqGains) => set({ eqGains }),
      setCrossfade: (crossfadeSec) => set({ crossfadeSec })
    }),
    {
      name: 'aurora.player.prefs',
      version: 1,
      // Only user preferences survive a restart; the queue is session state.
      partialize: (state) => ({
        volume: state.volume,
        muted: state.muted,
        shuffle: state.shuffle,
        repeat: state.repeat,
        eqEnabled: state.eqEnabled,
        eqGains: state.eqGains,
        crossfadeSec: state.crossfadeSec
      })
    }
  )
)
