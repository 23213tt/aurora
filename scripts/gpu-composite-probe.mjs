/**
 * GPU / compositing A/B probe for the Aurora performance task.
 *
 * Why this file exists: `scripts/perf-report.mjs` answers "how much main-thread
 * work does a screen cost", but it cannot say *which CSS feature* costs it, and
 * it never varies the CSS. This rig takes the same preview builds and applies
 * **one override at a time** to the same page, then reads the process CPU
 * breakdown (`SystemInfo.getProcessInfo`) before and after a fixed window.
 *
 * What it measures: the renderer main thread, and the browser's GPU process.
 *
 * What it does NOT measure: real GPU occupancy. Headless Edge composites and
 * rasterises through SwiftShader (software), so the absolute GPU-process number
 * has no relationship to the shipped Electron window. What is trustworthy is the
 * *difference between two runs of the same rig on the same machine*: if removing
 * one CSS declaration moves the GPU process by a repeatable amount, that
 * declaration is doing that much compositing/raster work under this rig. Every
 * claim in the report carries that caveat.
 *
 *   node scripts/gpu-composite-probe.mjs --duration=5000 --reps=2
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  Cdp,
  ELECTRON_BACKGROUND_FLAGS,
  assertEdge,
  baseFlags,
  freePort,
  killTree,
  listTargets,
  readProcessInfo,
  sleep,
  sumCpuByType,
  waitForDevtools
} from './perf-lib.mjs'
import { spawn } from 'node:child_process'

const ROOT = path.resolve(import.meta.dirname, '..')
const PREVIEW_DIR = path.join(ROOT, 'preview-dist')
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const argv = process.argv.slice(2)
const argValue = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const DURATION = Number(argValue('duration', 5000))
const REPS = Number(argValue('reps', 2))

/**
 * Runs before any page script, so the rAF counter sees the app's own loop.
 * Kept deliberately tiny: this is measurement scaffolding in the page, and a
 * heavy probe would change what it measures.
 */
const EARLY = `(() => {
  window.__probe = { frames: [], raf: 0, watching: false, t0: 0 }
  const nativeRaf = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = (cb) => nativeRaf((ts) => {
    window.__probe.raf += 1
    if (window.__probe.watching) window.__probe.frames.push(ts - window.__probe.t0)
    cb(ts)
  })
})()`

/** Start/stop the frame-interval window. rAF is left running either way. */
const WINDOW_START = `(() => {
  const p = window.__probe
  p.frames.length = 0
  p.t0 = performance.now()
  p.watching = true
  return p.t0
})()`
const WINDOW_READ = `(() => {
  const p = window.__probe
  p.watching = false
  const f = p.frames
  const span = performance.now() - p.t0
  const sorted = [...f].sort((a, b) => a - b)
  const q = (x) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * x))] : null)
  return {
    frameCount: f.length,
    spanMs: span,
    fps: span > 0 ? (f.length / span) * 1000 : null,
    p50: q(0.5), p95: q(0.95), max: sorted.length ? sorted[sorted.length - 1] : null,
    hidden: document.hidden,
    canvases: document.querySelectorAll('canvas').length,
    hasBackdrop: !!document.querySelector('.shell__backdrop'),
    /*
     * Which animations the document is actually running, and on what. This is
     * the difference between "there is a spin keyframe in the stylesheet" and
     * "a spin animation is ticking right now" - the task asks for the latter.
     *
     * 'document.getAnimations()' includes CSS *transitions*, which matters more
     * than the keyframes here: an 8 Hz write into a 240 ms transition restarts
     * that transition before it can finish, so it never settles.
     */
    runningAnimations: (() => {
      try {
        return document.getAnimations().map((a) => ({
          kind: a.constructor && a.constructor.name ? a.constructor.name : '?',
          name: a.animationName || a.transitionProperty || '?',
          state: a.playState,
          target: (() => {
            const el = a.effect && a.effect.target
            if (!el || !el.tagName) return null
            const cls = typeof el.className === 'string' && el.className.trim()
              ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.')
              : ''
            return el.tagName.toLowerCase() + cls
          })()
        }))
      } catch (e) {
        return ['error: ' + String(e && e.message)]
      }
    })(),
    backdropLayerInfo: (() => {
      const el = document.querySelector('.shell__backdrop')
      if (!el) return null
      const cs = getComputedStyle(el)
      return { filter: cs.filter, willChange: cs.willChange, opacity: cs.opacity, transform: cs.transform }
    })()
  }
})()`

