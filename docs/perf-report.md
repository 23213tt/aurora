# Aurora 性能基线（可复现报告）

生成时间：2026-10-14T14:44:40.102Z

本文件由 `npm run perf` 自动生成，**不要手改**。口径定义、局限与「测不出什么」写在 `docs/perf-baseline.md`，本文件只放数字与复现信息。

## 一、复现命令

```powershell
cd D:\Aurora
npm run perf                      # 构建预览产物 + 采集 + 写报告
node scripts/perf-report.mjs --no-build            # 复用已有产物，快速重测
node scripts/perf-report.mjs --no-build --duration=10000 --only=playing-stage
```

## 二、环境与锚点

| 项 | 值 |
| --- | --- |
| 浏览器 | Edg/155.0.4283.45（`--headless=new`） |
| 页面 | `file:///…/preview-dist/*.html`（自包含，无服务器） |
| git HEAD | `cc7e83ad98a1c3e4b8d74914c93bdc5f2b34e385` (main) |
| 工作区脏文件数 | 4 |
| 采样窗口 | 6000 ms（settle 3000 ms） |
| Node / OS | v24.19.0 / Windows_NT 10.0.26200 |
| 逻辑核心 | 24 |
| CPU | Intel(R) Core(TM) i7-14650HX |
| 实测产物指纹 | settings `36513937ea0367b4`，perf `ea20ebebb2fe4509`，stage `13761e89bc187b96` |

> 工作区有未提交改动，这份基线锚定的是「当前工作树」而不是一个干净的提交。对比前后必须用同一批文件状态。

改动文件（前 12 个）：

- `M docs/perf-baseline.md`
- ` M docs/perf-report.json`
- ` M docs/perf-report.md`
- ` M src/features/player/Bar.tsx`

## 三、基线数字表

| 场景 | document.hidden | rAF fps | 帧间隔 p50 / p95 / max (ms) | 主线程忙时 (ms) | 主线程忙时占单核 | 渲染进程 CPU 占单核 / 占全部核心 | 长任务数/总时长 | 根组件渲染 | DOM 变更/秒 | JS 堆增量 (KB) | DOM 节点增量 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 对照·空白页 `control-blank` | false | 60.01 | 16.70 / 17 / 17.20 | 43 | 0.72% | 1.51% / 0.063% | 0 / 0 ms | — | 0 | 23.4 | 0 |
| 空闲（要求场景） `idle-paused` | false | 59.95 | 16.70 / 17 / 17.50 | 46.1 | 0.77% | 1.57% / 0.065% | 0 / 0 ms | 0 | 0 | 23.0 | 0 |
| 参照·前台无 stage `playing-settings` | false | 59.87 | 16.70 / 16.90 / 17.60 | 132 | 2.20% | 3.78% / 0.158% | 0 / 0 ms | 0 | 17.46 | 225.4 | 0 |
| 参照·历史基准屏 `idle-perf` | false | 60.08 | 16.70 / 16.90 / 17.30 | 156.1 | 2.60% | 4.60% / 0.191% | 0 / 0 ms | 0 | 20.47 | 562.9 | 0 |
| 播放中（要求场景） `playing-stage` | false | 59.99 | 16.70 / 16.90 / 17.30 | 354.3 | 5.90% | 9.75% / 0.406% | 0 / 0 ms | 0 | 28.66 | -576.6 | 0 |
| 不可见（要求场景） `hidden-stage-electron` | true | 0 | — / — / — | 11 | 0.18% | 0.31% / 0.013% | 0 / 0 ms | 0 | 1.66 | 83.5 | 0 |
| 不可见·对照 `hidden-stage-browser` | true | 0 | — / — / — | 5 | 0.08% | 0.30% / 0.013% | 0 / 0 ms | 0 | 0 | 13.7 | 0 |

> ⚠ **rAF 帧数会高估「应用在画」**：采样器自己持有一个 `requestAnimationFrame` 回调，只要它在，渲染器就会持续产帧。所以 `fps≈60` 的含义是「帧时钟在跑」，不是「应用在动」。判断应用是否真在干活，看主线程 TaskDuration、根渲染次数和 DOM 变更三条。反过来，`fps=0` 是可信的：它说明渲染器连帧都不产了。

场景定义：

