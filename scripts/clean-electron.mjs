/*
 * Deletes the compiled main-process output before a rebuild.
 *
 * `tsc` writes into `outDir` but never prunes it, and `dist-electron/` is not in
 * version control, so a file that is renamed or moved leaves its old compiled copy
 * behind for good. Two consequences, both real:
 *
 *   - the stale copy is packaged and shipped, so `app.asar` carries modules whose
 *     source no longer exists;
 *   - a stale module can resolve `__dirname` differently from the current one,
 *     which is how a packaged build ended up computing its renderer root one
 *     directory too deep and showing an empty window.
 *
 * `vite build` empties `dist/` on its own, which is why only this half needed a fix.
 *
 * Usage: node scripts/clean-electron.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const target = path.join(root, 'dist-electron')

if (!fs.existsSync(target)) {
  console.log('dist-electron 不存在，无需清理。')
  process.exit(0)
}

// Refuse to delete anything that is not the compiled output, so a wrong `cwd` or a
// symlinked path cannot turn this into a recursive delete of something else.
const resolved = fs.realpathSync(target)
if (path.basename(resolved) !== 'dist-electron') {
  console.error(`拒绝删除：${resolved} 的目录名不是 dist-electron`)
  process.exit(1)
}

fs.rmSync(resolved, { recursive: true, force: true })
console.log(`已清理 ${path.relative(root, resolved)}`)
