/*
 * Exports that are only ever used inside their own file.
 *
 * An `export` on a module-private symbol widens the public surface for no
 * reason: it invites a future import that skips the intended seam, and it makes
 * "what is this module's contract" unanswerable by reading the file. The check
 * is name-based across every tracked source file, so a symbol that appears in
 * tests counts as used and is left alone.
 *
 * Usage: node scripts/audit-exports.mjs [--json]
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'

const root = process.cwd()
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)

const files = tracked.filter((file) => /\.(ts|tsx)$/.test(file))
const texts = new Map(files.map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]))

const isExported = (node) => {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  return Boolean(modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword))
}

const names = (node) => {
  const found = []
  if (node.name && ts.isIdentifier(node.name)) found.push(node.name.text)
  // export const a = 1, b = 2
  if (ts.isVariableStatement(node)) {
    for (const declaration of node.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) found.push(declaration.name.text)
    }
  }
  return found
}

const results = []
for (const file of files) {
  const text = texts.get(file)
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, undefined)
  for (const statement of source.statements) {
    if (!isExported(statement)) continue
    // `export { a, b }` and `export … from '…'` are re-exports; leave them.
    if (ts.isExportDeclaration(statement)) continue
    for (const name of names(statement)) {
      let usedElsewhere = false
      for (const [other, otherText] of texts) {
        if (other === file) continue
        if (new RegExp(`\\b${name.replace(/[$]/g, '\\$')}\\b`).test(otherText)) {
          usedElsewhere = true
          break
        }
      }
      if (!usedElsewhere) {
        const line = source.getLineAndCharacterOfPosition(statement.getStart(source)).line + 1
        results.push({ file, line, name })
      }
    }
  }
}

results.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(results, null, 2))
} else {
  console.log(`只在本文件内使用的导出：${results.length} 个\n`)
  let current = ''
  for (const item of results) {
    if (item.file !== current) {
      current = item.file
      console.log(`  ${current}`)
    }
    console.log(`    L${item.line}  ${item.name}`)
  }
}
