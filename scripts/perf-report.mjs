/**
 * Aurora performance baseline, one command.
 *
 *   npm run perf                 # build the preview, then measure
 *   node scripts/perf-report.mjs --no-build --duration=4000
 *
 * Writes `docs/perf-report.json` (machine readable) and `docs/perf-report.md`
 * (the table a human compares against), and prints the table to stdout.
 *
 * What it measures, and what it refuses to measure, is documented at the top of
 * `docs/perf-baseline.md`. The short version: this rig measures the *browser
 * preview build* in headless Edge, because the Electron window cannot start on
 * this machine. Renderer main-thread busy time, frame pacing, long tasks, heap,
 * DOM nodes, DOM mutation volume and the existing React render counter are all
 * real numbers from that build. Anything that only exists inside Electron (the
 * main process, its IPC sends, its process CPU) is reported as *not collected*
 * with the reason, never as a zero.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Cdp,
  ELECTRON_BACKGROUND_FLAGS,
  assertEdge,
  freePort,
  launchEdge,
  listTargets,
  readPerfMetrics,
  readProcessInfo,
  sleep,
  sumCpuByType,
  waitForDevtools
} from './perf-lib.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const PREVIEW_DIR = path.join(ROOT, 'preview-dist')
const DOCS_DIR = path.join(ROOT, 'docs')

// --- arguments -------------------------------------------------------------

const argv = process.argv.slice(2)
const argValue = (name) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  if (!hit) return undefined
  const value = hit.slice(name.length + 3)
  // PowerShell can hand over a bare `--json=` when the value came from a
  // parenthesised expression; treat that as "not supplied" instead of writing
  // to a path of "" and dying with ENOENT.
  return value === '' ? undefined : value
}
const hasFlag = (name) => argv.includes(`--${name}`)

const OPTIONS = {
  build: !hasFlag('no-build'),
  durationMs: Number(argValue('duration') ?? 6000),
  settleMs: Number(argValue('settle') ?? 3000),
  only: argValue('only') ? argValue('only').split(',').map((s) => s.trim()) : null,
  countersFile: argValue('counters') ?? null,
  jsonOut: argValue('json') ?? path.join(DOCS_DIR, 'perf-report.json'),
  mdOut: argValue('md') ?? path.join(DOCS_DIR, 'perf-report.md')
}

/**
 * Externally produced counters, merged into the report.
 *
 * Two of the three counting metrics this project needs cannot be produced by the
 * browser preview: zustand store notifications live in module scope, and
 * main-process IPC does not exist outside Electron. Rather than let those two
 * disappear from the report, `npm run perf` accepts a JSON file of *already
 * windowed deltas* from whichever rig can observe them (an Electron-side probe,
 * a page-side probe the lead approves) and records them with provenance.
 *
 * Shape:
 *   {
 *     "windowMs": 5000,
 *     "storeNotifications": 20000,
 *     "storeByStore": { "library": 12000 },
 *     "ipcMessages": 10002,
 *     "ipcByChannel": { "library:progress": 10002 },
 *     "source": "electron 侧探针 / scripts/perf-main.mjs",
 *     "note": "5000 首扫描"
 *   }
 *
 * Every field is optional and nothing is invented: whatever is absent stays
 * "not collected".
 */
function loadCountersFile(file) {
  if (!file) return null
  const absolute = path.resolve(ROOT, file)
  if (!fs.existsSync(absolute)) {
    throw new Error(`--counters file not found: ${absolute}`)
  }
  const buffer = fs.readFileSync(absolute)
  let parsed
  try {
    // Windows PowerShell 5.1's `Set-Content -Encoding UTF8` writes a BOM, which
    // `JSON.parse` rejects. Strip it rather than making the user fight encoding.
    parsed = JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error(`--counters file is not valid JSON: ${error.message}`)
  }
  return {
    path: path.relative(ROOT, absolute),
    sha256: createHash('sha256').update(buffer).digest('hex').slice(0, 16),
    data: parsed
  }
}

// --- scenarios -------------------------------------------------------------

/**
 * The three groups the task asks for, plus the reference screen the project
 * already used to make its render-cost claim.
 *
 * `writesPositionPerSecond` is not measured: it is the synthetic driver's
 * definition. `#perf` runs `setInterval(..., 1000/60)` and nothing else, so the
 * store write count for that scenario is known by construction and is only used
 * to express the render count as "renders per store write".
 */
const SCENARIOS = [
  {
    id: 'control-blank',
    group: '对照·空白页',
    hash: null,
    url: 'about:blank',
    what:
      '同一套启动参数下的 about:blank。用来量「这个装置自己」的开销：Edge 的 browser/GPU/utility 服务、' +
      'CDP 通道、我自己的 rAF 采样器。从其它场景的进程 CPU 里减掉它，才是应用自己的成本。',
    hidden: false,
    flags: [],
    pausePlayback: false,
    writesPositionPerSecond: 0
  },
  {
    id: 'idle-paused',
    group: '空闲（要求场景）',
    hash: 'settings',
    what:
      '设置页 + 用 UI 上的暂停按钮停掉播放。无 stage、无 60Hz 位置流、界面静止。' +
      '这是本装置能给出的最接近「真正空闲」的一档。',
    hidden: false,
    flags: [],
    pausePlayback: true,
    writesPositionPerSecond: 0
  },
  {
    id: 'playing-settings',
    group: '参照·前台无 stage',
    hash: 'settings',
    what:
      '同一个设置页但不暂停。预览的合成音频驱动每帧向 store 写一次播放位置，' +
      '用来单独量「60Hz 位置写入 → 进度条重渲染」这一条路径的成本。',
    hidden: false,
    flags: [],
    pausePlayback: false,
    writesPositionPerSecond: 60
  },
  {
    id: 'idle-perf',
    group: '参照·历史基准屏',
    hash: 'perf',
    what:
      '历史基准屏 #perf：stage 未挂载，setInterval(1000/60) 与合成驱动各写一次位置，合计约 120 次/秒。' +
      '根组件渲染次数的历史口径就是这一屏。',
    hidden: false,
    flags: [],
    pausePlayback: false,
    writesPositionPerSecond: 120
  },
  {
    id: 'playing-stage',
    group: '播放中（要求场景）',
    hash: 'stage',
    what: '沉浸舞台：极光 ribbon + 340 粒子 canvas 每帧重绘，合成驱动 60Hz 写播放位置。',
    hidden: false,
    flags: [],
    pausePlayback: false,
    writesPositionPerSecond: 60
  },
  {
    id: 'hidden-stage-electron',
    group: '不可见（要求场景）',
    hash: 'stage',
    what:
      '先在前台播放，再切到另一个标签页（document.hidden=true）。带 Electron backgroundThrottling:false 的三条等效开关。',
    hidden: true,
    flags: ELECTRON_BACKGROUND_FLAGS,
    pausePlayback: false,
    writesPositionPerSecond: 0
  },
  {
    id: 'hidden-stage-browser',
    group: '不可见·对照',
    hash: 'stage',
    what: '同上，但不给任何反节流开关，即浏览器默认行为。用来看「停渲染」是否真的发生。',
    hidden: true,
    flags: [],
    pausePlayback: false,
    writesPositionPerSecond: 0
  }
]

/**
 * Pause via the app's own transport button.
 *
 * The preview bootstrap autoplays (`App.tsx` calls `player.playQueue`), and the
 * preview's synthetic driver writes `setPosition` on every animation frame with
 * no visibility gate - so "just open the settings screen" is *not* an idle
 * measurement. Clicking the real button is the only way to reach a genuinely
 * idle page without touching product code. The click is verified afterwards
 * instead of assumed.
 */
