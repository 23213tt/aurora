/*
 * Removes declarations that nothing uses - not other files, and not even their own.
 *
 * Found by accident: after `narrow-exports.mjs` dropped `export` from symbols the
 * audit called file-private, `noUnusedLocals` immediately reported them as never
 * read at all. `audit-exports.mjs` only checks whether *another* file imports a
 * symbol, so it cannot see this class, and it is the more useful half: these 26
 * were written, documented, exported, and then never called by anyone, including
 * their own module.
 *
 * Boundaries are found by bracket balance from the reported line, not by guessing a
 * line count, because a wrong boundary here silently deletes a neighbouring
 * function. Anything it cannot delimit confidently is skipped and reported rather
 * than removed.
 *
 * Usage: node scripts/remove-dead-decls.mjs [--apply]
 */
import fs from 'node:fs'
import path from 'node:path'

const APPLY = process.argv.includes('--apply')
const root = process.cwd()

/** file, 1-based line of the declaration, and the symbol name to confirm. */
const TARGETS = [
  ['electron/netease/client.ts', 480, 'upstreamDiagnostics'],
  ['electron/pure/scan-progress.ts', 75, 'configureProgressClock'],
  ['electron/qq/ipc.ts', 94, 'warmUpQq'],
  ['src/app/search/remembered-source.ts', 95, 'isKnownSource'],
  ['src/app/search/SearchView.tsx', 135, 'trackSourceLabel'],
  ['src/features/library/demo.ts', 174, 'demoArt'],
  ['src/features/library/source.ts', 161, 'DEFAULT_SOURCE_ID'],
  ['src/features/netease/api.ts', 35, 'remoteImage'],
  ['src/features/netease/provider.ts', 277, 'neteaseCover'],
  ['src/features/netease/store.ts', 239, 'DEFAULT_NETEASE_QUALITY'],
  ['src/features/netease/store.ts', 255, 'neteaseSongIdOf'],
  ['src/features/online/hooks.ts', 66, 'useProvider'],
  ['src/features/online/hooks.ts', 78, 'useOnlineProviderState'],
  ['src/features/online/normalize.ts', 160, 'normalizeFailure'],
  ['src/features/online/normalize.ts', 183, 'noVerifiedTakenDown'],
  ['src/features/online/PlatformView.tsx', 629, 'hasResults'],
  ['src/features/online/registry.ts', 131, 'canPlayTrack'],
  ['src/features/online/registry.ts', 144, 'providerCanAuthenticate'],
  ['src/features/online/registry.ts', 148, 'providerOffersAccountContent'],
  ['src/features/online/registry.ts', 163, 'searchApiOf'],
  ['src/features/online/registry.ts', 167, 'playbackApiOf'],
  ['src/features/online/registry.ts', 185, 'isTrackUnavailable'],
  ['src/features/online/registry.ts', 190, 'unavailableLabel'],
  ['src/features/online/streams.ts', 100, 'forgetStream'],
  ['src/ui/icons.tsx', 225, 'More']
]

/**
 * The half-open line span of the declaration starting at `start`.
 *
 * Two shapes to handle: a braced body (`{ … }`, `( … )`, `=> { … }`) whose extent is
 * the bracket balance, and a bodyless statement (`const X = 1`, `type T = …`) that
 * ends at the first line whose statement is complete - tracked with a depth counter
 * across `()[]{}` and a trailing operator check.
 */
function span(lines, start) {
  const first = lines[start]
  if (first === undefined) return null

  let depth = 0
  let sawBracket = false
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]
    for (const ch of line) {
      if (ch === '{' || ch === '(' || ch === '[') {
        depth += 1
        sawBracket = true
      } else if (ch === '}' || ch === ')' || ch === ']') depth -= 1
    }
    if (sawBracket && depth === 0 && i > start) return [start, i]
    if (sawBracket && depth === 0 && i === start) return [start, i]
    if (depth === 0 && !sawBracket) {
      /*
       * No brackets yet: the declaration is a simple statement. It ends at the
       * first line that does not look continued (no trailing operator or comma).
       */
      if (!/[=,:]\s*$|\|\s*$|&\s*$|\?\s*$/.test(line) && i >= start) return [start, i]
    }
  }
  return null
}

let removed = 0
let skipped = 0
/** Group edits per file so one pass covers several targets. */
const byFile = new Map()
for (const [file, line, name] of TARGETS) {
  if (!byFile.has(file)) byFile.set(file, [])
  byFile.get(file).push({ line, name })
}

for (const [file, targets] of byFile) {
  const full = path.join(root, file)
  if (!fs.existsSync(full)) {
    console.log(`  跳过（文件不存在）: ${file}`)
    skipped += targets.length
    continue
  }
  const text = fs.readFileSync(full, 'utf8')
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)

  // Remove from the bottom up so earlier line numbers stay valid.
  const edits = []
  for (const { line, name } of targets.sort((a, b) => b.line - a.line)) {
    const index = line - 1
    if (!new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lines[index] ?? '')) {
      console.log(`  跳过（行内容不符）: ${file}:${line} ${name}`)
      skipped += 1
      continue
    }
    const range = span(lines, index)
    if (!range) {
      console.log(`  跳过（无法确定边界）: ${file}:${line} ${name}`)
      skipped += 1
      continue
    }
    /*
     * Walk back over the doc comment directly above, which describes this symbol and
     * nobody else - but only while the lines are contiguous comment lines all the way
     * to the comment's opening. Stopping at the first line that is not part of a
     * comment is what keeps a following symbol's documentation from being eaten; a
     * blank line inside the walk means the comment belongs to something else.
     */
    let from = range[0]
    let probe = from - 1
    let sawComment = false
    while (probe >= 0) {
      const line = lines[probe]
      if (/^\s*$/.test(line)) {
        // A blank line ends the doc comment, unless nothing has been consumed yet.
        if (sawComment) break
        probe -= 1
        continue
      }
      if (/^\s*(\/\*\*?|\*|\*\/)/.test(line) || sawComment) {
        // `sawComment` keeps consuming the body of a block comment once started.
        if (/^\s*\/\*\*?/.test(line)) sawComment = true
        probe -= 1
        continue
      }
      break
    }
    if (probe + 1 < from) from = probe + 1
    const keep = edits.some((e) => e.to >= from && e.from <= range[1])
    if (keep) {
      console.log(`  跳过（与另一处删除重叠）: ${file}:${line} ${name}`)
      skipped += 1
      continue
    }
    edits.push({ from, to: range[1], name, line })
  }

  for (const edit of edits.sort((a, b) => b.from - a.from)) {
    lines.splice(edit.from, edit.to - edit.from + 1)
    removed += 1
    console.log(`  ${APPLY ? '删除' : '将删除'} ${file}: ${edit.name}（原 L${edit.line}，${edit.to - edit.from + 1} 行）`)
  }
  if (APPLY && edits.length > 0) fs.writeFileSync(full, lines.join(eol))
}

console.log(`\n${APPLY ? '已删除' : '可删除'} ${removed} 处；跳过 ${skipped} 处。`)
if (!APPLY) console.log('加 --apply 才会真正写入。')
