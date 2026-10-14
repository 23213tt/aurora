/*
 * 重建前清掉主进程编译产物。tsc 不清理 outDir，移动过的文件会留下旧产物并被一起打包。
 * 用法: node scripts/clean-electron.mjs
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