const PAUSE_VIA_UI = `(() => {
  const button =
    document.querySelector('button[aria-label="暂停"]') ||
    document.querySelector('button[aria-label="播放"]')
  if (!button) return { clicked: false, reason: 'no transport button found' }
  const was = button.getAttribute('aria-label')
  button.click()
  return { clicked: true, was, now: button.getAttribute('aria-label') }
})()`

const MUTATION_PROBE = `(() => {
  const state = window.__perf
  state.mutations = 0
  return state.mutations
})()`

const MUTATION_READ = `window.__perf ? window.__perf.mutations : null`

// --- in-page collectors ----------------------------------------------------

/**
 * Installed once per page load.
 *
 * The rAF loop is started while the page is still visible on purpose: a loop
 * that is *started* in a hidden page never gets its first callback, and then the
 * measurement cannot tell "frames stopped" from "frame loop never began".
 * Nothing here decides when the window ends; Node calls `__perfMark` and reads
 * the arrays later, which is the only way this survives a renderer whose frame
 * loop has been suspended.
 */
const INSTALL_COLLECTOR = `(() => {
  if (window.__perf) return 'already installed'
  const rootEl = document.getElementById('root') || document.body
  const state = {
    raf: [],
    longTasks: [],
    mutations: 0,
    mutationBreakdown: { childList: 0, characterData: 0, attributes: 0 },
    stopped: false,
    installedAt: performance.now(),
    mark: null,
    rafLoopRunning: true,
    errors: []
  }
  window.__perf = state

  const loop = (ts) => {
    if (state.stopped) { state.rafLoopRunning = false; return }
    state.raf.push(ts)
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)

  try {
    state.longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longTasks.push({ start: entry.startTime, duration: entry.duration })
      }
    })
    state.longTaskObserver.observe({ type: 'longtask', buffered: true })
    state.longTaskSupported = true
  } catch (error) {
    state.longTaskSupported = false
    state.longTaskError = String((error && error.message) || error)
  }

  /*
   * Mutation volume alone says "the DOM is being rewritten"; it does not say by
   * whom. Attribution is what turns the number into an actionable finding, so
   * the observer also keeps a bounded histogram of the mutated elements and a
   * few verbatim samples.
   */
  state.mutationTargets = {}
  state.mutationSamples = []
  const describe = (node) => {
    const el = node && node.nodeType === 3 ? node.parentElement : node
    if (!el || !el.tagName) return '(detached/text)'
    const id = el.id ? '#' + el.id : ''
    let cls = ''
    if (typeof el.className === 'string' && el.className.trim()) {
      cls = '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
    }
    return el.tagName.toLowerCase() + id + cls
  }
  try {
    state.mutationObserver = new MutationObserver((records) => {
      state.mutations += records.length
      for (const record of records) {
        state.mutationBreakdown[record.type] = (state.mutationBreakdown[record.type] || 0) + 1
        const path = describe(record.target)
        state.mutationTargets[path] = (state.mutationTargets[path] || 0) + 1
        if (state.mutationSamples.length < 30) {
          state.mutationSamples.push({
            type: record.type,
            path,
            text: record.type === 'characterData'
              ? String(record.target.data || '').slice(0, 40)
              : record.type === 'attributes'
                ? String(record.attributeName || '')
                : String(record.addedNodes.length) + ' added / ' + String(record.removedNodes.length) + ' removed'
          })
        }
      }
      const keys = Object.keys(state.mutationTargets)
      if (keys.length > 60) {
        state.mutationTargetsTruncated = true
        for (const key of keys.slice(60)) delete state.mutationTargets[key]
      }
    })
    state.mutationObserver.observe(rootEl, {
      subtree: true, childList: true, characterData: true, attributes: true
    })
    state.mutationSupported = true
  } catch (error) {
    state.mutationSupported = false
    state.mutationError = String((error && error.message) || error)
  }

  return 'installed'
})()`

/**
 * Resets the window and snapshots the app counters at its start.
 *
 * Three counters are read here:
 *   - root renders: the project's own preview-only counter (`window.__auroraRenders`)
 *   - store notification count: `window.__auroraPerfStore` - a probe that does not
 *     exist yet, because the zustand stores are module-scope and unreachable from
 *     the page. Absent means absent; the report says "not collected".
 *   - IPC message count: `window.__auroraPerfIpc` - same story, and worse: the
 *     browser preview has no preload bridge at all, so no IPC crosses this rig.
 */
const MARK_WINDOW = `(() => {
  const state = window.__perf
  state.raf.length = 0
  state.longTasks.length = 0
  state.mutations = 0
  state.mutationBreakdown = { childList: 0, characterData: 0, attributes: 0 }
  state.mutationTargets = {}
  state.mutationSamples = []
  const mem = performance.memory || null
  state.mark = {
    at: performance.now(),
    renders: typeof window.__auroraRenders === 'number' ? window.__auroraRenders : null,
    heap: mem ? mem.usedJSHeapSize : null,
    heapTotal: mem ? mem.totalJSHeapSize : null,
    nodes: document.getElementsByTagName('*').length,
    ipc: window.__auroraPerfIpc || (window.__auroraPerf && window.__auroraPerf.ipc)
      ? JSON.parse(JSON.stringify(window.__auroraPerfIpc || window.__auroraPerf.ipc))
      : null,
    store: window.__auroraPerfStore || (window.__auroraPerf && window.__auroraPerf.store)
      ? JSON.parse(JSON.stringify(window.__auroraPerfStore || window.__auroraPerf.store))
      : null
  }
  return state.mark.at
})()`

const READ_WINDOW = `(() => {
  const state = window.__perf
  const mark = state.mark || {}
  const mem = performance.memory || null
  const intervals = []
  for (let i = 1; i < state.raf.length; i += 1) intervals.push(state.raf[i] - state.raf[i - 1])
  const errorEl = document.getElementById('__harness_error__')
  /*
   * Probe counters are accepted in several shapes, because whoever wires them
   * decides. A number, or an object carrying the total under one of the usual
   * names. Anything else is reported as present-but-unreadable rather than 0.
   */
  const norm = (value) => {
    if (value === null || value === undefined) return null
    if (typeof value === 'number') return { count: value, raw: value }
    if (typeof value === 'object') {
      for (const key of ['count', 'notifies', 'notifications', 'sent', 'messages', 'total', 'calls']) {
        if (typeof value[key] === 'number') return { count: value[key], raw: value }
      }
      return { count: null, raw: value }
    }
    return { count: null, raw: String(value) }
  }
  const topTargets = Object.entries(state.mutationTargets || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
  return {
    windowStart: mark.at ?? null,
    windowEnd: performance.now(),
    intervals: intervals.slice(0, 20000),
    firstFrame: state.raf.length ? state.raf[0] : null,
    lastFrame: state.raf.length ? state.raf[state.raf.length - 1] : null,
    rafCount: state.raf.length,
    rafLoopRunning: state.rafLoopRunning,
    longTasks: state.longTasks.slice(0, 5000),
    longTaskSupported: state.longTaskSupported === true,
    longTaskError: state.longTaskError ?? null,
    mutationSupported: state.mutationSupported === true,
    mutationError: state.mutationError ?? null,
    mutations: state.mutations,
    mutationBreakdown: state.mutationBreakdown,
    mutationTopTargets: topTargets,
    mutationSamples: state.mutationSamples.slice(0, 12),
    renders: typeof window.__auroraRenders === 'number' ? window.__auroraRenders : null,
    rendersAtMark: mark.renders ?? null,
    heap: mem ? mem.usedJSHeapSize : null,
    heapTotal: mem ? mem.totalJSHeapSize : null,
    heapAtMark: mark.heap ?? null,
    nodes: document.getElementsByTagName('*').length,
    nodesAtMark: mark.nodes ?? null,
    ipc: norm(window.__auroraPerfIpc || (window.__auroraPerf && window.__auroraPerf.ipc)),
    ipcAtMark: mark.ipc ?? null,
    store: norm(window.__auroraPerfStore || (window.__auroraPerf && window.__auroraPerf.store)),
    storeAtMark: mark.store ?? null,
    hidden: document.hidden,
    visibilityState: document.visibilityState,
    canvases: document.querySelectorAll('canvas').length,
    rootChildren: (document.getElementById('root') || { children: [] }).children.length,
    harnessError: errorEl ? String(errorEl.textContent).slice(0, 600) : null,
    userAgent: navigator.userAgent
  }
})()`

