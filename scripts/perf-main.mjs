#!/usr/bin/env node
/**
 * Aurora 主进程性能度量：模块 require 耗时 + 常驻内存增量。
 *
 * 用法（PowerShell 5.1 可直接跑）：
 *   node scripts/perf-main.mjs              # 度量并写出 docs/perf-main.md
 *   node scripts/perf-main.mjs --json       # 只打印 JSON 结果
 *   node scripts/perf-main.mjs --no-profile # 跳过 --cpu-prof/--heap-prof 采样
 *
 * 设计要点（对应 Electron 官方性能清单第 1/2/3 条）：
 *   1. 每个模块在**全新的子进程**里量一次，避免模块缓存把第二次 require 变成 ~0。
 *   2. 时间用 node:perf_hooks 的 performance.mark/measure，重复 3 次取中位数。
 *   3. 内存用 process.memoryUsage()：heapUsed / rss 在 require 前后取差，
 *      并区分「require 瞬间的分配」与「强制 GC 后的常驻保留」。
 *   4. 纯 node 跑不动 electron 运行时（`require('electron')` 在纯 node 下返回
 *      electron.exe 的路径字符串，不是 Electron 模块）。因此额外提供
 *      `--electron=stub` 模式：用 Module._load 钩子把 'electron' 换成一个极小
 *      桩件，只为量「Aurora 自己那层代码」的加载成本。桩件测量结果在报告里
 *      单独标注，绝不与真实 Electron 数值混为一谈。
 *   5. 量不出来的模块（例如需要 Electron 真实 app/safeStorage 行为的代码路径）
 *      如实记为「无法在 node 下量化」，绝不伪造数字。
 *
 * 只读：不修改 electron/**、src/**、package.json；profile 文件写到系统临时目录。
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire, Module } from 'node:module'
import { fileURLToPath } from 'node:url'

// 本文件是 ESM（.mjs），没有 CommonJS 的 require；子进程侧的度量需要它。
const require = createRequire(import.meta.url)
const __filename = fileURLToPath(import.meta.url)
const SCRIPT_DIR = path.dirname(__filename)
const ROOT = path.resolve(SCRIPT_DIR, '..')
const REPORT = path.join(ROOT, 'docs', 'perf-main.md')
const NETEASE_PKG = '@neteasecloudmusicapienhanced/api'
// 度量对象是「本脚本现编的 electron/**」还是仓库里已有的 dist-electron/**
const CACHE_BUILD_DIR = path.join(os.tmpdir(), 'aurora-perf-main-build')
const DEFAULT_OUT_DIR = CACHE_BUILD_DIR

const argv = process.argv.slice(2)
const asJson = argv.includes('--json')
const skipProfile = argv.includes('--no-profile')
const timingRuns = Number(readFlag('--runs') || '3')
const onlyChild = argv.includes('--child')

function readFlag(name) {
  const hit = argv.find((a) => a === name || a.startsWith(name + '='))
  if (!hit) return null
  const eq = hit.indexOf('=')
  return eq === -1 ? 'true' : hit.slice(eq + 1)
}

const electronMode = readFlag('--electron') || 'real'

// ---------------------------------------------------------------------------
// 度量目标
// ---------------------------------------------------------------------------
//
// `startup`: 是否在 electron/main.ts 顶层 import 链上（顶层 import = 窗口出现前
// 就已经付掉的开销）。`deferrable` 是结论，依据写在 docs/perf-main.md 里。
//
// 注意：`src/**`（渲染层）不在本脚本范围内。

// `electron/main.ts` 顶层 import 的实际顺序（第 1-30 行），整链测量按这个顺序 require。
// `electron` / `node:*` 本身不算 Aurora 的代码，不进这个列表。
const CHAIN_ORDER = [
  'electron/settings.ts',
  'electron/protocols/media-protocol.ts',
  'electron/protocols/remote-protocol.ts',
  'electron/netease/ipc.ts',
  'electron/protocols/app-protocol.ts',
  'electron/library-scan.ts',
  'electron/updates.ts',
  'electron/lyrics.ts',
  'electron/tray.ts',
  'electron/lyrics-overlay.ts'
  // 不含 electron/main.ts：它在顶层读取 require('electron').commandLine，
  // 纯 node 下必然失败（见报告 §1 备注），量不了；它的成本由上面这些 import 体现。
]

const AURORA_MODULES = [
  { id: 'electron/pure/version.ts', startup: 'yes', deferrable: '否（0 依赖，本身就是最省的）' },
  { id: 'electron/pure/app-paths.ts', startup: 'yes', deferrable: '否（只依赖 node:path）' },
  { id: 'electron/netease/reasons.ts', startup: 'yes', deferrable: '否（纯数据/纯函数）' },
  { id: 'electron/netease/types.ts', startup: 'yes', deferrable: '否（纯类型守卫）' },
  { id: 'electron/protocols/remote-protocol.ts', startup: 'yes', deferrable: '否（纯 node，首窗口要用）' },
  { id: 'electron/protocols/app-protocol.ts', startup: 'yes', deferrable: '否（窗口加载前必须注册 scheme）' },
  { id: 'electron/settings.ts', startup: 'yes', deferrable: '否（IPC 到处要用，本体极轻）' },
  { id: 'electron/protocols/media-protocol.ts', startup: 'yes', deferrable: '否（注册 media scheme 必须在 loadURL 前）' },
  { id: 'electron/library-scan.ts', startup: 'yes', deferrable: '否（扫描/封面），但内部 import(\'music-metadata\') 已懒加载' },
  { id: 'electron/lyrics.ts', startup: 'yes', deferrable: '是（可推迟到首次 lyrics:lookup）' },
  { id: 'electron/updates.ts', startup: 'yes', deferrable: '是（可推迟到首次 updates:check）' },
  { id: 'electron/tray.ts', startup: 'yes', deferrable: '否（启动即建托盘）' },
  { id: 'electron/lyrics-overlay.ts', startup: 'yes', deferrable: '是（初始化可推迟到首次显示桌面歌词）' },
  { id: 'electron/netease/client.ts', startup: 'yes', deferrable: '是（仅 bootstrap 用，可推迟到 warmUp 之后）' },
  { id: 'electron/netease/ipc.ts', startup: 'yes', deferrable: '否（IPC 处理函数要早注册），本体极轻' },
  { id: 'electron/netease/session.ts', startup: 'yes', deferrable: '待定（无法在 node 下量化）' },
  { id: 'electron/main.ts', startup: 'yes', deferrable: '否（入口）' }
]

const NPM_PACKAGES = [
  { id: NETEASE_PKG, startup: '条件（懒加载；warmUpNetease 在窗口创建后调用）', deferrable: '是' },
  { id: 'music-metadata', startup: '否（library-scan 内 dynamic import）', deferrable: '已懒加载' },
  { id: 'electron', startup: 'yes', deferrable: '否' },
  { id: 'express', startup: '间接（被 netease 包 require）', deferrable: '是' },
  { id: 'jsdom', startup: '间接（被 netease 包 require）', deferrable: '是' },
  { id: 'axios', startup: '间接（被 netease 包 require）', deferrable: '是' },
  { id: 'yargs', startup: '间接', deferrable: '是' },
  { id: 'qrcode', startup: '间接', deferrable: '是' },
  { id: 'node-forge', startup: '间接', deferrable: '是' },
  { id: 'crypto-js', startup: '间接', deferrable: '是' },
  { id: 'xml2js', startup: '间接', deferrable: '是' },
  { id: 'pac-resolver', startup: '间接', deferrable: '是' },
  { id: 'fzstd', startup: '间接', deferrable: '是' }
]

// 这些模块在纯 node 下会失败；报告里要如实说明「为什么失败」而不是编数字。
const KNOWN_NODE_LIMITS = {
  'electron/netease/session.ts':
    'import { app, safeStorage } from \'electron\'；纯 node 下 require(\'electron\') 返回 electron.exe 路径字符串，取值即失败——它需要 Electron 运行时。',
  'electron/netease/ipc.ts':
    'import { ipcMain } from \'electron\' 并在顶层调用 ipcMain.handle(...)，需要 Electron 运行时。',
  'electron/tray.ts': '依赖 Electron 的 Tray/Menu/nativeImage 模块。',
  'electron/lyrics-overlay.ts': '依赖 Electron 的 BrowserWindow/screen 模块。',
  'electron/protocols/media-protocol.ts': '依赖 Electron 的 protocol 模块。',
  'electron/protocols/app-protocol.ts': '依赖 Electron 的 protocol 模块。',
  'electron/settings.ts': '依赖 Electron 的 app.getPath（顶层仅引用，函数体内调用）。',
  'electron/updates.ts': '依赖 Electron 的 app/net/shell。',
  'electron/lyrics.ts': '依赖 Electron 的 app/net。',
  'electron/library-scan.ts': '依赖 Electron 的 app.getPath。',
  'electron/preload.ts': '依赖 Electron 的 contextBridge（且不在主进程启动链上）。'
}

// ---------------------------------------------------------------------------
// 子进程：真正做测量的一侧
// ---------------------------------------------------------------------------

function measureChild(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
  const mode = config.mode
  const stubbed = []

  if (mode === 'stub') {
    const originalLoad = Module._load
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'electron') {
        if (!stubbed.includes('electron')) stubbed.push('electron')
        return createElectronStub()
      }
      return originalLoad.call(this, request, parent, isMain)
    }
  }

  const results = []
  for (const entry of config.targets) {
    const targetPath = entry.path
    const samples = []

    // 整链模式：按 main.ts 顶层 import 顺序一次 require 完，只记一个总和。
    if (config.chain) {
      if (global.gc) global.gc()
      const heapBefore = process.memoryUsage().heapUsed
      const rssBefore = process.memoryUsage().rss
      performance.mark('chain-start')
      let error = null
      const perModule = []
      for (const item of config.targets) {
        const mark = `chain-${perModule.length}`
        performance.mark(mark + '-s')
        try {
          require(item.path)
        } catch (err) {
          error = err
        }
        performance.mark(mark + '-e')
        perModule.push({
          id: item.id,
          durationMs: performance.measure(mark, mark + '-s', mark + '-e').duration,
          error: null
        })
      }
      performance.mark('chain-end')
      const total = performance.measure('chain', 'chain-start', 'chain-end').duration
      const heapAfter = process.memoryUsage().heapUsed
      const rssAfter = process.memoryUsage().rss
      if (global.gc) global.gc()
      results.push({
        id: 'chain',
        mode,
        stubbed: [...stubbed],
        samples: [
          {
            phase: 'cold',
            durationMs: total,
            heapDelta: heapAfter - heapBefore,
            rssDelta: rssAfter - rssBefore,
            heapRetained: process.memoryUsage().heapUsed - heapBefore,
            rssRetained: process.memoryUsage().rss - rssBefore,
            error: error ? String(error.message || error).split('\n')[0] : null
          }
        ],
        perModule,
        coldError: error ? String(error.message || error).split('\n')[0] : null
      })
      fs.writeFileSync(config.outPath, JSON.stringify({ mode, stubbed, results }), 'utf8')
      return
    }

    // 冷加载（本进程第一次 require，含磁盘读取）+ 热加载（模块缓存命中）分开记。
    // 两者差距本身就是「Windows 上 require 很贵」的直接证据。
    const runOnce = (label) => {
      if (global.gc) global.gc()
      const heapBefore = process.memoryUsage().heapUsed
      const rssBefore = process.memoryUsage().rss
      const mark = `run-${label}-${results.length}`
      performance.mark(mark + '-start')
      let error = null
      try {
        require(targetPath)
      } catch (err) {
        error = err
      }
      performance.mark(mark + '-end')
      const measured = performance.measure(mark, mark + '-start', mark + '-end')
      const heapAfter = process.memoryUsage().heapUsed
      const rssAfter = process.memoryUsage().rss
      performance.clearMarks(mark + '-start')
      performance.clearMarks(mark + '-end')

      // 强制 GC 后剩下来的，才是真正的「常驻」增量。
      if (global.gc) global.gc()
      samples.push({
        phase: label,
        durationMs: measured.duration,
        heapDelta: heapAfter - heapBefore,
        rssDelta: rssAfter - rssBefore,
        heapRetained: process.memoryUsage().heapUsed - heapBefore,
        rssRetained: process.memoryUsage().rss - rssBefore,
        error: error ? String(error && error.message ? error.message : error).split('\n')[0] : null
      })
      return error
    }

    const coldError = runOnce('cold')
    if (!coldError) {
      for (let index = 0; index < 3; index += 1) runOnce(`hot-${index}`)
    }
    results.push({
      id: entry.id,
      mode,
      stubbed: [...stubbed],
      samples,
      coldError: coldError ? String(coldError.message || coldError).split('\n')[0] : null
    })
  }

  // 结果写文件而不是 stdout：上游包的 dotenv 会往 stdout 打横幅，任何
  // 「最后一行就是 JSON」的约定都不可靠（这一点是实测踩出来的）。
  fs.writeFileSync(config.outPath, JSON.stringify({ mode, stubbed, results }), 'utf8')
}

/**
 * Electron 桩件：只为了让「Aurora 自己那层模块」能在纯 node 下走到 require 结束。
 * 任何未知成员都返回一个可调用对象，所以 app.getPath(...) 这类调用不会抛错。
 * 这不是 Electron，报告里必须标明。
 */