const css = (...lines) => JSON.stringify(`${lines.join('\n')}`)
const STYLE = `(() => {
  const id = '__probe_override__'
  let el = document.getElementById(id)
  if (!el) { el = document.createElement('style'); el.id = id; document.head.appendChild(el) }
  el.textContent = OVERRIDE
  return el.textContent.length
})()`

const SCENARIOS = [
  {
    id: 'blank-control',
    url: 'about:blank',
    note: '装置自身开销：同一套启动参数下的 about:blank',
    override: null,
    flags: []
  },
  {
    id: 'stage-baseline',
    hash: 'stage',
    note: '播放舞台 + 当前 CSS（整窗 blur(76px) 背景 + 舞台 canvas + 所有无限动画）',
    override: null,
    flags: []
  },
  {
    id: 'stage-no-backdrop-filter',
    hash: 'stage',
    note: '去掉 .shell__backdrop 的 filter: blur(76px) saturate(1.3)（图层仍存在，只是不模糊）',
    override: css('.shell__backdrop { filter: none !important; }'),
    flags: []
  },
  {
    id: 'stage-no-backdrop',
    hash: 'stage',
    note: '整个封面模糊层 display:none（回到纯 --ink-900 背景）',
    override: css('.shell__backdrop { display: none !important; }'),
    flags: []
  },
  {
    id: 'stage-no-backdrop-filter-cached',
    hash: 'stage',
    note: '保留 blur，但要求合成器缓存模糊结果（will-change: filter）',
    override: css('.shell__backdrop { will-change: filter; }'),
    flags: []
  },
  {
    id: 'stage-no-animations',
    hash: 'stage',
    note: '暂停所有 CSS 动画（spin / eq-bounce），canvas 动画不受影响',
    override: css('*, *::before, *::after { animation-play-state: paused !important; }'),
    flags: []
  },
  {
    id: 'stage-no-canvas',
    hash: 'stage',
    note: '去掉舞台 canvas 的绘制（display:none），但保留封面模糊背景与动画',
    override: css('.viz { display: none !important; }'),
    flags: []
  },
  {
    id: 'stage-no-backdrop-filter-no-canvas',
    hash: 'stage',
    note: '去掉模糊 + 去掉 canvas：看两者是否叠加',
    override: css('.shell__backdrop { filter: none !important; } .viz { display: none !important; }'),
    flags: []
  },
  {
    id: 'stage-hidden-baseline',
    hash: 'stage',
    note: '页面切到后台（document.hidden=true）+ Electron 等效反节流开关，当前 CSS。用来验证「切后台动画还烧不烧」',
    override: null,
    flags: ELECTRON_BACKGROUND_FLAGS,
    hidden: true
  },
  {
    id: 'stage-hidden-no-animations',
    hash: 'stage',
    note: '同上，但暂停所有 CSS 动画：量「后台时 CSS 动画是否仍在计算」',
    override: css('*, *::before, *::after { animation-play-state: paused !important; }'),
    flags: ELECTRON_BACKGROUND_FLAGS,
    hidden: true
  },
  {
    id: 'idle-paused-baseline',
    hash: 'settings',
    note: '空闲静止页（暂停播放、无 stage、无 canvas）：当前 CSS，含整窗封面模糊层与无限动画。' +
      '这一档是「合成器在静止页上花多少」的基准',
    override: null,
    flags: [],
    pause: true
  },
  {
    id: 'idle-paused-no-backdrop',
    hash: 'settings',
    note: '同上，整个封面模糊层 display:none',
    override: css('.shell__backdrop { display: none !important; }'),
    flags: [],
    pause: true
  },
  {
    id: 'idle-paused-no-backdrop-filter',
    hash: 'settings',
    note: '同上，保留封面图层但去掉 blur(76px)：单独量模糊核本身的成本',
    override: css('.shell__backdrop { filter: none !important; }'),
    flags: [],
    pause: true
  },
  {
    id: 'idle-paused-no-animations',
    hash: 'settings',
    note: '同上，暂停所有 CSS 动画',
    override: css('*, *::before, *::after { animation-play-state: paused !important; }'),
    flags: [],
    pause: true
  },
  {
    id: 'idle-paused-reduced-motion',
    hash: 'settings',
    note: '同上，模拟 prefers-reduced-motion: reduce（系统级减少动态效果）',
    override: null,
    flags: [],
    pause: true,
    reducedMotion: true
  },
  {
    id: 'idle-paused-hi-dpi',
    hash: 'settings',
    note: '同上，deviceScaleFactor=2（模拟 200% 显示缩放）：看整窗模糊层的成本是否随像素数走',
    override: null,
    flags: [],
    pause: true,
    scaleFactor: 2
  },
  {
    id: 'idle-paused-hi-dpi-no-backdrop-filter',
    hash: 'settings',
    note: '同上 + 去掉 blur：两条曲线的差就是「模糊在 2x 下的增量」',
    override: css('.shell__backdrop { filter: none !important; }'),
    flags: [],
    pause: true,
    scaleFactor: 2
  },

  /*
   * --- the per-frame question, on screens that actually produce frames -----
   *
   * `idle-paused` above shows fps=0: a static page makes the compositor produce
   * no frames at all, so a blurred layer that never changes costs nothing there
   * and cannot answer "is the blur recomputed every frame". These scenarios keep
   * frames flowing (the preview's synthetic audio driver writes the playhead at
   * 60 Hz) and toggle one declaration at a time.
   */
  {
    id: 'playing-settings-baseline',
    hash: 'settings',
    note: '设置页播放中（封面模糊背景 + 60Hz 进度条写入 + 无 stage）',
    override: null,
    flags: []
  },
  {
    id: 'playing-settings-no-backdrop-filter',
    hash: 'settings',
    note: '同上，去掉 .shell__backdrop 的 blur(76px)：差值即「每帧是否为整窗模糊付钱」',
    override: css('.shell__backdrop { filter: none !important; }'),
    flags: []
  },
  {
    id: 'playing-settings-no-backdrop',
    hash: 'settings',
    note: '同上，整层移除',
    override: css('.shell__backdrop { display: none !important; }'),
    flags: []
  },
  {
    id: 'playing-settings-no-backdrops-anywhere',
    hash: 'settings',
    note: '同上，把全部 backdrop-filter 声明去掉（app.css 2 处 + netease 1 处）',
    override: css(
      '.card__play, .menu, .ne-modal__scrim, .stage-lyric { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }'
    ),
    flags: []
  },
  {
    id: 'songs-playing-baseline',
    hash: 'songs',
    note: '歌曲列表播放中：.eq.is-live 无限动画 + 封面模糊背景 + 60Hz 写入',
    override: null,
    flags: []
  },
  {
    id: 'songs-playing-no-animations',
    hash: 'songs',
    note: '同上，暂停所有 CSS 动画（本屏 eq-bounce 是唯一持续动画）',
    override: css('*, *::before, *::after { animation-play-state: paused !important; }'),
    flags: []
  },
  {
    id: 'songs-playing-no-backdrop-filter',
    hash: 'songs',
    note: '同上，去掉整窗封面模糊',
    override: css('.shell__backdrop { filter: none !important; }'),
    flags: []
  },
  {
    id: 'stage-playing-baseline',
    hash: 'stage',
    note: '舞台播放中（对照，重复之前的基准，用于确认噪声幅度）',
    override: null,
    flags: []
  },
  {
    id: 'stage-playing-no-backdrop',
    hash: 'stage',
    note: '舞台播放中 + 移除整窗封面模糊层：验证「整窗模糊是否每帧都在合成」',
    override: css('.shell__backdrop { display: none !important; }'),
    flags: []
  },

  /*
   * --- who is producing frames on a visually idle screen? ------------------
   *
   * `gpu-screen-inventory.mjs` shows the settings screen runs zero CSS
   * animations, zero `backdrop-filter` elements and a static blurred backdrop,
   * yet the compositor still produces ~60 frames/s while the 8 Hz seek-bar
   * write keeps restarting a 240 ms `width` transition. These scenarios isolate
   * that: if the transition is the frame fuel, freezing it should collapse the
   * frame rate without touching a single visual declaration.
   */
  {
    id: 'idle-paused-no-transitions',
    hash: 'settings',
    note: '空闲静止页 + 冻结所有 CSS 过渡（不改任何观感，只把「永不完成的过渡」停掉）',
    override: css('*, *::before, *::after { transition: none !important; }'),
    flags: [],
    pause: true
  },
  {
    id: 'idle-paused-no-bar-transition-only',
    hash: 'settings',
    note: '空闲静止页 + 只冻结进度条的 width 过渡：定位到具体是哪条过渡在供帧',
    override: css('.bar__fill, .bar__knob { transition: none !important; }'),
    flags: [],
    pause: true
  },
  {
    id: 'idle-paused-no-transitions-no-backdrop-filter',
    hash: 'settings',
    note: '空闲静止页 + 冻结过渡 + 去掉 blur(76px)：整窗模糊在「有帧」时到底值多少',
    override: css(
      '*, *::before, *::after { transition: none !important; } .shell__backdrop { filter: none !important; }'
    ),
    flags: [],
    pause: true
  },
  {
    id: 'idle-paused-no-transitions-no-backdrop',
    hash: 'settings',
    note: '空闲静止页 + 冻结过渡 + 移除整层封面背景：把模糊层拆到最彻底',
    override: css(
      '*, *::before, *::after { transition: none !important; } .shell__backdrop { display: none !important; }'
    ),
    flags: [],
    pause: true
  },
  {
    id: 'playing-settings-no-transitions',
    hash: 'settings',
    note: '播放中 + 冻结所有过渡：8Hz 进度写入不再重启过渡，看帧是否还在产',
    override: css('*, *::before, *::after { transition: none !important; }'),
    flags: []
  },
  {
    id: 'playing-settings-no-transitions-no-backdrop-filter',
    hash: 'settings',
    note: '播放中 + 冻结过渡 + 去掉 blur：这是「触发器掐掉之后」的当前树口径',
    override: css(
      '*, *::before, *::after { transition: none !important; } .shell__backdrop { filter: none !important; }'
    ),
    flags: []
  },

  /*
   * --- the stage's own per-frame paint ------------------------------------
   *
   * `stage.css` puts a window-sized radial-gradient `mask-image` on the visual
   * bed and `app.css` puts a `box-shadow` on the progress fill. Both are
   * per-frame work in a layer that is redrawn 120 times a second, and both are
   * expressed in files this task owns, so they can be tested directly.
   */
  {
    id: 'stage-playing-no-mask',
    hash: 'stage',
    note: '舞台播放中 + 去掉 .viz 的整窗 radial-gradient mask-image：量遮罩合成成本',
    override: css('.viz { mask-image: none !important; -webkit-mask-image: none !important; }'),
    flags: []
  },
  {
    id: 'stage-playing-no-glow',
    hash: 'stage',
    note: '舞台播放中 + 去掉进度条填充的 box-shadow 光晕',
    override: css('.stage__track-fill { box-shadow: none !important; }'),
    flags: []
  },
  {
    id: 'stage-playing-no-mask-no-backdrop',
    hash: 'stage',
    note: '舞台播放中 + 去 mask + 去整窗模糊层：看两项是否叠加',
    override: css(
      '.viz { mask-image: none !important; -webkit-mask-image: none !important; } .shell__backdrop { display: none !important; }'
    ),
    flags: []
  },

  /* --- the transparent desktop-lyric window ------------------------------- */
  {
    id: 'overlay-baseline',
    url: 'aurora-overlay-preview.html',
    note: '桌面歌词浮窗（透明置顶窗口）：当前带 backdrop-filter: blur(14px) saturate(1.2) 的毛玻璃板',
    override: null,
    flags: []
  },
  {
    id: 'overlay-no-backdrop-filter',
    url: 'aurora-overlay-preview.html',
    note: '同上，去掉毛玻璃',
    override: css('.stage-lyric { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }'),
    flags: []
  },
  {
    id: 'overlay-no-backdrop-filter-opaque',
    url: 'aurora-overlay-preview.html',
    note: '同上，去掉毛玻璃并把底板加深（观感取舍方案：用更高的不透明度换掉模糊）',
    override: css(
      '.stage-lyric { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; background: rgb(8 10 12 / 0.62) !important; }'
    ),
    flags: []
  }
]