// --- statistics ------------------------------------------------------------

function quantile(sortedValues, p) {
  if (sortedValues.length === 0) return null
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.floor(sortedValues.length * p)))
  return sortedValues[index]
}

function frameStats(intervals) {
  if (intervals.length === 0) {
    return { frames: 0, p50: null, p95: null, p99: null, max: null, min: null, mean: null, over33: 0 }
  }
  const sorted = [...intervals].sort((a, b) => a - b)
  const sum = intervals.reduce((a, b) => a + b, 0)
  return {
    frames: intervals.length + 1,
    samples: intervals.length,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: sorted[sorted.length - 1],
    min: sorted[0],
    mean: sum / intervals.length,
    over33ms: intervals.filter((v) => v > 33.4).length,
    over50ms: intervals.filter((v) => v > 50).length
  }
}

function round(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

// --- environment -----------------------------------------------------------

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', ...options })
  if (result.status !== 0) return null
  return (result.stdout ?? '').trim()
}

function gitInfo() {
  return {
    rev: run('git', ['rev-parse', 'HEAD']),
    branch: run('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
    dirtyFiles: (run('git', ['status', '--porcelain']) ?? '').split('\n').filter(Boolean).length,
    dirtySample: (run('git', ['status', '--porcelain']) ?? '').split('\n').filter(Boolean).slice(0, 12)
  }
}

function buildPreview() {
  console.log('[perf] building the preview bundle (npm run preview) ...')
  const started = Date.now()
  // `npm` is a .cmd shim on Windows, which Node cannot spawn without a shell.
  // Going through cmd.exe explicitly avoids `shell: true` quoting rules.
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm run preview'], {
    cwd: ROOT,
    stdio: 'inherit'
  })
  if (result.status !== 0) {
    throw new Error(`npm run preview failed with status ${result.status}`)
  }
  return Date.now() - started
}

function assertPreviewExists() {
  if (!fs.existsSync(PREVIEW_DIR)) {
    throw new Error(`${PREVIEW_DIR} missing - run without --no-build first`)
  }
  const missing = SCENARIOS.filter((s) => s.hash)
    .map((s) => `aurora-preview-${s.hash}.html`)
    .filter((name) => !fs.existsSync(path.join(PREVIEW_DIR, name)))
  if (missing.length) throw new Error(`preview files missing: ${missing.join(', ')}`)
}

/**
 * sha256 of every preview page the run will touch.
 *
 * A "baseline" is only an anchor if the next person can prove they measured the
 * same bytes. A git revision is not enough here: the preview bundle is a build
 * artifact, and this project is being edited while the baseline is taken.
 */
function fingerprintPreviews() {
  const out = {}
  for (const spec of SCENARIOS) {
    if (!spec.hash) continue
    const file = path.join(PREVIEW_DIR, `aurora-preview-${spec.hash}.html`)
    if (!fs.existsSync(file)) {
      out[`aurora-preview-${spec.hash}.html`] = null
      continue
    }
    const buffer = fs.readFileSync(file)
    out[`aurora-preview-${spec.hash}.html`] = {
      bytes: buffer.length,
      sha256: createHash('sha256').update(buffer).digest('hex').slice(0, 16)
    }
  }
  return out
}

// --- one scenario ----------------------------------------------------------

async function settle(cdp, settleMs) {
  const deadline = Date.now() + settleMs
  let lastNodes = -1
  let stable = 0
  while (Date.now() < deadline) {
    const snapshot = await cdp.eval(
      `({renders: typeof window.__auroraRenders === 'number' ? window.__auroraRenders : null,
         nodes: document.getElementsByTagName('*').length,
         error: document.getElementById('__harness_error__') ? document.getElementById('__harness_error__').textContent.slice(0,300) : null})`
    )
    if (snapshot.renders !== null && snapshot.nodes === lastNodes) {
      stable += 1
      if (stable >= 2) return snapshot
    } else {
      stable = 0
    }
    lastNodes = snapshot.nodes
    await sleep(250)
  }
  return null
}

async function runScenario(spec) {
  assertEdge()
  const port = await freePort()
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `aurora-perf-${spec.id}-`))
  const pageUrl = spec.url ?? pathToFileURL(path.join(PREVIEW_DIR, `aurora-preview-${spec.hash}.html`)).href
  const edge = launchEdge({ port, url: pageUrl, profileDir, extraFlags: spec.flags })
  const notes = []
  let cdp = null
  let browserCdp = null
  try {
    const version = await waitForDevtools(port, { getStderr: edge.getStderr })
    const targets = await listTargets(port)
    const pageTarget =
      targets.find((t) => t.type === 'page' && t.url.startsWith('file:')) ??
      targets.find((t) => t.type === 'page' && t.url === 'about:blank') ??
      targets.find((t) => t.type === 'page')
    if (!pageTarget) throw new Error('no page target in the headless browser')

    cdp = await Cdp.connect(pageTarget.webSocketDebuggerUrl, { callTimeoutMs: 20000 })
    await cdp.send('Runtime.enable')
    await cdp.send('Performance.enable')

    /*
     * `SystemInfo.getProcessInfo` is a *browser*-level command: on a page session
     * it answers "method not found". Per-process CPU lives there, so the rig
     * keeps a second connection to the browser endpoint for it.
     */
    try {
      browserCdp = await Cdp.connect(version.webSocketDebuggerUrl, { callTimeoutMs: 10000 })
    } catch (error) {
      notes.push(`浏览器级 CDP 连接失败，进程 CPU 未采集：${error.message}`)
    }

    const settled = await settle(cdp, OPTIONS.settleMs)
    if (spec.hash && !settled) {
      notes.push('页面在 settle 窗口内没有达到稳定状态，采样可能包含首次挂载成本。')
    }
    if (settled && settled.error) notes.push(`页面内置错误捕获器报告了异常：${settled.error}`)
    if (spec.hash && settled && settled.renders === null) {
      notes.push('window.__auroraRenders 不存在：应用可能根本没挂载。')
    }

    await cdp.eval(INSTALL_COLLECTOR)

    if (spec.pausePlayback) {
      const pause = await cdp.eval(PAUSE_VIA_UI)
      if (!pause.clicked) {
        notes.push(`暂停失败：${pause.reason}；本场景实际仍在播放，数字按「前台播放」解释。`)
      } else {
        await sleep(1200)
        // Verify with the mutation counter rather than trusting the click: the
        // 60 Hz style writes must stop for this to be an idle measurement.
        await cdp.eval(MUTATION_PROBE)
        await sleep(1000)
        const residual = await cdp.eval(MUTATION_READ)
        notes.push(
          `已点击「${pause.was}」（点击后标签：${pause.now}）；暂停后 DOM 变更残值 ${residual} 条/秒。`
        )
        if (typeof residual === 'number' && residual > 10) {
          notes.push(`暂停后仍有 ${residual} 条/秒 DOM 变更，本场景不算静止，请按「前台有动画」解释。`)
        }
      }
    }

    if (spec.hidden) {
      const created = await cdp.send('Target.createTarget', { url: 'about:blank' })
      try {
        await cdp.send('Target.activateTarget', { targetId: created.targetId })
      } catch {
        notes.push('Target.activateTarget 不可用，改为依赖 createTarget 的隐式激活。')
      }
      await sleep(1000)
      const visibility = await cdp.eval('({hidden: document.hidden, state: document.visibilityState})')
      if (!visibility.hidden) {
        notes.push(
          `切标签页后 document.hidden 仍为 ${JSON.stringify(visibility)}：本场景实际没有进入隐藏态，数字按可见解释。`
        )
      }
    }

    const metricsBefore = await readPerfMetrics(cdp)
    const procsBefore = browserCdp ? await readProcessInfo(browserCdp) : { error: 'no browser-level connection' }
    await cdp.eval(MARK_WINDOW)
    const wallStart = process.hrtime.bigint()
    await sleep(OPTIONS.durationMs)
    const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6
    const raw = await cdp.eval(READ_WINDOW)
    const metricsAfter = await readPerfMetrics(cdp)
    const procsAfter = browserCdp ? await readProcessInfo(browserCdp) : { error: 'no browser-level connection' }

    const result = summarize(spec, { raw, metricsBefore, metricsAfter, procsBefore, procsAfter, wallMs, version, notes })
    return result
  } finally {
    if (cdp) cdp.close()
    if (browserCdp) browserCdp.close()
    await edge.kill()
  }
}