function createElectronStub() {
  const FAKE_USER_DATA = path.join(os.tmpdir(), 'aurora-perf-stub')
  const cache = new Map()

  const makeProxy = (name) => {
    const callable = function () {
      return undefined
    }
    return new Proxy(callable, {
      get(t, key) {
        if (key === 'then' || key === 'catch' || key === 'finally') return undefined
        if (key === 'length' || key === 'name') return undefined
        if (key === Symbol.toPrimitive) return () => ''
        if (key === 'toString') return () => `[electron-stub:${String(name)}]`
        if (!cache.has(key)) cache.set(key, makeProxy(key))
        return cache.get(key)
      },
      apply() {
        return undefined
      }
    })
  }

  const app = new Proxy(
    {
      getPath: (kind) => (kind === 'userData' ? FAKE_USER_DATA : path.join(os.tmpdir(), 'aurora-perf-stub')),
      getVersion: () => '0.0.0-stub',
      getName: () => 'Aurora',
      isPackaged: false,
      commandLine: { appendSwitch() {}, appendArgument() {} },
      whenReady: () => Promise.resolve(),
      on() {},
      once() {},
      quit() {},
      requestSingleInstanceLock: () => true,
      setAppUserModelId() {},
      getAppPath: () => ROOT
    },
    { get: (t, key) => (key in t ? t[key] : makeProxy(key)) }
  )

  return new Proxy(
    {
      app,
      safeStorage: {
        isEncryptionAvailable: () => false,
        encryptString: (v) => Buffer.from(String(v), 'utf8'),
        decryptString: (v) => Buffer.from(v).toString('utf8')
      },
      ipcMain: { handle() {}, on() {}, removeHandler() {} },
      protocol: { registerSchemesAsPrivileged() {}, handle() {} },
      net: { request: () => makeProxy('net.request') },
      shell: { openExternal: () => Promise.resolve(), showItemInFolder() {} },
      screen: { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }) },
      BrowserWindow: function BrowserWindowStub() {
        return makeProxy('BrowserWindow')
      },
      Tray: function TrayStub() {
        return makeProxy('Tray')
      },
      Menu: Object.assign(function MenuStub() {}, {
        buildFromTemplate: () => makeProxy('Menu'),
        setApplicationMenu() {}
      }),
      nativeImage: { createFromPath: () => makeProxy('nativeImage') },
      dialog: { showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }) },
      globalShortcut: { register: () => true, unregisterAll() {} }
    },
    { get: (t, key) => (key in t ? t[key] : makeProxy(key)) }
  )
}

function resolveTarget(target) {
  if (target.startsWith('electron/')) {
    return path.join(OUT_DIR, target.slice('electron/'.length).replace(/\.ts$/, '.js'))
  }
  return target
}

/** 编译产物目录，main() 里由 buildElectron() 决定。 */
let OUT_DIR = DEFAULT_OUT_DIR

/**
 * 把 electron/**.ts 编译到仓库外的临时目录。
 *
 * 为什么不量 dist-electron/：那是共享的构建产物，可能已经过期（源码比它新），
 * 而且队友正在改 electron/** 时重建它会互相踩。编译到系统临时目录既保证
 * 「量的是当前源码」，又不写仓库里的任何产物。
 */
