# Aurora 主进程性能度量（模块加载成本与常驻内存）

本文件由 `node scripts/perf-main.mjs` 自动生成，不要手工编辑。

- 生成时间：2026-10-14T14:50:26.039Z
- 平台：win32 x64 / Node v24.19.0（Electron 44 自带 Node，版本可能不同；趋势一致）
- 度量对象：本脚本刚刚编译出来的 `electron/**/*.ts`（22 个 .js，输出到 `C:\Users\PC\AppData\Local\Temp\aurora-perf-main-build`）
- 度量方式：`perf_hooks` 的 mark/measure 量 require 耗时，`process.memoryUsage()` 量 heapUsed/rss 增量；每个模块量 1 次首载 + 3 次重复，并额外给出强制 GC 后的常驻增量
- 第三方包每个都在独立子进程里量；Aurora 自己的模块在同一子进程里顺序量（结果里会扣除前面模块已加载的共享依赖）

## 0. 结论摘要

### 0.1 一句话结论

Aurora 自己的主进程代码很轻：整条启动 import 链（10 个模块、按 `main.ts` 顺序）在一个进程里一次性加载，
**37.9 ms / 瞬时分配 1.26 MB / GC 后常驻 1.04 MB**。

真正的问题只有一个：`@neteasecloudmusicapienhanced/api` **一次 require 1482.8 ms、瞬时分配 51.67 MB、GC 后常驻 29.09 MB**，
并且 `main.ts` 在 `app.whenReady()` 里立刻 `void warmUpNetease()`，所以这笔开销紧跟在首窗口之后发生。

### 0.2 关键数字

- **@neteasecloudmusicapienhanced/api 一次 require 常驻 29.09 MB、耗时 1482.8 ms**
- **jsdom require 717.9 ms**
- **express require 231.6 ms**
- 上游包一次 require 拉起 **1539 个模块**；其中 jsdom 465 个、该包自身 468 个。
- `module/register_checktoken_v2.js` 在文件顶部 `require('jsdom')`，而 `main.js` 会把 `module/` 下 **449 个文件全部 require 一遍**——Aurora 只用到其中 19 个端点。
- 单看 jsdom：717.9 ms / 15.20 MB；单看 express：231.6 ms / 3.91 MB。
- 上游那 4 个最大的包加起来（jsdom 15.20 MB + axios 4.25 MB + express 3.91 MB + pac-resolver 2.80 MB）已经超过上游包整体（29.09 MB）的一半。

### 0.3 口径

- 「常驻内存增量」= 强制 GC 之后的 `heapUsed` 差值（比 rss 稳）；「瞬时分配」= require 刚结束、还没 GC 时的 `heapUsed` 差值，更接近启动瞬间的压力。
- 每个第三方包在**独立子进程**里量。同一个进程里连续量多个包会互相预热（先量上游包之后，再单独量 express 只剩 1 ms），那样数字是假的。
- Aurora 自己的模块共用一个子进程、按顺序量，所以靠后模块的增量不含前面已加载的共享依赖（例如 `./settings`）。
- 「逐模块相加」不等于一次真实启动的耗时；真实口径看 §0.1 的整链数值。

## 1. Aurora 自己的主进程模块（`electron/**`）

「首次 require」= 本进程第一次加载（真实启动付的代价）；「缓存命中」= 后续重复 require 的中位数（3 次）。

**带 ✓ 的数字来自 electron 桩件**（该模块在纯 node + 真实 electron 下无法加载），只含 Aurora 自己那层代码，不能与其它行的真实数值直接相加。

「常驻内存增量」列凡小于 1 MB 一律标为「低于本口径噪声」：度量框架自身的字符串在 GC 后仍有残留，实测同一模块可抖动 ±0.6 MB。
可信的常驻数字看 §1.2 的整链测量；本表主要用于比较各模块的**加载耗时**。

