/*
 * Moves source files and rewrites every relative import that pointed at them.
 *
 * A directory reorganisation touches hundreds of import strings, and doing it by
 * hand is how you get a file that resolves in the editor but not in the build.
 * This parses each file with TypeScript, so it rewrites real import specifiers
 * (static, dynamic, type-only, `export … from`) and never touches a string that
 * merely looks like a path.
 *
 * Usage:
 *   node scripts/move-files.mjs --plan plan.json           # dry run, prints the diff
 *   node scripts/move-files.mjs --plan plan.json --apply
 *
 * plan.json: [{ "from": "src/a.ts", "to": "src/features/b/a.ts" }, …]
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import ts from 'typescript'

const args = process.argv.slice(2)
const planArg = args.indexOf('--plan')
if (planArg < 0 || !args[planArg + 1]) {
  console.error('usage: node scripts/move-files.mjs --plan plan.json [--apply]')
  process.exit(2)
}
const apply = args.includes('--apply')
const root = process.cwd()
const plan = JSON.parse(fs.readFileSync(args[planArg + 1], 'utf8'))

const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
  .split('\n')
  .filter(Boolean)

/** Where a file ended up after the move (identity for files that stayed). */
const moved = new Map(plan.map((item) => [item.from.replace(/\\/g, '/'), item.to.replace(/\\/g, '/')]))
const finalPath = (file) => moved.get(file) ?? file

/** Resolves a relative specifier to a tracked file, the way Vite/tsc would. */
function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith('.')) return null
  const base = path.posix.join(path.posix.dirname(fromFile), spec)
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    // `../env` resolves to src/env.d.ts: declaration files are importable and
    // carry this project's API contracts, so they must be rewritten like any
    // other target.
    `${base}.d.ts`,
    `${base}/index.ts`,
    `${base}/index.tsx`
  ]
  for (const candidate of candidates) {
    if (tracked.includes(candidate) && fs.existsSync(path.join(root, candidate))) return candidate
    // A file may already have been moved in this run, so also try its new home.
    const done = plan.find((item) => item.from.replace(/\\/g, '/') === candidate)
    if (done) return done.to.replace(/\\/g, '/')
    const doneTo = plan.find((item) => item.to.replace(/\\/g, '/') === candidate)
    if (doneTo) return candidate
  }
  return null
}

const sources = tracked.filter((file) => /\.(ts|tsx)$/.test(file))

/** One file's rewritten text, plus the rewrites for reporting. */
function rewrite(file) {
  const text = fs.readFileSync(path.join(root, file), 'utf8')
  const destination = finalPath(file)
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, undefined)
  const edits = []

  const consider = (node, spec) => {
    // Resolve against where the file *was*; the file's own location is what the
    // existing specifier was written for.
    const target = resolveSpecifier(file, spec)
    if (!target) return
    const to = finalPath(target)
    let next = path.posix.relative(path.posix.dirname(destination), to)
    if (!next.startsWith('.')) next = `./${next}`
    /*
     * Match the extension style the author used: tests write `.ts` explicitly,
     * application code does not. `./env` points at `src/env.d.ts`, so a target
     * ending in `.d.ts` must drop both suffixes - leaving `./env.d` would be a
     * path to a file that does not exist.
     */
    const hadExtension = /\.(ts|tsx)$/.test(spec)
    if (!hadExtension) next = next.replace(/\.d\.ts$/, '').replace(/\.(ts|tsx)$/, '')
    if (next === spec) return
    edits.push({ start: node.getStart(source) + 1, end: node.getEnd() - 1, text: next, from: spec })
  }

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const spec = node.moduleSpecifier
      if (spec && ts.isStringLiteral(spec)) consider(spec, spec.text)
    }
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
      const callee = node.expression.getText(source)
      if (callee === 'import' || callee === 'require') consider(node.arguments[0], node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)

  if (edits.length === 0) return { file, destination, text, edits }
  // Apply from the end so earlier offsets stay valid.
  let out = text
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  }
  return { file, destination, text: out, edits }
}

const results = sources.map(rewrite)

/** CSS files import nothing relatively, but they do move. */
const cssMoves = plan.filter((item) => /\.css$/.test(item.from))

if (!apply) {
  console.log(`将移动 ${plan.length} 个文件，重写 ${results.filter((r) => r.edits.length > 0).length} 个文件的 import\n`)
  for (const item of plan) console.log(`  ${item.from}  →  ${item.to}`)
  console.log(`\n受影响的 import 语句：${results.reduce((sum, r) => sum + r.edits.length, 0)} 处`)
  for (const result of results) {
    if (result.edits.length === 0) continue
    console.log(`\n  ${result.file}  (→ ${result.destination})`)
    for (const edit of result.edits) console.log(`      ${edit.from}  →  ${edit.text}`)
  }
  process.exit(0)
}

// --- apply -----------------------------------------------------------------

/*
 * Preflight the whole plan before touching anything.
 *
 * The first version moved files as it went and only discovered a bad source path
 * partway through, leaving the tree in a mixed state that had to be cleaned up
 * by hand. Checking every source first makes a bad plan a no-op.
 */
const missing = plan.filter((item) => !fs.existsSync(path.join(root, item.from)))
if (missing.length > 0) {
  console.error('计划里有源文件不存在，未做任何改动：')
  for (const item of missing) console.error(`  ${item.from}`)
  process.exit(1)
}
const clashes = plan.filter((item) => fs.existsSync(path.join(root, item.to)) && !moved.has(item.to))
if (clashes.length > 0) {
  console.error('计划的目标路径已存在，未做任何改动：')
  for (const item of clashes) console.error(`  ${item.to}`)
  process.exit(1)
}

for (const item of plan) {
  fs.mkdirSync(path.dirname(path.join(root, item.to)), { recursive: true })
}
for (const item of plan) {
  execFileSync('git', ['mv', item.from, item.to], { cwd: root })
}

// 2. Write the rewritten imports at their new locations.
let changed = 0
for (const result of results) {
  const target = path.join(root, result.destination)
  if (!fs.existsSync(target)) continue
  const current = fs.readFileSync(target, 'utf8')
  if (result.text === current) continue
  fs.writeFileSync(target, result.text)
  changed += 1
}

console.log(`moved ${plan.length} files (${cssMoves.length} css), rewrote imports in ${changed} files`)