- `control-blank`（对照·空白页）：同一套启动参数下的 about:blank。用来量「这个装置自己」的开销：Edge 的 browser/GPU/utility 服务、CDP 通道、我自己的 rAF 采样器。从其它场景的进程 CPU 里减掉它，才是应用自己的成本。 页面：`preview-dist/aurora-preview-null.html#null`
- `idle-paused`（空闲（要求场景））：设置页 + 用 UI 上的暂停按钮停掉播放。无 stage、无 60Hz 位置流、界面静止。这是本装置能给出的最接近「真正空闲」的一档。 页面：`preview-dist/aurora-preview-settings.html#settings`
- `playing-settings`（参照·前台无 stage）：同一个设置页但不暂停。预览的合成音频驱动每帧向 store 写一次播放位置，用来单独量「60Hz 位置写入 → 进度条重渲染」这一条路径的成本。 页面：`preview-dist/aurora-preview-settings.html#settings`
- `idle-perf`（参照·历史基准屏）：历史基准屏 #perf：stage 未挂载，setInterval(1000/60) 与合成驱动各写一次位置，合计约 120 次/秒。根组件渲染次数的历史口径就是这一屏。 页面：`preview-dist/aurora-preview-perf.html#perf`
- `playing-stage`（播放中（要求场景））：沉浸舞台：极光 ribbon + 340 粒子 canvas 每帧重绘，合成驱动 60Hz 写播放位置。 页面：`preview-dist/aurora-preview-stage.html#stage`
- `hidden-stage-electron`（不可见（要求场景））：先在前台播放，再切到另一个标签页（document.hidden=true）。带 Electron backgroundThrottling:false 的三条等效开关。 页面：`preview-dist/aurora-preview-stage.html#stage`
- `hidden-stage-browser`（不可见·对照）：同上，但不给任何反节流开关，即浏览器默认行为。用来看「停渲染」是否真的发生。 页面：`preview-dist/aurora-preview-stage.html#stage`

### 减掉装置自身的开销

`control-blank`（同一套参数下的 about:blank）里渲染进程也烧掉了 90.7 ms（占单核 1.51%），浏览器全部进程 275.8 ms（占单核 4.59%）——这部分是 Edge 自身服务、CDP 通道和我自己的采样器，不是 Aurora。

读「进程 CPU」一列时请做减法：`场景渲染进程 ms − control-blank 渲染进程 ms`。主线程忙时（TaskDuration）那一列基本不受此影响，可以直读。

| 场景 | 渲染进程 CPU (ms) | 减掉对照后 (ms) |
| --- | --- | --- |
| `idle-paused` | 94.2 | 3.5 |
| `playing-settings` | 227.3 | 136.6 |
| `idle-perf` | 276.1 | 185.4 |
| `playing-stage` | 584.8 | 494.1 |
| `hidden-stage-electron` | 18.7 | -72 |
| `hidden-stage-browser` | 18.3 | -72.4 |

## 四、逐场景明细

### `control-blank` — 对照·空白页

- 可见性：document.visibilityState = `visible`，采到 rAF 帧 361 帧 / 6016.1 ms
- 帧间隔：p50 16.70，p95 17，p99 17.20，max 17.20，>33.4ms 的帧 0 个
- 渲染进程主线程：TaskDuration 43 ms（占单核 0.72%），其中 Script 7 ms / Layout 0 ms / Style 0 ms
- 进程 CPU：渲染进程 90.7 ms（占单核 1.51%，占全部 24 核 0.063%）；浏览器全部进程合计 275.8 ms（占单核 4.59%）
  - 分进程：browser 105.5ms，renderer 90.7ms，GPU 59.1ms，network.mojom.NetworkService 20.3ms，storage.mojom.StorageService 0ms，edge_collections.mojom.CollectionsDataManager 0ms，entity_extraction_service.mojom.Extractor 0ms，winrt_app_id.mojom.WinrtAppIdService 0.2ms
- 根组件渲染 未采集（—，载入以来累计 — 次）
- DOM 变更 0 条（0 条/秒；childList 0，characterData 0，attributes 0）
- 探针计数：store 通知 未采集；IPC 条数 未采集
- 内存：JS 堆 0.56 MB（窗口内增量 23.4 KB），DOM 节点 3（增量 0）
- 页面自检：canvas 0 个，根节点子元素 0，内置错误捕获器：无