const only = argValue('only', null)
const wanted = only ? only.split(',').map((s) => s.trim()) : null

function launch(url, port, profileDir, extraFlags) {
  const args = [...baseFlags(port, profileDir), ...extraFlags, url]
  const child = spawn(EDGE_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (c) => {
    stderr += String(c)
  })
  return { child, getStderr: () => stderr, kill: () => killTree(child) }
}

function quantile(sorted, p) {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))]
}

function round(v, d = 2) {
  if (v === null || v === undefined || !Number.isFinite(v)) return null
  const f = 10 ** d
  return Math.round(v * f) / f
}

async function runScenario(spec) {
  assertEdge()
  const port = await freePort()
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `aurora-gpu-${spec.id}-`))
  const url = spec.hash
    ? pathToFileURL(path.join(PREVIEW_DIR, `aurora-preview-${spec.hash}.html`)).href
    : spec.url && spec.url !== 'about:blank'
      ? pathToFileURL(path.join(PREVIEW_DIR, spec.url)).href
      : spec.url
  const edge = launch(url, port, profileDir, spec.flags)
  let cdp = null
  let browserCdp = null
  const notes = []
  try {
    const version = await waitForDevtools(port, { getStderr: edge.getStderr })
    const targets = await listTargets(port)
    const target =
      targets.find((t) => t.type === 'page' && t.url.startsWith('file:')) ??
      targets.find((t) => t.type === 'page')
    if (!target) throw new Error('no page target')

    cdp = await Cdp.connect(target.webSocketDebuggerUrl, { callTimeoutMs: 20000 })
    await cdp.send('Runtime.enable')
    await cdp.send('Performance.enable')
    await cdp.send('Page.enable')
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: EARLY })
    await cdp.send('Page.reload', { ignoreCache: false })
    await sleep(2500)

    // Blank page has no app; nothing to override.
    if (spec.override) {
      const applied = await cdp.eval(
        `(() => { const OVERRIDE = ${spec.override}; return ${STYLE} })()`
      )
      if (!applied) throw new Error('override was not applied')
      await sleep(1200)
    }

    /*
     * Real Windows runs often at 125-200% display scaling, and every one of
     * these layers is sized in CSS pixels while rasterisation happens in device
     * pixels. A cost that scales with the scale factor is a per-frame raster
     * cost; one that does not is a fixed compositing cost.
     */
    if (spec.scaleFactor) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1600,
        height: 1000,
        deviceScaleFactor: spec.scaleFactor,
        mobile: false
      })
      await sleep(1200)
      notes.push(`deviceScaleFactor=${spec.scaleFactor}`)
    }

    if (spec.reducedMotion) {
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
      })
      await sleep(600)
    }

    /*
     * Pause via the app's own transport button: the preview autoplays, so
     * "open the settings screen" is not an idle measurement on its own. The
     * 60 Hz position write driven by the synthetic audio driver keeps the seek
     * bar rewriting inline styles otherwise.
     */
    if (spec.pause) {
      const paused = await cdp.eval(`(() => {
        const button = document.querySelector('button[aria-label="暂停"]') ||
          document.querySelector('button[aria-label="播放"]')
        if (!button) return { clicked: false, reason: 'no transport button' }
        const was = button.getAttribute('aria-label')
        button.click()
        return { clicked: true, was, now: button.getAttribute('aria-label') }
      })()`)
      if (!paused.clicked) notes.push(`pause failed: ${paused.reason}`)
      await sleep(1200)
    }

    try {
      browserCdp = await Cdp.connect(version.webSocketDebuggerUrl, { callTimeoutMs: 10000 })
    } catch (error) {
      notes.push(`browser-level CDP unavailable: ${error.message}`)
    }

    if (spec.hidden) {
      const created = await cdp.send('Target.createTarget', { url: 'about:blank' })
      try {
        await cdp.send('Target.activateTarget', { targetId: created.targetId })
      } catch {
        notes.push('Target.activateTarget unavailable')
      }
      await sleep(1200)
      const vis = await cdp.eval('({hidden: document.hidden, state: document.visibilityState})')
      if (!vis.hidden) notes.push(`page never became hidden: ${JSON.stringify(vis)}`)
    }

    await cdp.eval(WINDOW_START)
    const procBefore = browserCdp ? await readProcessInfo(browserCdp) : null
    const metricsBefore = (await cdp.send('Performance.getMetrics')).metrics
    const wallStart = process.hrtime.bigint()
    await sleep(DURATION)
    const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6
    const procAfter = browserCdp ? await readProcessInfo(browserCdp) : null
    const metricsAfter = (await cdp.send('Performance.getMetrics')).metrics
    const read = await cdp.eval(WINDOW_READ)

    const cpuBefore = sumCpuByType(procBefore)
    const cpuAfter = sumCpuByType(procAfter)
    const byType = {}
    if (cpuBefore && cpuAfter) {
      for (const k of new Set([...Object.keys(cpuBefore.byType), ...Object.keys(cpuAfter.byType)])) {
        byType[k] = round(((cpuAfter.byType[k] ?? 0) - (cpuBefore.byType[k] ?? 0)) * 1000, 1)
      }
    }
    const metric = (name) => {
      const a = metricsAfter.find((m) => m.name === name)?.value
      const b = metricsBefore.find((m) => m.name === name)?.value
      return a === undefined || b === undefined ? null : a - b
    }
    const taskSec = metric('TaskDuration')
    const scriptSec = metric('ScriptDuration')
    const styleSec = metric('RecalcStyleDuration')
    const layoutSec = metric('LayoutDuration')
    // Counts, not durations: "how many times was style recomputed / laid out"
    // says whether an invalidation ran at all, which a duration can hide.
    const styleCount = metric('RecalcStyleCount')
    const layoutCount = metric('LayoutCount')

    return {
      id: spec.id,
      note: spec.note,
      browser: version.Browser,
      override: spec.override,
      visibility: read.hidden ? 'hidden' : 'visible',
      page: {
        frames: read.frameCount,
        spanMs: round(read.spanMs, 1),
        fps: round(read.fps),
        p50: round(read.p50),
        p95: round(read.p95),
        max: round(read.max),
        canvases: read.canvases,
        hasBackdrop: read.hasBackdrop,
        runningAnimations: read.runningAnimations,
        backdropStyle: read.backdropLayerInfo
      },
      mainThread: {
        windowMs: round(wallMs, 1),
        taskMs: taskSec === null ? null : round(taskSec * 1000, 1),
        taskPctOfOneCore: taskSec === null ? null : round((taskSec / (wallMs / 1000)) * 100, 2),
        scriptMs: scriptSec === null ? null : round(scriptSec * 1000, 1),
        styleMs: styleSec === null ? null : round(styleSec * 1000, 1),
        layoutMs: layoutSec === null ? null : round(layoutSec * 1000, 1),
        styleCount,
        layoutCount
      },
      processCpu: cpuBefore && cpuAfter
        ? {
            byTypeMs: byType,
            totalMs: round((cpuAfter.total - cpuBefore.total) * 1000, 1),
            rendererMs: byType.renderer ?? null,
            // Chromium labels this process family 'GPU' (capitalised) in
            // `SystemInfo.getProcessInfo`, unlike the lowercase 'renderer'.
            gpuMs: byType.GPU ?? byType.gpu ?? null,
            browserMs: byType.browser ?? null
          }
        : null,
      notes
    }
  } finally {
    if (cdp) cdp.close()
    if (browserCdp) browserCdp.close()
    await edge.kill()
    try {
      fs.rmSync(profileDir, { recursive: true, force: true })
    } catch {
      /* temp dir */
    }
  }
}

