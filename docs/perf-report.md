# Aurora 性能基线（可复现报告）

生成时间：2026-10-14T14:46:33.683Z

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
| git HEAD | `79922951a2498c8074bc012688bfd53b80e22c6c` (main) |
| 工作区脏文件数 | 0 |
| 采样窗口 | 6000 ms（settle 3000 ms） |
| Node / OS | v24.19.0 / Windows_NT 10.0.26200 |
| 逻辑核心 | 24 |
| CPU | Intel(R) Core(TM) i7-14650HX |
| 实测产物指纹 | settings `36513937ea0367b4`，perf `ea20ebebb2fe4509`，stage `13761e89bc187b96` |

## 三、基线数字表

| 场景 | document.hidden | rAF fps | 帧间隔 p50 / p95 / max (ms) | 主线程忙时 (ms) | 主线程忙时占单核 | 渲染进程 CPU 占单核 / 占全部核心 | 长任务数/总时长 | 根组件渲染 | DOM 变更/秒 | JS 堆增量 (KB) | DOM 节点增量 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 空闲（要求场景） `idle-paused` | false | 60.09 | 16.70 / 17.10 / 17.80 | 43.9 | 0.73% | 1.56% / 0.065% | 0 / 0 ms | 0 | 0 | 23.1 | 0 |
| 参照·前台无 stage `playing-settings` | false | 60.02 | 16.70 / 17.10 / 17.40 | 123.1 | 2.05% | 3.60% / 0.150% | 0 / 0 ms | 0 | 17.46 | 229.4 | 0 |
| 播放中（要求场景） `playing-stage` | false | 60.05 | 16.70 / 16.90 / 17.40 | 345 | 5.74% | 9.73% / 0.405% | 0 / 0 ms | 0 | 28.61 | -949.5 | 0 |

> ⚠ **rAF 帧数会高估「应用在画」**：采样器自己持有一个 `requestAnimationFrame` 回调，只要它在，渲染器就会持续产帧。所以 `fps≈60` 的含义是「帧时钟在跑」，不是「应用在动」。判断应用是否真在干活，看主线程 TaskDuration、根渲染次数和 DOM 变更三条。反过来，`fps=0` 是可信的：它说明渲染器连帧都不产了。

场景定义：

- `idle-paused`（空闲（要求场景））：设置页 + 用 UI 上的暂停按钮停掉播放。无 stage、无 60Hz 位置流、界面静止。这是本装置能给出的最接近「真正空闲」的一档。 页面：`preview-dist/aurora-preview-settings.html#settings`
- `playing-settings`（参照·前台无 stage）：同一个设置页但不暂停。预览的合成音频驱动每帧向 store 写一次播放位置，用来单独量「60Hz 位置写入 → 进度条重渲染」这一条路径的成本。 页面：`preview-dist/aurora-preview-settings.html#settings`
- `playing-stage`（播放中（要求场景））：沉浸舞台：极光 ribbon + 340 粒子 canvas 每帧重绘，合成驱动 60Hz 写播放位置。 页面：`preview-dist/aurora-preview-stage.html#stage`

## 四、逐场景明细

### `idle-paused` — 空闲（要求场景）

- 可见性：document.visibilityState = `visible`，采到 rAF 帧 361 帧 / 6007.4 ms
- 帧间隔：p50 16.70，p95 17.10，p99 17.30，max 17.80，>33.4ms 的帧 0 个
- 渲染进程主线程：TaskDuration 43.9 ms（占单核 0.73%），其中 Script 6.3 ms / Layout 0 ms / Style 0 ms
- 进程 CPU：渲染进程 93.8 ms（占单核 1.56%，占全部 24 核 0.065%）；浏览器全部进程合计 254.8 ms（占单核 4.24%）
  - 分进程：browser 87.6ms，renderer 93.8ms，GPU 52.5ms，network.mojom.NetworkService 20.4ms，storage.mojom.StorageService 0.2ms，edge_collections.mojom.CollectionsDataManager 0ms，entity_extraction_service.mojom.Extractor 0ms，winrt_app_id.mojom.WinrtAppIdService 0.3ms
