/*
 * Removes imports that nothing in the file uses, until the type checker stops
 * reporting them.
 *
 * Needed because deleting a dead declaration orphans whatever it imported, which
 * orphans what *that* imported - a cascade that only `tsc` can trace reliably. So
 * this drives `tsc`, not a regexp: it reads the TS6133 errors, keeps only those on
 * import lines, removes them, and repeats until there is nothing left to remove.
 *
 * Only imports are touched. An unused *local* declaration is a different judgement
 * (it may be a contract that is meant to be wired up), so those are reported and
 * left alone.
 *
 * Usage: node scripts/prune-unused-imports.mjs [--apply]
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const APPLY = process.argv.includes('--apply')
const root = process.cwd()

/**
 * Runs one tsc project and returns its TS6133 findings.
 *
 * `shell: true` because on Windows `npx` is `npx.cmd`, which `execFileSync` cannot
 * resolve directly - it throws ENOENT, and the catch below then sees empty output
 * and concludes there is nothing to do. That silent no-op is exactly the failure
 * mode this whole exercise is about, so it is worth naming here.
 */
function unusedIn(project) {
  let out = ''
  try {
    out = execFileSync('npx', ['tsc', '-p', project, '--noEmit'], { cwd: root, encoding: 'utf8', shell: true })
  } catch (error) {
    out = String(error.stdout ?? '') + String(error.stderr ?? '')
  }
  const findings = []
  for (const line of out.split(/\r?\n/)) {
    const m = /^(.+?)\((\d+),(\d+)\): error TS6133: '(.+?)' is declared but its value is never read/.exec(line.trim())
    if (m) findings.push({ file: m[1].replace(/\\/g, '/'), line: Number(m[2]), name: m[4] })
  }
  if (findings.length === 0 && /error TS/.test(out)) {
    console.log(`  ⚠ ${project} 报了错但没有一条是 TS6133（可能是我解析不了的形式），原始输出前 200 字符：`)
    console.log('    ' + out.slice(0, 200).replace(/\n/g, '\n    '))
  }
  return findings
}

const projects = ['tsconfig.electron.json', 'tsconfig.json']
let totalRemoved = 0
let round = 0
const skipped = []

for (;;) {
  round += 1
  const findings = projects.flatMap((project) => unusedIn(project).map((f) => ({ ...f, project })))
  if (findings.length === 0) {
    console.log(`第 ${round} 轮：没有未使用的导入。`)
    break
  }

  const byFile = new Map()
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, [])
    byFile.get(f.file).push(f)
  }

  let removedThisRound = 0
  for (const [file, items] of byFile) {
    const full = path.join(root, file)
    if (!fs.existsSync(full)) continue
    const text = fs.readFileSync(full, 'utf8')
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const lines = text.split(/\r?\n/)

    const edits = []
    for (const item of items) {
      const index = item.line - 1
      const line = lines[index] ?? ''
      /*
       * An import, not a local declaration. The error's own column points at the
       * identifier, so this only needs to know whether the line is part of an import
       * statement - which includes a name on its own line inside a multi-line list.
       */
      const isImportLine =
        /^\s*import\b/.test(line) ||
        (index > 0 && lines.slice(Math.max(0, index - 12), index).some((l) => /^\s*import\b/.test(l)) && /^\s*[A-Za-z_$]/.test(line))
      if (!isImportLine) {
        skipped.push(`${file}:${item.line} ${item.name}（本地声明，未动）`)
        continue
      }
      edits.push({ index, line, name: item.name })
    }

    for (const edit of edits.sort((a, b) => b.index - a.index)) {
      const line = lines[edit.index]
      /*
       * Drop just this name: `import { a, b }` loses `a` and keeps `b`. When it is the
       * last name, the whole statement goes - `import { a }` alone would be invalid.
       */
      const braced = /^(.*\{)([^}]*)(\}\s*from\s*.+)$/.exec(line)
      if (braced) {
        const names = braced[2].split(',').map((n) => n.trim()).filter(Boolean)
        const left = names.filter((n) => n.replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim() !== edit.name)
        if (left.length === 0) {
          // Nothing left in the braces: remove the statement (and its line).
          lines.splice(edit.index, 1)
        } else {
          lines[edit.index] = `${braced[1]} ${left.join(', ')} ${braced[3]}`
        }
        removedThisRound += 1
        continue
      }
      // A bare `import X from '…'` whose only binding is unused.
      if (/^\s*import\s+[A-Za-z_$][\w$]*\s+from\b/.test(line)) {
        lines.splice(edit.index, 1)
        removedThisRound += 1
        continue
      }
      skipped.push(`${file}:${edit.line} ${edit.name}（导入形式未识别，未动）`)
    }

    if (APPLY && edits.length > 0) fs.writeFileSync(full, lines.join(eol))
  }

  console.log(`第 ${round} 轮：${APPLY ? '移除' : '可移除'} ${removedThisRound} 个未使用导入（共 ${findings.length} 条 TS6133）`)
  totalRemoved += removedThisRound
  if (!APPLY || removedThisRound === 0) break
}

console.log(`\n${APPLY ? '已移除' : '可移除'} ${totalRemoved} 个未使用导入。`)
if (skipped.length > 0) {
  console.log('\n未处理的本地声明（需人工判断，可能是本该接上的 contract）：')
  for (const s of [...new Set(skipped)]) console.log(`  ${s}`)
}
if (!APPLY) console.log('\n加 --apply 才会真正写入。')
