/**
 * Screenshot A/B for a CSS change, with a same-code baseline for phase noise.
 *
 * The question this answers is not "does the after look right" but "is the
 * before-vs-after difference larger than the difference between two frames of
 * the *same* code". The visual bed is a canvas driven by `performance.now()`, so
 * two captures of identical code never match exactly; without that control any
 * conclusion from a single pair of images is unfalsifiable.
 *
 *   node scripts/css-ab-shot.mjs --screen=stage --out=dir \
 *     --override=".viz { mask-image: none !important; }" --override-tag=nomask
 *
 * Writes `<out>/<tag>-<n>.png`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { Cdp, assertEdge, baseFlags, freePort, killTree, listTargets, sleep, waitForDevtools } from './perf-lib.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const PREVIEW_DIR = path.join(ROOT, 'preview-dist')
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const SCREEN = arg('screen', 'stage')
const OUT = path.resolve(ROOT, arg('out', 'docs/shots'))
const OVERRIDE = arg('override', '')
const TAG = arg('tag', OVERRIDE ? 'after' : 'base')
const SHOTS = Number(arg('shots', 3))
const SETTLE = Number(arg('settle', 1500))
const PAUSE = argv.includes('--pause')
const WIDTH = Number(arg('width', 1600))
const HEIGHT = Number(arg('height', 1000))
/**
 * Freeze the page clock before capturing.
 *
 * The visual bed is driven by `performance.now()`, so two captures of identical
 * code never line up: the canvas is at a different phase and the whole frame
 * differs. Pinning the clock makes the comparison falsifiable - identical code
 * must then produce a byte-identical image, and any remaining difference is the
 * CSS change and nothing else.
 */
const FREEZE_AT = arg('freeze', null)

function launch(url, port, profileDir) {
  const args = [...baseFlags(port, profileDir), '--hide-scrollbars', url]
  const child = spawn(EDGE_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (c) => {
    stderr += String(c)
  })
  return { child, getStderr: () => stderr, kill: () => killTree(child) }
}

fs.mkdirSync(OUT, { recursive: true })
assertEdge()

const port = await freePort()
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `aurora-shot-${SCREEN}-`))
const url = pathToFileURL(path.join(PREVIEW_DIR, `aurora-preview-${SCREEN}.html`)).href
const edge = launch(url, port, profileDir)
let cdp = null
const written = []
try {
  await waitForDevtools(port, { getStderr: edge.getStderr })
  const targets = await listTargets(port)
  const target = targets.find((t) => t.type === 'page' && t.url.startsWith('file:')) ?? targets[0]
  cdp = await Cdp.connect(target.webSocketDebuggerUrl, { callTimeoutMs: 30000 })
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 1,
    mobile: false
  })

  if (FREEZE_AT !== null) {
    /*
     * Freeze the clock *before* the bundle runs, then reload.
     *
     * Both `performance.now()` and the timestamp handed to `requestAnimationFrame`
     * have to be pinned: the visualiser computes its animation phase from the rAF
     * timestamp, and React's scheduler reads `performance.now()`. Patching only
     * one of them leaves the canvas at a moving phase, which is exactly the
     * confound this flag exists to remove.
     */
    const freezeSource = `(() => {
      const fixed = ${Number(FREEZE_AT)}
      const realNow = performance.now.bind(performance)
      performance.now = () => fixed
      const realRaf = window.requestAnimationFrame.bind(window)
      window.requestAnimationFrame = (cb) => realRaf(() => cb(fixed))
      window.__frozenClock = { fixed, realAtFreeze: realNow() }
    })()`
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: freezeSource })
    await cdp.send('Page.reload', { ignoreCache: false })
    await sleep(4000)
    const applied = await cdp.eval('({ frozen: window.__frozenClock, now: performance.now() })')
    console.log(`clock frozen at ${applied.now}ms (real at freeze ${applied.frozen.realAtFreeze.toFixed(1)})`)
  } else {
    await sleep(3000)
  }

  if (PAUSE) {
    await cdp.eval(`(() => {
      const b = document.querySelector('button[aria-label="暂停"]') || document.querySelector('button[aria-label="播放"]')
      if (b) b.click()
      return !!b
    })()`)
    await sleep(1200)
  }

  if (OVERRIDE) {
    await cdp.eval(`(() => {
      const id = '__ab_override__'
      let el = document.getElementById(id)
      if (!el) { el = document.createElement('style'); el.id = id; document.head.appendChild(el) }
      el.textContent = ${JSON.stringify(OVERRIDE)}
      return el.textContent.length
    })()`)
  }

  for (let n = 1; n <= SHOTS; n += 1) {
    // Spread the captures so the canvas phase differs between them: that is what
    // makes the same-code spread a usable noise floor.
    await sleep(SETTLE)
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const file = path.join(OUT, `${TAG}-${n}.png`)
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
    written.push(file)
    console.log(`wrote ${path.relative(ROOT, file)} (${(fs.statSync(file).size / 1024).toFixed(1)} kB)`)
  }
} finally {
  if (cdp) cdp.close()
  await edge.kill()
  try {
    fs.rmSync(profileDir, { recursive: true, force: true })
  } catch {
    /* temp */
  }
}
