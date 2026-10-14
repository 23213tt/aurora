/**
 * Shared plumbing for the Aurora performance baseline.
 *
 * The baseline has to run on a machine where the Electron window cannot start
 * (process sandbox), so it measures the browser preview build in headless
 * Microsoft Edge and talks to the page over the Chrome DevTools Protocol. Node
 * 24 ships a global `WebSocket`, so the CDP client below needs no dependency.
 *
 * Two rules shape this file:
 *   1. Every wait is bounded. A hidden renderer stops `requestAnimationFrame`
 *      entirely, so a page-side promise that awaits a frame never settles; the
 *      page only ever *stores* samples and Node decides when to read them.
 *   2. Nothing here trusts the page. Counters that do not exist are reported as
 *      missing rather than defaulted to zero.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'

export const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function assertEdge() {
  if (!fs.existsSync(EDGE_PATH)) {
    throw new Error(`Microsoft Edge not found at ${EDGE_PATH}`)
  }
}

/** Ask the OS for a free loopback port. Small race, retried by the caller. */
export async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

/**
 * Flags shared by every scenario.
 *
 * `--headless=new` is deliberate, and it is not the same browser the old
 * `--headless` was: the new headless mode runs a real frame pipeline, so
 * `requestAnimationFrame` fires at the display rate. `--disable-gpu` is
 * deliberately absent - it would force software rasterisation and turn the
 * canvas numbers into an artefact of the flag.
 */
export function baseFlags(port, profileDir) {
  return [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Edge ships built-in component extensions; their background pages burn CPU
    // that would be charged to the scenario.
    '--disable-extensions',
    '--disable-component-update',
    '--enable-precise-memory-info',
    '--window-size=1600,1000',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-sync'
  ]
}

/**
 * Chromium's equivalent of Electron's `backgroundThrottling: false`.
 *
 * The shipped app must keep playing when minimised, so the renderer is exempt
 * from the throttling a normal browser applies to hidden pages. These three
 * switches are what the browser preview needs to resemble that configuration;
 * without them a hidden page is throttled far harder than Aurora ever is.
 */
export const ELECTRON_BACKGROUND_FLAGS = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows'
]

export function launchEdge({ port, url, profileDir, extraFlags = [] }) {
  const args = [...baseFlags(port, profileDir), ...extraFlags, url]
  const child = spawn(EDGE_PATH, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk)
  })
  return {
    child,
    getStderr: () => stderr,
    async kill() {
      await killTree(child)
      try {
        fs.rmSync(profileDir, { recursive: true, force: true })
      } catch {
        /* the profile is in %TEMP%; failing to remove it is not fatal */
      }
    }
  }
}

export async function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) {
    if (child && child.exitCode === null) {
      try {
        spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } catch {
        /* best effort */
      }
    }
    return
  }
  try {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    try {
      child.kill()
    } catch {
      /* best effort */
    }
  }
  // Give Windows a moment to reap the tree before the temp profile is deleted.
  await sleep(300)
}

export async function waitForDevtools(port, { timeoutMs = 20000, getStderr } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'no attempt'
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return await res.json()
      lastError = `HTTP ${res.status}`
    } catch (error) {
      lastError = error.message
    }
    await sleep(150)
  }
  const stderr = getStderr ? getStderr().slice(-1200) : ''
  throw new Error(`DevTools endpoint on port ${port} never answered (${lastError}).\n${stderr}`)
}

export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  return res.json()
}

/**
 * Minimal CDP client: one connection, request/response, per-call timeout.
 *
 * A timeout is not decoration. `Runtime.evaluate` on a backgrounded renderer can
 * sit in a queue for a long time, and an unbounded await would hang the whole
 * report instead of recording a slow scenario.
 */
export class Cdp {
  static async connect(wsUrl, { callTimeoutMs = 15000 } = {}) {
    const client = new Cdp(wsUrl, callTimeoutMs)
    await client.open()
    return client
  }

  constructor(wsUrl, callTimeoutMs) {
    this.wsUrl = wsUrl
    this.callTimeoutMs = callTimeoutMs
    this.id = 0
    this.pending = new Map()
    this.events = []
    this.closed = false
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl)
      this.ws = ws
      const onError = (event) => {
        if (!this.opened) reject(new Error(`websocket failed: ${event.message ?? 'unknown'}`))
      }
      ws.addEventListener('error', onError)
      ws.addEventListener('message', (event) => {
        let message
        try {
          message = JSON.parse(event.data)
        } catch {
          return
        }
        if (message.id && this.pending.has(message.id)) {
          const { resolve: res, reject: rej, timer } = this.pending.get(message.id)
          this.pending.delete(message.id)
          clearTimeout(timer)
          if (message.error) rej(new Error(`${message.error.message} (${message.error.code})`))
          else res(message.result)
          return
        }
        if (message.method) this.events.push(message)
      })
      ws.addEventListener('close', () => {
        this.closed = true
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer)
          entry.reject(new Error('websocket closed'))
        }
        this.pending.clear()
        if (!this.opened) reject(new Error('websocket closed before open'))
      })
      ws.addEventListener('open', () => {
        this.opened = true
        resolve()
      })
    })
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error(`websocket closed; cannot send ${method}`))
    this.id += 1
    const id = this.id
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out after ${this.callTimeoutMs}ms`))
      }, this.callTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify(payload))
    })
  }

  /** Evaluate an expression in the page and return its value. */
  async eval(expression, { timeoutMs } = {}) {
    const previous = this.callTimeoutMs
    if (timeoutMs) this.callTimeoutMs = timeoutMs
    try {
      const result = await this.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: false
      })
      if (result.exceptionDetails) {
        const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
        throw new Error(`page evaluation threw: ${String(text).slice(0, 400)}`)
      }
      return result.result.value
    } finally {
      this.callTimeoutMs = previous
    }
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* already gone */
    }
  }
}

/** Metrics we care about out of `Performance.getMetrics` (renderer main thread). */
export const PERF_METRIC_KEYS = [
  'TaskDuration',
  'ScriptDuration',
  'LayoutDuration',
  'RecalcStyleDuration',
  'Nodes',
  'JSHeapUsedSize',
  'JSHeapTotalSize',
  'JSEventListeners',
  'LayoutCount',
  'RecalcStyleCount',
  'Documents'
]

export async function readPerfMetrics(cdp) {
  try {
    await cdp.send('Performance.enable')
  } catch {
    /* already enabled */
  }
  const { metrics } = await cdp.send('Performance.getMetrics')
  const out = {}
  for (const { name, value } of metrics) out[name] = value
  return out
}

export async function readProcessInfo(cdp) {
  try {
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo')
    return processInfo
  } catch (error) {
    return { error: error.message }
  }
}

/** Chromium cpuTime is seconds of CPU; sum it per process family. */
export function sumCpuByType(processInfo) {
  if (!Array.isArray(processInfo)) return null
  const byType = {}
  let total = 0
  for (const proc of processInfo) {
    const type = proc.type ?? 'unknown'
    byType[type] = (byType[type] ?? 0) + proc.cpuTime
    total += proc.cpuTime
  }
  return { byType, total }
}
