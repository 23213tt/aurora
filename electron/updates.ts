import { app, net, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { loadSettings, saveSettings } from './settings'
import { isNewer } from './version'

/**
 * Update checking against GitHub Releases.
 *
 * Deliberately check-and-notify rather than auto-install. The builds are
 * unsigned, so there is no signature to verify before replacing the running
 * executable; downloading and applying an unverified binary automatically is
 * exactly the behaviour users are right to distrust. Instead Aurora reports the
 * new version and opens the release page in the real browser, which is also
 * where the SmartScreen warning belongs - in the user's own download flow, not
 * hidden inside the app.
 */

export interface UpdateInfo {
  version: string
  name: string
  notes: string
  url: string
  publishedAt: string
}

export type UpdateResult =
  | { state: 'current'; current: string; checkedAt: number }
  | { state: 'available'; current: string; checkedAt: number; info: UpdateInfo }
  | { state: 'unconfigured'; current: string; message: string }
  | { state: 'error'; current: string; checkedAt: number; message: string }

const REQUEST_TIMEOUT_MS = 9000
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

interface PublishConfig {
  provider?: string
  owner?: string
  repo?: string
}

const PLACEHOLDER = /REPLACE-WITH-YOUR-USERNAME/i

/**
 * The repository this build came from, read from the packaged package.json.
 * Returns null while the publish config still holds placeholders, which is the
 * honest state for a fresh clone rather than a fabricated "up to date".
 */
function publishTarget(): { owner: string; repo: string } | null {
  try {
    const raw = fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { build?: { publish?: PublishConfig } }
    const publish = pkg.build?.publish
    if (!publish?.owner || !publish?.repo) return null
    if (PLACEHOLDER.test(publish.owner) || PLACEHOLDER.test(publish.repo)) return null
    return { owner: publish.owner, repo: publish.repo }
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

/** True when a background check is due (at most once a day, never twice at once). */
let checkInFlight = false

export function shouldAutoCheck(): boolean {
  if (checkInFlight) return false
  const settings = loadSettings()
  if (settings.autoCheckUpdates === false) return false
  return Date.now() - (settings.lastUpdateCheck ?? 0) > CHECK_INTERVAL_MS
}

export async function autoCheck(onResult: (result: UpdateResult) => void): Promise<void> {
  if (!shouldAutoCheck()) return
  checkInFlight = true
  try {
    const result = await checkForUpdate()
    if (result.state === 'available') onResult(result)
  } finally {
    checkInFlight = false
  }
}

/** Hand the release page to the real browser, never to an in-app window. */
export async function openReleasePage(url: string): Promise<void> {
  if (!/^https:\/\/github\.com\//.test(url)) return
  await shell.openExternal(url)
}