const scenarios = wanted ? SCENARIOS.filter((s) => wanted.includes(s.id)) : SCENARIOS
if (!scenarios.length) throw new Error(`no scenario matched --only=${only}`)

const results = {}
for (const spec of scenarios) {
  const runs = []
  for (let rep = 1; rep <= REPS; rep += 1) {
    process.stdout.write(`[gpu] ${spec.id} rep${rep}/${REPS} ...`)
    try {
      const result = await runScenario(spec)
      runs.push(result)
      console.log(
        ` task ${result.mainThread.taskPctOfOneCore}%  gpu ${result.processCpu?.gpuMs}ms  renderer ${result.processCpu?.rendererMs}ms  fps ${result.page.fps}`
      )
    } catch (error) {
      console.log(` FAILED: ${error.message}`)
    }
  }
  if (!runs.length) {
    results[spec.id] = { id: spec.id, note: spec.note, failed: true }
    continue
  }
  const median = (key) => {
    const values = runs.map(key).filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b)
    return quantile(values, 0.5)
  }
  results[spec.id] = {
    id: spec.id,
    note: spec.note,
    override: spec.override,
    reps: runs.length,
    browser: runs[0].browser,
    visibility: runs[0].visibility,
    fps: round(median((r) => r.page.fps)),
    taskPctOfOneCore: round(median((r) => r.mainThread.taskPctOfOneCore)),
    taskMs: round(median((r) => r.mainThread.taskMs), 1),
    scriptMs: round(median((r) => r.mainThread.scriptMs), 1),
    styleMs: round(median((r) => r.mainThread.styleMs), 1),
    layoutMs: round(median((r) => r.mainThread.layoutMs), 1),
    styleCount: round(median((r) => r.mainThread.styleCount), 0),
    layoutCount: round(median((r) => r.mainThread.layoutCount), 0),
    gpuMs: round(median((r) => r.processCpu?.gpuMs), 1),
    rendererMs: round(median((r) => r.processCpu?.rendererMs), 1),
    browserProcessMs: round(median((r) => r.processCpu?.browserMs), 1),
    totalProcMs: round(median((r) => r.processCpu?.totalMs), 1),
    byTypeMs: runs[0].processCpu?.byTypeMs ?? null,
    backdropStyle: runs[0].page.backdropStyle,
    runningAnimations: runs[0].page.runningAnimations,
    animationTargets: [
      ...new Set(
        runs
          .flatMap((r) => r.page.runningAnimations ?? [])
          .filter((a) => a && a.state === 'running')
          .map((a) => `${a.kind}:${a.name}@${a.target}`)
      )
    ],
    notes: [...new Set(runs.flatMap((r) => r.notes))],
    raw: runs.map((r) => ({
      fps: r.page.fps,
      taskPct: r.mainThread.taskPctOfOneCore,
      gpuMs: r.processCpu?.gpuMs,
      rendererMs: r.processCpu?.rendererMs,
      browserMs: r.processCpu?.browserMs,
      totalMs: r.processCpu?.totalMs
    }))
  }
}

