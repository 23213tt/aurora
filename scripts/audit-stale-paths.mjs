/*
 * Finds references to source files that no longer exist at the path written.
 *
 * A repository reorganisation leaves stale paths behind in the places nothing
 * type-checks: measurement scripts, docs, plans, comments. Those failures are
 * quiet - a perf tool that cannot find a module just reports nothing, so the
 * number simply disappears from the report and nobody notices.
 *
 * What this checks: every quoted or backticked string that looks like a path into
 * src/ or electron/, resolved against git's file list. It deliberately ignores
 * strings that resolve to a directory, since those are legitimate.
 *
 * Usage: node scripts/audit-stale-paths.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = process.cwd()
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)

const trackedSet = new Set(tracked)
/** Directories that exist, so a path into one is not stale. */
const dirs = new Set()
for (const file of tracked) {
  const parts = file.split('/')
  for (let i = 1; i < parts.length; i += 1) dirs.add(parts.slice(0, i).join('/'))
}

/** Files worth scanning (skip binaries and lockfiles by extension). */
const scanned = tracked.filter(
  (file) =>
    /\.(ts|tsx|mjs|cjs|js|md|json|css|html)$/.test(file) &&
    file !== 'package-lock.json' &&
    /*
     * Move plans are a record of where files *were*: every entry names a source
     * that no longer exists by design, so they are not stale references. Same for
     * the `usage:` examples inside the tooling itself, which show a fictional
     * path on purpose.
     */
    !file.startsWith('scripts/moves/')
)

/** Files whose `usage:` examples show made-up paths. */
const EXAMPLE_FILES = new Set(['scripts/move-files.mjs', 'scripts/audit-stale-paths.mjs'])

/** Longest meaningful source path in a string. */
const PATH_PATTERN = /(?:^|[\s'"(=`])((?:src|electron)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|css|mjs|cjs))/g

const stale = []
for (const file of scanned) {
  const text = fs.readFileSync(path.join(root, file), 'utf8')
  // A `usage:` line in tooling shows a path that is not meant to exist.
  const lines = text.split('\n')
  for (const match of text.matchAll(PATH_PATTERN)) {
    const candidate = match[1]
    if (trackedSet.has(candidate) || dirs.has(candidate)) continue
    const line = text.slice(0, match.index).split('\n').length
    if (EXAMPLE_FILES.has(file) && /\busage\b|^ \*/i.test(lines[line - 1] ?? '')) continue
    stale.push({ file, line, candidate })
  }
}

if (stale.length === 0) {
  console.log('✓ 没有指向已不存在文件的路径引用')
} else {
  console.log(`发现 ${stale.length} 处指向已不存在文件的引用：\n`)
  let current = ''
  for (const item of stale.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    if (item.file !== current) {
      current = item.file
      console.log(`  ${current}`)
    }
    console.log(`    L${item.line}  ${item.candidate}`)
  }
}
