import { useEffect } from 'react'
import { bridge, isNative } from '../bridge'
import { activeLineAt, type Lyrics } from '../lyrics/lrc'
import { usePlayer } from '../player/store'
import type { Track } from '../types'

interface DesktopLyricsBridgeProps {
  lyrics: Lyrics
  track: Track | null
  playing: boolean
}

/**
 * Feeds the desktop lyric window.
 *
 * Subscribes to the *derived active line index* rather than to `position`, so
 * crossing the process boundary happens a handful of times per song instead of
 * sixty times a second. The same trick that keeps the stage from re-rendering
 * also keeps this IPC channel quiet.
 *
 * Renders nothing: it exists purely to project player state into the overlay
 * window.
 */
export function DesktopLyricsBridge({ lyrics, track, playing }: DesktopLyricsBridgeProps) {
  const active = usePlayer((state) => activeLineAt(lyrics.lines, state.position))

  useEffect(() => {
    if (!isNative) return

    const lineAt = (index: number): string | null => {
      const text = lyrics.lines[index]?.text?.trim()
      return text ? text : null
    }

    void bridge.overlay.push({
      // Null while there is no lyric means the overlay falls back to showing the
      // track title, which keeps it useful for instrumentals.
      text: lyrics.empty ? null : lineAt(active),
      next: lyrics.empty ? null : lineAt(active + 1),
      title: track?.title ?? '',
      artist: track?.artist ?? '',
      playing
    })
  }, [active, lyrics, track?.title, track?.artist, playing])

  return null
}
