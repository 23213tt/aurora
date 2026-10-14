import { useEffect, useRef } from 'react'
import { bridge, isNative } from '../bridge'
import { activeLineAt, type Lyrics } from '../lyrics/lrc'
import { usePlayer } from '../player/store'
import type { Track } from '../types'

interface DesktopLyricsBridgeProps {
  lyrics: Lyrics
  track: Track | null
  playing: boolean
  /** Whether the desktop lyric window is on screen. Pushing while it is closed is waste. */
  overlayOpen: boolean
}

/**
 * Feeds the desktop lyric window.
 *
 * Subscribes to the *derived active line index* rather than to `position`, so
 * crossing the process boundary happens a handful of times per song instead of
 * sixty times a second. Measured at 0.25 pushes/second (10 per 40-second song)
 * by scripts/probe-aurora-bg.mjs - the same trick that keeps the stage from
 * re-rendering also keeps this IPC channel quiet.
 *
 * Renders nothing: it exists purely to project player state into the overlay
 * window.
 */
export function DesktopLyricsBridge({ lyrics, track, playing, overlayOpen }: DesktopLyricsBridgeProps) {
  const active = usePlayer((state) => activeLineAt(lyrics.lines, state.position))
  /**
   * The payload is the dependency list made explicit.
   *
   * The component only re-renders when one of these changes, but `lyrics` is a
   * new object on every track change, so comparing the rendered values is what
   * keeps one track change from producing two identical pushes. It also has to be
   * a ref rather than state: this must not trigger a render of its own.
   */
  const lastPushed = useRef<string | null>(null)

  useEffect(() => {
    if (!isNative) return

    const lineAt = (index: number): string | null => {
      const text = lyrics.lines[index]?.text?.trim()
      return text ? text : null
    }

    const payload = {
      // Null while there is no lyric means the overlay falls back to showing the
      // track title, which keeps it useful for instrumentals.
      text: lyrics.empty ? null : lineAt(active),
      next: lyrics.empty ? null : lineAt(active + 1),
      title: track?.title ?? '',
      artist: track?.artist ?? '',
      playing
    }

    /*
     * Nothing on screen can show this yet.
     *
     * The strip in the tray is a different window, so this is not a
     * visibility check on the player: it is the cheaper, unambiguous fact that
     * there is no overlay window at all. The main process keeps the state it was
     * last given and replays it when the window opens (electron/lyrics-overlay.ts
     * `open()` calls `sendState()`), so a reopened strip is never stale - but
     * while it is closed this IPC produced nothing anyone could see.
     */
    if (!overlayOpen) {
      lastPushed.current = null
      return
    }

    const key = JSON.stringify([payload.text, payload.next, payload.title, payload.artist, payload.playing])
    if (key === lastPushed.current) return
    lastPushed.current = key
    void bridge.overlay.push(payload)
  }, [active, lyrics, track?.title, track?.artist, playing, overlayOpen])

  return null
}