| 模块 | 首次 require | 缓存命中（重复 3 次中位数） | 常驻内存增量（GC 后 heapUsed） | 分配瞬间 heapUsed | rss 增量 | 启动路径 | 能否推迟 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `electron/pure/version.ts` | 2.5 ms | 0.0 ms | < 1 MB（低于本口径噪声） | 167.4 KB | 640.0 KB | yes | 否（0 依赖，本身就是最省的） |  |
| `electron/pure/app-paths.ts` | 0.7 ms | 0.0 ms | < 1 MB（低于本口径噪声） | 31.7 KB | 4.0 KB | yes | 否（只依赖 node:path） |  |
| `electron/netease/reasons.ts` | 0.9 ms | 0.0 ms | < 1 MB（低于本口径噪声） | 41.8 KB | 64.0 KB | yes | 否（纯数据/纯函数） |  |
| `electron/netease/types.ts` | 0.6 ms | 0.0 ms | < 1 MB（低于本口径噪声） | 23.8 KB | 0 B | yes | 否（纯类型守卫） |  |
| `electron/protocols/remote-protocol.ts` | 11.8 ms | 0.0 ms | < 1 MB（低于本口径噪声） | 107.3 KB | 1.64 MB | yes | 否（纯 node，首窗口要用） |  |
| `electron/protocols/app-protocol.ts` | 3.4 ms | 0.0 ms | < 1 MB（低于本口径噪声） | 110.2 KB | 92.0 KB | yes | 否（窗口加载前必须注册 scheme） |  |
| `electron/settings.ts` | 2.1 ms | 0.0 ms | < 1 MB（低于本口径噪声） | 447.9 KB | 12.0 KB | yes | 否（IPC 到处要用，本体极轻） |  |
| `electron/protocols/media-protocol.ts` | 3.1 ms | 0.0 ms | < 1 MB（低于本口径噪声） | 498.5 KB | 4.0 KB | yes | 否（注册 media scheme 必须在 loadURL 前） |  |
| `electron/library-scan.ts` | 0.3 ms | 0.0 ms | < 1 MB（低于本口径噪声） | 11.1 KB | 0 B | yes | 否（扫描/封面），但内部 import('music-metadata') 已懒加载 |  |
| `electron/lyrics.ts` | 0.8 ms | 0.0 ms | < 1 MB（低于本口径噪声） | 41.9 KB | 0 B | yes | 是（可推迟到首次 lyrics:lookup） |  |
| `electron/updates.ts` | 2.0 ms | 0.0 ms | < 1 MB（低于本口径噪声） | 96.1 KB | 12.0 KB | yes | 是（可推迟到首次 updates:check） |  |
| `electron/tray.ts` | 0.9 ms | 0.0 ms | < 1 MB（低于本口径噪声） | 34.1 KB | 8.0 KB | yes | 否（启动即建托盘） |  |
| `electron/lyrics-overlay.ts` | 1.1 ms | 0.0 ms | < 1 MB（低于本口径噪声） | 55.7 KB | 0 B | yes | 是（初始化可推迟到首次显示桌面歌词） |  |
| `electron/netease/client.ts` | 8.2 ms | 0.0 ms | < 1 MB（低于本口径噪声） | 821.3 KB | 1.24 MB | yes | 是（仅 bootstrap 用，可推迟到 warmUp 之后） |  |
| `electron/netease/ipc.ts` | 1.4 ms | 0.0 ms | < 1 MB（低于本口径噪声） | 70.3 KB | 16.0 KB | yes | 否（IPC 处理函数要早注册），本体极轻 |  |
| `electron/netease/session.ts` | 0.3 ms | 0.0 ms | < 1 MB（低于本口径噪声） | 11.8 KB | 4.0 KB | yes | 待定（无法在 node 下量化） |  |
| `electron/main.ts` | 4.6 ms ✓ | 0.0 ms ✓ | < 1 MB（低于本口径噪声） ✓ | 226.3 KB ✓ | 76.0 KB ✓ | yes | 否（入口） | **真实 electron 下无法在 node 中量化**（Cannot read properties of undefined (reading 'commandLine')）；本行数字来自 electron 桩件，仅含 Aurora 自己那层代码 |

