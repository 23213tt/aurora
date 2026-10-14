import { usePlayer } from './store'

/**
 * Playhead position, in seconds.
 *
 * Deliberately not read from the store at the top of the app. The engine
 * publishes position on every animation frame, so a component high in the tree
 * that subscribes to it re-renders the whole tree sixty times a second. Only the
 * leaf components that actually draw the playhead should call these.
 */
export function usePosition(): number {
  return usePlayer((state) => state.position)
}

/** Track duration, in seconds. Changes once per track, so any level may read it. */
export function useDuration(): number {
  return usePlayer((state) => state.duration)
}
