import { bridge, isNative } from '../bridge'
import type { ScanProgress } from '../env'
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

/*
 * Two fields, two update rates.
 *
 * The main process already coalesces `library:progress` to 10 Hz
 * (electron/scan-progress.ts), which is the rate limit that matters. What is left
 * here is the cost of a report that carries no new information: the store is
 * subscribed at the App root (src/App.tsx), so *any* write re-renders the whole
 * library view, and a coalesced report can arrive while the file name and the
 * rounded percentage are both unchanged.
 *
 * `currentScan` is the one that changes fastest - it is the status line - so it is
 * written whenever the file changes and never rate limited further. `progress` is
 * only ever drawn rounded to a whole percent (src/App.tsx), so a write that
 * cannot change a displayed digit is pure re-render and is skipped. Comparing the
 * rounded value is safe precisely because the number is a fraction: any change
 * that would move the visible digit moves the rounded value too.
 */
let lastProgressFile: string | null = null
let lastProgressPercent = -1

function applyProgress(progress: ScanProgress): void {
  const total = Math.max(1, progress.found)
  // Progress is measured in files read, not files found, so a mostly cached
  // rescan still shows meaningful movement.
  const ratio = Math.min(1, (progress.scanned + progress.cached) / total)
  const percent = Math.round(ratio * 100)

  if (progress.current !== lastProgressFile) {
    lastProgressFile = progress.current
    useLibrary.getState().setCurrentScan(progress.current)
  }
  if (percent !== lastProgressPercent) {
    lastProgressPercent = percent
    useLibrary.getState().setProgress(ratio)
  }
}

export async function runScan(): Promise<void> {
  if (!isNative) return

  const store = useLibrary.getState()
  if (store.scanning) return

  store.setScanning(true)
  store.setError(null)

  if (!unsubscribeProgress) {
    unsubscribeProgress = bridge.library.onProgress(applyProgress)
  }
  // A rescan starts from zero, so the previous run's "already reported" values
  // must not suppress the first report of this one.
  lastProgressFile = null
  lastProgressPercent = -1

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