// --- summarising -----------------------------------------------------------

function delta(after, before, key) {
  if (typeof after?.[key] !== 'number' || typeof before?.[key] !== 'number') return null
  return after[key] - before[key]
}

/** Accepts a number or the usual count-bearing object shapes. */
function probeCount(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return value
  if (typeof value === 'object') {
    for (const key of ['count', 'notifies', 'notifications', 'sent', 'messages', 'total', 'calls']) {
      if (typeof value[key] === 'number') return value[key]
    }
  }
  return null
}

function probeDelta(end, start) {
  const a = probeCount(end)
  const b = probeCount(start === undefined ? null : start)
  if (a === null) return { available: false, count: null, delta: null }
  if (b === null) return { available: true, count: a, delta: null, note: '只有结束值，没有窗口起点值，因此没有增量' }
  return { available: true, count: a, delta: a - b }
}

function summarize(spec, ctx) {
  const { raw, metricsBefore, metricsAfter, procsBefore, procsAfter, wallMs, version, notes } = ctx
  const out = { ...notes }
  const warnings = [...notes]

  const spanMs = raw.windowStart !== null && raw.windowEnd !== null ? raw.windowEnd - raw.windowStart : wallMs
  const frames = frameStats(raw.intervals ?? [])
  const fps = spanMs > 0 ? ((raw.rafCount ?? 0) / spanMs) * 1000 : null

  // --- renderer main thread, from CDP performance metrics -------------------
  const taskDelta = delta(metricsAfter, metricsBefore, 'TaskDuration')
  const scriptDelta = delta(metricsAfter, metricsBefore, 'ScriptDuration')
  const layoutDelta = delta(metricsAfter, metricsBefore, 'LayoutDuration')
  const styleDelta = delta(metricsAfter, metricsBefore, 'RecalcStyleDuration')
  const cpuWindowSec = wallMs / 1000

  const busy = {
    taskMs: taskDelta === null ? null : round(taskDelta * 1000, 1),
    scriptMs: scriptDelta === null ? null : round(scriptDelta * 1000, 1),
    layoutMs: layoutDelta === null ? null : round(layoutDelta * 1000, 1),
    styleMs: styleDelta === null ? null : round(styleDelta * 1000, 1),
    taskBusyPctOfOneCore: taskDelta === null ? null : round((taskDelta / cpuWindowSec) * 100, 2),
    scriptPctOfOneCore: scriptDelta === null ? null : round((scriptDelta / cpuWindowSec) * 100, 2),
    windowMs: round(wallMs, 1)
  }

  // --- process CPU, browser-wide -------------------------------------------
  const cpuBefore = sumCpuByType(procsBefore)
  const cpuAfter = sumCpuByType(procsAfter)
  const cores = os.cpus()?.length ?? 1
  let processCpu = null
  if (cpuBefore && cpuAfter) {
    const byType = {}
    for (const type of new Set([...Object.keys(cpuBefore.byType), ...Object.keys(cpuAfter.byType)])) {
      byType[type] = round(((cpuAfter.byType[type] ?? 0) - (cpuBefore.byType[type] ?? 0)) * 1000, 1)
    }
    const totalMs = (cpuAfter.total - cpuBefore.total) * 1000
    const rendererMs = byType.renderer ?? null
    processCpu = {
      byTypeMs: byType,
      totalCpuMs: round(totalMs, 1),
      pctOfAllCores: round((totalMs / 1000 / cpuWindowSec / cores) * 100, 3),
      pctOfOneCore: round((totalMs / 1000 / cpuWindowSec) * 100, 2),
      rendererCpuMs: rendererMs,
      rendererPctOfOneCore: rendererMs === null ? null : round((rendererMs / 1000 / cpuWindowSec) * 100, 2),
      rendererPctOfAllCores:
        rendererMs === null ? null : round((rendererMs / 1000 / cpuWindowSec / cores) * 100, 3),
      roles:
        'browser / renderer / GPU / utility，来自浏览器级 SystemInfo.getProcessInfo。' +
        '除 renderer 外都混有 Edge 自身服务开销，必须减掉 control-blank 场景再解读。'
    }
  }

  // --- long tasks -----------------------------------------------------------
  const longTasks = Array.isArray(raw.longTasks) ? raw.longTasks : []
  const longTaskTotal = longTasks.reduce((acc, e) => acc + (e.duration ?? 0), 0)

  // --- counters -------------------------------------------------------------
  const rendersDelta =
    typeof raw.renders === 'number' && typeof raw.rendersAtMark === 'number'
      ? raw.renders - raw.rendersAtMark
      : null
  const heapDelta =
    typeof raw.heap === 'number' && typeof raw.heapAtMark === 'number' ? raw.heap - raw.heapAtMark : null
  const nodesDelta =
    typeof raw.nodes === 'number' && typeof raw.nodesAtMark === 'number' ? raw.nodes - raw.nodesAtMark : null

  const expectedWrites =
    spec.writesPositionPerSecond > 0 ? (spanMs / 1000) * spec.writesPositionPerSecond : null

  const storeProbe = probeDelta(raw.store, raw.storeAtMark)
  const ipcProbe = probeDelta(raw.ipc, raw.ipcAtMark)
  const mutationTopTargets = (raw.mutationTopTargets ?? []).map(([target, count]) => ({ target, count }))

  return {
    id: spec.id,
    group: spec.group,
    hash: spec.hash,
    what: spec.what,
    hidden: spec.hidden,
    extraFlags: spec.flags,
    url: `preview-dist/aurora-preview-${spec.hash}.html#${spec.hash}`,
    browser: version?.Browser ?? null,
    window: {
      wallMs: round(wallMs, 1),
      pageSpanMs: round(spanMs, 1),
      visibilityState: raw.visibilityState,
      documentHidden: raw.hidden
    },
    frames: {
      ...frames,
      fps: round(fps, 2),
      samplerDriven: true,
      rafLoopRunning: raw.rafLoopRunning,
      firstFrameAt: raw.firstFrame === null ? null : round(raw.firstFrame - (raw.windowStart ?? 0), 1),
      lastFrameAt: raw.lastFrame === null ? null : round(raw.lastFrame - (raw.windowStart ?? 0), 1)
    },
    longTasks: {
      supported: raw.longTaskSupported,
      error: raw.longTaskError,
      count: longTasks.length,
      totalMs: round(longTaskTotal, 1),
      maxMs: longTasks.length ? round(Math.max(...longTasks.map((e) => e.duration)), 1) : null,
      perSecond: round((longTasks.length / spanMs) * 1000, 2)
    },
    mainThread: busy,
    processCpu,
    memory: {
      heapUsedAtEndBytes: raw.heap,
      heapUsedDeltaBytes: heapDelta,
      heapTotalAtEndBytes: raw.heapTotal,
      cdpJsHeapUsedBytes: metricsAfter?.JSHeapUsedSize ?? null,
      domNodesAtEnd: raw.nodes,
      domNodesDelta: nodesDelta,
      cdpNodes: metricsAfter?.Nodes ?? null,
      cdpLayoutCount: metricsAfter?.LayoutCount ?? null,
      cdpRecalcStyleCount: metricsAfter?.RecalcStyleCount ?? null
    },
    renderCounters: {
      rootRenders: rendersDelta,
      rootRendersSinceLoad: raw.renders,
      rootRendersPerSecond: rendersDelta === null || spanMs <= 0 ? null : round((rendersDelta / spanMs) * 1000, 2),
      counterSource: '__auroraRenders（App.tsx 里已有的 preview-only 计数器）',
      expectedPositionWrites: expectedWrites === null ? null : Math.round(expectedWrites),
      rendersPerPositionWrite:
        expectedWrites && rendersDelta !== null ? round(rendersDelta / expectedWrites, 4) : null
    },
    domMutations: {
      supported: raw.mutationSupported,
      error: raw.mutationError,
      total: raw.mutations,
      perSecond: spanMs > 0 ? round((raw.mutations / spanMs) * 1000, 2) : null,
      breakdown: raw.mutationBreakdown,
      topTargets: mutationTopTargets,
      samples: raw.mutationSamples ?? []
    },
    /** Probe-gated counters. Absent means "not collected", never zero. */
    probeCounters: {
      storeNotifications: storeProbe,
      ipcMessages: ipcProbe,
      storeProbeGlobal: 'window.__auroraPerfStore',
      ipcProbeGlobal: 'window.__auroraPerfIpc',
      raw: { store: raw.store, storeAtMark: raw.storeAtMark, ipc: raw.ipc, ipcAtMark: raw.ipcAtMark }
    },
    unavailable: {
      storeNotifications: storeProbe.available
        ? null
        : '未采集：zustand store 在模块作用域内，浏览器预览无法从页面侧订阅。需要 window.__auroraPerfStore 探针（方案见 docs/perf-baseline.md 的《缺口与探针方案》一节）。',
      ipcMessages: ipcProbe.available
        ? null
        : '未采集：浏览器预览没有 preload/ipcRenderer，主进程→渲染层 IPC 完全不经过这条通道；需要 Electron 运行时 + window.__auroraPerfIpc 探针（或 --counters 文件）。'
    },
    page: {
      canvases: raw.canvases,
      rootChildren: raw.rootChildren,
      harnessError: raw.harnessError,
      userAgent: raw.userAgent
    },
    warnings
  }
}

