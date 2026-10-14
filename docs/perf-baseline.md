# Aurora 性能与后台占用 · 度量口径与基线（人读版）

> 这份文件是**四名优化队友读口径的地方**，也是「优化前 vs 优化后」的对照锚点。
> 数字本身由 `npm run perf` 自动生成到 [`docs/perf-report.md`](perf-report.md)（人读）与
> [`docs/perf-report.json`](perf-report.json)（机器读），**每次运行都会覆盖**。
> 本文件不自动生成：它负责解释**这些数字是什么、不是什么、以及怎么换算**。
>
> 主进程侧的度量（模块加载成本、常驻内存）是另一套装置，见 [`docs/perf-main.md`](perf-main.md)。

---

## 一、一句话结论（2026 基线，git `62adc25` + 工作区改动）

> 下面的结论描述的是**量级与方向**；精确数值永远看第五节里那段自动生成的表格。

1. **真正空闲时，Aurora 几乎不花 CPU。**「设置页 + 暂停播放」的渲染进程主线程忙时与 `about:blank`
   空白对照**在噪声内无法区分**（两者都在 0.8% 单核上下）。空闲态不是问题。
2. **前台持续烧 CPU 的是「60Hz 播放位置流」这条链，不是 340 粒子 Canvas。**
   同一条设置页，仅仅因为预览的合成音频驱动在跑（每帧写一次 `setPosition`），单核忙时就从约 0.8% 涨到约 5.8%，
   并且产生约 121 次/秒的 DOM 属性变更，其中 **99% 落在 `div.bar__fill` / `div.bar__knob`（进度条）**。
   再加舞台 canvas 才涨到约 12%。**先修位置流链，再修 canvas。**
3. **没有任何掉帧。** 所有可见场景 p95 帧间隔 16.8–17.0 ms，最大 17.4 ms，>33 ms 的帧 **0 个**，
   Long Task **0 次**。所以这一轮的问题是**持续 CPU 占用与耗电**，不是卡顿——用「帧率」去验收优化会看不见收益，
   必须用忙时百分比与 DOM 变更次数验收。
4. **根组件渲染次数在采样窗口内全是 0**（载入以来累计 4–5 次）。`#perf` 基准屏历史上记录的
   「6 秒 4 次渲染」这次是 6 秒 0 次，说明「把 playhead 订阅下沉到叶子组件」的优化仍然成立、没有回归。
   注意：这也意味着**根渲染次数这个指标现在测不出东西了**，要继续用它验收，得先落地第七节的探针去数叶子组件。

---

## 二、复现命令（Windows PowerShell 5.1 可用）

```powershell
cd D:\Aurora

npm run perf                                  # 构建预览产物 + 采集 7 个场景 + 覆盖两份报告
node scripts/perf-report.mjs --no-build       # 复用已有 preview-dist，快速重测
node scripts/perf-report.mjs --no-build --duration=10000 --settle=4000
node scripts/perf-report.mjs --no-build --only=playing-stage,idle-paused
node scripts/perf-report.mjs --counters=perf-counters.json    # 并入外部计数（见第七节）
```

- 一条命令跑完，全程不需要装任何 npm 依赖（用 Node 内置 `WebSocket` 直连 CDP）。
- 只写 `docs/perf-report.md`、`docs/perf-report.json`，以及 `scripts/perf-*`。
- 默认采样 6000 ms/场景、settle 3000 ms，7 个场景约 70 秒。
- **构建会读取当前工作区**：如果 `src/**` 有未提交改动，报告里的「工作区脏文件数」和产物指纹会变，
  换版本对比时必须以产物指纹（sha256 前 16 位）对齐，不能只看 git rev。

---

## 三、采集口径（每条指标的精确定义）