- 根组件渲染 0 次（0 次/秒，载入以来累计 5 次）
- DOM 变更 0 条（0 条/秒；childList 0，characterData 0，attributes 0）
- 探针计数：store 通知 未采集；IPC 条数 未采集
- 内存：JS 堆 3.14 MB（窗口内增量 23.1 KB），DOM 节点 312（增量 0）
- 页面自检：canvas 0 个，根节点子元素 1，内置错误捕获器：无
- ⚠ 已点击「暂停」（点击后标签：暂停）；暂停后 DOM 变更残值 0 条/秒。

### `playing-settings` — 参照·前台无 stage

- 可见性：document.visibilityState = `visible`，采到 rAF 帧 361 帧 / 6014.6 ms
- 帧间隔：p50 16.70，p95 17.10，p99 17.30，max 17.40，>33.4ms 的帧 0 个
- 渲染进程主线程：TaskDuration 123.1 ms（占单核 2.05%），其中 Script 42 ms / Layout 4.3 ms / Style 6.6 ms
- 进程 CPU：渲染进程 216.7 ms（占单核 3.60%，占全部 24 核 0.150%）；浏览器全部进程合计 2008.8 ms（占单核 33.40%）
  - 分进程：browser 1394.7ms，renderer 216.7ms，GPU 181.8ms，network.mojom.NetworkService 52.9ms，storage.mojom.StorageService 35.5ms，edge_collections.mojom.CollectionsDataManager 0.2ms，entity_extraction_service.mojom.Extractor 25.4ms，winrt_app_id.mojom.WinrtAppIdService 101.6ms
- 根组件渲染 0 次（0 次/秒，载入以来累计 4 次），每次位置写入对应 0 次根渲染
- DOM 变更 105 条（17.46 条/秒；childList 0，characterData 6，attributes 99）
  - 变更最多的节点：`div.bar__fill` 48；`div.bar__knob` 48；`span.seek__time` 6；`div.bar` 3
  - 样本：attributes@div.bar__fill(style)，attributes@div.bar__knob(style)，attributes@div.bar__fill(style)，attributes@div.bar__knob(style)
- 探针计数：store 通知 未采集；IPC 条数 未采集
- 内存：JS 堆 3.18 MB（窗口内增量 229.4 KB），DOM 节点 312（增量 0）
- 页面自检：canvas 0 个，根节点子元素 1，内置错误捕获器：无

### `playing-stage` — 播放中（要求场景）

- 可见性：document.visibilityState = `visible`，采到 rAF 帧 361 帧 / 6011.3 ms
- 帧间隔：p50 16.70，p95 16.90，p99 17.20，max 17.40，>33.4ms 的帧 0 个
- 渲染进程主线程：TaskDuration 345 ms（占单核 5.74%），其中 Script 176.2 ms / Layout 12.5 ms / Style 15.2 ms
- 进程 CPU：渲染进程 584.9 ms（占单核 9.73%，占全部 24 核 0.405%）；浏览器全部进程合计 4661.4 ms（占单核 77.56%）
  - 分进程：browser 1535.6ms，renderer 584.9ms，GPU 2290ms，network.mojom.NetworkService 68.2ms，storage.mojom.StorageService 37.8ms，edge_collections.mojom.CollectionsDataManager 18.6ms，entity_extraction_service.mojom.Extractor 27.6ms，winrt_app_id.mojom.WinrtAppIdService 98.6ms
- 根组件渲染 0 次（0 次/秒，载入以来累计 4 次），每次位置写入对应 0 次根渲染
- DOM 变更 172 条（28.61 条/秒；childList 2，characterData 12，attributes 158）
  - 变更最多的节点：`div.bar__fill` 48；`div.bar__knob` 48；`div.stage__track-fill` 48；`span.seek__time` 6；`span.stage__time` 6；`div.bar` 3；`div.stage__track` 3；`div.stage__lyrics` 2
  - 样本：attributes@div.bar__fill(style)，attributes@div.bar__knob(style)，attributes@div.stage__track-fill(style)，attributes@div.bar__fill(style)
- 探针计数：store 通知 未采集；IPC 条数 未采集
- 内存：JS 堆 3.35 MB（窗口内增量 -949.5 KB），DOM 节点 258（增量 0）
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
