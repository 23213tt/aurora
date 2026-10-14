/**
 * Working out which GitHub repository a build should check for updates.
 *
 * This is pure so it can be tested - and it needs testing, because the previous
 * version of this logic read `build.publish` out of the *packaged*
 * `package.json`, where that block does not exist. electron-builder strips it
 * when packaging, so every shipped build said "这个构建还没有配置发布仓库" and
 * neither update checking nor auto-install could ever work. In development the
 * source file still had the block, so it looked correct.
 *
 * The packaged file has exactly these keys:
 *   name, private, version, description, author, license, repository, main, dependencies
 * so `repository.url` is what to read.
 */

interface PublishConfig {
  provider?: string
  owner?: string
  repo?: string
}

const PLACEHOLDER = /REPLACE-WITH-YOUR-USERNAME/i

export interface RepositoryTarget {
  owner: string
  repo: string
}

export function repositoryTarget(pkg: {
  repository?: string | { url?: string }
  build?: { publish?: PublishConfig }
}): RepositoryTarget | null {
  const usable = (owner?: string, repo?: string): RepositoryTarget | null =>
    owner && repo && !PLACEHOLDER.test(owner) && !PLACEHOLDER.test(repo) ? { owner, repo } : null

  // Kept as a fallback: running from source, this is present and authoritative.
  const fromPublish = usable(pkg.build?.publish?.owner, pkg.build?.publish?.repo)
  if (fromPublish) return fromPublish

  const url = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  if (!url) return null
  // https://github.com/o/r(.git) | git+https://… | git@github.com:o/r.git
  const match = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url.trim())
  if (!match) return null
  return usable(match[1], match[2])
}