// --- rendering -------------------------------------------------------------

const fmt = (value, digits = 2) => {
  if (value === null || value === undefined) return '—'
  if (typeof value !== 'number') return String(value)
  return Number.isInteger(value) ? String(value) : value.toFixed(digits)
}

/**
 * The numeric block that is spliced into the hand-written `perf-baseline.md`.
 *
 * `perf-report.md` is wholly generated, but `perf-baseline.md` also carries the
 * measurement definitions and the limitations, which are human judgement. The
 * numbers in it are therefore injected between two HTML-comment markers so the
 * prose stays hand-written and the numbers can never go stale.
 */
function renderMeasuredBlock(report) {
  const { environment, rig, scenarios } = report
  const allRows = Object.values(scenarios)
  const rows = allRows.filter((row) => !row.failed)
  const control = scenarios['control-blank']
  const external = report.externalCounters?.data ?? null
  const out = []

  const fingerprints = Object.entries(environment.previewBundle ?? {})
    .map(([name, info]) => (info ? `${name.slice(15, -5)} ${info.sha256}` : `${name} 缺失`))
    .join('，')

  out.push(`- 生成时间：${report.generatedAt}`)
  out.push(`- git：\`${environment.git.rev}\`（${environment.git.branch}），工作区脏文件 ${environment.git.dirtyFiles} 个`)
  out.push(`- 环境：Edge ${environment.edge} / \`--headless=new\` / Node ${environment.node} / ${environment.cores} 逻辑核心`)
  out.push(`- 采样：每场景 ${rig.durationMs} ms（settle ${rig.settleMs} ms），构建 ${rig.buildRan ? '已执行' : '复用产物'}`)
  out.push(`- **产物指纹（对比时必须一致）**：${fingerprints}`)
  out.push('')
  out.push('| 场景 | 主线程忙时 (ms) | 忙时占单核 | 渲染进程 CPU 占单核 | 占全部核心 | DOM 变更 | 变更/秒 | JS 堆增量 | DOM 节点 | p95 帧间隔 (ms) | Long Task |')
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const row of rows) {
    out.push(
      '| ' +
        [
          `\`${row.id}\` ${row.group}`,
          fmt(row.mainThread.taskMs, 1),
          row.mainThread.taskBusyPctOfOneCore === null ? '—' : `${fmt(row.mainThread.taskBusyPctOfOneCore)}%`,
          row.processCpu === null ? '—' : `${fmt(row.processCpu.rendererPctOfOneCore)}%`,
          row.processCpu === null ? '—' : `${fmt(row.processCpu.rendererPctOfAllCores, 3)}%`,
          row.domMutations.total,
          fmt(row.domMutations.perSecond),
          row.memory.heapUsedDeltaBytes === null ? '—' : `${fmt(row.memory.heapUsedDeltaBytes / 1024, 0)} KB`,
          row.memory.domNodesAtEnd,
          fmt(row.frames.p95),
          row.longTasks.count
        ].join(' | ') +
        ' |'
    )
  }
  const failed = allRows.filter((row) => row.failed)
  if (failed.length) {
    out.push('')
    out.push(`> 未跑成功：${failed.map((row) => `\`${row.id}\`（${row.error}）`).join('；')}`)
  }
  if (control && !control.failed && control.processCpu) {
    out.push('')
    out.push(
      `**减掉装置自身开销后的渲染进程 CPU**（对照 \`control-blank\` = ${fmt(control.processCpu.rendererCpuMs, 1)} ms；` +
        '这部分是 Edge 自身服务、CDP 通道与采样器，不是 Aurora）：'
    )
    out.push('')
    out.push('| 场景 | 渲染进程 CPU (ms) | 减掉对照后 (ms) |')
    out.push('| --- | --- | --- |')
    for (const row of rows) {
      if (!row.processCpu || row.id === 'control-blank') continue
      out.push(
        `| \`${row.id}\` | ${fmt(row.processCpu.rendererCpuMs, 1)} | ${fmt(row.processCpu.rendererCpuMs - control.processCpu.rendererCpuMs, 1)} |`
      )
    }
  }
  if (external) {
    out.push('')
    out.push(
      `**外部计数**（来自 \`${report.externalCounters.path}\`，sha256 ${report.externalCounters.sha256}）：` +
        `store 通知 ${external.storeNotifications ?? '未提供'} 次，IPC ${external.ipcMessages ?? '未提供'} 条` +
        (external.source ? `；来源说明：${external.source}` : '')
    )
  }
  return out.join('\n')
}

/**
 * Splices `renderMeasuredBlock` into the hand-written baseline document.
 *
 * If the markers are missing the file is left untouched and the caller is told,
 * because silently appending to a hand-written document is worse than not
 * updating it.
 */
