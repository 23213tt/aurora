/*
 * Removes the `export` keyword from symbols that are only used inside their own
 * file - the findings `audit-exports.mjs` reports.
 *
 * Why do it mechanically: the decision is a name-based search across every tracked
 * file, which is exactly what the audit already does. Doing 121 of them by hand
 * would be 121 chances to break an import.
 *
 * What it refuses to touch, and why:
 *   - `export default`   - removing `export` changes it into something else.
 *   - `export { … }` and `export … from '…'` - re-exports; the audit skips them and
 *     so does this.
 *   - a reported line whose text does not match the symbol it claims - a sign the
 *     audit's line number and the file have drifted apart, so the edit would land
 *     somewhere unintended.
 *   - a reported symbol whose name does not appear on that line.
 *
 * Usage: node scripts/narrow-exports.mjs [--apply]
 * Without `--apply` it only prints what it would change.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const APPLY = process.argv.includes('--apply')
const root = process.cwd()

const raw = execFileSync('node', ['scripts/audit-exports.mjs', '--json'], { cwd: root, encoding: 'utf8' })
const report = JSON.parse(raw)
const findings = Array.isArray(report) ? report : report.findings ?? report.entries ?? []
if (findings.length === 0) {
  console.log('审计没有报告可收窄的导出。')
  process.exit(0)
}

/** file -> [ { line, name } ] */
const byFile = new Map()
for (const item of findings) {
  const file = item.file ?? item.path
  const line = Number(item.line)
  const name = item.name ?? item.symbol
  if (!file || !Number.isFinite(line) || !name) continue
  if (!byFile.has(file)) byFile.set(file, [])
  byFile.get(file).push({ line, name })
}

let changed = 0
let skipped = 0

for (const [file, items] of byFile) {
  const full = path.join(root, file)
  if (!fs.existsSync(full)) {
    console.log(`  跳过（文件不存在）: ${file}`)
    skipped += items.length
    continue
  }
  // Preserve the file's own line ending; this repo stores LF and checks out CRLF.
  const text = fs.readFileSync(full, 'utf8')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)

  const edits = []
  for (const item of items) {
    const index = item.line - 1
    if (index < 0 || index >= lines.length) {
      skipped += 1
      continue
    }
    const original = lines[index]

    // The symbol must actually be on the line the audit named.
    if (!new RegExp(`\\b${item.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(original)) {
      console.log(`  跳过（行内容与符号不符）: ${file}:${item.line} ${item.name}`)
      skipped += 1
      continue
    }
    // Refuse the forms where `export` is load bearing.
    if (/\bexport\s+default\b/.test(original) || /^\s*export\s*\{/.test(original) || /\bexport\s+\*\s+from\b/.test(original)) {
      skipped += 1
      continue
    }

    /*
     * Remove only the keyword, and only the one that starts the declaration:
     * `export` may also appear inside a string or a comment on the same line.
     */
    const replaced = original.replace(/^(\s*)export(\s+(?:declare\s+)?(?:abstract\s+)?)/, '$1$2')
    if (replaced === original) {
      skipped += 1
      continue
    }
    edits.push({ index, replaced })
  }

  if (edits.length === 0) continue

  for (const edit of edits) lines[edit.index] = edit.replaced
  if (APPLY) fs.writeFileSync(full, lines.join(eol))
  changed += edits.length
  console.log(`  ${APPLY ? '收窄' : '将收窄'} ${file}: ${edits.length} 个`)
}

console.log(`\n${APPLY ? '已收窄' : '可收窄'} ${changed} 个导出；跳过 ${skipped} 个。`)
if (!APPLY) console.log('加 --apply 才会真正写入。')