| 指标 | 精确定义 | 数据来源 | 单位 |
| --- | --- | --- | --- |
| **主线程忙时** | 采样窗口内渲染进程主线程花在 task 上的累计时间 | CDP `Performance.getMetrics` 的 `TaskDuration` 增量 | ms |
| **主线程忙时占单核** | `TaskDuration 增量 ÷ 窗口墙钟时间` | 同上 | % |
| **Script / Layout / Style** | 上面那部分时间分别花在 JS、布局、样式重算上 | `ScriptDuration` / `LayoutDuration` / `RecalcStyleDuration` | ms |
| **渲染进程 CPU** | 采样窗口内 `type=renderer` 的那个进程消耗的 CPU 时间（含栅格化等非主线程工作） | 浏览器级 CDP `SystemInfo.getProcessInfo` 的 `cpuTime` 增量 | ms / % |
| **rAF 帧间隔 p50/p95/p99/max** | 采样器自己的 rAF 回调时间戳之差的分位数 | 页内 `requestAnimationFrame` | ms |
| **fps** | `帧数 ÷ 窗口时长` | 同上 | 帧/秒 |
| **Long Task** | 单个 task 超过 50 ms 的次数与总时长 | 页内 `PerformanceObserver({type:'longtask'})` | 次 / ms |
| **JS 堆** | `performance.memory.usedJSHeapSize` 在窗口首尾的差 | 页内，需 `--enable-precise-memory-info` | KB |
| **DOM 节点数** | `document.getElementsByTagName('*').length` 在窗口首尾的差 | 页内 | 个 |
| **DOM 变更** | 窗口内 `MutationObserver` 收到的 record 条数（childList + characterData + attributes），并给出变更最多的节点与样本 | 页内 `MutationObserver(subtree)` | 条 / 条每秒 |
| **根组件渲染次数** | `window.__auroraRenders` 在窗口首尾的差（沿用 `src/App.tsx` 里已有的 preview-only 计数器） | 页内 | 次 |
| **位置写入次数** | **不是测出来的**：`#perf` 屏跑 `setInterval(1000/60)`，预览的合成驱动每帧又写一次，所以按构造是 60 或 120 次/秒 | 代码事实（`src/App.tsx` / `src/player/driver.ts`） | 次/秒 |
| **进程 CPU（全部进程）** | 窗口内 browser+renderer+GPU+utility 全部进程的 `cpuTime` 增量之和 | 浏览器级 CDP `SystemInfo.getProcessInfo` | ms |

### 3.1 百分比换算（**必读，否则会误读 10 倍以上**）

本机 **24 个逻辑核心**。所有「%」列默认都是**占单个核心**的百分比。Windows 任务管理器显示的是**占全部核心**的百分比：

```
占全部核心 % = 占单核 % ÷ 逻辑核心数
```

实例（24 核机器）：

| 单核读数 | 占全部核心（任务管理器口径） |
| --- | --- |
| 0.72%（真正空闲） | **0.030%** |
| 5.79%（前台，只有位置流在跑） | **0.241%** |
| 12.09%（前台，位置流 + 极光粒子） | **0.504%** |

- 换算公式里的核心数在报告头部的「逻辑核心」一行，换机器要重算。
- 8 核笔记本上同样的 12.09% 单核 ≈ 1.51% 全机；核越少，同一个单核读数在全机占比越大。
- **为什么仍然要盯单核百分比**：一条 rAF/定时器循环最多只能吃掉一个核，所以它的上限就是 `1 ÷ 核心数`。
  它不会把多核跑满，但它会**持续占用一个核**——阻止 CPU 进入深度 idle、增加耗电与风扇，也会和音频线程抢时间。
  用户说的「后台占用」正是这一块，而不是全机百分比。
- 报告里另有一列「渲染进程 CPU 占全部核心」，可以直接和任务管理器的数字对照。

### 3.2 为什么要减掉空白对照

`control-blank`（同参数下的 `about:blank`）渲染进程也要烧掉约 **94 ms / 5 s（1.88% 单核）**：
那是 Edge 自身的 browser/GPU/utility 服务、CDP 通道、以及**我自己的 rAF 采样器**。
`docs/perf-report.md` 里有一张「减掉对照后」的表。读「渲染进程 CPU」时请做减法，
读「主线程忙时」（TaskDuration）时基本可以直接读。

---

## 四、场景定义

| id | 场景 | 页面 | 特殊处理 |
| --- | --- | --- | --- |
| `control-blank` | 对照·空白页 | `about:blank` | 量装置自身开销 |
| `idle-paused` | **空闲（任务要求）** | `#settings` | 用 UI 上的暂停按钮停掉播放，验证方式：暂停后 DOM 变更残值必须是 0 |
| `playing-settings` | 参照·前台无 stage | `#settings` | 不暂停；单独量「60Hz 位置写入 → 进度条」这一条链 |
| `idle-perf` | 参照·历史基准屏 | `#perf` | stage 未挂载；`setInterval(1000/60)` + 合成驱动 ≈ 120 次/秒位置写入 |
| `playing-stage` | **播放中（任务要求）** | `#stage` | 极光 ribbon + 340 粒子 canvas 每帧重绘 |
| `hidden-stage-electron` | **不可见（任务要求）** | `#stage` | 前台播放后切到另一个标签页（`document.hidden=true`），带 Electron `backgroundThrottling:false` 的三条等效开关 |
| `hidden-stage-browser` | 不可见·对照 | `#stage` | 同上但不加任何反节流开关 |