### `idle-paused` — 空闲（要求场景）

- 可见性：document.visibilityState = `visible`，采到 rAF 帧 360 帧 / 6005.2 ms
- 帧间隔：p50 16.70，p95 17，p99 17.40，max 17.50，>33.4ms 的帧 0 个
- 渲染进程主线程：TaskDuration 46.1 ms（占单核 0.77%），其中 Script 7 ms / Layout 0 ms / Style 0 ms
- 进程 CPU：渲染进程 94.2 ms（占单核 1.57%，占全部 24 核 0.065%）；浏览器全部进程合计 463 ms（占单核 7.71%）
  - 分进程：browser 298.3ms，renderer 94.2ms，GPU 56.2ms，network.mojom.NetworkService 13.8ms，storage.mojom.StorageService 0.3ms，edge_collections.mojom.CollectionsDataManager 0ms，entity_extraction_service.mojom.Extractor 0.1ms，winrt_app_id.mojom.WinrtAppIdService 0.3ms
- 根组件渲染 0 次（0 次/秒，载入以来累计 5 次）
- DOM 变更 0 条（0 条/秒；childList 0，characterData 0，attributes 0）
- 探针计数：store 通知 未采集；IPC 条数 未采集
- 内存：JS 堆 3.13 MB（窗口内增量 23.0 KB），DOM 节点 312（增量 0）
- 页面自检：canvas 0 个，根节点子元素 1，内置错误捕获器：无
- ⚠ 已点击「暂停」（点击后标签：暂停）；暂停后 DOM 变更残值 0 条/秒。

### `playing-settings` — 参照·前台无 stage

- 可见性：document.visibilityState = `visible`，采到 rAF 帧 360 帧 / 6012.6 ms
- 帧间隔：p50 16.70，p95 16.90，p99 17.30，max 17.60，>33.4ms 的帧 0 个
- 渲染进程主线程：TaskDuration 132 ms（占单核 2.20%），其中 Script 42.9 ms / Layout 4.3 ms / Style 7.9 ms
- 进程 CPU：渲染进程 227.3 ms（占单核 3.78%，占全部 24 核 0.158%）；浏览器全部进程合计 2087.1 ms（占单核 34.72%）
  - 分进程：browser 1441.2ms，renderer 227.3ms，GPU 198ms，network.mojom.NetworkService 47.6ms，storage.mojom.StorageService 35.4ms，edge_collections.mojom.CollectionsDataManager 17.7ms，entity_extraction_service.mojom.Extractor 24.9ms，winrt_app_id.mojom.WinrtAppIdService 95ms
- 根组件渲染 0 次（0 次/秒，载入以来累计 4 次），每次位置写入对应 0 次根渲染
- DOM 变更 105 条（17.46 条/秒；childList 0，characterData 6，attributes 99）
  - 变更最多的节点：`div.bar__fill` 48；`div.bar__knob` 48；`span.seek__time` 6；`div.bar` 3
  - 样本：attributes@div.bar__fill(style)，attributes@div.bar__knob(style)，attributes@div.bar__fill(style)，attributes@div.bar__knob(style)
- 探针计数：store 通知 未采集；IPC 条数 未采集
- 内存：JS 堆 3.18 MB（窗口内增量 225.4 KB），DOM 节点 312（增量 0）
- 页面自检：canvas 0 个，根节点子元素 1，内置错误捕获器：无

### `idle-perf` — 参照·历史基准屏

- 可见性：document.visibilityState = `visible`，采到 rAF 帧 361 帧 / 6008.7 ms
- 帧间隔：p50 16.70，p95 16.90，p99 17.10，max 17.30，>33.4ms 的帧 0 个
- 渲染进程主线程：TaskDuration 156.1 ms（占单核 2.60%），其中 Script 58.3 ms / Layout 4.6 ms / Style 7.8 ms
- 进程 CPU：渲染进程 276.1 ms（占单核 4.60%，占全部 24 核 0.191%）；浏览器全部进程合计 2218.2 ms（占单核 36.92%）
  - 分进程：browser 1507.2ms，renderer 276.1ms，GPU 177.7ms，network.mojom.NetworkService 54.2ms，storage.mojom.StorageService 58.3ms，edge_collections.mojom.CollectionsDataManager 18.6ms，entity_extraction_service.mojom.Extractor 26.5ms，winrt_app_id.mojom.WinrtAppIdService 99.5ms
