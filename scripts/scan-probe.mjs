/**
 * Runs the real scanner outside Electron.
 *
 * The scanner is the one substantial piece of the main process that does not
 * need a BrowserWindow, and the packaged app is the one place it cannot be
 * exercised by the design harness. This stands in for `electron` so the compiled
 * code can be driven directly from Node:
 *
 *   node scripts/scan-probe.mjs <musicFolder>
 *
 * Run `npm run build:electron` first. It reports what the walk found and what
 * each file became, which distinguishes "found nothing" from "read nothing".
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const target = process.argv[2]
if (!target) {
  console.error('usage: node scripts/scan-probe.mjs <musicFolder>')
  process.exit(2)
}
if (!fs.existsSync(target)) {
  console.error(`no such folder: ${target}`)
  process.exit(2)
}

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-probe-'))
fs.writeFileSync(
  path.join(userData, 'settings.json'),
  JSON.stringify({ roots: [path.resolve(target)] }, null, 2),
  'utf8'
)

/*
 * `library-scan` pulls `app.getPath` out of electron at call time. Intercepting
 * the module load is enough - nothing else in the scanner touches electron.
 */
const require = createRequire(import.meta.url)
const Module = require('node:module')
const load = Module._load
Module._load = function (request, ...rest) {
  if (request === 'electron') {
    return { app: { getPath: () => userData } }
  }
  return load.call(this, request, ...rest)
}

console.log(`userData: ${userData}`)
console.log(`root:     ${path.resolve(target)}`)
console.log('')

/*
 * Check the ESM-only dependency resolves from this context before scanning.
 *
 * The main process is CommonJS and `music-metadata` is ESM-only, so it is pulled
 * in with a real dynamic import. If that import fails every file silently falls
 * back to its filename, which looks like "the scanner works" while actually
 * having lost all the tags.
 */
try {
  const mm = await import('music-metadata')
  console.log(`music-metadata: resolved (parseFile: ${typeof mm.parseFile})`)
} catch (error) {
  console.log(`music-metadata: FAILED TO LOAD — ${error?.message ?? error}`)
}
console.log('')

const { scanLibrary } = require('../dist-electron/library-scan.js')

const started = Date.now()
let last = ''
const index = await scanLibrary({
  onProgress: (progress) => {
    const line = `${progress.phase} found=${progress.found} scanned=${progress.scanned} cached=${progress.cached}`
    if (line !== last) {
      last = line
      console.log(`  ${line}`)
    }
  }
})
const elapsed = Date.now() - started

console.log('')
console.log(`tracks: ${index.tracks.length}   (${elapsed} ms)`)
console.log(`roots recorded in the index: ${JSON.stringify(index.roots)}`)

for (const track of index.tracks.slice(0, 8)) {
  console.log(`  ${track.artist} — ${track.title}  [${track.album}]  ${track.duration.toFixed(1)}s ${track.codec}`)
}
if (index.tracks.length > 8) console.log(`  … and ${index.tracks.length - 8} more`)

// A track whose title equals its filename came from the fallback path, which is
// what happens when tag parsing fails. Worth calling out explicitly.
const fellBack = index.tracks.filter((t) => t.title === path.basename(t.path, path.extname(t.path)))
if (fellBack.length > 0) {
  console.log('')
  console.log(`${fellBack.length} file(s) produced no metadata and fell back to the filename.`)
  console.log('First one:', fellBack[0].path)
}

fs.rmSync(userData, { recursive: true, force: true })