### 1.1 用 electron 桩件量到的「Aurora 自己那层代码」

桩件把 `require('electron')` 换成一个极小对象，让顶层就用 Electron API 的模块也能走到 require 结束。
**桩件数值不等于真实 Electron 启动成本**（真实 Electron 还要拉起 Chromium 的绑定层），只用于模块之间的相对比较。
桩件下的「常驻」列对 1 MB 以下的模块不可信（度量框架自身的字符串在 GC 后仍有残留，实测同一模块可抖动 ±0.6 MB），
所以这一列凡小于 1 MB 一律写「低于本口径噪声」；真正可信的常驻数字看 §1.2 的整链测量。

| 模块 | 首次 require（桩件） | 常驻内存增量（桩件） | 启动路径 | 能否推迟 | 备注 |
| --- | --- | --- | --- | --- | --- |
| `electron/pure/version.ts` | 2.3 ms | < 1 MB（低于本口径噪声） | yes | 否（0 依赖，本身就是最省的） |  |
| `electron/pure/app-paths.ts` | 0.7 ms | < 1 MB（低于本口径噪声） | yes | 否（只依赖 node:path） |  |
| `electron/netease/reasons.ts` | 0.9 ms | < 1 MB（低于本口径噪声） | yes | 否（纯数据/纯函数） |  |
| `electron/netease/types.ts` | 0.7 ms | < 1 MB（低于本口径噪声） | yes | 否（纯类型守卫） |  |
| `electron/protocols/remote-protocol.ts` | 10.9 ms | < 1 MB（低于本口径噪声） | yes | 否（纯 node，首窗口要用） |  |
| `electron/protocols/app-protocol.ts` | 1.3 ms | < 1 MB（低于本口径噪声） | yes | 否（窗口加载前必须注册 scheme） |  |
| `electron/settings.ts` | 0.9 ms | < 1 MB（低于本口径噪声） | yes | 否（IPC 到处要用，本体极轻） |  |
| `electron/protocols/media-protocol.ts` | 3.4 ms | < 1 MB（低于本口径噪声） | yes | 否（注册 media scheme 必须在 loadURL 前） |  |
| `electron/library-scan.ts` | 0.2 ms | < 1 MB（低于本口径噪声） | yes | 否（扫描/封面），但内部 import('music-metadata') 已懒加载 |  |
| `electron/lyrics.ts` | 0.9 ms | < 1 MB（低于本口径噪声） | yes | 是（可推迟到首次 lyrics:lookup） |  |
| `electron/updates.ts` | 2.0 ms | < 1 MB（低于本口径噪声） | yes | 是（可推迟到首次 updates:check） |  |
| `electron/tray.ts` | 0.8 ms | < 1 MB（低于本口径噪声） | yes | 否（启动即建托盘） |  |
| `electron/lyrics-overlay.ts` | 1.2 ms | < 1 MB（低于本口径噪声） | yes | 是（初始化可推迟到首次显示桌面歌词） |  |
| `electron/netease/client.ts` | 7.1 ms | < 1 MB（低于本口径噪声） | yes | 是（仅 bootstrap 用，可推迟到 warmUp 之后） |  |
| `electron/netease/ipc.ts` | 1.4 ms | < 1 MB（低于本口径噪声） | yes | 否（IPC 处理函数要早注册），本体极轻 |  |
| `electron/netease/session.ts` | 0.2 ms | < 1 MB（低于本口径噪声） | yes | 待定（无法在 node 下量化） |  |
| `electron/main.ts` | 4.6 ms | < 1 MB（低于本口径噪声） | yes | 否（入口） |  |

启动路径上这些模块的桩件耗时合计：**39.6 ms**（内存合计无意义：每个模块都低于本口径噪声，见 §1.2）。

