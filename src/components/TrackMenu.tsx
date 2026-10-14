import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isNative } from '../bridge'
import type { Track } from '../types'

interface TrackMenuProps {
  track: Track
  /** Where the pointer asked for it, in viewport coordinates. */
  x: number
  y: number
  playlists: { id: string; name: string }[]
  onClose(): void
  onPlayNext(): void
  onAddToPlaylist(playlistId: string): void
  onReveal(): void
}

const MARGIN = 8

/**
 * The per-track actions menu.
 *
 * Positioned at the pointer but clamped into the viewport: a menu opened near the
 * bottom-right corner would otherwise be drawn mostly off-screen, which reads as
 * the menu being broken rather than as a positioning bug.
 */
export function TrackMenu({
  track,
  x,
  y,
  playlists,
  onClose,
  onPlayNext,
  onAddToPlaylist,
  onReveal
}: TrackMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }))

  /*
   * Reposition on resize rather than closing.
   *
   * The menu is placed in viewport coordinates, so a resize invalidates where it
   * is. Dismissing it would technically avoid the misplacement, but silently
   * vanishing under the user's pointer is worse than moving: they asked for a
   * menu, and a menu that stays put and stays on screen is the answer.
   */
  useEffect(() => {
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight })
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({
      left: Math.max(MARGIN, Math.min(x, viewport.width - rect.width - MARGIN)),
      top: Math.max(MARGIN, Math.min(y, viewport.height - rect.height - MARGIN))
    })
  }, [x, y, viewport])

  useEffect(() => {
    // `pointerdown` rather than `click`: the menu should be gone before the
    // click lands on whatever is underneath it.
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  return (
    <div
      className="menu"
      role="menu"
      ref={ref}
      style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
      aria-label={`${track.title} 的操作`}
    >
      <button className="menu__item" role="menuitem" onClick={onPlayNext}>
        下一首播放
      </button>

      <div className="menu__sep" role="separator" />

      <div className="menu__label">加入播放列表</div>
      <div className="menu__scroll">
        {playlists.length === 0 ? (
          <div className="menu__empty">还没有播放列表</div>
        ) : (
          playlists.map((playlist) => (
            <button
              key={playlist.id}
              className="menu__item"
              role="menuitem"
              onClick={() => onAddToPlaylist(playlist.id)}
            >
              {playlist.name}
            </button>
          ))
        )}
      </div>

      <div className="menu__sep" role="separator" />

      <button
        className="menu__item"
        role="menuitem"
        onClick={onReveal}
        // The browser preview has no filesystem to reveal anything in.
        disabled={!isNative}
        title={isNative ? undefined : '只有桌面版能打开文件所在位置'}
      >
        在文件夹中显示
      </button>
    </div>
  )
}