> **为什么必须有 `idle-paused` 而不能直接用 `#settings`**：浏览器预览的启动引导会 `player.playQueue(demoLibrary)` 自动起播，
> 而预览的**合成音频驱动**（`src/player/driver.ts:62-79`）在 `requestAnimationFrame` 里每帧调用 `store.setPosition()`，
> 且**没有做任何可见性判断**。所以「打开设置页」根本不是空闲态，它自带一个 60Hz 写 store 的循环。
> 只有点真实的暂停按钮才能得到真正静止的页面（脚本会验证暂停后 DOM 变更残值为 0，否则打警告）。

---

## 五、基线数字表

### 5.0 基线锚点（优化前，已冻结）

这一组是**优化工作开始之前**的读数，三期数值一致，用作对照锚点。它对应的产物指纹是：

```
aurora-preview-settings.html  25942f4b85460371   386896 bytes
aurora-preview-perf.html      1284d114dfc15dad   386892 bytes
aurora-preview-stage.html     8afdc2a04abde9bb   386893 bytes
```

| 场景 | 忙时占单核（三期读数 → 中位） | 渲染进程 CPU 占单核 | DOM 变更/秒 |
| --- | --- | --- | --- |
| `control-blank` 对照·空白 | 0.79 / 0.83 / 0.83 → **0.83%** | 1.88% | 0 |
| `idle-paused` **空闲** | 0.78 / 0.80 / 0.72 → **0.78%** | 1.60% | **0** |
| `playing-settings` 参照·无 stage | 5.86 / 6.20 / 5.79 → **5.86%** | 9.11% | **121.4** |
| `idle-perf` 参照·基准屏 | 7.18 / 6.77 / 7.02 → **7.02%** | 11.21% | **246.4** |
| `playing-stage` **播放中** | 12.31 / 12.26 / 12.09 → **12.26%** | 18.09% | **185.1** |
| `hidden-stage-electron` **不可见** | 0.09 / 0.05 / 0.05 → **0.05%** | 0.23% | 0 |
| `hidden-stage-browser` 不可见·对照 | 0.05 / 0.13 / 0.05 → **0.05%** | 0.23% | 0 |

其他基线事实：Long Task 全部 0 次；>33 ms 的帧 0 个；根组件渲染在采样窗口内全部 0 次；
`playing-settings` 的 DOM 变更里 `div.bar__fill` / `div.bar__knob` 各约 300 条（99% 来自进度条，60/秒）。

> ⚠ **这个产物在磁盘上已经不存在了。** 基线采完之后，队友并行改 `src/**` 并重新跑了
> `npm run preview`，`preview-dist/` 被覆盖成新的构建（指纹变为 `3b8e2e96…` / `6a4fe89f…` / `094ff694…`）。
> 所以 5.0 是**已记录的历史锚点**，无法在本地原样复现；要复现只能回退到产生它的那次工作区状态。
> 这正是 `npm run perf` 把产物指纹写进报告的原因：**没有指纹的对比不算对比。**

### 5.1 最近一次运行的自动读数

> 下面这段（标记 `PERF-MEASURED`）由 `npm run perf` **自动覆盖**，不要手改。
> 它记录的是最近一次运行的原始数字与产物指纹——**很可能已经是队友改过之后的构建**。
> 与 5.0 对比之前，先确认两边指纹不同，并把工作区改动一并考虑进去。

<!-- PERF-MEASURED-BEGIN -->
- 生成时间：2026-10-14T14:46:33.683Z
- git：`79922951a2498c8074bc012688bfd53b80e22c6c`（main），工作区脏文件 0 个
- 环境：Edge Edg/155.0.4283.45 / `--headless=new` / Node v24.19.0 / 24 逻辑核心
- 采样：每场景 6000 ms（settle 3000 ms），构建 已执行
- **产物指纹（对比时必须一致）**：settings 36513937ea0367b4，perf ea20ebebb2fe4509，stage 13761e89bc187b96

