import { useCallback, useEffect, useState } from 'react'
import { isNative } from '../../bridge'
import { emptyLyrics, parseLrc, type Lyrics } from '../../lyrics/lrc'
import type { Track } from '../../types'
import { extractPalette, IDLE_PALETTE, type Palette } from './palette'
import { artworkFor, sourceFor } from './source'

/**
 * Resolve the current track's palette and publish it as CSS custom properties.
 *
 * This is the single mechanism behind "the interface owns no colour": nothing
 * downstream needs to know about artwork, it just reads `var(--accent)`.
 */
export function usePalette(track: Track | null): Palette {
  const [palette, setPalette] = useState<Palette>(IDLE_PALETTE)
  const trackId = track?.id ?? null

  useEffect(() => {
    const source = artworkFor(track)
    if (!source) {
      setPalette(IDLE_PALETTE)
      return
    }
    let cancelled = false
    void extractPalette(source).then((next) => {
      if (!cancelled) setPalette(next)
    })
    return () => {
      cancelled = true
    }
    // Keyed on the track id, not the object: an equal track must not re-extract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId])

  useEffect(() => {
    const root = document.documentElement
    root.style.setProperty('--accent', palette.accent)
    root.style.setProperty('--accent-rgb', palette.accentRgb)
    root.style.setProperty('--accent-strong', palette.colors[1] ?? palette.accent)
  }, [palette])

  return palette
}

export interface LyricsState {
  lyrics: Lyrics
  /** Whether online lookup is allowed; the stage offers to turn it on. */
  onlineEnabled: boolean
  /** Force a re-resolve, e.g. right after enabling online lookup. */
  reload(): void
  setOnline(enabled: boolean): Promise<void>
}

/** Lyrics for the current track. The owning source decides where they come from. */
export function useLyrics(track: Track | null): LyricsState {
  const [lyrics, setLyrics] = useState<Lyrics>(() => emptyLyrics())
  const [onlineEnabled, setOnlineEnabled] = useState(false)
  // Bumped to re-run the lookup against the same track.
  const [revision, setRevision] = useState(0)
  const trackId = track?.id ?? null

  useEffect(() => {
    if (!isNative) return
    void window.aurora?.lyrics.isOnlineEnabled().then(setOnlineEnabled)
  }, [])

  useEffect(() => {
    const subject = track
    if (!subject) {
      setLyrics(emptyLyrics())
      return
    }

    let cancelled = false
    void sourceFor(subject)
      .lyrics(subject)
      .then((raw) => {
        if (!cancelled) setLyrics(raw ? parseLrc(raw) : emptyLyrics())
      })
      .catch(() => {
        if (!cancelled) setLyrics(emptyLyrics())
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackId, revision])

  const reload = useCallback(() => setRevision((value) => value + 1), [])

  const setOnline = useCallback(async (enabled: boolean) => {
    if (!isNative) return
    const applied = await window.aurora?.lyrics.setOnlineEnabled(enabled)
    setOnlineEnabled(Boolean(applied))
    // Re-resolve immediately so the user sees the result of their choice.
    setRevision((value) => value + 1)
  }, [])

  return { lyrics, onlineEnabled, reload, setOnline }
}
