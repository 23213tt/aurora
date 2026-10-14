import { bridge, isNative } from '../bridge'
import { useLibrary } from './store'

/**
 * Scan orchestration.
 *
 * The main process owns the filesystem and the index; this module only drives
 * it and mirrors the result into the library store. A scan is resumable in the
 * sense that the index is written incrementally by the main process, so an
 * interrupted scan still leaves the next run with a warm cache.
 */

let unsubscribeProgress: (() => void) | null = null

/** Load the cached index on startup. Never scans: that is the user's call. */
export async function loadInitialIndex(): Promise<void> {
  if (!isNative) return
  try {
    const index = await bridge.library.getIndex()
    useLibrary.getState().setRoots(index.roots ?? [])
    useLibrary.getState().setTracks(index.tracks ?? [])
  } catch (error) {
    useLibrary.getState().setError(error instanceof Error ? error.message : String(error))
  }
}

export async function runScan(): Promise<void> {
  if (!isNative) return

  const store = useLibrary.getState()
  if (store.scanning) return

  store.setScanning(true)
  store.setError(null)

  if (!unsubscribeProgress) {
    unsubscribeProgress = bridge.library.onProgress((progress) => {
      const state = useLibrary.getState()
      state.setCurrentScan(progress.current)
      // Progress is measured in files read, not files found, so a mostly
      // cached rescan still shows meaningful movement.
      const total = Math.max(1, progress.found)
      state.setProgress(Math.min(1, (progress.scanned + progress.cached) / total))
    })
  }

  try {
    const index = await bridge.library.scan()
    useLibrary.getState().setTracks(index.tracks ?? [])
    useLibrary.getState().setRoots(index.roots ?? [])
  } catch (error) {
    useLibrary.getState().setError(error instanceof Error ? error.message : String(error))
  } finally {
    useLibrary.getState().setScanning(false)
    useLibrary.getState().setCurrentScan('')
    unsubscribeProgress?.()
    unsubscribeProgress = null
  }
}

export async function cancelScan(): Promise<void> {
  if (!isNative) return
  await bridge.library.cancelScan()
}