注意 `electron/main.ts` 在桩件下只量到「顶层 import + `registerMediaScheme()`/`registerAppScheme()`/`registerRemoteScheme()`/`app.setAppUserModelId`」这些同步语句；
`app.whenReady()` 的回调在下一个 tick 才跑，不在这次度量里。

### 1.2 整条启动 import 链（单进程、按 `main.ts` 顺序，共享依赖只算一次）

| 口径 | 数值 |
| --- | --- |
| 模块数 | 10 |
| 首次 require 全链耗时 | **37.9 ms**（3 轮中位数） |
| 瞬时分配（heapUsed，未 GC） | **1.26 MB** |
| GC 后常驻（heapUsed） | **1.04 MB** |
| rss 增量 | 4.45 MB |

链内逐模块耗时（顺序 require，靠后的模块更快，因为共享依赖已被前面的模块加载）：

| 顺序 | 模块 | 首次 require |
| --- | --- | --- |
| 1 | `electron/settings.ts` | 5.2 ms |
| 2 | `electron/protocols/media-protocol.ts` | 4.2 ms |
| 3 | `electron/protocols/remote-protocol.ts` | 11.6 ms |
| 4 | `electron/netease/ipc.ts` | 10.5 ms |
| 5 | `electron/protocols/app-protocol.ts` | 1.2 ms |
| 6 | `electron/library-scan.ts` | 0.1 ms |
| 7 | `electron/updates.ts` | 2.5 ms |
| 8 | `electron/lyrics.ts` | 0.6 ms |
| 9 | `electron/tray.ts` | 0.7 ms |
| 10 | `electron/lyrics-overlay.ts` | 0.9 ms |

**这就是 Aurora 自己那层代码在「窗口出现之前」的全部加载成本。**
对比一下：上游包一次 require 是 1482.8 ms / 29.09 MB（GC 后常驻），
是整条 Aurora 启动链（37.9 ms / 1.04 MB）的 39.2 倍 / 27.9 倍。

口径：整链是 3 轮独立子进程的中位数；本机在跑其它任务时波动明显，
本次三轮分别是 38.0 ms / 37.5 ms / 37.9 ms，所以这个数字当**数量级**看，不要当常数。
内存侧的 1 MB 是稳定的（三轮几乎一致），可以当结论。

## 2. 上游/第三方包

每个包都在**独立子进程**里量，跑 3 轮取中位数（同进程连续量会互相预热，数字会假性变小；单次测量又容易被系统负载带偏）。

| 包 | 首次 require | 缓存命中（重复 3 次中位数） | 常驻内存增量（GC 后 heapUsed） | 分配瞬间 heapUsed | rss 增量 | 启动路径 | 能否推迟 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `@neteasecloudmusicapienhanced/api` | 1482.8 ms | 0.1 ms | 29.09 MB | 51.67 MB | 92.27 MB | 条件（懒加载；warmUpNetease 在窗口创建后调用） | 是 |  |
| `music-metadata` | 100.9 ms | 0.0 ms | 1.80 MB | 2.38 MB | 8.75 MB | 否（library-scan 内 dynamic import） | 已懒加载 |  |
| `electron` | 2.8 ms | 0.0 ms | < 1 MB（低于本口径噪声） | 194.8 KB | 690.0 KB | yes | 否 | 纯 node 下返回 electron.exe 路径字符串 |
| `express` | 231.6 ms | 0.0 ms | 3.91 MB | 5.07 MB | 14.89 MB | 间接（被 netease 包 require） | 是 |  |
| `jsdom` | 717.9 ms | 0.0 ms | 15.20 MB | 27.41 MB | 52.84 MB | 间接（被 netease 包 require） | 是 |  |
| `axios` | 116.9 ms | 0.0 ms | 4.25 MB | 5.18 MB | 15.91 MB | 间接（被 netease 包 require） | 是 |  |
| `yargs` | 31.9 ms | 0.0 ms | < 1 MB（低于本口径噪声） | 1.07 MB | 2.24 MB | 间接 | 是 |  |
| `qrcode` | 49.7 ms | 0.0 ms | < 1 MB（低于本口径噪声） | 1.16 MB | 5.32 MB | 间接 | 是 |  |
| `node-forge` | 46.3 ms | 0.0 ms | 2.02 MB | 2.77 MB | 4.07 MB | 间接 | 是 |  |
| `crypto-js` | 37.2 ms | 0.0 ms | 1.22 MB | 1.51 MB | 3.36 MB | 间接 | 是 |  |
| `xml2js` | 36.8 ms | 0.0 ms | < 1 MB（低于本口径噪声） | 1009.7 KB | 5.06 MB | 间接 | 是 |  |
| `pac-resolver` | 82.6 ms | 0.0 ms | 2.80 MB | 3.98 MB | 7.92 MB | 间接 | 是 |  |
| `fzstd` | 3.3 ms | 0.0 ms | < 1 MB（低于本口径噪声） | 280.3 KB | 652.0 KB | 间接 | 是 |  |