function refreshBaselineDoc(report) {
  const baselinePath = path.join(DOCS_DIR, 'perf-baseline.md')
  if (!fs.existsSync(baselinePath)) return { updated: false, reason: 'docs/perf-baseline.md 不存在' }
  const BEGIN = '<!-- PERF-MEASURED-BEGIN -->'
  const END = '<!-- PERF-MEASURED-END -->'
  const text = fs.readFileSync(baselinePath, 'utf8')
  const begin = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  if (begin === -1 || end === -1 || end < begin) {
    return { updated: false, reason: 'docs/perf-baseline.md 里没有 PERF-MEASURED 标记，未改动' }
  }
  const block = `\n${renderMeasuredBlock(report)}\n`
  const updated = text.slice(0, begin + BEGIN.length) + block + text.slice(end)
  fs.writeFileSync(baselinePath, updated, 'utf8')
  return { updated: true, reason: 'ok' }
}

function buildMarkdown(report) {
  const { environment, rig, scenarios } = report
  const allRows = Object.values(scenarios)
  const rows = allRows.filter((row) => !row.failed)
  const failedRows = allRows.filter((row) => row.failed)
  const lines = []

  lines.push('# Aurora 性能基线（可复现报告）')
  lines.push('')
  lines.push(`生成时间：${report.generatedAt}`)
  lines.push('')
  lines.push(
    '本文件由 `npm run perf` 自动生成，**不要手改**。口径定义、局限与「测不出什么」写在 ' +
      '`docs/perf-baseline.md`，本文件只放数字与复现信息。'
  )
  lines.push('')
  lines.push('## 一、复现命令')
  lines.push('')
  lines.push('```powershell')
  lines.push('cd D:\\Aurora')
  lines.push('npm run perf                      # 构建预览产物 + 采集 + 写报告')
  lines.push('node scripts/perf-report.mjs --no-build            # 复用已有产物，快速重测')
  lines.push('node scripts/perf-report.mjs --no-build --duration=10000 --only=playing-stage')
  lines.push('```')
  lines.push('')
  lines.push('## 二、环境与锚点')
  lines.push('')
  lines.push('| 项 | 值 |')
  lines.push('| --- | --- |')
  lines.push(`| 浏览器 | ${environment.edge}（\`--headless=new\`） |`)
  lines.push(`| 页面 | \`file:///…/preview-dist/*.html\`（自包含，无服务器） |`)
  lines.push(`| git HEAD | \`${environment.git.rev}\` (${environment.git.branch}) |`)
  lines.push(`| 工作区脏文件数 | ${environment.git.dirtyFiles} |`)
  lines.push(`| 采样窗口 | ${rig.durationMs} ms（settle ${rig.settleMs} ms） |`)
  lines.push(`| Node / OS | ${environment.node} / ${environment.os} |`)
  lines.push(`| 逻辑核心 | ${environment.cores} |`)
  lines.push(`| CPU | ${environment.cpuModel} |`)
  const fingerprintEntries = Object.entries(environment.previewBundle ?? {})
  if (fingerprintEntries.length) {
    lines.push(
      `| 实测产物指纹 | ${fingerprintEntries
        .map(([name, info]) => (info ? `${name.slice(15, -5)} \`${info.sha256}\`` : `${name} 缺失`))
        .join('，')} |`
    )
  }
  if (environment.git.dirtyFiles > 0) {
    lines.push('')
    lines.push('> 工作区有未提交改动，这份基线锚定的是「当前工作树」而不是一个干净的提交。对比前后必须用同一批文件状态。')
    lines.push('')
    lines.push('改动文件（前 12 个）：')
    lines.push('')
    for (const file of environment.git.dirtySample) lines.push(`- \`${file}\``)
  }
  lines.push('')
  lines.push('## 三、基线数字表')
  lines.push('')
  lines.push(
    '| 场景 | document.hidden | rAF fps | 帧间隔 p50 / p95 / max (ms) | 主线程忙时 (ms) | 主线程忙时占单核 | 渲染进程 CPU 占单核 / 占全部核心 | 长任务数/总时长 | 根组件渲染 | DOM 变更/秒 | JS 堆增量 (KB) | DOM 节点增量 |'
  )
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const row of rows) {
    lines.push(
      '| ' +
        [
          `${row.group} \`${row.id}\``,
          row.window.documentHidden ? 'true' : 'false',
          fmt(row.frames.fps),
          `${fmt(row.frames.p50)} / ${fmt(row.frames.p95)} / ${fmt(row.frames.max)}`,
          fmt(row.mainThread.taskMs, 1),
          row.mainThread.taskBusyPctOfOneCore === null ? '—' : `${fmt(row.mainThread.taskBusyPctOfOneCore)}%`,
          row.processCpu === null
            ? '—'
            : `${fmt(row.processCpu.rendererPctOfOneCore)}% / ${fmt(row.processCpu.rendererPctOfAllCores, 3)}%`,
          `${row.longTasks.count} / ${fmt(row.longTasks.totalMs, 1)} ms`,
          row.renderCounters.rootRenders === null ? '—' : String(row.renderCounters.rootRenders),
          fmt(row.domMutations.perSecond),
          row.memory.heapUsedDeltaBytes === null ? '—' : fmt(row.memory.heapUsedDeltaBytes / 1024, 1),
          row.memory.domNodesDelta === null ? '—' : String(row.memory.domNodesDelta)
        ].join(' | ') +
        ' |'
    )
  }
  lines.push('')
  lines.push(
    '> ⚠ **rAF 帧数会高估「应用在画」**：采样器自己持有一个 `requestAnimationFrame` 回调，只要它在，渲染器就会持续产帧。' +
      '所以 `fps≈60` 的含义是「帧时钟在跑」，不是「应用在动」。判断应用是否真在干活，看主线程 TaskDuration、根渲染次数和 DOM 变更三条。' +
      '反过来，`fps=0` 是可信的：它说明渲染器连帧都不产了。'
  )
  lines.push('')
  lines.push('场景定义：')
  lines.push('')
  for (const row of rows) {
    lines.push(`- \`${row.id}\`（${row.group}）：${row.what} 页面：\`${row.url}\``)
  }
  if (failedRows.length) {
    lines.push('')
    lines.push('**未跑成功的场景：**')
    lines.push('')
    for (const row of failedRows) {
      lines.push(`- \`${row.id}\`（${row.group}）：${row.error}`)
    }
  }
  const control = scenarios['control-blank']
  if (control && !control.failed && control.processCpu) {
    lines.push('')
    lines.push('### 减掉装置自身的开销')
    lines.push('')
    lines.push(
      '`control-blank`（同一套参数下的 about:blank）里渲染进程也烧掉了 ' +
        `${fmt(control.processCpu.rendererCpuMs, 1)} ms（占单核 ${fmt(control.processCpu.rendererPctOfOneCore)}%），` +
        `浏览器全部进程 ${fmt(control.processCpu.totalCpuMs, 1)} ms（占单核 ${fmt(control.processCpu.pctOfOneCore)}%）——` +
        '这部分是 Edge 自身服务、CDP 通道和我自己的采样器，不是 Aurora。'
    )
    lines.push('')
    lines.push(
      '读「进程 CPU」一列时请做减法：`场景渲染进程 ms − control-blank 渲染进程 ms`。' +
        '主线程忙时（TaskDuration）那一列基本不受此影响，可以直读。'
    )
    lines.push('')
    lines.push('| 场景 | 渲染进程 CPU (ms) | 减掉对照后 (ms) |')
    lines.push('| --- | --- | --- |')
    for (const row of rows) {
      if (!row.processCpu || row.id === 'control-blank') continue
      const net = row.processCpu.rendererCpuMs - control.processCpu.rendererCpuMs
      lines.push(`| \`${row.id}\` | ${fmt(row.processCpu.rendererCpuMs, 1)} | ${fmt(net, 1)} |`)
    }
  }
  lines.push('')
  lines.push('## 四、逐场景明细')
  lines.push('')
  for (const row of rows) {
    lines.push(`### \`${row.id}\` — ${row.group}`)
    lines.push('')
    lines.push(`- 可见性：document.visibilityState = \`${row.window.visibilityState}\`，采到 rAF 帧 ${row.frames.frames} 帧 / ${row.window.pageSpanMs} ms`)
    lines.push(
      `- 帧间隔：p50 ${fmt(row.frames.p50)}，p95 ${fmt(row.frames.p95)}，p99 ${fmt(row.frames.p99)}，max ${fmt(row.frames.max)}，>33.4ms 的帧 ${row.frames.over33ms ?? 0} 个`
    )
    lines.push(
      `- 渲染进程主线程：TaskDuration ${fmt(row.mainThread.taskMs, 1)} ms（占单核 ${row.mainThread.taskBusyPctOfOneCore === null ? '—' : fmt(row.mainThread.taskBusyPctOfOneCore) + '%'}），其中 Script ${fmt(row.mainThread.scriptMs, 1)} ms / Layout ${fmt(row.mainThread.layoutMs, 1)} ms / Style ${fmt(row.mainThread.styleMs, 1)} ms`
    )
    if (row.processCpu) {
      const byType = Object.entries(row.processCpu.byTypeMs)
        .map(([k, v]) => `${k} ${fmt(v, 1)}ms`)
        .join('，')
      lines.push(
        `- 进程 CPU：渲染进程 ${fmt(row.processCpu.rendererCpuMs, 1)} ms（占单核 ${fmt(row.processCpu.rendererPctOfOneCore)}%，占全部 ${environment.cores} 核 ${fmt(row.processCpu.rendererPctOfAllCores, 3)}%）；` +
          `浏览器全部进程合计 ${fmt(row.processCpu.totalCpuMs, 1)} ms（占单核 ${fmt(row.processCpu.pctOfOneCore)}%）`
      )
      lines.push(`  - 分进程：${byType}`)
    } else {
      lines.push('- 进程 CPU：未采集（浏览器级 SystemInfo.getProcessInfo 不可用）')
    }
    lines.push(
      `- 根组件渲染 ${row.renderCounters.rootRenders === null ? '未采集' : row.renderCounters.rootRenders + ' 次'}（${row.renderCounters.rootRendersPerSecond === null ? '—' : fmt(row.renderCounters.rootRendersPerSecond) + ' 次/秒'}，载入以来累计 ${row.renderCounters.rootRendersSinceLoad ?? '—'} 次）` +
        (row.renderCounters.rendersPerPositionWrite === null
          ? ''
          : `，每次位置写入对应 ${row.renderCounters.rendersPerPositionWrite} 次根渲染`)
    )
    lines.push(
      `- DOM 变更 ${row.domMutations.total} 条（${fmt(row.domMutations.perSecond)} 条/秒；childList ${row.domMutations.breakdown?.childList ?? 0}，characterData ${row.domMutations.breakdown?.characterData ?? 0}，attributes ${row.domMutations.breakdown?.attributes ?? 0}）`
    )
    if (row.domMutations.topTargets?.length) {
      lines.push(
        `  - 变更最多的节点：${row.domMutations.topTargets.map((t) => `\`${t.target}\` ${t.count}`).join('；')}`
      )
    }
    if (row.domMutations.samples?.length) {
      const sample = row.domMutations.samples
        .slice(0, 4)
        .map((s) => `${s.type}@${s.path}${s.text ? `(${s.text})` : ''}`)
        .join('，')
      lines.push(`  - 样本：${sample}`)
    }
    lines.push(
      `- 探针计数：store 通知 ${row.probeCounters?.storeNotifications?.available ? row.probeCounters.storeNotifications.delta + ' 次' : '未采集'}；IPC 条数 ${row.probeCounters?.ipcMessages?.available ? row.probeCounters.ipcMessages.delta + ' 条' : '未采集'}`
    )
    lines.push(
      `- 内存：JS 堆 ${fmt((row.memory.heapUsedAtEndBytes ?? 0) / 1048576, 2)} MB（窗口内增量 ${row.memory.heapUsedDeltaBytes === null ? '—' : fmt(row.memory.heapUsedDeltaBytes / 1024, 1) + ' KB'}），DOM 节点 ${row.memory.domNodesAtEnd}（增量 ${row.memory.domNodesDelta ?? '—'}）`
    )
    lines.push(`- 页面自检：canvas ${row.page.canvases} 个，根节点子元素 ${row.page.rootChildren}，内置错误捕获器：${row.page.harnessError ? '有异常' : '无'}`)
    for (const warning of row.warnings ?? []) lines.push(`- ⚠ ${warning}`)
    lines.push('')
  }
  lines.push('## 五、外部计数（store 通知 / IPC 条数）')
  lines.push('')
  if (report.externalCounters) {
    const data = report.externalCounters.data
    lines.push(
      `来源文件：\`${report.externalCounters.path}\`（sha256 ${report.externalCounters.sha256}）` +
        (data.windowMs ? `，其采样窗口 ${data.windowMs} ms` : '')
    )
    lines.push('')
    lines.push('| 指标 | 数值 | 细分 |')
    lines.push('| --- | --- | --- |')
    lines.push(
      `| store 通知次数 | ${data.storeNotifications ?? '未提供'} | ${JSON.stringify(data.storeByStore ?? {})} |`
    )
    lines.push(
      `| IPC 条数 | ${data.ipcMessages ?? '未提供'} | ${JSON.stringify(data.ipcByChannel ?? {})} |`
    )
    if (data.source) lines.push('')
    if (data.source) lines.push(`来源说明：${data.source}`)
    if (data.note) lines.push('')
    if (data.note) lines.push(`备注：${data.note}`)
  } else {
    lines.push(
      '本次运行没有提供外部计数（`--counters=<file.json>`）。这两项在本装置的 **未采集**，原因见下一节：' +
        'store 在模块作用域内、IPC 根本不在浏览器预览里。'
    )
  }
  lines.push('')
  lines.push('## 六、本口径测不出的东西')
  lines.push('')
  lines.push(
    '### 最重要的一条：本装置的「不可见」不等于 Electron 的「不可见」'
  )
  lines.push('')
  lines.push(
    '实测：页面切到后台后，即使加上 `--disable-background-timer-throttling --disable-renderer-backgrounding ' +
      '--disable-backgrounding-occluded-windows`（Electron `backgroundThrottling: false` 的浏览器等效开关），' +
      '渲染器仍然完全停止产帧（fps = 0），主线程 TaskDuration 掉到 0.1% 以下。'
  )
  lines.push('')
  lines.push(
    '**所以：rAF 驱动的隐藏态工作，本装置测不出来**（帧停了，`requestAnimationFrame` 链就断了），' +
      '`hidden-*` 两行不能用来判断 Aurora 最小化时的真实 rAF 开销。'
  )
  lines.push('')
  lines.push(
    '**但计时器驱动的隐藏态工作测得出来。** 带上 `--disable-background-timer-throttling` 后 `setInterval` ' +
      '会按真实节奏跑，而 Electron 的 `backgroundThrottling: false` 正是它的等效物。' +
      '因此 `hidden-stage-electron` 对「隐藏时靠定时器继续更新的路径」可直接采信；' +
      '`hidden-stage-browser` 是节流后的对照，**不要用它代表 Electron**。'
  )
  lines.push('')
  lines.push(
    '隐藏态的验收因此要走**计数口径**（DOM 变更 / 渲染次数 / store 通知 / IPC 条数），' +
      '因为计数在帧停止后依然累加。'
  )
  lines.push('')
  const external = report.externalCounters?.data ?? null
  lines.push('| 指标 | 状态 | 原因 / 需要什么 |')
  lines.push('| --- | --- | --- |')
  lines.push(
    external && typeof external.storeNotifications === 'number'
      ? `| zustand store 通知次数 | 来自外部计数文件：${external.storeNotifications} | 本装置测不出；数值由 \`--counters\` 文件提供，见第五节 |`
      : '| zustand store 通知次数 | 未采集 | store 在模块作用域内，页面侧拿不到；需要 `window.__auroraPerfStore` 探针或 `--counters` 文件（方案见 `docs/perf-baseline.md` 的《缺口与探针方案》一节） |'
  )
  lines.push(
    external && typeof external.ipcMessages === 'number'
      ? `| 主进程→渲染层 IPC 条数（含 \`library:progress\`） | 来自外部计数文件：${external.ipcMessages} | 本装置测不出；数值由 \`--counters\` 文件提供，见第五节 |`
      : '| 主进程→渲染层 IPC 条数（含 `library:progress`） | 未采集 | 浏览器预览没有 preload/ipcRenderer，这条通道不经过本装置；需要 Electron 运行时探针或 `--counters` 文件 |'
  )
  lines.push('| GPU / 合成器耗时 | 未采集 | headless 下合成与栅格化走的是软件或 SwiftShader 路径，不代表真实窗口的 GPU 开销 |')
  lines.push('| 真实窗口(非 headless)的整机占用 | 未采集 | 本机进程沙箱起不了 Chromium/Electron 窗口 |')
  lines.push('| 音频解码 / AudioContext 频谱成本 | 未采集 | 预览里没有真实音频文件，`getSpectrum()` 返回 null 或全零 |')
  lines.push('')
  return lines.join('\n')
}