const out = {
  generatedAt: new Date().toISOString(),
  rig: {
    kind: 'headless Edge + CDP, one CSS override per scenario',
    caveat:
      'headless 合成/栅格走软件路径（SwiftShader）。绝对 GPU 进程数字不代表真实窗口的 GPU 开销；' +
      '只有「同一台机器、同一装置、两次运行之间的差值」可解释。',
    durationMs: DURATION,
    reps: REPS,
    cores: os.cpus()?.length ?? null,
    cpu: os.cpus()?.[0]?.model ?? null,
    node: process.version,
    os: `${os.type()} ${os.release()}`
  },
  results
}

const jsonOut = path.join(ROOT, 'docs', 'gpu-composite-probe.json')
fs.writeFileSync(jsonOut, JSON.stringify(out, null, 2), 'utf8')

console.log('')
console.log('id'.padEnd(42) + 'fps'.padStart(7) + 'taskPct'.padStart(9) + 'gpuMs'.padStart(9) + 'rendMs'.padStart(9) + 'totalMs'.padStart(9))
for (const r of Object.values(results)) {
  if (r.failed) {
    console.log(`${r.id.padEnd(42)} FAILED`)
    continue
  }
  console.log(
    `${r.id.padEnd(42)}${String(r.fps).padStart(7)}${String(r.taskPctOfOneCore).padStart(9)}${String(r.gpuMs).padStart(9)}${String(r.rendererMs).padStart(9)}${String(r.totalProcMs).padStart(9)}`
  )
}
console.log('')
console.log(`wrote ${path.relative(ROOT, jsonOut)}`)
