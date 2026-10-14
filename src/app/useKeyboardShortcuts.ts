import { useEffect } from 'react'
import { player } from '../features/player/actions'

/**
 * Transport and shell shortcuts, ignored while a field has focus.
 *
 * This is input handling and nothing else: which panels are open, what the volume
 * is, and what a key does. It lived in the middle of `App`, where the one thing a
 * reader needs to check - "does this shortcut fire while I am typing?" - was two
 * screens away from the key list.
 *
 * There are no shortcuts for the online screen or for navigation on purpose: the
 * bar's back and forward buttons already have a meaning here, and Overlay/Stage
 * are the only panels worth a bare letter.
 */
export function useKeyboardShortcuts(options: {
  stageOpen: boolean
  eqOpen: boolean
  queueOpen: boolean
  volume: number
  setStageOpen(update: (open: boolean) => boolean): void
  setEqOpen(update: (open: boolean) => boolean): void
  setQueueOpen(update: (open: boolean) => boolean): void
}) {
  const { stageOpen, eqOpen, queueOpen, volume, setStageOpen, setEqOpen, setQueueOpen } = options

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true
      if (typing) return

      const mod = event.ctrlKey || event.metaKey

      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        document.getElementById('global-search')?.focus()
        return
      }
      /* Escape closes the most recently opened panel, outermost first. */
      if (event.key === 'Escape') {
        if (stageOpen) setStageOpen(() => false)
        else if (eqOpen) setEqOpen(() => false)
        else if (queueOpen) setQueueOpen(() => false)
        return
      }
      if (event.key.toLowerCase() === 'l') {
        event.preventDefault()
        setStageOpen((open) => !open)
        return
      }
      if (event.key.toLowerCase() === 'e') {
        event.preventDefault()
        setEqOpen((open) => !open)
        return
      }
      if (event.code === 'Space') {
        event.preventDefault()
        player.toggle()
        return
      }
      if (event.key === 'ArrowRight' && mod) {
        event.preventDefault()
        player.next()
        return
      }
      if (event.key === 'ArrowLeft' && mod) {
        event.preventDefault()
        player.prev()
        return
      }
      if (event.key === 'ArrowRight') player.nudge(5)
      else if (event.key === 'ArrowLeft') player.nudge(-5)
      else if (event.key === 'ArrowUp') player.setVolume(volume + 0.05)
      else if (event.key === 'ArrowDown') player.setVolume(volume - 0.05)
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stageOpen, eqOpen, queueOpen, volume, setStageOpen, setEqOpen, setQueueOpen])
}
