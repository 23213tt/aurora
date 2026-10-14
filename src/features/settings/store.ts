import { useEffect, useState } from 'react'
import { bridge, isNative } from '../../bridge'
import type {
  AppSettings,
  StorageUsage,
  UpdateInterval,
  UpdatePrefs,
  UpdateResult
} from '../../env'

/**
 * The settings page's state.
 *
 * A plain hook rather than a store: settings are read once when the page opens
 * and written straight through to the main process, which owns the truth. There
 * is no cross-view subscription to keep in sync, so a store would only add a
 * second copy of every value that could drift from the file on disk.
 */

/** Mirrors the defaults in `electron/settings.ts` so the preview has something sane. */
const FALLBACK_SETTINGS: AppSettings = {
  onlineLyrics: false,
  updateInterval: 'manual',
  updateLastCheck: 0,
  autoInstallUpdates: false,
  desktopLyrics: { size: 34, min: 18, max: 64 }
}

export interface SettingsPage {
  settings: AppSettings
  prefs: UpdatePrefs
  storage: StorageUsage | null
  /** Last update result, including download progress. */
  update: UpdateResult | null
  checking: boolean
  clearing: boolean
  /** True while a write is in flight, so controls can be disabled. */
  busy: boolean
  error: string | null

  setOnlineLyrics(enabled: boolean): Promise<void>
  setLyricsSize(size: number): Promise<void>
  setUpdateInterval(interval: UpdateInterval): Promise<void>
  setAutoInstall(enabled: boolean): Promise<void>
  checkForUpdates(): Promise<void>
  installUpdate(): Promise<void>
  clearCache(): Promise<void>
  refreshStorage(): Promise<void>
}

export function useSettingsPage(): SettingsPage {
  const [settings, setSettings] = useState<AppSettings>(FALLBACK_SETTINGS)
  const [prefs, setPrefs] = useState<UpdatePrefs>({
    interval: 'manual',
    lastCheck: 0,
    autoInstall: false,
    autoInstallAvailable: false
  })
  const [storage, setStorage] = useState<StorageUsage | null>(null)
  const [update, setUpdate] = useState<UpdateResult | null>(null)
  const [checking, setChecking] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [loaded, updatePrefs, usage] = await Promise.all([
          bridge.settings.getAll(),
          bridge.updates.getPrefs(),
          bridge.settings.getStorage()
        ])
        if (cancelled) return
        setSettings(loaded)
        setPrefs(updatePrefs)
        setStorage(usage)
      } catch (problem) {
        if (!cancelled) setError(describe(problem))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  /*
   * The main process pushes every update transition: the manual check, the
   * background check, download progress and readiness. Subscribing once here
   * means the page never has to poll or guess.
   */
  useEffect(() => bridge.updates.onStatus(setUpdate), [])

  /** One wrapper for writes, so every setter reports failure the same way. */
  const write = async <T,>(action: () => Promise<T>, apply: (value: T) => void) => {
    setBusy(true)
    setError(null)
    try {
      apply(await action())
    } catch (problem) {
      setError(describe(problem))
    } finally {
      setBusy(false)
    }
  }

  return {
    settings,
    prefs,
    storage,
    update,
    checking,
    clearing,
    busy,
    error,

    setOnlineLyrics: (enabled) =>
      write(
        () => bridge.settings.setOnlineLyrics(enabled),
        (next) => setSettings(next)
      ),

    setLyricsSize: (size) =>
      write(
        () => bridge.settings.setDesktopLyricsSize(size),
        (next) => setSettings(next)
      ),

    setUpdateInterval: (interval) =>
      write(
        () => bridge.updates.setInterval(interval),
        (next) => setPrefs(next)
      ),

    setAutoInstall: (enabled) =>
      write(
        () => bridge.updates.setAutoInstall(enabled),
        (next) => setPrefs(next)
      ),

    async checkForUpdates() {
      setChecking(true)
      setError(null)
      try {
        setUpdate(await bridge.updates.check())
        // The check stamps `lastUpdateCheck`, so the displayed time is stale.
        setPrefs(await bridge.updates.getPrefs())
      } catch (problem) {
        setError(describe(problem))
      } finally {
        setChecking(false)
      }
    },

    async installUpdate() {
      await bridge.updates.install()
    },

    async clearCache() {
      setClearing(true)
      setError(null)
      try {
        setStorage(await bridge.settings.clearCache())
      } catch (problem) {
        setError(describe(problem))
      } finally {
        setClearing(false)
      }
    },

    async refreshStorage() {
      try {
        setStorage(await bridge.settings.getStorage())
      } catch (problem) {
        setError(describe(problem))
      }
    }
  }
}

function describe(problem: unknown): string {
  const message = problem instanceof Error ? problem.message : String(problem)
  return isNative ? message : `${message}（浏览器预览模式）`
}

/** Human-readable byte size. `null` means "could not be measured". */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return '无法测量'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

/** "今天 14:03" style, or a plain dash when nothing has run yet. */
export function formatCheckedAt(at: number): string {
  if (!at) return '还没有检查过'
  const then = new Date(at)
  const days = Math.floor((Date.now() - at) / (24 * 60 * 60 * 1000))
  const time = then.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  if (days <= 0) return `今天 ${time}`
  if (days === 1) return `昨天 ${time}`
  if (days < 30) return `${days} 天前`
  return then.toLocaleDateString('zh-CN')
}
