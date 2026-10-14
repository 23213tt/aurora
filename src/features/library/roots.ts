import { useCallback, useEffect, useState } from 'react'
import { bridge } from '../../bridge'

/**
 * Library roots: the folders Aurora is allowed to index and serve files from.
 * The main process owns the persisted list; this hook is just a view of it.
 *
 * On a machine that has never been configured, this also asks the main process
 * to look for music that is already here. An app for playing your own files
 * should not open as an empty list with a button - that reads as "it did not
 * work" - so the first run finds the folders instead of waiting to be told.
 */
export function useRoots() {
  const [roots, setRoots] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  /** Folders this launch added by itself, so the UI can say so once. */
  const [autoAdded, setAutoAdded] = useState<string[]>([])

  useEffect(() => {
    let cancelled = false
    void bridge.library
      .getRoots()
      .then(async (next) => {
        if (cancelled) return
        if (next.length === 0 && bridge.library.autoDiscover) {
          try {
            const discovered = await bridge.library.autoDiscover()
            if (cancelled) return
            if (discovered.roots.length > 0) {
              setRoots(discovered.roots)
              setAutoAdded(discovered.added)
              setReady(true)
              return
            }
          } catch {
            // Discovery is a convenience; failing it must not block the app.
          }
        }
        if (cancelled) return
        setRoots(next)
        setReady(true)
      })
      .catch(() => setReady(true))
    return () => {
      cancelled = true
    }
  }, [])

  const add = useCallback(async () => {
    setBusy(true)
    try {
      const next = await bridge.library.addRoots()
      setRoots(next)
      return next
    } finally {
      setBusy(false)
    }
  }, [])

  const remove = useCallback(async (root: string) => {
    setRoots(await bridge.library.removeRoot(root))
  }, [])

  return { roots, add, remove, busy, ready, autoAdded }
}
