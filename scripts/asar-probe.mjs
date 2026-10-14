/**
 * Lists the directory header of an Electron .asar archive.
 *
 * Packaging failures are silent: a file that should have shipped simply is not
 * in the archive, and the app misbehaves only at run time - which for this
 * project means the one thing that cannot be reproduced in the development
 * sandbox. This makes "is it actually in the package" a question with a command
 * for an answer.
 *
 * The format needs no dependency: four little-endian UInt32 fields, then a JSON
 * directory tree.
 *   [0..4)   pickle header size (always 4)
 *   [4..8)   pickle payload size
 *   [8..12)  JSON length
 *   [12..16) JSON length, repeated
 *   [16..)   JSON header
 *
 * Usage: node scripts/asar-probe.mjs <app.asar> [subpath]
 */
import fs from 'node:fs'

const [, , file, subpath] = process.argv
if (!file) {
  console.error('usage: node scripts/asar-probe.mjs <app.asar> [subpath]')
  process.exit(2)
}

const buf = fs.readFileSync(file)
const headerSize = buf.readUInt32LE(12)
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'))

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`

function walk(node, depth, maxDepth) {
  for (const name of Object.keys(node.files ?? {}).sort()) {
    if (name.startsWith('.')) continue
    const child = node.files[name]
    const isDir = Boolean(child.files)
    console.log(`${'  '.repeat(depth)}${name}${isDir ? '/' : `  ${kb(child.size ?? 0)}`}`)
    if (isDir && depth < maxDepth) walk(child, depth + 1, maxDepth)
  }
}

console.log(`archive: ${file} (${kb(buf.length)})`)

if (subpath) {
  let node = header
  for (const segment of subpath.split('/').filter(Boolean)) {
    node = node.files?.[segment]
    if (!node) {
      console.error(`no such entry: ${subpath}`)
      process.exit(1)
    }
  }
  walk(node, 0, 2)
} else {
  walk(header, 0, 1)
}