## 3. 上游包到底拉起了什么

一次 `require('@neteasecloudmusicapienhanced/api')` 之后，`require.cache` 共 **1539** 个模块，其中 node_modules 分组前 22 名：

| 包 | 模块数 |
| --- | --- |
| `@neteasecloudmusicapienhanced/api` | 468 |
| `jsdom` | 465 |
| `node-forge` | 42 |
| `xml2js` | 37 |
| `crypto-js` | 36 |
| `qrcode` | 35 |
| `cssstyle` | 35 |
| `rrweb-cssom` | 24 |
| `pngjs` | 22 |
| `ast-types` | 22 |
| `pac-resolver` | 15 |
| `parse5` | 14 |
| `ws` | 14 |
| `basic-ftp` | 14 |
| `whatwg-url` | 13 |
| `express` | 11 |
| `asynckit` | 10 |
| `tough-cookie` | 10 |
| `@tootallnate/quickjs-emscripten` | 10 |
| `get-uri` | 9 |
| `express-fileupload` | 9 |
| `math-intrinsics` | 8 |

该包 `module/` 目录下有 **449** 个 `.js` 文件，`main.js` 在加载时把它们**全部** require 一遍：

```js
// node_modules/@neteasecloudmusicapienhanced/api/main.js
const moduleFiles = fs.readdirSync(modulePath).reverse()
moduleFiles.forEach((file) => { ... require(filePath) ... })
Object.assign(module.exports, require('./server'))
```

Aurora 只用到其中 19 个端点（见 `electron/netease/client.ts` 的 `Upstream` 接口），却为 449 个文件付了加载成本。

`module/register_checktoken_v2.js` 在**文件顶部** `require('jsdom')`，而 `main.js` 会把 `module/` 下每个文件都 require 一遍，
于是 jsdom 连带 465 个模块被一并拉起——Aurora 从不调用这条端点。这是整个 +1482.8 ms 里最大的一块。

## 4. 「可推迟模块清单」

以下是**建议**（本任务只报告，不改 `electron/**`）。判定依据：该模块是否在窗口出现前就必须可用、以及它的加载成本。