- 根组件渲染 0 次（0 次/秒，载入以来累计 4 次），每次位置写入对应 0 次根渲染
- DOM 变更 123 条（20.47 条/秒；childList 0，characterData 8，attributes 115）
  - 变更最多的节点：`div.bar__fill` 56；`div.bar__knob` 56；`span.seek__time` 8；`div.bar` 3
  - 样本：attributes@div.bar__fill(style)，attributes@div.bar__knob(style)，attributes@div.bar__fill(style)，attributes@div.bar__knob(style)
- 探针计数：store 通知 未采集；IPC 条数 未采集
- 内存：JS 堆 3.53 MB（窗口内增量 562.9 KB），DOM 节点 312（增量 0）
- 页面自检：canvas 0 个，根节点子元素 1，内置错误捕获器：无

### `playing-stage` — 播放中（要求场景）

- 可见性：document.visibilityState = `visible`，采到 rAF 帧 360 帧 / 6001.5 ms
- 帧间隔：p50 16.70，p95 16.90，p99 17.30，max 17.30，>33.4ms 的帧 0 个
- 渲染进程主线程：TaskDuration 354.3 ms（占单核 5.90%），其中 Script 182.5 ms / Layout 12.4 ms / Style 15.4 ms
- 进程 CPU：渲染进程 584.8 ms（占单核 9.75%，占全部 24 核 0.406%）；浏览器全部进程合计 4723.7 ms（占单核 78.72%）
  - 分进程：browser 1564ms，renderer 584.8ms，GPU 2319.4ms，network.mojom.NetworkService 67.5ms，storage.mojom.StorageService 39ms，edge_collections.mojom.CollectionsDataManager 18ms，entity_extraction_service.mojom.Extractor 27ms，winrt_app_id.mojom.WinrtAppIdService 103.9ms
- 根组件渲染 0 次（0 次/秒，载入以来累计 4 次），每次位置写入对应 0 次根渲染
- DOM 变更 172 条（28.66 条/秒；childList 2，characterData 12，attributes 158）
  - 变更最多的节点：`div.bar__fill` 48；`div.bar__knob` 48；`div.stage__track-fill` 48；`span.seek__time` 6；`span.stage__time` 6；`div.bar` 3；`div.stage__track` 3；`div.stage__lyrics` 2
  - 样本：attributes@div.bar__fill(style)，attributes@div.bar__knob(style)，attributes@div.stage__track-fill(style)，attributes@div.bar__fill(style)
- 探针计数：store 通知 未采集；IPC 条数 未采集
- 内存：JS 堆 3.72 MB（窗口内增量 -576.6 KB），DOM 节点 258（增量 0）
- 页面自检：canvas 1 个，根节点子元素 2，内置错误捕获器：无

### `hidden-stage-electron` — 不可见（要求场景）

- 可见性：document.visibilityState = `hidden`，采到 rAF 帧 0 帧 / 6012 ms
- 帧间隔：p50 —，p95 —，p99 —，max —，>33.4ms 的帧 0 个
- 渲染进程主线程：TaskDuration 11 ms（占单核 0.18%），其中 Script 3.3 ms / Layout 0 ms / Style 0 ms
- 进程 CPU：渲染进程 18.7 ms（占单核 0.31%，占全部 24 核 0.013%）；浏览器全部进程合计 1362.6 ms（占单核 22.67%）
  - 分进程：browser 1167.9ms，renderer 18.7ms，GPU 18.6ms，network.mojom.NetworkService 37.5ms，storage.mojom.StorageService 2.1ms，edge_collections.mojom.CollectionsDataManager 0.1ms，entity_extraction_service.mojom.Extractor 25.4ms，winrt_app_id.mojom.WinrtAppIdService 92.4ms
- 根组件渲染 0 次（0 次/秒，载入以来累计 5 次）
- DOM 变更 10 条（1.66 条/秒；childList 2，characterData 0，attributes 8）
  - 变更最多的节点：`div.stage__lyrics` 2；`div.lyr.lyr--d3` 2；`div.lyr.lyr--d2` 2；`div.lyr.lyr--d1` 2；`div.lyr.lyr--d4` 1；`div.lyr.lyr--d0` 1
  - 样本：childList@div.stage__lyrics(0 added / 1 removed)，attributes@div.lyr.lyr--d4(class)，attributes@div.lyr.lyr--d3(class)，attributes@div.lyr.lyr--d2(class)