| 场景 | 主线程忙时 (ms) | 忙时占单核 | 渲染进程 CPU 占单核 | 占全部核心 | DOM 变更 | 变更/秒 | JS 堆增量 | DOM 节点 | p95 帧间隔 (ms) | Long Task |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `idle-paused` 空闲（要求场景） | 43.9 | 0.73% | 1.56% | 0.065% | 0 | 0 | 23 KB | 312 | 17.10 | 0 |
| `playing-settings` 参照·前台无 stage | 123.1 | 2.05% | 3.60% | 0.150% | 105 | 17.46 | 229 KB | 312 | 17.10 | 0 |
| `playing-stage` 播放中（要求场景） | 345 | 5.74% | 9.73% | 0.405% | 172 | 28.61 | -949 KB | 258 | 16.90 | 0 |
<!-- PERF-MEASURED-END -->

### 5.2 重复运行的噪声范围（**决定「多大的改善才算改善」**）

同一份产物、同样参数连续跑，`主线程忙时占单核` 的抖动约 **±0.3 个百分点**
（实测 `playing-settings` 三次：5.86% / 6.20% / 5.79%；`idle-paused`：0.80% / 0.78% / 0.72%）。

> **判定规则：前后差异小于 0.5 个百分点的，不要声称是优化。** 需要更稳的数字时，把
> `--duration` 提到 10000–15000 再跑，或同一配置连跑 3 次取中位数（报告 JSON 里有每次的原始值）。
>
> 另外：**机器上同时有别人跑浏览器探针或构建时，噪声会明显变大**——实测空白对照的渲染进程 CPU
> 在忙时从 1.68% 单核涨到 2.13%。前后对比必须在同一台机器、同一负载条件下做。

### 5.2.1 **跨会话的数字不能直接比较**（实测踩到过）

上面表格里的历史数字（以及本文档各处引用的「优化后」数值）是**当时那一次会话**的产物。
机器状态、后台负载、Chromium 版本、甚至是当天的驱动行为都会变，所以**拿表里的旧数字和今天
刚测的数字对比，会得出错误结论**。

实测例子：本文档记录 `playing-stage` 优化后为 4.71%；重构数周后在本机重测为 5.74%，看着像
退化 1 个百分点。于是用 `git worktree` 检出记录那个数字的提交（`616d3a6`），在同一台机器、
同一时段、同样参数下重测同一场景，得到 **5.95%** —— 也就是说当前代码**比基线还略快**，
那个「退化」只是两次会话之间的漂移。如果直接采信跨会话对比，就会去修一个不存在的问题。

**做前后对比的正确做法**：

```bash
# 1. 建一个对照工作树（共享主仓库的 node_modules，不必重装）
git worktree add D:\Aurora-baseline <要对比的提交>
cmd /c mklink /J "D:\Aurora-baseline\node_modules" "D:\Aurora\node_modules"

# 2. 两个工作树里跑同样的场景与参数，交替各跑一次
cd D:\Aurora-baseline ; npm run perf -- --only=playing-stage --runs=3
cd D:\Aurora          ; npm run perf -- --only=playing-stage --runs=3

# 3. 用完清理
cmd /c rmdir "D:\Aurora-baseline\node_modules"
git worktree remove D:\Aurora-baseline --force
```

**只有同一次会话里、同一台机器上、交替测出的差异才可作为依据。**

### 5.3 三条容易读错的细节

- **DOM 变更归属**：`playing-settings` 的几百条变更里，`div.bar__fill` 与 `div.bar__knob` 各占一半，
  即 **99% 来自进度条的两个 style 属性**，频率 60.0 次/秒；`span.seek__time` 只有 5 条（每秒换一次秒数，正常）。
  `playing-stage` 在此基础上多出 `div.stage__track-fill` 约 300 条（舞台进度条，同样 60/秒）。
- **Long Task**：全部场景 0 次。**没有任何一次主线程卡顿。**
- **JS 堆**：`idle-perf`（120 次/秒位置写入）窗口内涨得最多，是最能说明「高频写入 → 分配」的一条；
  `playing-stage` 反而会下降（GC 抵消）。**单次窗口的堆增量噪声很大，只能看趋势，不能当泄漏证据。**
  泄漏判定需要多轮同类场景对比（跑 3 次以上看是否单调上升）。