| 优先级 | 模块 | 现状 | 建议 | 预估收益 |
| --- | --- | --- | --- | --- |
| P0 | `@neteasecloudmusicapienhanced/api` | client.ts 已懒加载，但 main.ts 在 app.whenReady 后立刻 `void warmUpNetease()`，于是窗口一出现就把这个包整个 require 了 | 把 warmUp 推迟到「用户真的要播在线歌曲 / 打开在线页」时；或者在 warmUp 前先 await 窗口 ready-to-show + 一个空闲回调 | 1482.8 ms / 29.09 MB |
| P1 | `electron/lyrics-overlay.ts` | main.ts 第 22-30 行顶层 import，whenReady 里 initOverlay() | 顶层改成 `import type` + 首次 toggleOverlay/桌面歌词时才动态 import | 1.1 ms / < 1 MB（低于本口径噪声） |
| P1 | `electron/updates.ts` | main.ts 第 10 行顶层 import | 顶层改成 `import type`，ipc handler 内 `await import("./updates")` | 2.0 ms / < 1 MB（低于本口径噪声） |
| P2 | `electron/lyrics.ts` | main.ts 第 11 行顶层 import | 顶层改成 `import type`，首次 lyrics:lookup 时动态 import | 0.8 ms / < 1 MB（低于本口径噪声） |
| P2 | `electron/netease/client.ts` | main.ts 第 7 行经 netease/ipc.ts 顶层 import | client 本体很轻，但它把 `require("@neteasecloudmusicapienhanced/api")` 的入口放在 warmUp 里；先解决 P0 即可 | 8.2 ms / < 1 MB（低于本口径噪声） |
| P3 | `（上游包整体）` | 一次性 require：1539 个模块，其中 jsdom 465 个；实测只 require 一个端点文件是 4 个模块 / 约 14 ms | 真正的大头不在 Aurora 的代码里。可选：换轻量客户端 / 只 require 需要的 module 文件 / 把上游放进 utilityProcess。属破坏性改造，需单独评估 | 1482.8 ms / 29.09 MB |

## 5. 同步 I/O 与主进程阻塞点（只报告，已给行号）

- `electron/main.ts:147`：`fs.readFileSync(stateFile(), "utf8")` — loadWinState()，createWindow() 里同步读窗口状态（启动路径上，阻塞主进程）。改成先构造窗口用默认尺寸再异步套用 bounds，或把 state 读成启动前的一次异步读。
- `electron/main.ts:166-167`：`fs.mkdirSync` + `fs.writeFileSync` — saveWinState()，resize/move 防抖 400ms 后同步写（不在启动路径，但会在拖动窗口时阻塞 UI 线程）。改 `fs.promises`。
- `electron/main.ts:186-200`：decodeText() 里同步 TextDecoder（CPU 而非 I/O），只在打开歌词/歌单时运行，影响可忽略。
- `electron/settings.ts:51`：`fs.readFileSync(settingsFile(), "utf8")` — loadSettings()，被 IPC 与各协议处理函数大量调用；有 cache，首次调用同步读一次。首次调用发生在哪个 IPC 上就在那里阻塞一次。
- `electron/settings.ts:72-73`：`fs.mkdirSync` + `fs.writeFileSync` — saveSettings()，每次改设置同步写。
- `electron/netease/client.ts:96`：`fs.existsSync` + `fs.writeFileSync` — loadUpstream() 首次 require 前建 anonymous_token 文件（官方包要求在 import 时文件已存在，无法异步化）。
- `electron/netease/client.ts:198/214/249`：`fs.writeFileSync` — 写 xeapi key / anonymous token / deviceId，都在 bootstrap 阶段。

## 6. CPU / 堆 profile

本次以 `--no-profile` 运行，未生成 profile。

## 7. 度量口径与已知限制

- **量的是刚编译的源码**：脚本把 `electron/**/*.ts` 编译到临时目录 `C:\Users\PC\AppData\Local\Temp\aurora-perf-main-build`（22 个 .js），而不是仓库里的 `dist-electron`。后者是共享构建产物、随时可能过期，且队友正在改 `electron/**` 时重建它会互相踩。
- **纯 node vs Electron**：`require('electron')` 在纯 node 下返回 `electron.exe` 的路径字符串，不是 Electron 模块。顶层就用 Electron API 的模块因此加载失败，报告里标为「无法在 node 中量化」并附上桩件数值，没有填估算值。
- **electron 桩件**：桩件改变了依赖图形状（真实 Electron 会拉起 Chromium 绑定），所以桩件数值只用于**模块之间的相对比较**。
- **RSS 噪声**：进程 RSS 受 V8 页分配与操作系统缓存影响，单次差值抖动可达数 MB。因此「常驻」列以强制 GC 后的 `heapUsed` 为准，`rss` 列只作参考。
- **模块间重复计算**：Aurora 自己的模块在同一个子进程里顺序度量（第三方包是每个一进程）。排在前面的模块会把共享依赖（如 `./settings`、`node:fs`）先加载掉，排在后面的模块增量里就不含这部分。所以「逐模块相加」只是排序工具，真实口径看 §1.2 的整链。
- **未覆盖**：`src/**`（渲染进程）与 Chromium/GPU 侧开销不在本脚本范围内。