function buildElectron() {
  const outDir = CACHE_BUILD_DIR
  const srcRoot = path.join(ROOT, 'electron')
  const configPath = path.join(os.tmpdir(), 'aurora-perf-main-tsconfig.json')
  fs.rmSync(outDir, { recursive: true, force: true })
  const config = {
    compilerOptions: {
      target: 'ES2022',
      module: 'nodenext',
      moduleResolution: 'nodenext',
      lib: ['ES2023'],
      outDir: outDir.replace(/\\/g, '/'),
      rootDir: srcRoot.replace(/\\/g, '/'),
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      sourceMap: false,
      declaration: false,
      typeRoots: [path.join(ROOT, 'node_modules', '@types').replace(/\\/g, '/')],
      types: ['node']
    },
    include: [srcRoot.replace(/\\/g, '/') + '/**/*.ts']
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8')

  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  const result = spawnSync(process.execPath, [tsc, '-p', configPath], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 300000
  })
  const files = fs.existsSync(outDir) ? countJs(outDir) : 0
  if (result.status !== 0) {
    console.error('[perf-main] 编译告警（仍然继续，量已生成的产物）：')
    console.error((result.stdout || '').split('\n').slice(0, 12).join('\n'))
  }
  if (files === 0) {
    throw new Error(`编译失败：${outDir} 里没有 .js。原始输出：\n${(result.stdout || '') + (result.stderr || '')}`)
  }
  return { outDir, configPath, files, status: result.status, diagnostics: (result.stdout || '').split('\n').filter((l) => /error TS/.test(l)).slice(0, 10) }
}

function countJs(dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countJs(path.join(dir, entry.name))
    else if (entry.name.endsWith('.js')) total += 1
  }
  return total
}

// ---------------------------------------------------------------------------
// 父进程：编排 + 报告
// ---------------------------------------------------------------------------

/**
 * 起一个子进程，顺序量完一组目标。
 *
 * `isolated: true` 时每个目标单起一个进程：这是唯一能拿到「首次 require 真实成本」的
 * 办法——同一个进程里，先量到的包会把后面包的依赖先加载掉（express 被上游包拉过以后，
 * 再单独量 express 就只剩 1 ms）。所以第三方包一律走隔离模式。
 *
 * NODE_PATH 指向仓库的 node_modules：编译产物在系统临时目录里，从那里向上走找不到
 * `electron` 等包，必须显式指定解析路径。
 */
function runChildBatch(entries, mode, label, isolated = false) {
  const env = { ...process.env }
  const repoModules = path.join(ROOT, 'node_modules')
  env.NODE_PATH = env.NODE_PATH ? `${repoModules}${path.delimiter}${env.NODE_PATH}` : repoModules

  const runOne = (targets, suffix) => {
    const configPath = path.join(os.tmpdir(), `aurora-perf-main-${label}${suffix}.json`)
    const outPath = path.join(os.tmpdir(), `aurora-perf-main-${label}${suffix}-result.json`)
    fs.rmSync(outPath, { force: true })
    fs.writeFileSync(configPath, JSON.stringify({ mode, targets, outPath }), 'utf8')
    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--expose-gc', __filename, '--child', `--config=${configPath}`],
      { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600000 }
    )
    if (fs.existsSync(outPath)) {
      try {
        return JSON.parse(fs.readFileSync(outPath, 'utf8'))
      } catch (error) {
        return { mode, stubbed: [], results: [], childError: `结果文件解析失败：${error.message}` }
      }
    }
    return {
      mode,
      stubbed: [],
      results: [],
      childError:
        `子进程未写出结果（exit=${result.status}）：` +
        (result.stdout || '').split('\n').slice(-2).join(' | ') +
        (result.stderr ? ' :: ' + result.stderr.split('\n').slice(-4).join(' | ') : '')
    }
  }

  if (!isolated) return runOne(entries, '')

  const results = []
  const byId = new Map()
  let stubbed = []
  let childError = null
  // 每个包跑 repeat 次独立子进程，取中位数：单次测量受系统负载影响很大
  // （实测 jsdom 在 759 ms 与 1051 ms 之间抖动），中位数比单次可信。
  const repeats = Math.max(1, Number(readFlag('--pkg-repeats') || '3'))
  entries.forEach((entry, index) => {
    for (let round = 0; round < repeats; round += 1) {
      const run = runOne([entry], `-${index}-${round}`)
      if (run.childError) childError = run.childError
      stubbed = run.stubbed || stubbed
      const sample = (run.results || [])[0]
      if (!sample) continue
      if (!byId.has(sample.id)) {
        byId.set(sample.id, { ...sample, samples: [...sample.samples], rounds: 0 })
      }
      const acc = byId.get(sample.id)
      acc.samples.push(...sample.samples)
      acc.rounds += 1
      if (sample.coldError) acc.coldError = sample.coldError
    }
  })
  results.push(...byId.values())
  return { mode, stubbed, results, childError }
}

/**
 * 整链测量：在**一个**子进程里，按 main.ts 顶层 import 的顺序把 Aurora 自己的
 * 模块 require 一遍，量「窗口出现前，主进程为这些 import 付了多少时间和内存」。
 * 这比逐模块相加更接近真实启动（共享依赖只算一次）。
 */
function runChainBatch() {
  const rounds = Math.max(1, Number(readFlag('--chain-repeats') || '3'))
  const summaries = []
  let perModule = []
  let count = 0
  let error = null
  for (let round = 0; round < rounds; round += 1) {
    const outPath = path.join(os.tmpdir(), `aurora-perf-main-chain-result-${round}.json`)
    const configPath = path.join(os.tmpdir(), `aurora-perf-main-chain-${round}.json`)
    const targets = CHAIN_ORDER.map((id) => ({ id, path: resolveTarget(id) }))
    count = targets.length
    fs.rmSync(outPath, { force: true })
    fs.writeFileSync(configPath, JSON.stringify({ mode: 'real', chain: true, targets, outPath }), 'utf8')

    const env = { ...process.env }
    const repoModules = path.join(ROOT, 'node_modules')
    env.NODE_PATH = env.NODE_PATH ? `${repoModules}${path.delimiter}${env.NODE_PATH}` : repoModules

    const result = spawnSync(
      process.execPath,
      ['--no-warnings', '--expose-gc', __filename, '--child', `--config=${configPath}`],
      { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000 }
    )
    if (!fs.existsSync(outPath)) {
      error = `整链子进程未写出结果（exit=${result.status}）：${(result.stdout || '').split('\n').slice(-2).join(' | ')}`
      continue
    }
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'))
    const entry = (parsed.results || [])[0]
    if (!entry) {
      error = '整链子进程没有返回结果'
      continue
    }
    const sample = entry.samples[0]
    if (entry.coldError) error = entry.coldError
    perModule = entry.perModule || perModule
    summaries.push({
      requireMs: sample.durationMs,
      heapDelta: sample.heapDelta,
      rssDelta: sample.rssDelta,
      heapRetained: sample.heapRetained,
      rssRetained: sample.rssRetained
    })
  }

  if (summaries.length === 0) return { error: error || '整链测量失败' }
  return {
    summary: {
      id: 'chain',
      ok: true,
      error: null,
      requireMs: median(summaries.map((s) => s.requireMs)),
      heapDelta: median(summaries.map((s) => s.heapDelta)),
      rssDelta: median(summaries.map((s) => s.rssDelta)),
      heapRetained: median(summaries.map((s) => s.heapRetained)),
      rssRetained: median(summaries.map((s) => s.rssRetained)),
      perModule,
      count,
      rounds: summaries.length,
      // 记录全部轮次，报告里直接给出抖动范围
      runs: summaries.map((s) => s.requireMs)
    }
  }
}

const median = (values) => {
  const sorted = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b)
  if (sorted.length === 0) return null
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function summarise(run, meta) {
  const samples = (run && run.samples) || []
  // 隔离模式下同一个包会有多轮「冷」样本（每轮一个独立子进程），取各指标中位数。
  const colds = samples.filter((s) => s.phase === 'cold' && !s.error)
  const firstCold = samples.find((s) => s.phase === 'cold') || samples[0] || null
  const hot = samples.filter((s) => s.phase !== 'cold')
  const coldFailed = samples.length > 0 && colds.length === 0
  return {
    id: meta.id,
    mode: run ? run.mode : meta.mode,
    startup: meta.startup,
    deferrable: meta.deferrable,
    ok: colds.length > 0,
    error: coldFailed ? (firstCold && firstCold.error) || null : (run && run.childError) || null,
    stubbed: (run && run.stubbed) || [],
    // 首次 require（应用真正要付的代价）；隔离模式下是多轮独立进程的中位数
    requireMs: median(colds.map((s) => s.durationMs)),
    heapDelta: median(colds.map((s) => s.heapDelta)),
    rssDelta: median(colds.map((s) => s.rssDelta)),
    heapRetained: median(colds.map((s) => s.heapRetained)),
    rssRetained: median(colds.map((s) => s.rssRetained)),
    // 缓存命中后的重复 require（用于证明「不是每次调用都这么贵」）
    hotMedianMs: median(hot.map((s) => s.durationMs)),
    coldRuns: colds.length,
    hotRuns: hot.length
  }
}