> 5.0 是**手工冻结**的历史锚点（不会再变）；5.1 是**每次运行自动覆盖**的最新读数。
> 两者的产物指纹不同是正常的，对比时必须说明各自对应哪次工作区状态。

---

## 六、这个口径测不出什么（**最重要的一节**）

### 6.1 本装置的「不可见」≠ Electron 的「不可见」（但有一条重要的例外）

**基线构建的实测**（`hidden-stage-electron`，指纹 `8afdc2a0…`）：页面切到后台后，即使加上
`--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`
（这是 Electron `backgroundThrottling: false` 在浏览器里的等效开关），渲染器**依然完全停止产帧**：
fps = 0、主线程忙时 0.05%、DOM 变更 0 条/秒、渲染进程 CPU 0.30%。

**浏览器无法复现 Electron「隐藏后 rAF 继续跑」。** 所以：

- **rAF 驱动的隐藏态工作，本装置测不出来**（帧停了，`requestAnimationFrame` 链就断了）。
- **定时器驱动的隐藏态工作，本装置测得出来。** 只要带上
  `--disable-background-timer-throttling`，`setInterval` 就会按真实节奏跑；而 Electron 的
  `backgroundThrottling: false` 正是这个开关的等效物。所以**计时器路径的隐藏开销，`hidden-stage-electron`
  这一行是可以直接当真的**（`hidden-stage-browser` 那一行是节流后的对照，不要用来代表 Electron）。

> 这条区分现在很要紧：当前工作区的新构建已经给播放位置加了**可见性策略**——
> 可见时走 rAF，隐藏时改用 `setInterval(advance, 250ms)`（见 `src/player/driver.ts` 的 `armClock`）。
> 实测在隐藏态下（带反节流开关）它仍然保持约 **16.7 次/秒的 DOM 变更**
> （对比基线构建的 0 次/秒）——**这是设计使然，不是 bug**，但它意味着「看不见就不花代价」这条性质
> 在新实现里不再自动成立，必须靠这个口径持续盯着。
> 而浏览器默认节流下同一场景只有约 4 次/秒——**两个数字差了 4 倍，用错那一行就会低估隐藏开销。**

另外有一条**代码事实**（读代码得到，不是实测），指基线构建：真实音频路径 `src/player/engine.ts` 的
`startTicker()` 只用 `pause()` 停止，**没有任何可见性判断**，而 `src/stage/Visualizer.tsx` 有
（`visibilitychange → stop()`）。也就是说当时隐藏时 **canvas 会停、位置流不会停**。当前工作区已经
在改这两处，改完要用本装置重测，不要沿用这条描述。

### 6.2 其他测不出的项

| 指标 | 状态 | 原因 / 需要什么 |
| --- | --- | --- |
| zustand store 通知次数 | **未采集** | store 在模块作用域内，页面侧拿不到。需要第七节的探针，或用 `--counters` 并入外部计数 |
| 主进程 → 渲染层 IPC 条数（含 `library:progress`） | **未采集** | 浏览器预览**没有 preload / ipcRenderer**，这条通道完全不经过本装置。需要 Electron 运行时探针，或用 `--counters` 并入 |
| GPU / 合成器耗时 | 未采集 | headless 下合成与栅格化走软件/SwiftShader 路径，不代表真实窗口的 GPU 开销 |
| 真实窗口（非 headless）的整机占用 | 未采集 | 本机进程沙箱起不了 Chromium/Electron 窗口 |
| 音频解码 / AudioContext 频谱成本 | 未采集 | 预览里没有真实音频文件，`getSpectrum()` 返回的是合成频谱 |
| Electron 主进程占用 | 未采集 | 见 [`docs/perf-main.md`](perf-main.md)（模块加载与常驻内存是另一套装置） |

### 6.3 两条采样器自身的偏差（必须知道，否则会读错数字）

1. **fps 会高估「应用在画」。** 采样器自己持有一个 `requestAnimationFrame` 回调，只要它在，渲染器就会持续产帧。
   所以 `fps≈60` 的真实含义是「帧时钟在跑」，**不是**「应用在动」。
   判断应用是否真在干活，看**主线程忙时、根渲染次数、DOM 变更**三条。
   反过来 `fps = 0` 是可信的：它说明渲染器连帧都不产了。
