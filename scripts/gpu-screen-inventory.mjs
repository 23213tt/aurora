/**
 * Diagnostic pass: what is actually on each preview screen, and who is drawing.
 *
 * The A/B probe (`scripts/gpu-composite-probe.mjs`) can only attribute cost to a
 * declaration that is really present. A previous round measured "remove the
 * backdrop filter" on a screen where the backdrop element may not have existed,
 * which would report a null result for the wrong reason. This script exists to
 * make that impossible: it prints the elements, their computed styles, the
 * running animations, the DOM-mutation rate and the rAF rate, separately, for
 * each screen.
 *
 *   node scripts/gpu-screen-inventory.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import {
  Cdp,
  assertEdge,
  baseFlags,
  freePort,
  killTree,
  listTargets,
  sleep,
  waitForDevtools
} from './perf-lib.mjs'

const ROOT = path.resolve(import.meta.dirname, '..')
const PREVIEW_DIR = path.join(ROOT, 'preview-dist')
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

const argv = process.argv.slice(2)
const argValue = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const HASHES = (argValue('screens', 'settings,stage,songs,perf') ?? '').split(',').map((s) => s.trim())
const DURATION = Number(argValue('duration', 3000))

const BODY_SELECTOR = 'body'

function launch(url, port, profileDir) {
  const args = [...baseFlags(port, profileDir), url]
  const child = spawn(EDGE_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (c) => {
    stderr += String(c)
  })
  return { child, getStderr: () => stderr, kill: () => killTree(child) }
}

const INSPECT = `(() => {
  const el = document.querySelector('.shell__backdrop')
  const cs = el ? getComputedStyle(el) : null
  const shell = document.querySelector('.shell')
  const shellBefore = shell ? getComputedStyle(shell, '::before') : null
  const filterUsers = []
  for (const node of document.querySelectorAll('*')) {
    const s = getComputedStyle(node)
    const bf = s.backdropFilter || s.webkitBackdropFilter
    if (bf && bf !== 'none') {
      const cls = typeof node.className === 'string' && node.className.trim()
        ? '.' + node.className.trim().split(/\\s+/).slice(0, 2).join('.')
        : ''
      filterUsers.push({ sel: node.tagName.toLowerCase() + cls, backdropFilter: bf, filter: s.filter })
    }
  }
  const animated = []
  for (const node of document.querySelectorAll('*')) {
    const s = getComputedStyle(node)
    if (s.animationName && s.animationName !== 'none' && s.animationPlayState === 'running') {
      const cls = typeof node.className === 'string' && node.className.trim()
        ? '.' + node.className.trim().split(/\\s+/).slice(0, 2).join('.')
        : ''
      animated.push(node.tagName.toLowerCase() + cls + ' {' + s.animationName + ' ' + s.animationDuration + '}')
    }
  }
  return {
    url: location.href.split('/').pop(),
    hash: location.hash,
    backdropPresent: !!el,
    backdropStyle: cs ? { filter: cs.filter, opacity: cs.opacity, willChange: cs.willChange, display: cs.display, size: el.getBoundingClientRect().width + 'x' + el.getBoundingClientRect().height } : null,
    shellBefore: shellBefore ? { background: shellBefore.background.slice(0, 80), opacity: shellBefore.opacity } : null,
    canvasCount: document.querySelectorAll('canvas').length,
    canvasSize: [...document.querySelectorAll('canvas')].map((c) => c.width + 'x' + c.height),
    animationsRunning: animated,
    documentAnimations: (() => { try { return document.getAnimations().length } catch (e) { return 'error' } })(),
    backdropFilters: filterUsers,
    totalFilters: [...document.querySelectorAll('*')].filter((n) => {
      const f = getComputedStyle(n).filter
      return f && f !== 'none'
    }).map((n) => {
      const cls = typeof n.className === 'string' && n.className.trim()
        ? '.' + n.className.trim().split(/\\s+/).slice(0, 2).join('.')
        : ''
      return n.tagName.toLowerCase() + cls + ' {' + getComputedStyle(n).filter + '}'
    }),
    nodes: document.getElementsByTagName('*').length,
    htmlClass: document.documentElement.className
  }
})()`

async function probeScreen(hash) {
  assertEdge()
  const port = await freePort()
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), `aurora-inv-${hash}-`))
  const url = pathToFileURL(path.join(PREVIEW_DIR, `aurora-preview-${hash}.html`)).href
  const edge = launch(url, port, profileDir)
  let cdp = null
  try {
    await waitForDevtools(port, { getStderr: edge.getStderr })
    const targets = await listTargets(port)
    const target = targets.find((t) => t.type === 'page' && t.url.startsWith('file:')) ?? targets[0]
    cdp = await Cdp.connect(target.webSocketDebuggerUrl, { callTimeoutMs: 20000 })
    await cdp.send('Runtime.enable')
    await sleep(3000)

    const before = await cdp.eval(`(() => { window.__inv = { mutations: 0, attrs: {} }; new MutationObserver((rs) => { window.__inv.mutations += rs.length; for (const r of rs) { const el = r.target.nodeType === 3 ? r.target.parentElement : r.target; const cls = el && typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : ''; const key = (el ? el.tagName.toLowerCase() : '?') + cls + ':' + r.type + (r.attributeName ? '[' + r.attributeName + ']' : ''); window.__inv.attrs[key] = (window.__inv.attrs[key] || 0) + 1 } }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true }); window.__inv.raf = 0; const loop = () => { window.__inv.raf++; requestAnimationFrame(loop) }; requestAnimationFrame(loop); return true })()`)
    const t0 = Date.now()
    await sleep(DURATION)
    const spanMs = Date.now() - t0
    const after = await cdp.eval(`(() => ({ mutations: window.__inv.mutations, perSecond: window.__inv.mutations / ${spanMs} * 1000, attrs: Object.entries(window.__inv.attrs).sort((a,b) => b[1]-a[1]).slice(0, 8), raf: window.__inv.raf, rafFps: window.__inv.raf / ${spanMs} * 1000 }))()`)
    const inventory = await cdp.eval(INSPECT)
    return { hash, inventory, mutations: after, hidden: await cdp.eval('document.hidden') }
  } finally {
    if (cdp) cdp.close()
    await edge.kill()
    try {
      fs.rmSync(profileDir, { recursive: true, force: true })
    } catch {
      /* temp */
    }
  }
}

const out = {}
for (const hash of HASHES) {
  process.stdout.write(`[inv] ${hash} ...`)
  try {
    out[hash] = await probeScreen(hash)
    const inv = out[hash].inventory
    console.log(
      ` backdrop=${inv.backdropPresent} filter=${inv.backdropStyle?.filter ?? '-'} canvas=${inv.canvasCount} anims=${inv.animationsRunning.length} rafFps=${out[hash].mutations.rafFps.toFixed(1)} mut/s=${out[hash].mutations.perSecond.toFixed(1)}`
    )
  } catch (error) {
    console.log(` FAILED: ${error.message}`)
    out[hash] = { failed: true, error: error.message }
  }
}

const jsonOut = path.join(ROOT, 'docs', 'gpu-screen-inventory.json')
fs.writeFileSync(jsonOut, JSON.stringify(out, null, 2), 'utf8')
console.log('')
console.log(JSON.stringify(out, null, 2))
console.log(`wrote ${path.relative(ROOT, jsonOut)}`)
