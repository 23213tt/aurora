import { app, net, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { appSettings, loadSettings, saveSettings, type UpdateInterval } from './settings'
import { isNewer } from './version'
import { repositoryTarget } from './release-target'

// `UpdateInterval` is declared alongside the settings that store it; re-exported
// so callers of this module do not need to know where it lives.
export type { UpdateInterval }

/**
 * Update checking against GitHub Releases.
 *
 * The default is check-and-notify, and it stays the default: the builds are
 * unsigned, so there is no signature to verify before replacing the running
 * executable. Aurora reports the new version and opens the release page in the
 * real browser, which is also where the SmartScreen warning belongs - in the
 * user's own download flow, not hidden inside the app.
 *
 * Automatic download and install exists as an **opt-in** on top of that. When
 * the user turns it on they have been told, in the settings page, exactly what
 * they are giving up: the SmartScreen prompt, and any chance for Aurora to
 * verify the binary it is about to run. The two paths share one source of truth
 * for "is there a newer version" - the GitHub check above - so the news and the
 * binary can never disagree.
 */

/** Mirrors the `UpdatePrefs` block in `src/env.d.ts`. */
export interface UpdatePrefs {
  interval: UpdateInterval
  lastCheck: number
  autoInstall: boolean
  /**
   * Whether automatic installation can work *in this build*.
   *
   * False in a dev checkout and false when the optional `electron-updater`
   * package is not installed. The settings page uses it to disable the switch
   * rather than offering something that silently does nothing.
   */
  autoInstallAvailable: boolean
}

export async function updatePrefs(): Promise<UpdatePrefs> {
  const settings = loadSettings()
  return {
    interval: settings.updateInterval,
    lastCheck: settings.lastUpdateCheck,
    autoInstall: settings.autoInstallUpdates,
    autoInstallAvailable: await autoInstallAvailable()
  }
}

/** Pushes every state transition to the renderer's settings page. */
let broadcast: (result: UpdateResult) => void = () => undefined

export function onUpdateStatus(handler: (result: UpdateResult) => void): void {
  broadcast = handler
}

const INTERVAL_MS: Record<UpdateInterval, number> = {
  manual: Number.POSITIVE_INFINITY,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000
}


export interface UpdateInfo {
  version: string
  name: string
  notes: string
  url: string
  publishedAt: string
}

/**
 * Mirrors the `UpdateResult` union in `src/env.d.ts`.
 *
 * The three `install*` states only ever appear when the user has switched
 * automatic installation on; without it the flow still stops at `available`.
 */
export type UpdateResult =
  | { state: 'current'; current: string; checkedAt: number }
  | { state: 'available'; current: string; checkedAt: number; info: UpdateInfo }
  | { state: 'unconfigured'; current: string; message: string }
  | { state: 'error'; current: string; checkedAt: number; message: string }
  | {
      state: 'downloading'
      current: string
      info: UpdateInfo
      percent: number
      transferred: number
      total: number
    }
  | { state: 'ready'; current: string; info: UpdateInfo }
  | { state: 'installing'; current: string; info: UpdateInfo }

const REQUEST_TIMEOUT_MS = 9000

/**
 * The repository this build came from, read from the packaged `package.json`.
 *
 * The decision itself lives in `release-target.ts`, which is pure and tested:
 * the packaged file has no `build` block (electron-builder strips it), so the
 * target has to come from `repository.url`.
 */
function publishTarget(): { owner: string; repo: string } | null {
  try {
    const raw = fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')
    return repositoryTarget(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Markdown to something readable in a narrow panel. Approximate on purpose. */
function plainNotes(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/\*\*|__|`/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 1200)
}

interface GithubRelease {
  tag_name?: string
  name?: string
  body?: string
  html_url?: string
  published_at?: string
  draft?: boolean
  prerelease?: boolean
}

export async function checkForUpdate(): Promise<UpdateResult> {
  const current = app.getVersion()
  const target = publishTarget()

  if (!target) {
    return {
      state: 'unconfigured',
      current,
      message: '这个构建还没有配置发布仓库（package.json 里的 build.publish）'
    }
  }

  const checkedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await net.fetch(
      `https://api.github.com/repos/${target.owner}/${target.repo}/releases/latest`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'Aurora-Player'
        },
        signal: controller.signal
      }
    )

    if (response.status === 404) {
      // No releases yet is a normal state for a young repository.
      saveSettings({ lastUpdateCheck: checkedAt })
      return { state: 'current', current, checkedAt }
    }
    if (!response.ok) {
      return {
        state: 'error',
        current,
        checkedAt,
        message: `GitHub 返回 ${response.status}${response.status === 403 ? '（可能是接口访问频率限制）' : ''}`
      }
    }

    const release = (await response.json()) as GithubRelease
    if (release.draft) {
      saveSettings({ lastUpdateCheck: checkedAt })
      return { state: 'current', current, checkedAt }
    }

    const latest = (release.tag_name ?? '').replace(/^v/i, '')
    const url = release.html_url ?? `https://github.com/${target.owner}/${target.repo}/releases`

    saveSettings({ lastUpdateCheck: checkedAt })

    if (!latest || !isNewer(latest, current)) {
      return { state: 'current', current, checkedAt }
    }

    return {
      state: 'available',
      current,
      checkedAt,
      info: {
        version: latest,
        name: release.name?.trim() || `Aurora ${latest}`,
        notes: plainNotes(release.body ?? ''),
        url,
        publishedAt: release.published_at ?? ''
      }
    }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError'
    return {
      state: 'error',
      current,
      checkedAt,
      message: aborted ? '检查更新超时，稍后再试' : '无法连接到 GitHub'
    }
  } finally {
    clearTimeout(timer)
  }
}

