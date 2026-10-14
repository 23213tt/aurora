import { useCallback, useEffect, useState } from 'react'
import { bridge } from '../bridge'

/**
 * Library roots: the folders Aurora is allowed to index and serve files from.
 * The main process owns the persisted list; this hook is just a view of it.
 */
export function useRoots() {
  const [roots, setRoots] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    void bridge.library
      .getRoots()
      .then((next) => {
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

  return { roots, add, remove, busy, ready }
}