### 为什么有些模块量不到真实数值

`require('electron')` 在纯 node 下不是 Electron 模块，而是 `node_modules/electron/index.js` 导出的
`D:\Aurora\node_modules\electron\dist\electron.exe` 字符串。于是：

- 顶层只做**引用**（`import { app } from 'electron'` 后仅在函数体内用 `app.getPath`）的模块，require 能走完，数字有效：`settings.ts`、`netease/client.ts`、`netease/session.ts` 等。
- 顶层就**取属性或调用** Electron API 的模块，require 立刻失败，数字无效：`main.ts`（读 `app.commandLine`）。
  这一类在表里标了 ✓，数值来自 electron 桩件。

本次在真实 electron 下失败的模块：

- `electron/main.ts`：需要 Electron 运行时（具体调用点见源码）。桩件下可量：4.6 ms / < 1 MB（低于本口径噪声）。

### 关于 `electron` 这个包本身

`require('electron')` 在纯 node 下只是读取 `node_modules/electron/index.js`，返回 `path.txt` 里记的 `electron.exe` 路径字符串。
所以在纯 node 下「加载 electron」几乎免费，真正的 Electron 绑定层成本只能在实际 Electron 主进程里量——那是本脚本做不到的部分。

## 8. 复现

```powershell
cd D:\Aurora
node scripts/perf-main.mjs                 # 度量 + 重新生成 docs/perf-main.md
node scripts/perf-main.mjs --json          # 只输出 JSON
node scripts/perf-main.mjs --no-profile    # 跳过 cpu/heap profile（快）
node scripts/perf-main.mjs --no-stub       # 跳过 electron 桩件那一轮
node --cpu-prof --heap-prof -e "require('@neteasecloudmusicapienhanced/api')"   # 官方给的单命令口径
```

脚本自己编译 `electron/**/*.ts` 到临时目录，不需要先跑 `npm run build:electron`，也不会写仓库里的 `dist-electron`。

profile 文件默认落在当前目录（即 `D:\Aurora`），本脚本改写到系统临时目录以免污染仓库：

```powershell
node --cpu-prof --heap-prof --cpu-prof-dir "$env:TEMP" --heap-prof-dir "$env:TEMP" -e "require('@neteasecloudmusicapienhanced/api')"
```

`.cpuprofile` 用 Chrome DevTools 的 Performance 面板打开，`.heapprofile` 用 Memory 面板打开。

### 手工复现「一次 require 到底多贵」

```powershell
cd D:\Aurora
$t0 = Get-Date; node -e "require('@neteasecloudmusicapienhanced/api')" | Out-Null; ((Get-Date) - $t0).TotalMilliseconds
```

```powershell
# 数一数这次 require 拉起了多少个模块
node -e "require('@neteasecloudmusicapienhanced/api'); console.log(Object.keys(require.cache).length)"
```

```powershell
# 只加载 Aurora 真正用到的那几个端点文件，对比一下（实测 4 个模块 / 约 14 ms）
node -e "const t0=process.hrtime.bigint(); require('@neteasecloudmusicapienhanced/api/module/song_url_v1.js'); const ms=Number(process.hrtime.bigint()-t0)/1e6; console.log('ms=', ms.toFixed(1), 'modules=', Object.keys(require.cache).length)"
```

### 手工复现整条启动 import 链

```powershell
cd D:\Aurora
node scripts/perf-main.mjs --no-profile --no-stub --json | Select-String -Pattern "chain" -Context 0,12
```

脚本内部把这条链放在**一个**子进程里顺序 require，量的是「窗口出现前」的真实加载成本（见 §1.2）。

