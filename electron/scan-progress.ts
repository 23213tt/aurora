import type { BrowserWindow } from 'electron'
import type { ScanProgress } from './library-scan'

/**
 * Coalesced scan-progress delivery.
 *
 * `scanLibrary` reports once per *discovered* file and once per *indexed* file,
 * so a 5,000-track library produced ~10,000 `library:progress` messages
 * (measured: scripts/probe-aurora-bg.mjs reports `messagesPerFile: 2`). Each one
 * cost the renderer two store writes (`setCurrentScan` + `setProgress`) and one
 * render of the whole App tree, because the progress bar is state at the root
 * (src/library/scan.ts, src/App.tsx). None of it is visible while the window is
 * hidden.
 *
 * The fix belongs on the sending side: a message the renderer never receives
 * costs nothing, whereas de-duplicating in the renderer would still pay the IPC
 * crossing and the store notification.
 *
 * This module deliberately does not import `electron` at runtime - the transport
 * is injected (see `configureProgressTransport`). That is the same shape as
 * `electron/app-paths.ts`, and it is what lets the throttle be unit-tested under
 * bare Node, where an ESM named import of `electron` fails outright.
 */

/**
 * 100ms.
 *
 * What is on screen is a filename and a percentage. 10 Hz is already smoother
 * than a progress bar is read, and a scan's throughput is bounded by disk and tag
 * parsing, so a faster interval only spends IPC repainting the same wedges. A
 * slower one starts to look like the bar has stalled.
 */
const PROGRESS_THROTTLE_MS = 100

export interface ProgressTransport {
  /** Deliver one report to every window that cares. */
  send(progress: ScanProgress): void
}

let transport: ProgressTransport | null = null

export function configureProgressTransport(next: ProgressTransport): void {
  transport = next
}

/**
 * The clock, injected for the same reason as the transport.
 *
 * Because the throttle's whole job is a time decision, a probe that drives it
 * through real timers measures Node's timer granularity (~1ms per `setTimeout`,
 * which is coarser than the interval being tested) rather than the throttle. A
 * swappable `now()` lets the measurement advance time exactly.
 */
let now: () => number = Date.now

export function configureProgressClock(next: () => number): void {
  now = next
}

let pending: ScanProgress | null = null
let timer: NodeJS.Timeout | null = null
let lastSentAt = 0
/** Phase of the last report seen, to notice the walking -> reading transition. */
let lastPhase: ScanProgress['phase'] | null = null

/**
 * Leading + trailing.
 *
 * The leading edge keeps the bar moving the instant a scan starts, and the
 * trailing edge guarantees that the *newest* report is always the one that
 * arrives: intermediate frames are what get dropped, never the current state.
 * Without the trailing edge a scan that finished inside one window would report
 * the same percentage forever.
 *
 * Two cases are exempt and go out immediately:
 *
 *  - `phase: 'done'` is not an update but the final state. A progress bar left at
 *    97% while the scan has actually finished is a bug, not a frame that was
 *    saved.
 *  - A phase change. It is the one report where waiting would be visible: at the
 *    end of the walk the bar is still at 0%, so a throttled "reading" report
 *    reads as the scan having stalled. The walk itself is one message per file -
 *    thousands of them - and is coalesced like everything else, because the bar
 *    cannot move until the walk is over anyway.
 */
export function sendProgress(progress: ScanProgress): void {
  if (progress.phase === 'done') {
    // The pending read-phase report is now strictly older than the final state,
    // so it is dropped rather than flushed: delivering it first would only make
    // the bar jump backwards before landing.
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    pending = null
    lastPhase = progress.phase
    deliver(progress)
    return
  }

  const phaseChanged = progress.phase !== lastPhase
  lastPhase = progress.phase
  if (phaseChanged) {
    lastSentAt = now()
    deliver(progress)
    return
  }

  const elapsed = now() - lastSentAt
  if (elapsed >= PROGRESS_THROTTLE_MS) {
    deliver(progress)
    return
  }

  pending = progress
  if (timer) return
  timer = setTimeout(flushProgress, PROGRESS_THROTTLE_MS - elapsed)
}

function flushProgress(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const progress = pending
  pending = null
  if (progress) deliver(progress)
}

function deliver(progress: ScanProgress): void {
  lastSentAt = now()
  transport?.send(progress)
}

/**
 * Reset the throttle. Used by the tests; a running app never needs it, because a
 * new scan starts with a `phase: 'walking'` report that is delivered immediately.
 */
export function resetProgressThrottle(): void {
  if (timer) clearTimeout(timer)
  timer = null
  pending = null
  lastSentAt = 0
  lastPhase = null
}

// --- window visibility -----------------------------------------------------

export interface WindowVisibilityState {
  /** The main window exists and is on screen. */
  visible: boolean
  minimized: boolean
  /** Nothing drawn in it can reach the screen (hidden to the tray, or minimised). */
  hidden: boolean
}

/**
 * The main process's answer to "is the player window actually on screen?".
 *
 * `document.hidden` is not a reliable proxy inside Electron: a window hidden to
 * the tray can report a stale `hidden`, which is harmless when Chromium throttles
 * the renderer but actively wrong here, where `backgroundThrottling: false` keeps
 * the page running at full rate. Electron's own `isVisible()`/`isMinimized()` is
 * the authority.
 *
 * Two deliberate omissions, both of which would be regressions if "optimised":
 *
 *  - **Focus is not part of this.** A visible-but-blurred window is on screen and
 *    must keep rendering at full rate; pausing on blur makes alt-tabbing back to
 *    a frozen frame.
 *  - **Occlusion is not part of this.** A window covered by another app is still
 *    composited, and Electron exposes no reliable "completely covered" signal.
 */
export function mainWindowVisibility(mainWindow: BrowserWindow | null): WindowVisibilityState {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { visible: false, minimized: false, hidden: true }
  }
  const minimized = mainWindow.isMinimized()
  const visible = mainWindow.isVisible() && !minimized
  return { visible, minimized, hidden: !visible }
}