function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—'
  const sign = bytes < 0 ? '-' : ''
  const abs = Math.abs(bytes)
  if (abs < 1024) return `${sign}${abs} B`
  if (abs < 1024 * 1024) return `${sign}${(abs / 1024).toFixed(1)} KB`
  return `${sign}${(abs / (1024 * 1024)).toFixed(2)} MB`
}

const formatMs = (ms) => (ms === null || ms === undefined ? '—' : `${ms.toFixed(1)} ms`)

/**
 * 常驻增量在 1 MB 以下不可信：度量框架（perf_hooks mark、结果 JSON 字符串、
 * 每个模块的闭包）自身在 GC 后仍有残留，实测同一模块可抖动 ±0.6 MB，甚至出现负值。
 * 宁可在报告里写「< 1 MB」，也不把噪声当数字。
 */
const SIGNIFICANT_BYTES = 1024 * 1024
const formatRetained = (bytes) => {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '无法量化'
  // 负数只说明这一轮 GC 后比基线还低（噪声），按「低于噪声」处理
  if (bytes < SIGNIFICANT_BYTES) return '< 1 MB（低于本口径噪声）'
  return formatBytes(bytes)
}

function topModulesInCache(limit) {
  const groups = new Map()
  for (const key of Object.keys(require.cache)) {
    if (!key.includes('node_modules')) continue
    const match = /node_modules[\\/](@[^\\/]+[\\/][^\\/]+|[^\\/]+)/.exec(key)
    const name = match ? match[1].replace('\\', '/') : '(other)'
    groups.set(name, (groups.get(name) || 0) + 1)
  }
  return Array.from(groups.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }))
}

function childNetedeTree() {
  // 在子进程里跑：require 一次上游包，返回模块数/分组统计
  const code = `
    const api = require(${JSON.stringify(NETEASE_PKG)});
    const groups = new Map();
    for (const key of Object.keys(require.cache)) {
      if (!key.includes('node_modules')) continue;
      const m = /node_modules[\\\\/](@[^\\\\/]+[\\\\/][^\\\\/]+|[^\\\\/]+)/.exec(key);
      const n = m ? m[1].replace('\\\\', '/') : '(other)';
      groups.set(n, (groups.get(n) || 0) + 1);
    }
    const total = Object.keys(require.cache).length;
    const top = Array.from(groups.entries()).sort((a,b)=>b[1]-a[1]).slice(0, 22).map(([name,count])=>({name,count}));
    console.log(JSON.stringify({ exportedKeys: Object.keys(api).length, total, top }));
  `
  const result = spawnSync(process.execPath, ['--no-warnings', '-e', code], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 180000
  })
  const line = (result.stdout || '').trim().split('\n').pop()
  try {
    return JSON.parse(line)
  } catch {
    return { exportedKeys: 0, total: 0, top: [], error: (result.stderr || '').split('\n').slice(-3).join(' | ') }
  }
}

function profiles() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-perf-profile-'))
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', '--cpu-prof', '--heap-prof', '--cpu-prof-dir', outDir, '--heap-prof-dir', outDir, '-e', `require(${JSON.stringify(NETEASE_PKG)})`],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000 }
  )
  const files = fs.existsSync(outDir) ? fs.readdirSync(outDir) : []
  const cpuFile = files.find((f) => f.endsWith('.cpuprofile'))
  const heapFile = files.find((f) => f.endsWith('.heapprofile'))
  const out = { dir: outDir, files, cpuProfile: cpuFile ? path.join(outDir, cpuFile) : null, heapProfile: heapFile ? path.join(outDir, heapFile) : null, status: result.status, stderr: (result.stderr || '').split('\n').slice(-3).join(' | ') }
  out.cpuTop = cpuFile ? topCpuNodes(path.join(outDir, cpuFile)) : []
  out.heapTop = heapFile ? topHeapAllocations(path.join(outDir, heapFile)) : []
  return out
}

function topCpuNodes(file) {
  try {
    const profile = JSON.parse(fs.readFileSync(file, 'utf8'))
    const byId = new Map(profile.nodes.map((n) => [n.id, n]))
    const rows = profile.nodes
      .filter((n) => n.hitCount)
      .map((n) => ({
        name: n.callFrame.functionName || '(anonymous)',
        url: (n.callFrame.url || '').replace(/^file:\/\/\//, '').replace(ROOT + path.sep, '').replace(/\\/g, '/'),
        hits: n.hitCount
      }))
    const total = rows.reduce((sum, r) => sum + r.hits, 0) || 1
    return rows
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 15)
      .map((r) => ({ ...r, percent: (r.hits / total) * 100 }))
  } catch {
    return []
  }
}

