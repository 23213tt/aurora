/*
 * Reachability audit: which tracked source files can never be loaded.
 *
 * Walks the import graph from the real entry points (the two HTML entries, the
 * main process, the preload, the test files) and reports anything left over.
 * Uses TypeScript's own parser rather than a regex, because a regex over
 * `import` lines reports false positives for dynamic imports, type-only imports
 * and re-exports - the exact cases that matter when deciding what to delete.
 *
 * Usage: node scripts/audit-reachability.mjs [--json]
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'

const root = process.cwd()
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)

/*
 * Declaration files are excluded: `.d.ts` describes types to the compiler and is
 * consumed through the type system, not by an import statement, so "nothing
 * imports it" is its normal state rather than a finding. Including them made the
 * audit always report `src/env.d.ts` as dead, which is the kind of permanent false
 * positive that teaches people to ignore the tool.
 */
const sources = tracked.filter((file) => /\.(ts|tsx)$/.test(file) && !/\.d\.ts$/.test(file))

/** Files that are loaded without being imported by anything else. */
const entries = [
  'src/main.tsx',
  'src/overlay/main.tsx',
  'electron/main.ts',
  'electron/preload.ts',
  // Vite resolves these as build entries, not imports.
  ...tracked.filter((file) => /\.config\.(ts|mjs)$/.test(file)),
  // Tests run directly.
  ...tracked.filter((file) => /^tests\/.*\.test\.ts$/.test(file))
]

const norm = (from, spec) => {
  if (!spec.startsWith('.')) return null
  const base = path.posix.join(path.posix.dirname(from), spec)
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
  for (const candidate of candidates) {
    if (tracked.includes(candidate)) return candidate
  }
  // Extension written explicitly in the import (tests do this).
  return null
}

const edges = new Map()
for (const file of sources) {
  const text = fs.readFileSync(path.join(root, file), 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, undefined)
  const found = new Set()

  const visit = (node) => {
    // import ... from 'x'  /  export ... from 'x'
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier
      if (spec && ts.isStringLiteral(spec)) {
        const target = norm(file, spec.text)
        if (target) found.add(target)
      }
    }
    // import('x') and require('x')
    if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const arg = node.arguments[0]
      if (ts.isStringLiteral(arg)) {
        const name = node.expression.getText(source)
        if (name === 'import' || name === 'require') {
          const target = norm(file, arg.text)
          if (target) found.add(target)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  edges.set(file, [...found])
}

const seen = new Set()
const queue = [...entries.filter((entry) => tracked.includes(entry))]
while (queue.length > 0) {
  const file = queue.pop()
  if (seen.has(file)) continue
  seen.add(file)
  for (const next of edges.get(file) ?? []) {
    if (!seen.has(next)) queue.push(next)
  }
}

const unreachable = sources.filter((file) => !seen.has(file)).sort()

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ entries: entries.length, reachable: seen.size, unreachable }, null, 2))
} else {
  console.log(`入口 ${entries.length} 个，可达 ${seen.size} 个源文件`)
  if (unreachable.length === 0) {
    console.log('✓ 没有被孤立的源文件')
  } else {
    console.log(`\n${unreachable.length} 个文件从任何入口都到不了：`)
    for (const file of unreachable) {
      const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n').length
      console.log(`  ${file}  (${lines} 行)`)
    }
  }
}