// --- main ------------------------------------------------------------------

async function main() {
  /*
   * Re-render only: rebuild both reports from a previously captured JSON.
   *
   * Report wording is part of the deliverable and gets corrected after a run;
   * re-measuring just to fix a sentence would also move the numbers. This mode
   * touches no browser and no build.
   */
  const fromJson = argValue('from-json')
  if (fromJson) {
    const source = path.resolve(ROOT, fromJson)
    const report = JSON.parse(fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, ''))
    fs.writeFileSync(OPTIONS.mdOut, buildMarkdown(report), 'utf8')
    const baseline = refreshBaselineDoc(report)
    console.log(`[perf] re-rendered ${path.relative(ROOT, OPTIONS.mdOut)} from ${path.relative(ROOT, source)}`)
    console.log(
      baseline.updated
        ? '[perf] refreshed the measured block in docs/perf-baseline.md'
        : `[perf] docs/perf-baseline.md not refreshed: ${baseline.reason}`
    )
    if (path.resolve(ROOT, OPTIONS.jsonOut) !== source) {
      console.log('[perf] note: --from-json does not rewrite the JSON (it is the source)')
    }
    return
  }

  const startedAt = Date.now()
  const environment = {
    node: process.version,
    os: `${os.type()} ${os.release()}`,
    cores: os.cpus()?.length ?? null,
    cpuModel: os.cpus()?.[0]?.model ?? null,
    totalMemBytes: os.totalmem(),
    git: gitInfo(),
    edge: null,
    previewBundle: fingerprintPreviews()
  }

  let buildMs = null
  if (OPTIONS.build) {
    buildMs = buildPreview()
  } else {
    console.log('[perf] --no-build: reusing preview-dist as-is')
  }
  assertPreviewExists()

  const scenarios = OPTIONS.only ? SCENARIOS.filter((s) => OPTIONS.only.includes(s.id)) : SCENARIOS
  if (scenarios.length === 0) throw new Error(`no scenario matched --only=${OPTIONS.only}`)

  const results = {}
  const countersFile = loadCountersFile(OPTIONS.countersFile)
  if (countersFile) {
    console.log(
      `[perf] external counters from ${countersFile.path} (sha256 ${countersFile.sha256}): ${JSON.stringify(countersFile.data)}`
    )
  }
  for (const spec of scenarios) {
    process.stdout.write(`[perf] ${spec.id} ...`)
    let result = null
    let lastError = null
    /*
     * One retry. These runs share the machine with other agents' browser probes,
     * and evidence so far is that an unrelated `msedge` kill can take this
     * browser down mid-scenario; a single retry separates that from a real
     * failure. A retried scenario is flagged, never silently averaged.
     */
    for (let attempt = 1; attempt <= 2 && !result; attempt += 1) {
      const scenarioStarted = Date.now()
      try {
        result = await runScenario(spec)
        if (attempt > 1) {
          result.warnings = [...(result.warnings ?? []), `第一次尝试失败（${lastError}），本次是重试结果。`]
          result.retried = true
        }
        console.log(
          ` done in ${((Date.now() - scenarioStarted) / 1000).toFixed(1)}s` +
            (attempt > 1 ? ' (retry)' : '') +
            ` (fps ${fmt(result.frames.fps)}, busy ${fmt(result.mainThread.taskBusyPctOfOneCore)}%, renders ${result.renderCounters.rootRenders})`
        )
      } catch (error) {
        lastError = error.message
        result = null
        if (attempt === 1) process.stdout.write(` retrying (${lastError}) ...`)
      }
    }
    if (result) {
      results[spec.id] = result
      environment.edge = environment.edge ?? result.browser
    } else {
      console.log(` FAILED: ${lastError}`)
      results[spec.id] = {
        id: spec.id,
        group: spec.group,
        hash: spec.hash,
        what: spec.what,
        failed: true,
        error: lastError,
        warnings: [`场景执行失败（两次尝试）：${lastError}`]
      }
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    environment,
    rig: {
      kind: 'browser-preview + headless Edge over CDP',
      browserPath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      headless: '--headless=new',
      transport: 'file:// self-contained preview pages (no static server)',
      durationMs: OPTIONS.durationMs,
      settleMs: OPTIONS.settleMs,
      buildRan: OPTIONS.build,
      buildMs,
      totalMs: Date.now() - startedAt
    },
    externalCounters: countersFile,
    caveat:
      '这是浏览器预览构建的渲染进程数字，不是 Electron 整机占用；Electron 主进程、IPC 与 GPU 合成不在本口径内。',
    scenarios: results
  }

  fs.mkdirSync(DOCS_DIR, { recursive: true })
  fs.writeFileSync(OPTIONS.jsonOut, JSON.stringify(report, null, 2), 'utf8')
  fs.writeFileSync(OPTIONS.mdOut, buildMarkdown(report), 'utf8')
  const baseline = refreshBaselineDoc(report)

  console.log('')
  console.log(`[perf] wrote ${path.relative(ROOT, OPTIONS.jsonOut)} and ${path.relative(ROOT, OPTIONS.mdOut)}`)
  console.log(
    baseline.updated
      ? '[perf] refreshed the measured block in docs/perf-baseline.md'
      : `[perf] docs/perf-baseline.md not refreshed: ${baseline.reason}`
  )
  console.log('')
  for (const row of Object.values(results)) {
    if (row.failed) {
      console.log(`  ${row.id.padEnd(24)} FAILED  ${row.error}`)
      continue
    }
    console.log(
      `  ${row.id.padEnd(24)} fps=${String(fmt(row.frames.fps)).padStart(6)}  busy=${String(fmt(row.mainThread.taskBusyPctOfOneCore)).padStart(6)}%  renders=${String(row.renderCounters.rootRenders).padStart(5)}  mutations/s=${String(fmt(row.domMutations.perSecond)).padStart(8)}  hidden=${row.window.documentHidden}`
    )
  }
}

main().catch((error) => {
  console.error('[perf] failed:', error.message)
  process.exitCode = 1
})