- 探针计数：store 通知 未采集；IPC 条数 未采集
- 内存：JS 堆 3.53 MB（窗口内增量 83.5 KB），DOM 节点 258（增量 0）
- 页面自检：canvas 1 个，根节点子元素 2，内置错误捕获器：无

### `hidden-stage-browser` — 不可见·对照

- 可见性：document.visibilityState = `hidden`，采到 rAF 帧 0 帧 / 6016.2 ms
- 帧间隔：p50 —，p95 —，p99 —，max —，>33.4ms 的帧 0 个
- 渲染进程主线程：TaskDuration 5 ms（占单核 0.08%），其中 Script 1 ms / Layout 0 ms / Style 0 ms
- 进程 CPU：渲染进程 18.3 ms（占单核 0.30%，占全部 24 核 0.013%）；浏览器全部进程合计 1520 ms（占单核 25.27%）
  - 分进程：browser 1324.9ms，renderer 18.3ms，GPU 19.2ms，network.mojom.NetworkService 37.9ms，storage.mojom.StorageService 0.9ms，edge_collections.mojom.CollectionsDataManager 0.1ms，entity_extraction_service.mojom.Extractor 25.3ms，winrt_app_id.mojom.WinrtAppIdService 93.5ms
- 根组件渲染 0 次（0 次/秒，载入以来累计 4 次）
- DOM 变更 0 条（0 条/秒；childList 0，characterData 0，attributes 0）
- 探针计数：store 通知 未采集；IPC 条数 未采集
- 内存：JS 堆 3.72 MB（窗口内增量 13.7 KB），DOM 节点 258（增量 0）
- 页面自检：canvas 1 个，根节点子元素 2，内置错误捕获器：无

## 五、外部计数（store 通知 / IPC 条数）

本次运行没有提供外部计数（`--counters=<file.json>`）。这两项在本装置的 **未采集**，原因见下一节：store 在模块作用域内、IPC 根本不在浏览器预览里。

## 六、本口径测不出的东西

### 最重要的一条：本装置的「不可见」不等于 Electron 的「不可见」

实测：页面切到后台后，即使加上 `--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`（Electron `backgroundThrottling: false` 的浏览器等效开关），渲染器仍然完全停止产帧（fps = 0），主线程 TaskDuration 掉到 0.1% 以下。

**所以：rAF 驱动的隐藏态工作，本装置测不出来**（帧停了，`requestAnimationFrame` 链就断了），`hidden-*` 两行不能用来判断 Aurora 最小化时的真实 rAF 开销。

**但计时器驱动的隐藏态工作测得出来。** 带上 `--disable-background-timer-throttling` 后 `setInterval` 会按真实节奏跑，而 Electron 的 `backgroundThrottling: false` 正是它的等效物。因此 `hidden-stage-electron` 对「隐藏时靠定时器继续更新的路径」可直接采信；`hidden-stage-browser` 是节流后的对照，**不要用它代表 Electron**。

隐藏态的验收因此要走**计数口径**（DOM 变更 / 渲染次数 / store 通知 / IPC 条数），因为计数在帧停止后依然累加。

| 指标 | 状态 | 原因 / 需要什么 |
| --- | --- | --- |
| zustand store 通知次数 | 未采集 | store 在模块作用域内，页面侧拿不到；需要 `window.__auroraPerfStore` 探针或 `--counters` 文件（方案见 `docs/perf-baseline.md` 的《缺口与探针方案》一节） |
| 主进程→渲染层 IPC 条数（含 `library:progress`） | 未采集 | 浏览器预览没有 preload/ipcRenderer，这条通道不经过本装置；需要 Electron 运行时探针或 `--counters` 文件 |
| GPU / 合成器耗时 | 未采集 | headless 下合成与栅格化走的是软件或 SwiftShader 路径，不代表真实窗口的 GPU 开销 |
| 真实窗口(非 headless)的整机占用 | 未采集 | 本机进程沙箱起不了 Chromium/Electron 窗口 |
| 音频解码 / AudioContext 频谱成本 | 未采集 | 预览里没有真实音频文件，`getSpectrum()` 返回 null 或全零 |