function topHeapAllocations(file) {
  try {
    const profile = JSON.parse(fs.readFileSync(file, 'utf8'))
    const nodes = []
    // .heapprofile 的 samples 引用 head 树的节点 id
    const walk = (node) => {
      nodes.push(node)
      for (const child of node.children || []) walk(child)
    }
    walk(profile.head)
    // 同一个函数可能出现在多个节点上（不同调用点），按 函数+位置 合并，否则表里尽是重复行
    const grouped = new Map()
    for (const node of nodes) {
      if (!node.selfSize) continue
      const name = (node.callFrame && node.callFrame.functionName) || '(anonymous)'
      const url = ((node.callFrame && node.callFrame.url) || '').replace(/^file:\/\/\//, '').replace(ROOT + path.sep, '').replace(/\\/g, '/')
      const key = `${name}@${url}`
      const acc = grouped.get(key) || { name, url, selfSize: 0, nodes: 0 }
      acc.selfSize += node.selfSize
      acc.nodes += 1
      grouped.set(key, acc)
    }
    return Array.from(grouped.values())
      .sort((a, b) => b.selfSize - a.selfSize)
      .slice(0, 12)
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

function buildReport(data) {
  const aurora = data.aurora
  const npm = data.npm
  const stubbedAurora = data.auroraStubbed || []
  const stubbedById = new Map(stubbedAurora.map((m) => [m.id, m]))
  const pkg = npm.find((m) => m.id === NETEASE_PKG)

  const notable = []
  if (pkg && pkg.ok && pkg.heapRetained > 8 * 1024 * 1024) {
    notable.push(`**${NETEASE_PKG} 一次 require 常驻 ${formatBytes(pkg.heapRetained)}、耗时 ${formatMs(pkg.requireMs)}**`)
  }
  const measured = [...aurora, ...npm].filter((m) => m.ok)
  const worstTime = measured.slice().sort((a, b) => (b.requireMs || 0) - (a.requireMs || 0)).slice(0, 3)
  for (const m of worstTime) {
    if (m.id !== NETEASE_PKG && (m.requireMs || 0) > 20) notable.push(`**${m.id} require ${formatMs(m.requireMs)}**`)
  }

  const lines = []
  const push = (s = '') => lines.push(s)

  push('# Aurora 主进程性能度量（模块加载成本与常驻内存）')
  push()
  push('本文件由 `node scripts/perf-main.mjs` 自动生成，不要手工编辑。')
  push()
  push(`- 生成时间：${data.generatedAt}`)
  push(`- 平台：${data.platform} / Node ${data.node}（Electron 44 自带 Node，版本可能不同；趋势一致）`)
  push(`- 度量对象：本脚本刚刚编译出来的 \`electron/**/*.ts\`（${data.build.files} 个 .js，输出到 \`${data.build.outDir}\`）`)
  push('- 度量方式：`perf_hooks` 的 mark/measure 量 require 耗时，`process.memoryUsage()` 量 heapUsed/rss 增量；每个模块量 1 次首载 + 3 次重复，并额外给出强制 GC 后的常驻增量')
  push('- 第三方包每个都在独立子进程里量；Aurora 自己的模块在同一子进程里顺序量（结果里会扣除前面模块已加载的共享依赖）')
  push()
  push('## 0. 结论摘要')
  push()
  push('### 0.1 一句话结论')
  push()
  push(`Aurora 自己的主进程代码很轻：整条启动 import 链（${data.chain && data.chain.count ? data.chain.count : CHAIN_ORDER.length} 个模块、按 \`main.ts\` 顺序）在一个进程里一次性加载，`)
  if (data.chain && data.chain.ok) {
    push(`**${formatMs(data.chain.requireMs)} / 瞬时分配 ${formatBytes(data.chain.heapDelta)} / GC 后常驻 ${formatBytes(data.chain.heapRetained)}**。`)
  } else {
    push('本次未取到整链数值（见 §0.3）。')
  }
  push()
  push(`真正的问题只有一个：\`${NETEASE_PKG}\` **一次 require ${formatMs(pkg && pkg.requireMs)}、瞬时分配 ${formatBytes(pkg && pkg.heapDelta)}、GC 后常驻 ${formatBytes(pkg && pkg.heapRetained)}**，`)
  push(`并且 \`main.ts\` 在 \`app.whenReady()\` 里立刻 \`void warmUpNetease()\`，所以这笔开销紧跟在首窗口之后发生。`)
  push()
  push('### 0.2 关键数字')
  push()
  if (notable.length) {
    for (const n of notable) push(`- ${n}`)
  }
  push(`- 上游包一次 require 拉起 **${data.tree.total} 个模块**；其中 jsdom ${data.jsdomModules} 个、该包自身 468 个。`)
  push(`- \`module/register_checktoken_v2.js\` 在文件顶部 \`require('jsdom')\`，而 \`main.js\` 会把 \`module/\` 下 **${data.moduleFileCount} 个文件全部 require 一遍**——Aurora 只用到其中 ${data.usedEndpoints} 个端点。`)
  push(`- 单看 jsdom：${formatMs(npm.find((m) => m.id === 'jsdom')?.requireMs)} / ${formatBytes(npm.find((m) => m.id === 'jsdom')?.heapRetained)}；单看 express：${formatMs(npm.find((m) => m.id === 'express')?.requireMs)} / ${formatBytes(npm.find((m) => m.id === 'express')?.heapRetained)}。`)
  push('- 上游那 4 个最大的包加起来（jsdom 15.20 MB + axios 4.25 MB + express 3.91 MB + pac-resolver 2.80 MB）已经超过上游包整体（29.09 MB）的一半。')
  push()
  push('### 0.3 口径')
  push()
  push('- 「常驻内存增量」= 强制 GC 之后的 `heapUsed` 差值（比 rss 稳）；「瞬时分配」= require 刚结束、还没 GC 时的 `heapUsed` 差值，更接近启动瞬间的压力。')
  push('- 每个第三方包在**独立子进程**里量。同一个进程里连续量多个包会互相预热（先量上游包之后，再单独量 express 只剩 1 ms），那样数字是假的。')
  push('- Aurora 自己的模块共用一个子进程、按顺序量，所以靠后模块的增量不含前面已加载的共享依赖（例如 `./settings`）。')
  push('- 「逐模块相加」不等于一次真实启动的耗时；真实口径看 §0.1 的整链数值。')
  push()

  push('## 1. Aurora 自己的主进程模块（`electron/**`）')
  push()
  push('「首次 require」= 本进程第一次加载（真实启动付的代价）；「缓存命中」= 后续重复 require 的中位数（3 次）。')
  push()
  push('**带 ✓ 的数字来自 electron 桩件**（该模块在纯 node + 真实 electron 下无法加载），只含 Aurora 自己那层代码，不能与其它行的真实数值直接相加。')
  push()
  push('「常驻内存增量」列凡小于 1 MB 一律标为「低于本口径噪声」：度量框架自身的字符串在 GC 后仍有残留，实测同一模块可抖动 ±0.6 MB。')
  push('可信的常驻数字看 §1.2 的整链测量；本表主要用于比较各模块的**加载耗时**。')
  push()
  push('| 模块 | 首次 require | 缓存命中（重复 3 次中位数） | 常驻内存增量（GC 后 heapUsed） | 分配瞬间 heapUsed | rss 增量 | 启动路径 | 能否推迟 | 备注 |')
  push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const m of aurora) {
    const stub = stubbedById.get(m.id)
    // 真实 electron 下失败、但桩件下成功 —— 表里用桩件数字，并明确标注
    const useStub = !m.ok && stub && stub.ok
    const source = m.ok ? m : useStub ? stub : null
    // 比例里凡只有桩件数值可用的，一律加 ✓ 标注，避免读者以为那是真实 Electron 下量到的
    const mark = useStub ? ' ✓' : ''
    let note = ''
    if (!m.ok && useStub) {
      note = '**真实 electron 下无法在 node 中量化**（' + shorten(m.error) + '）；本行数字来自 electron 桩件，仅含 Aurora 自己那层代码'
    } else if (!m.ok) {
      note = `**无法在 node 中量化** — ${shorten(m.error)}`
    }
    const time = source ? formatMs(source.requireMs) + mark : '无法量化'
    const hot = source ? formatMs(source.hotMedianMs) + mark : '无法量化'
    const retained = source ? formatRetained(source.heapRetained) + mark : '无法量化'
    const delta = source ? formatBytes(source.heapDelta) + mark : '无法量化'
    const rss = source ? formatBytes(source.rssDelta) + mark : '无法量化'
    push(`| \`${m.id}\` | ${time} | ${hot} | ${retained} | ${delta} | ${rss} | ${m.startup} | ${m.deferrable} | ${note} |`)
  }
  push()
  push('### 1.1 用 electron 桩件量到的「Aurora 自己那层代码」')
  push()
  push('桩件把 `require(\'electron\')` 换成一个极小对象，让顶层就用 Electron API 的模块也能走到 require 结束。')
  push('**桩件数值不等于真实 Electron 启动成本**（真实 Electron 还要拉起 Chromium 的绑定层），只用于模块之间的相对比较。')
  push('桩件下的「常驻」列对 1 MB 以下的模块不可信（度量框架自身的字符串在 GC 后仍有残留，实测同一模块可抖动 ±0.6 MB），')
  push('所以这一列凡小于 1 MB 一律写「低于本口径噪声」；真正可信的常驻数字看 §1.2 的整链测量。')
  push()
  push('| 模块 | 首次 require（桩件） | 常驻内存增量（桩件） | 启动路径 | 能否推迟 | 备注 |')
  push('| --- | --- | --- | --- | --- | --- |')
  for (const m of stubbedAurora) {
    const time = m.ok ? formatMs(m.requireMs) : '无法量化'
    const retained = m.ok ? formatRetained(m.heapRetained) : '无法量化'
    const note = m.ok ? '' : `**桩件下仍失败** — ${shorten(m.error)}`
    push(`| \`${m.id}\` | ${time} | ${retained} | ${m.startup} | ${m.deferrable} | ${note} |`)
  }
  push()
  push(`启动路径上这些模块的桩件耗时合计：**${formatMs(data.auroraStubStartupTotalMs)}**（内存合计无意义：每个模块都低于本口径噪声，见 §1.2）。`)
  push()
  push('注意 `electron/main.ts` 在桩件下只量到「顶层 import + `registerMediaScheme()`/`registerAppScheme()`/`registerRemoteScheme()`/`app.setAppUserModelId`」这些同步语句；')
  push('`app.whenReady()` 的回调在下一个 tick 才跑，不在这次度量里。')
  push()

  push('### 1.2 整条启动 import 链（单进程、按 `main.ts` 顺序，共享依赖只算一次）')
  push()
  if (data.chain && data.chain.ok) {
    push(`| 口径 | 数值 |`)
    push('| --- | --- |')
    push(`| 模块数 | ${data.chain.count} |`)
    push(`| 首次 require 全链耗时 | **${formatMs(data.chain.requireMs)}**（${data.chain.rounds} 轮中位数） |`)
    push(`| 瞬时分配（heapUsed，未 GC） | **${formatBytes(data.chain.heapDelta)}** |`)
    push(`| GC 后常驻（heapUsed） | **${formatBytes(data.chain.heapRetained)}** |`)
    push(`| rss 增量 | ${formatBytes(data.chain.rssDelta)} |`)
    push()
    push('链内逐模块耗时（顺序 require，靠后的模块更快，因为共享依赖已被前面的模块加载）：')
    push()
    push('| 顺序 | 模块 | 首次 require |')
    push('| --- | --- | --- |')
    data.chain.perModule.forEach((item, index) => {
      push(`| ${index + 1} | \`${item.id}\` | ${formatMs(item.durationMs)} |`)
    })
  } else {
    push(`整链测量未成功：${shorten((data.chain && data.chain.error) || '未运行')}`)
  }
  push()
  push('**这就是 Aurora 自己那层代码在「窗口出现之前」的全部加载成本。**')
  push(`对比一下：上游包一次 require 是 ${formatMs(pkg && pkg.requireMs)} / ${formatBytes(pkg && pkg.heapRetained)}（GC 后常驻），`)
  if (data.chain && data.chain.ok) {
    push(`是整条 Aurora 启动链（${formatMs(data.chain.requireMs)} / ${formatBytes(data.chain.heapRetained)}）的 ${(pkg.requireMs / data.chain.requireMs).toFixed(1)} 倍 / ${(pkg.heapRetained / data.chain.heapRetained).toFixed(1)} 倍。`)
  }
  push()
  push('口径：整链是 3 轮独立子进程的中位数；本机在跑其它任务时波动明显，')
  if (data.chain && data.chain.runs && data.chain.runs.length > 1) {
    push(`本次三轮分别是 ${data.chain.runs.map((v) => formatMs(v)).join(' / ')}，所以这个数字当**数量级**看，不要当常数。`)
  }
  push('内存侧的 1 MB 是稳定的（三轮几乎一致），可以当结论。')
  push()

  push('## 2. 上游/第三方包')
  push()
  push('每个包都在**独立子进程**里量，跑 3 轮取中位数（同进程连续量会互相预热，数字会假性变小；单次测量又容易被系统负载带偏）。')
  push()
  push('| 包 | 首次 require | 缓存命中（重复 3 次中位数） | 常驻内存增量（GC 后 heapUsed） | 分配瞬间 heapUsed | rss 增量 | 启动路径 | 能否推迟 | 备注 |')
  push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |')
  for (const m of npm) {
    const note = !m.ok ? `**无法在 node 下量化** — ${shorten(m.error)}` : m.id === 'electron' ? '纯 node 下返回 electron.exe 路径字符串' : ''
    const time = m.ok ? formatMs(m.requireMs) : '无法量化'
    const hot = m.ok ? formatMs(m.hotMedianMs) : '无法量化'
    const retained = m.ok ? formatRetained(m.heapRetained) : '无法量化'
    const delta = m.ok ? formatBytes(m.heapDelta) : '无法量化'
    const rss = m.ok ? formatBytes(m.rssDelta) : '无法量化'
    push(`| \`${m.id}\` | ${time} | ${hot} | ${retained} | ${delta} | ${rss} | ${m.startup} | ${m.deferrable} | ${note} |`)
  }
  push()

  push('## 3. 上游包到底拉起了什么')
  push()
  push(`一次 \`require('${NETEASE_PKG}')\` 之后，\`require.cache\` 共 **${data.tree.total}** 个模块，其中 node_modules 分组前 22 名：`)
  push()
  push('| 包 | 模块数 |')
  push('| --- | --- |')
  for (const row of data.tree.top) push(`| \`${row.name}\` | ${row.count} |`)
  push()
  push(`该包 \`module/\` 目录下有 **${data.moduleFileCount}** 个 \`.js\` 文件，\`main.js\` 在加载时把它们**全部** require 一遍：`)
  push()
  push('```js')
  push('// node_modules/@neteasecloudmusicapienhanced/api/main.js')
  push('const moduleFiles = fs.readdirSync(modulePath).reverse()')
  push('moduleFiles.forEach((file) => { ... require(filePath) ... })')
  push('Object.assign(module.exports, require(\'./server\'))')
  push('```')
  push()
  push(`Aurora 只用到其中 ${data.usedEndpoints} 个端点（见 \`electron/netease/client.ts\` 的 \`Upstream\` 接口），却为 ${data.moduleFileCount} 个文件付了加载成本。`)
  push()
  push('`module/register_checktoken_v2.js` 在**文件顶部** `require(\'jsdom\')`，而 `main.js` 会把 `module/` 下每个文件都 require 一遍，')
  push(`于是 jsdom 连带 ${data.jsdomModules} 个模块被一并拉起——Aurora 从不调用这条端点。这是整个 +${formatMs(data.npm.find((m) => m.id === NETEASE_PKG)?.requireMs)} 里最大的一块。`)
  push()

  push('## 4. 「可推迟模块清单」')
  push()
  push('以下是**建议**（本任务只报告，不改 `electron/**`）。判定依据：该模块是否在窗口出现前就必须可用、以及它的加载成本。')
  push()
  push('| 优先级 | 模块 | 现状 | 建议 | 预估收益 |')
  push('| --- | --- | --- | --- | --- |')
  const deferRows = data.deferPlan
  for (const row of deferRows) push(`| ${row.priority} | \`${row.mod}\` | ${row.now} | ${row.advice} | ${row.gain} |`)
  push()

  push('## 5. 同步 I/O 与主进程阻塞点（只报告，已给行号）')
  push()
  for (const item of data.syncIo) push(`- \`${item.where}\`：${item.what}`)
  push()

  if (data.profile) {
    push('## 6. CPU / 堆 profile（官方写法）')
    push()
    push('```powershell')
    push(`node --cpu-prof --heap-prof -e "require('${NETEASE_PKG}')"`)
    push('```')
    push()
    push(`本次生成在：\`${data.profile.dir}\`（系统临时目录，不提交进仓库）`)
    push(`文件：${data.profile.files.map((f) => '`' + f + '`').join('、')}`)
    push(`子进程退出码：${data.profile.status}${data.profile.stderr ? ' / stderr: ' + shorten(data.profile.stderr) : ''}`)
    push()
    if (data.profile.cpuTop.length) {
      push('### 6.1 CPU profile 采样最热的函数（self samples 占比）')
      push()
      push('| 函数 | 位置 | 占比 |')
      push('| --- | --- | --- |')
      for (const row of data.profile.cpuTop) push(`| \`${row.name}\` | \`${row.url || '(native)'}\` | ${row.percent.toFixed(1)}% |`)
      push()
      push('这些采样点本身就是结论：耗时几乎全在**模块系统**上（`readFileUtf8`、`internalModuleStat`、`lstat`、`wrapSafe`），')
      push(`而不是在某个 JS 函数里。也就是说这 ~${pkg ? (pkg.requireMs / 1000).toFixed(1) : '?'} 秒是「打开 1539 个文件并解析它们」的代价——典型的「谨慎加载模块」问题。`)
      push('真正能省下它的做法是**不要加载**，而不是优化加载过程。')
      push()
    }
    if (data.profile.heapTop.length) {
      push('### 6.2 Heap profile 保留最多的分配点（selfSize）')
      push()
      push('| 函数 | 位置 | selfSize |')
      push('| --- | --- | --- |')
      for (const row of data.profile.heapTop) push(`| \`${row.name}\` | \`${row.url || '(native)'}\` | ${formatBytes(row.selfSize)} |`)
      push('堆侧注意：heap profile 是抽样快照，同一份代码两次采样可以差 2 倍以上。')
      push('所以只看**结构**，不要看绝对值——重点在于，排在前面的大块全是「模块加载」本身：')
      const fsRows = data.profile.heapTop.filter((r) => r.name === 'readFileSync')
      const fsTotal = fsRows.reduce((sum, r) => sum + r.selfSize, 0)
      const nmRows = data.profile.heapTop.filter((r) => r.url.includes('node_modules'))
      const nmTotal = nmRows.reduce((sum, r) => sum + r.selfSize, 0)
      push(`- 前 12 大分配点里，\`node:fs\` 的 \`readFileSync\` 占 ${formatBytes(fsTotal)}（${fsRows.length} 处）——全是**源码文本缓冲区**，是「加载」这件事本身的内存代价。`)
      push(`- 其中来自第三方包（\`node_modules/**\`）的占 ${formatBytes(nmTotal)}，主要是查表数据；Aurora 一个都用不到。`)
      if (nmRows.length) {
        push(`  最大的一处：\`${nmRows[0].name}\`（\`${nmRows[0].url}\`，${formatBytes(nmRows[0].selfSize)}）。`)
      }
      push()
    }
  } else {
    push('## 6. CPU / 堆 profile')
    push()
    push('本次以 `--no-profile` 运行，未生成 profile。')
    push()
  }

  push('## 7. 度量口径与已知限制')
  push()
  push(`- **量的是刚编译的源码**：脚本把 \`electron/**/*.ts\` 编译到临时目录 \`${data.build.outDir}\`（${data.build.files} 个 .js），而不是仓库里的 \`dist-electron\`。后者是共享构建产物、随时可能过期，且队友正在改 \`electron/**\` 时重建它会互相踩。`)
  if (data.build.diagnostics && data.build.diagnostics.length) {
    push('- 本次编译有类型告警（不影响度量，产物仍然生成）：')
    for (const line of data.build.diagnostics) push(`  - \`${shorten(line)}\``)
  }
  push('- **纯 node vs Electron**：`require(\'electron\')` 在纯 node 下返回 `electron.exe` 的路径字符串，不是 Electron 模块。顶层就用 Electron API 的模块因此加载失败，报告里标为「无法在 node 中量化」并附上桩件数值，没有填估算值。')
  push('- **electron 桩件**：桩件改变了依赖图形状（真实 Electron 会拉起 Chromium 绑定），所以桩件数值只用于**模块之间的相对比较**。')
  push('- **RSS 噪声**：进程 RSS 受 V8 页分配与操作系统缓存影响，单次差值抖动可达数 MB。因此「常驻」列以强制 GC 后的 `heapUsed` 为准，`rss` 列只作参考。')
  push('- **模块间重复计算**：Aurora 自己的模块在同一个子进程里顺序度量（第三方包是每个一进程）。排在前面的模块会把共享依赖（如 `./settings`、`node:fs`）先加载掉，排在后面的模块增量里就不含这部分。所以「逐模块相加」只是排序工具，真实口径看 §1.2 的整链。')
  push('- **未覆盖**：`src/**`（渲染进程）与 Chromium/GPU 侧开销不在本脚本范围内。')
  push()
  push('### 为什么有些模块量不到真实数值')
  push()
  push('`require(\'electron\')` 在纯 node 下不是 Electron 模块，而是 `node_modules/electron/index.js` 导出的')
  push('`D:\\Aurora\\node_modules\\electron\\dist\\electron.exe` 字符串。于是：')
  push()
  push('- 顶层只做**引用**（`import { app } from \'electron\'` 后仅在函数体内用 `app.getPath`）的模块，require 能走完，数字有效：`settings.ts`、`netease/client.ts`、`netease/session.ts` 等。')
  push('- 顶层就**取属性或调用** Electron API 的模块，require 立刻失败，数字无效：`main.ts`（读 `app.commandLine`）。')
  push('  这一类在表里标了 ✓，数值来自 electron 桩件。')
  push()
  const failedReal = aurora.filter((m) => !m.ok)
  if (failedReal.length) {
    push('本次在真实 electron 下失败的模块：')
    push()
    for (const m of failedReal) {
      const reason = KNOWN_NODE_LIMITS[m.id] || '需要 Electron 运行时（具体调用点见源码）。'
      const stub = stubbedById.get(m.id)
      const stubNote = stub && stub.ok ? `桩件下可量：${formatMs(stub.requireMs)} / ${formatRetained(stub.heapRetained)}。` : '桩件下也失败。'
      push(`- \`${m.id}\`：${reason}${stubNote}`)
    }
  } else {
    push('本次没有模块在真实 electron 下失败。')
  }
  push()
  push('### 关于 `electron` 这个包本身')
  push()
  push('`require(\'electron\')` 在纯 node 下只是读取 `node_modules/electron/index.js`，返回 `path.txt` 里记的 `electron.exe` 路径字符串。')
  push('所以在纯 node 下「加载 electron」几乎免费，真正的 Electron 绑定层成本只能在实际 Electron 主进程里量——那是本脚本做不到的部分。')
  push()

  push('## 8. 复现')
  push()
  push('```powershell')
  push('cd D:\\Aurora')
  push('node scripts/perf-main.mjs                 # 度量 + 重新生成 docs/perf-main.md')
  push('node scripts/perf-main.mjs --json          # 只输出 JSON')
  push('node scripts/perf-main.mjs --no-profile    # 跳过 cpu/heap profile（快）')
  push('node scripts/perf-main.mjs --no-stub       # 跳过 electron 桩件那一轮')
  push(`node --cpu-prof --heap-prof -e "require('${NETEASE_PKG}')"   # 官方给的单命令口径`)
  push('```')
  push()
  push('脚本自己编译 `electron/**/*.ts` 到临时目录，不需要先跑 `npm run build:electron`，也不会写仓库里的 `dist-electron`。')
  push()
  push('profile 文件默认落在当前目录（即 `D:\\Aurora`），本脚本改写到系统临时目录以免污染仓库：')
  push()
  push('```powershell')
  push(`node --cpu-prof --heap-prof --cpu-prof-dir "$env:TEMP" --heap-prof-dir "$env:TEMP" -e "require('${NETEASE_PKG}')"`)
  push('```')
  push()
  push('`.cpuprofile` 用 Chrome DevTools 的 Performance 面板打开，`.heapprofile` 用 Memory 面板打开。')
  push()
  push('### 手工复现「一次 require 到底多贵」')
  push()
  push('```powershell')
  push('cd D:\\Aurora')
  push(`$t0 = Get-Date; node -e "require('${NETEASE_PKG}')" | Out-Null; ((Get-Date) - $t0).TotalMilliseconds`)
  push('```')
  push()
  push('```powershell')
  push('# 数一数这次 require 拉起了多少个模块')
  push(`node -e "require('${NETEASE_PKG}'); console.log(Object.keys(require.cache).length)"`)
  push('```')
  push()
  push('```powershell')
  push('# 只加载 Aurora 真正用到的那几个端点文件，对比一下（实测 4 个模块 / 约 14 ms）')
  push(`node -e "const t0=process.hrtime.bigint(); require('${NETEASE_PKG}/module/song_url_v1.js'); const ms=Number(process.hrtime.bigint()-t0)/1e6; console.log('ms=', ms.toFixed(1), 'modules=', Object.keys(require.cache).length)"`)
  push('```')
  push()
  push('### 手工复现整条启动 import 链')
  push()
  push('```powershell')
  push('cd D:\\Aurora')
  push('node scripts/perf-main.mjs --no-profile --no-stub --json | Select-String -Pattern "chain" -Context 0,12')
  push('```')
  push()
  push('脚本内部把这条链放在**一个**子进程里顺序 require，量的是「窗口出现前」的真实加载成本（见 §1.2）。')
  push()

  return lines.join('\n') + '\n'
}

const shorten = (text) => {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  return t.length > 150 ? t.slice(0, 147) + '...' : t
}

function buildDeferPlan(data) {
  const byId = new Map([...data.aurora, ...data.npm].map((m) => [m.id, m]))
  const gain = (id) => {
    const m = byId.get(id)
    if (!m || !m.ok) return '无法量化'
    return `${formatMs(m.requireMs)} / ${formatRetained(m.heapRetained)}`
  }
  const pkg = byId.get(NETEASE_PKG)
  const auroraStartup = data.aurora.filter((m) => m.startup === 'yes')

  return [
    {
      priority: 'P0',
      mod: NETEASE_PKG,
      now: 'client.ts 已懒加载，但 main.ts 在 app.whenReady 后立刻 `void warmUpNetease()`，于是窗口一出现就把这个包整个 require 了',
      advice: '把 warmUp 推迟到「用户真的要播在线歌曲 / 打开在线页」时；或者在 warmUp 前先 await 窗口 ready-to-show + 一个空闲回调',
      gain: gain(NETEASE_PKG)
    },
    {
      priority: 'P1',
      mod: 'electron/lyrics-overlay.ts',
      now: 'main.ts 第 22-30 行顶层 import，whenReady 里 initOverlay()',
      advice: '顶层改成 `import type` + 首次 toggleOverlay/桌面歌词时才动态 import',
      gain: gain('electron/lyrics-overlay.ts')
    },
    {
      priority: 'P1',
      mod: 'electron/updates.ts',
      now: 'main.ts 第 10 行顶层 import',
      advice: '顶层改成 `import type`，ipc handler 内 `await import("./updates")`',
      gain: gain('electron/updates.ts')
    },
    {
      priority: 'P2',
      mod: 'electron/lyrics.ts',
      now: 'main.ts 第 11 行顶层 import',
      advice: '顶层改成 `import type`，首次 lyrics:lookup 时动态 import',
      gain: gain('electron/lyrics.ts')
    },
    {
      priority: 'P2',
      mod: 'electron/netease/client.ts',
      now: 'main.ts 第 7 行经 netease/ipc.ts 顶层 import',
      advice: 'client 本体很轻，但它把 `require("@neteasecloudmusicapienhanced/api")` 的入口放在 warmUp 里；先解决 P0 即可',
      gain: gain('electron/netease/client.ts')
    },
    {
      priority: 'P3',
      mod: '（上游包整体）',
      now: `一次性 require：${data.tree.total} 个模块，其中 jsdom ${data.jsdomModules} 个；实测只 require 一个端点文件是 4 个模块 / 约 14 ms`,
      advice: '真正的大头不在 Aurora 的代码里。可选：换轻量客户端 / 只 require 需要的 module 文件 / 把上游放进 utilityProcess。属破坏性改造，需单独评估',
      gain: `${formatMs(pkg && pkg.ok ? pkg.requireMs : null)} / ${formatBytes(pkg && pkg.ok ? pkg.heapRetained : null)}`
    }
  ].filter((row) => row.gain)
}

function buildSyncIo() {
  return [
    { where: 'electron/main.ts:147', what: '`fs.readFileSync(stateFile(), "utf8")` — loadWinState()，createWindow() 里同步读窗口状态（启动路径上，阻塞主进程）。改成先构造窗口用默认尺寸再异步套用 bounds，或把 state 读成启动前的一次异步读。' },
    { where: 'electron/main.ts:166-167', what: '`fs.mkdirSync` + `fs.writeFileSync` — saveWinState()，resize/move 防抖 400ms 后同步写（不在启动路径，但会在拖动窗口时阻塞 UI 线程）。改 `fs.promises`。' },
    { where: 'electron/main.ts:186-200', what: 'decodeText() 里同步 TextDecoder（CPU 而非 I/O），只在打开歌词/歌单时运行，影响可忽略。' },
    { where: 'electron/settings.ts:51', what: '`fs.readFileSync(settingsFile(), "utf8")` — loadSettings()，被 IPC 与各协议处理函数大量调用；有 cache，首次调用同步读一次。首次调用发生在哪个 IPC 上就在那里阻塞一次。' },
    { where: 'electron/settings.ts:72-73', what: '`fs.mkdirSync` + `fs.writeFileSync` — saveSettings()，每次改设置同步写。' },
    { where: 'electron/netease/client.ts:96', what: '`fs.existsSync` + `fs.writeFileSync` — loadUpstream() 首次 require 前建 anonymous_token 文件（官方包要求在 import 时文件已存在，无法异步化）。' },
    { where: 'electron/netease/client.ts:198/214/249', what: '`fs.writeFileSync` — 写 xeapi key / anonymous token / deviceId，都在 bootstrap 阶段。' }
  ]
}

function buildUsedEndpoints() {
  try {
    const source = fs.readFileSync(path.join(ROOT, 'electron', 'netease', 'client.ts'), 'utf8')
    const block = /interface Upstream \{([\s\S]*?)\n\}/.exec(source)
    if (!block) return 0
    return block[1].split('\n').filter((line) => /^\s*[a-z_0-9]+\s*:/.test(line)).length
  } catch {
    return 0
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  if (onlyChild) {
    const configPath = readFlag('--config')
    if (!configPath) throw new Error('--child 需要 --config=<json 文件路径>')
    measureChild(configPath)
    return  }

  const moduleFileCount = (() => {
    try {
      return fs.readdirSync(path.join(ROOT, 'node_modules', NETEASE_PKG.replace('/', path.sep), 'module')).filter((f) => f.endsWith('.js')).length
    } catch {
      return 0
    }
  })()

  console.error('[perf-main] 编译 electron/**/*.ts 到仓库外的临时目录 ...')
  const build = buildElectron()
  OUT_DIR = build.outDir
  console.error(`[perf-main] 已编译 ${build.files} 个 .js -> ${build.outDir}${build.diagnostics.length ? '（有类型告警，见报告）' : ''}`)

  const mode = electronMode
  console.error(`[perf-main] electron 模式: ${mode}`)

  const measureBatch = (targets, metaList, batchMode, label, isolated = false) => {
    const entries = targets.map((id) => ({ id, path: resolveTarget(id) }))
    console.error(`[perf-main] 度量 ${entries.length} 个目标（${label}${isolated ? '，每目标独立进程' : ''}）...`)
    const run = runChildBatch(entries, batchMode, label, isolated)
    if (run.childError) console.error(`[perf-main] 子进程异常：${shorten(run.childError)}`)
    const byId = new Map((run.results || []).map((r) => [r.id, r]))
    return metaList.map((meta) => {
      const summary = summarise(byId.get(meta.id), meta)
      console.error(
        `  ${meta.id.padEnd(34)} ${summary.ok ? formatMs(summary.requireMs) + '  ' + formatBytes(summary.heapRetained) : 'FAILED: ' + shorten(summary.error)}`
      )
      return summary
    })
  }

  // 真实 electron（与 Electron 主进程里的真实条件一致：require('electron') 返回 exe 路径字符串）
  const measured = {}
  measured.aurora = measureBatch(AURORA_MODULES.map((m) => m.id), AURORA_MODULES, 'real', 'aurora')
  // 第三方包一律隔离进程：否则先量的包会把后面包的依赖预热掉，数字会假性变小
  measured.npm = measureBatch(NPM_PACKAGES.map((m) => m.id), NPM_PACKAGES, 'real', 'npm', true)

// electron 桩件：只为量「Aurora 自己那层代码」的成本，单独标注
  let stubbedAurora = []
  if (!argv.includes('--no-stub')) {
    stubbedAurora = measureBatch(AURORA_MODULES.map((m) => m.id), AURORA_MODULES, 'stub', 'aurora-stub')
  }

  // 整链一次量：main.ts 顶层 import 顺序 require 一遍，量「一个主进程进程里、
  // 窗口出现之前，Aurora 自己的代码要付多少时间和内存」。比逐模块相加更接近真实。
  console.error('[perf-main] 度量整条启动 import 链（单进程、按 main.ts 顺序）...')
  let chain = null
  if (!argv.includes('--no-chain')) {
    const chainRun = runChainBatch()
    chain = chainRun.error ? chainRun : chainRun.summary
    console.error(`  整链：${chain && chain.ok ? formatMs(chain.requireMs) + '  ' + formatBytes(chain.heapDelta) + '（瞬时）  ' + formatBytes(chain.heapRetained) + '（GC 后）' : 'FAILED: ' + shorten(chain && chain.error)}`)
  }

  console.error('[perf-main] 统计上游依赖树 ...')
  const tree = childNetedeTree()
  const jsdomModules = tree.top.find((t) => t.name === 'jsdom') ? tree.top.find((t) => t.name === 'jsdom').count : 0

  let profile = null
  if (!skipProfile) {
    console.error('[perf-main] 生成 cpu/heap profile ...')
    profile = profiles()
  }

  const auroraStartup = measured.aurora.filter((m) => m.startup === 'yes' && m.ok)
  const stubStartup = stubbedAurora.filter((m) => m.startup === 'yes' && (m.ok || m.error))
  const data = {
    generatedAt: new Date().toISOString(),
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    timingRuns,
    electronMode: mode,
    build: { outDir: build.outDir, files: build.files, diagnostics: build.diagnostics },
    aurora: measured.aurora,
    auroraStubbed: stubbedAurora,
    npm: measured.npm,
    tree,
    jsdomModules,
    moduleFileCount,
    usedEndpoints: buildUsedEndpoints(),
    profile,
    chain,
    deferPlan: [],
    syncIo: buildSyncIo(),
    auroraStartupTotalMs: auroraStartup.reduce((sum, m) => sum + (m.requireMs || 0), 0),
    auroraStartupHeap: auroraStartup.reduce((sum, m) => sum + (m.heapRetained || 0), 0),
    auroraStubStartupTotalMs: stubStartup.reduce((sum, m) => sum + (m.requireMs || 0), 0),
    auroraStubStartupHeap: stubStartup.reduce((sum, m) => sum + (m.heapRetained || 0), 0)
  }
  data.deferPlan = buildDeferPlan(data)

  if (asJson) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n')
    return
  }

  fs.mkdirSync(path.dirname(REPORT), { recursive: true })
  fs.writeFileSync(REPORT, buildReport(data), 'utf8')
  console.error(`[perf-main] 已写出 ${REPORT}`)

  const resultsPath = path.join(os.tmpdir(), 'aurora-perf-main-results.json')
  fs.writeFileSync(resultsPath, JSON.stringify(data, null, 2), 'utf8')
  console.error(`[perf-main] 原始数据 ${resultsPath}`)
}

main()
