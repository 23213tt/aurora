/*
 * Finds CSS classes that no component can ever produce.
 *
 * A plain "is this string in the source" search is wrong in four ways, and the
 * first version of this script got three of them wrong:
 *
 *  1. class names built by template literals (`` `ne__tile${…}` ``,
 *     `` `ne__qr is-${qr.kind}` ``) - so `$` and `{` must not split a token;
 *  2. classes named only inside CSS comments (".btn/.seg/.specs" in prose) - so
 *     comments are stripped before selectors are read;
 *  3. classes used in HTML entry points (`overlay.html` has `class="overlay-body"`) -
 *     so HTML is part of the search;
 *  4. class names that are only prefixes of longer ones (`.ne__welcome` vs
 *     `.ne__welcome-note`) - so splitting is on real token boundaries.
 *
 * Usage: node scripts/audit-css.mjs [--json]
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const root = process.cwd()
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)

const cssFiles = tracked.filter((file) => /\.css$/.test(file))
const codeFiles = tracked.filter((file) => /\.(ts|tsx|mjs|cjs|html)$/.test(file))

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ')

/**
 * File-extension-looking matches are not class selectors.
 *
 * Prose like "reuses tokens.css" would otherwise register a class called `css`.
 */
const NOT_A_CLASS = new Set([
  'css', 'ts', 'tsx', 'js', 'mjs', 'cjs', 'json', 'html', 'md', 'exe', 'png',
  'jpg', 'svg', 'yml', 'map', 'woff2'
])

/** Every class selector defined in the stylesheets, comments excluded. */
const defined = new Map()
for (const file of cssFiles) {
  const text = stripComments(fs.readFileSync(path.join(root, file), 'utf8'))
  for (const match of text.matchAll(/\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)/g)) {
    const name = match[1]
    if (NOT_A_CLASS.has(name)) continue
    if (!defined.has(name)) defined.set(name, file)
  }
}

/**
 * Every class token a component could produce.
 *
 * Interpolations are replaced with a wildcard, and the surrounding literal is
 * split on whitespace and markup - not on `$` or `{`, which is what makes
 * `lyr--d${n}` and `is-${kind}` resolve. A wildcard token then matches any
 * defined class with that prefix.
 */
const used = new Set()
const prefixes = new Set()

for (const file of codeFiles) {
  const text = stripComments(fs.readFileSync(path.join(root, file), 'utf8'))
  const literals = [
    ...text.matchAll(/'([^'\\\n]*)'/g),
    ...text.matchAll(/"([^"\\\n]*)"/g),
    ...text.matchAll(/`([^`]*)`/g)
  ]
  for (const literal of literals) {
    const raw = literal[1]
    // `lyr--d${x}` -> `lyr--d*`, and the wildcard part is recorded as a prefix.
    for (const piece of raw.split(/\$\{[^}]*\}/)) {
      for (const token of piece.split(/[\s"'`?:+()[\]{},;=<>|&!]+/)) {
        if (!token) continue
        used.add(token)
        if (token.length > 1) prefixes.add(token)
      }
    }
    // The whole literal, in case a class is written without interpolation.
    for (const token of raw.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) {
      if (token) used.add(token)
    }
  }
}

const orphans = [...defined.entries()]
  .filter(([name]) => {
    if (used.has(name)) return false
    // A class may be produced by an interpolated name: `lyr--d` + `${n}`.
    for (let end = name.length - 1; end >= 3; end -= 1) {
      if (prefixes.has(name.slice(0, end))) return false
    }
    return true
  })
  .map(([name, file]) => ({ name, file, selector: `.${name}` }))
  .sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name))

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ definedCount: defined.size, orphans }, null, 2))
} else {
  console.log(`CSS 定义 ${defined.size} 个 class；可能在代码/HTML 中合成的之外，剩 ${orphans.length} 个：\n`)
  if (orphans.length === 0) console.log('  ✓ 没有死选择器')
  let currentFile = ''
  for (const orphan of orphans) {
    if (orphan.file !== currentFile) {
      currentFile = orphan.file
      console.log(`  ${currentFile}`)
    }
    console.log(`    ${orphan.selector}`)
  }
}