2. **`MutationObserver` 本身有开销。** 它按 record 计数，会与热循环抢时间。
   但所有场景用的是同一个观察者配置，**横向对比仍然成立**；不要拿它的绝对值和其它工具比。

---

## 七、缺口与探针方案（**需 Lead 批准后才能进产品代码**）

按当前分工，`src/**` 与 `electron/**` 不属于本任务，所以下面**只是方案，没有落地**。

### 7.1 契约：探针只需往页面上挂两个全局对象

`scripts/perf-report.mjs` **已经支持**读取它们并自动算窗口增量，探针一落地，`npm run perf` 立刻能报数：

```ts
// 单调递增、从页面载入起累计；形状宽松，下面任一写法都能被识别
window.__auroraPerfStore = { count: 20000, byStore: { library: 12000, player: 8000 } }
window.__auroraPerfIpc   = { count: 10002, byChannel: { 'library:progress': 10002 } }
// 也可以挂在同一个命名空间下：
window.__auroraPerf = { store: {...}, ipc: {...} }
```

要求只有两条：**单调递增**（harness 取窗口首尾差值）、**字段名属于
`count / notifies / notifications / sent / messages / total / calls` 之一**（数字也可以直接给）。

### 7.2 store 通知次数：一个新文件 + 一行受保护调用

```ts
// 新增 src/perf-probe.ts（唯一的新文件）
import { useLibrary } from './library/store'
import { usePlayer } from './player/store'
// …其余 store

export function installPerfProbe(): void {
  const w = window as Window & { __auroraPerfStore?: unknown }
  if (w.__auroraPerfStore) return
  const probe = { count: 0, byStore: {} as Record<string, number> }
  w.__auroraPerfStore = probe
  for (const [name, store] of Object.entries({ library: useLibrary, player: usePlayer /* … */ })) {
    probe.byStore[name] = 0
    store.subscribe(() => {
      probe.count += 1
      probe.byStore[name] += 1
    })
  }
}
```

在 `src/main.tsx` 里加**一行**，用项目已有的 `isNative` 守卫（Electron 里永远不执行，对线上零成本）：

```ts
if (!isNative) installPerfProbe()
```

- **不需要改任何 store 文件**，因为探针自己 import store 并订阅。
- **可移除性**：删掉 `src/perf-probe.ts` + 删掉那一行即可，没有第二个改动点。
- **观察者效应**：多一个订阅者，每次通知多两次 `++`（实测应 <0.1% 单核，落地后本装置能量出来）。

### 7.3 IPC 条数：只能来自 Electron 侧

浏览器预览里根本没有 IPC。两条路：

1. 在 `electron/main.ts` 创建窗口处**包一次 `webContents.send`**（零调用点改动，
   用 `process.env.AURORA_PERF === '1'` 守卫），把 `{count, byChannel}` 暴露出来；
2. 或者沿用 bg-perf 已有的探针（他已给出 `library:progress` 10002 → 33 的前后对比），
   **把结果写成一个 JSON 文件交给本装置**：

```json
{
  "windowMs": 5000,
  "ipcMessages": 10002,
  "ipcByChannel": { "library:progress": 10002 },
  "storeNotifications": 20000,
  "storeByStore": { "library": 20000 },
  "source": "electron 侧探针 / bg-perf",
  "note": "5000 首扫描期间"
}
```

```powershell
node scripts/perf-report.mjs --counters=perf-counters.json
```

报告会把这段数字连同**文件路径与 sha256** 一起写进「第五节 外部计数」，来源可追溯，不会被误当成实测值。

---

## 八、给优化队友的验收约定

1. **改前跑一次、改后跑一次，用同一台机器、同一组参数**，并且对比 `--no-build` 下的**同一份产物指纹**
   （`npm run perf` 会重新构建，指纹会变——对比时应各自记录指纹，而不是假设没变）。
2. **主验收指标**：`主线程忙时占单核` 与 `DOM 变更/秒`。这两个直接对应「后台占用」。
3. **不要用帧率验收**：基线里根本没有掉帧（0 个 >33 ms 的帧），帧率不会动。
4. **根组件渲染次数**在本口径下已经是 0，如果优化目标是它，需要改成统计**叶子组件渲染**或先落地 7.2 的探针。
5. 任何「优化后」的数字如果**没有同时给出改动前后的产物指纹**，不接受。
