import { useEffect, useState } from 'react'
import { bridge, isNative } from './bridge'

/**
 * Whether anything this window draws can reach the screen.
 *
 * This is the signal that lets an "always running" player stop spending CPU on
 * pixels nobody can see, and it is deliberately not `document.hidden`:
 *
 *  - Inside Electron, `document.hidden` can be stale. A window sent to the tray
 *    with `hide()` may still report itself visible, and because Aurora runs with
 *    `backgroundThrottling: false` nothing else will throttle the page either.
 *    The main process answers with Electron's own `isVisible()`/`isMinimized()`
 *    instead and pushes every change (see electron/scan-progress.ts).
 *  - **A hidden player window is not the same as "stop everything".** The desktop
 *    lyric strip is a second window that stays on screen when the player is in
 *    the tray, and it is fed by the player renderer. So this hook answers whether
 *    the *player window* is on screen, and callers that feed a second window must
 *    combine it with that window's own state before deciding to idle.
 *
 * In the browser preview there is no main process, so `document.hidden` is the
 * only source and it is accurate there.
 */
export interface WindowVisibility {
  /** The player window exists and is on screen (not hidden, not minimised). */
  visible: boolean
  minimized: boolean
  hidden: boolean
  /** `document.hidden`, kept for callers that want Chromium's own opinion. */
  occluded: boolean
}

const INITIAL: WindowVisibility = { visible: true, minimized: false, hidden: false, occluded: false }

export function useWindowVisibility(): WindowVisibility {
  const [state, setState] = useState<WindowVisibility>(INITIAL)

  useEffect(() => {
    if (!isNative) {
      const sync = () => {
        setState({
          visible: !document.hidden,
          minimized: false,
          hidden: document.hidden,
          occluded: document.hidden
        })
      }
      sync()
      document.addEventListener('visibilitychange', sync)
      return () => document.removeEventListener('visibilitychange', sync)
    }

    let cancelled = false
    void bridge.app.getVisibility().then((next) => {
      if (!cancelled) setState({ ...next, occluded: document.hidden })
    })

    const unsubscribe = bridge.app.onVisibility((next) => {
      setState({ ...next, occluded: document.hidden })
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return state
}
