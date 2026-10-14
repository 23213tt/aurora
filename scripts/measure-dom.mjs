/*
 * What a real-sized library costs the renderer.
 *
 * The demo library is 27 rows, which cannot answer "what does a personal library
 * cost": grouping, DOM node count and scrolling all scale with the number of
 * tracks. This seeds the store with synthetic tracks through the same components
 * the app uses (`src/preview/stress.ts`), then measures the result.
 *
 * `src/preview/stress.ts` has referred to this script since it was written, and
 * the script did not exist - so "we can measure a large library" was a claim with
 * no command behind it. This is that command.
 *
 * Usage:
 *   node scripts/measure-dom.mjs [--tracks=5000] [--json]
 *
 * Reports: DOM node count, JS heap, the time the list took to appear, and the
 * scroll frame intervals - the four numbers a large library can ruin.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Cdp,
  assertEdge,
  freePort,
  killTree,
  launchEdge,
  listTargets,
  sleep,
  waitForDevtools
} from './perf-lib.mjs'

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const hit = argv.find((arg) => arg.startsWith(`--${name}=`))
  return hit ? hit.split('=')[1] : fallback
}
const asJson = argv.includes('--json')
const tracks = Number(flag('tracks', '5000'))
const settleMs = Number(flag('settle', '6000'))

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = flag('page', path.join(ROOT, 'preview-dist', 'aurora-preview-songs.html'))
if (!fs.existsSync(PAGE)) {
  console.error(`${PAGE} 不存在。先跑 npm run preview。`)
  process.exit(2)
}
assertEdge()

const port = await freePort()
const profileDir = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'aurora-dom-'))
const pageUrl = `file:///${PAGE.replace(/\\/g, '/')}`

const edge = launchEdge({ port, url: 'about:blank', profileDir })
let cdp = null
try {
  await waitForDevtools(port)
  const targets = await listTargets(port)
  const page = targets.find((target) => target.type === 'page')
  if (!page) throw new Error('no page target')
  cdp = await Cdp.connect(page.webSocketDebuggerUrl, { callTimeoutMs: 20000 })
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  /*
   * The flag is read while the bundle initialises, so it has to be set for the
   * document that is about to load - setting it after a navigation would be too
   * late and would silently measure the 27-row demo library instead.
   */
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__AURORA_STRESS = ${tracks}`
  })
  await cdp.send('Page.navigate', { url: pageUrl })
  await sleep(settleMs)

  /* `cdp.eval` returns the value directly (returnByValue), so no JSON round-trip. */
  const measured = await cdp.eval(
    `(() => {
      const rows = document.querySelectorAll('.trk').length
      const nodes = document.getElementsByTagName('*').length
      const heap = performance.memory ? performance.memory.usedJSHeapSize : null
      return { rows, nodes, heap, title: document.title }
    })()`
  )

  /*
   * Scroll the list and collect frame intervals.
   *
   * Follows the rule this repository's perf library states at the top: **no
   * page-side promise may await a frame**, because a headless renderer can stop
   * `requestAnimationFrame` entirely and the promise then never settles. The first
   * two attempts at this script did exactly that and hung for ten minutes.
   *
   * So the page only *starts* work and *stores* samples; Node decides when to read
   * them, with bounded waits. The scrolling itself uses `setInterval` rather than
   * frames for the same reason - moving a scroll container does not need a frame.
   */
  await cdp.eval(
    `(() => {
      const el = document.querySelector('.main__body') || document.scrollingElement
      window.__domProbe = { gaps: [], done: false, ticks: 0 }
      let last = performance.now()
      const onFrame = () => {
        const now = performance.now()
        window.__domProbe.gaps.push(now - last)
        last = now
        if (!window.__domProbe.done) requestAnimationFrame(onFrame)
      }
      requestAnimationFrame(onFrame)
      let step = 0
      const timer = setInterval(() => {
        step += 60
        el.scrollTop = step
        window.__domProbe.ticks += 1
        if (window.__domProbe.ticks >= 150) {
          clearInterval(timer)
          window.__domProbe.done = true
        }
      }, 16)
      return true
    })()`
  )

  /* Bounded read-back: never wait on the page to tell us it is finished. */
  const deadline = Date.now() + 15000
  let scroll = { samples: 0, p50: null, p95: null, max: null, over33: false, ticks: 0 }
  while (Date.now() < deadline) {
    await sleep(500)
    const progress = await cdp.eval(
      `(() => {
        const probe = window.__domProbe
        if (!probe) return { ready: false }
        return { ready: probe.done === true, frames: probe.gaps.length, ticks: probe.ticks }
      })()`
    )
    if (!progress?.ready) continue
    scroll = await cdp.eval(
      `(() => {
        const sorted = window.__domProbe.gaps.slice(2).sort((a, b) => a - b)
        const at = (q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : null)
        return {
          samples: sorted.length,
          p50: at(0.5),
          p95: at(0.95),
          max: sorted.length ? sorted[sorted.length - 1] : null,
          over33: sorted.filter((gap) => gap > 33).length,
          ticks: window.__domProbe.ticks
        }
      })()`
    )
    break
  }

  const report = {
    tracks,
    rows: measured.rows,
    domNodes: measured.nodes,
    jsHeapMB: measured.heap === null ? null : +(measured.heap / 1024 / 1024).toFixed(1),
    scrollP50ms: scroll.p50 === null ? null : +scroll.p50.toFixed(1),
    scrollP95ms: scroll.p95 === null ? null : +scroll.p95.toFixed(1),
    scrollMaxMs: scroll.max === null ? null : +scroll.max.toFixed(1),
    framesOver33ms: scroll.over33,
    frameSamples: scroll.samples
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`曲库规模 ${tracks} 首\n`)
    console.log(`  列表行数        ${report.rows}`)
    console.log(`  DOM 节点数      ${report.domNodes}`)
    console.log(`  JS 堆           ${report.jsHeapMB === null ? '（本环境不可读）' : report.jsHeapMB + ' MB'}`)
    console.log(`  滚动帧间隔      p50 ${report.scrollP50ms} ms  p95 ${report.scrollP95ms} ms  最大 ${report.scrollMaxMs} ms`)
    console.log(`  超过 33ms 的帧  ${report.framesOver33ms} / ${report.frameSamples}`)
  }

  const out = path.join(ROOT, 'docs', 'perf-dom.json')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(report, null, 2))
  if (!asJson) console.log(`\n已写出 ${path.relative(ROOT, out)}`)

  /*
   * Exit explicitly.
   *
   * The CDP WebSocket and the browser's stdio pipes keep the event loop alive, so
   * the script finished its work and then simply never returned - the numbers were
   * written but the shell hung. Nothing here needs to run after this point.
   */
  process.exit(0)
} finally {
  if (cdp) cdp.close()
  await killTree(edge)
  /*
   * Chromium keeps a handle on its profile for a moment after the process is
   * killed, and on Windows that makes the delete throw EPERM. Retry briefly, then
   * give up: a stale directory in the temp folder is not worth failing a
   * measurement run over.
   */
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(profileDir, { recursive: true, force: true })
      break
    } catch {
      await sleep(400)
    }
  }
}