/** True when a background check is due (never twice at once). */
let checkInFlight = false

export function shouldAutoCheck(): boolean {
  if (checkInFlight) return false
  const settings = loadSettings()
  const interval = INTERVAL_MS[settings.updateInterval]
  if (!Number.isFinite(interval)) return false
  return Date.now() - (settings.lastUpdateCheck ?? 0) > interval
}

export async function autoCheck(onResult: (result: UpdateResult) => void): Promise<void> {
  if (!shouldAutoCheck()) return
  checkInFlight = true
  try {
    const result = await checkForUpdate()
    if (result.state !== 'available') return
    onResult(result)
    // The settings page shows progress, so it needs the same news the toast got.
    broadcast(result)
    if (shouldAutoInstall(result)) void downloadAndInstall(result)
  } finally {
    checkInFlight = false
  }
}

/**
 * Should this result be downloaded and installed without asking?
 *
 * Both conditions matter. `autoInstallUpdates` is the user's explicit consent,
 * and `app.isPackaged` is the difference between a real installation and a dev
 * checkout, where there is no installer to replace and the updater would only
 * produce errors.
 */
export function shouldAutoInstall(result: UpdateResult): boolean {
  return result.state === 'available' && appSettings().autoInstallUpdates && app.isPackaged
}

/**
 * Download the pending release and hand it to the installer.
 *
 * `electron-updater` is loaded dynamically so that a user who never turns the
 * option on does not pay for loading it at startup. It is a real dependency now,
 * so `autoInstallAvailable` normally reports true - but the dynamic form stays,
 * because a packaged build can still be missing it and the settings page must be
 * able to say so instead of throwing.
 *
 * The GitHub check above remains the source of truth for *whether* there is an
 * update; this only fetches the file. That is why the update info shown here is
 * the info the check produced, not whatever the updater's own feed says.
 */

/** The slice of `electron-updater` this file uses. */
type ProgressInfo = { percent: number; transferred: number; total: number }

interface AutoUpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  on(event: 'download-progress', listener: (progress: ProgressInfo) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
}

/**
 * Load `electron-updater`, or null when it is not present.
 *
 * `import()` rather than a static import: the module registers itself against
 * `electron`'s app lifecycle on load, and a dev checkout should not pay that
 * cost at startup for a feature that is off by default.
 */
async function loadUpdater(): Promise<AutoUpdaterLike | null> {
  try {
    const module = (await import('electron-updater')) as unknown as { autoUpdater: AutoUpdaterLike }
    return module.autoUpdater ?? null
  } catch (error) {
    console.error('[aurora] electron-updater is unavailable', error)
    return null
  }
}

/** Whether this build can download and install by itself. */
export async function autoInstallAvailable(): Promise<boolean> {
  if (!app.isPackaged) return false
  return (await loadUpdater()) !== null
}

let installing = false

export async function downloadAndInstall(result: UpdateResult): Promise<void> {
  if (installing || result.state !== 'available') return
  // Narrowed once, so the progress callback and the failure path below cannot
  // lose track of which member of the union they are working with.
  const pending = result
  installing = true
  try {
    const updater = await loadUpdater()
    if (!updater) return
    /*
     * `autoDownload = false` plus an explicit `downloadUpdate()` is the ordering
     * the API expects: check first, then download. The alternative -
     * `checkForUpdatesAndNotify()` - downloads without asking, which would make
     * the setting's default a lie.
     */
    updater.autoDownload = false
    updater.autoInstallOnAppQuit = true

    updater.on('download-progress', (progress) => {
      broadcast({
        state: 'downloading',
        current: pending.current,
        info: pending.info,
        percent: progress.percent,
        transferred: progress.transferred,
        total: progress.total
      })
    })

    await updater.checkForUpdates()
    await updater.downloadUpdate()
    broadcast({ state: 'ready', current: pending.current, info: pending.info })
  } catch (error) {
    // Failing to download must not look like failing to check: the user still
    // has a release page they can open by hand.
    console.error('[aurora] automatic update failed', error)
    broadcast({
      state: 'available',
      current: pending.current,
      checkedAt: Date.now(),
      info: pending.info
    })
  } finally {
    installing = false
  }
}

/** Quit and run the downloaded installer. Only meaningful after `ready`. */
export async function installPendingUpdate(): Promise<boolean> {
  if (!app.isPackaged) return false
  try {
    const updater = await loadUpdater()
    if (!updater) return false
    updater.quitAndInstall()
    return true
  } catch (error) {
    console.error('[aurora] could not start the installer', error)
    return false
  }
}

/** Hand the release page to the real browser, never to an in-app window. */
export async function openReleasePage(url: string): Promise<void> {
  if (!/^https:\/\/github\.com\//.test(url)) return
  await shell.openExternal(url)
}
