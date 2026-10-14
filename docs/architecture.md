# 代码结构与约定

这份文档说明代码放在哪里、为什么这样分、以及哪些方向不允许反向依赖。界面设计的决定
另见 [`ui-design.md`](./ui-design.md)。

## 分层

```
src/
  app/          外壳与装配：App、路由、预览开关、Rail、TitleBar、跨功能的派生数据
  features/     功能模块，每个功能自成一目录（store / hooks / 该功能专属组件）
    accounts/     档案、按档案分区存储、在线账号绑定
    online/       **平台层**（与具体平台无关的一切）：契约、注册表、共享 store、
                  共享屏幕、直链缓存、预览开关
    netease/      网易云：provider 声明 + 它自己的登录弹窗 + api/track/stream/lrc
    qq/           QQ 音乐：它自己的登录弹窗与视图（provider 声明在 online/qq-provider.ts）
    library/      本地曲库：store、扫描、来源接缝、封面、歌单树、配色
    lyrics/       歌词解析（LRC）
    player/       播放内核：engine、driver、queue、urls、进度条
    playlists/    歌单：m3u 读写、存储、导入导出的流程
    settings/     设置状态的读写
  views/        页面与面板，一个文件一个屏幕或一块面板
  ui/           共享基元：ArtCard、Artwork、icons、TrackList、format、UpdatePanel
  stage/        歌词舞台与可视化
  overlay/      桌面歌词窗口（独立入口 overlay.html）
  styles/       全局样式；功能专属样式跟随其目录
  preview/      仅预览构建使用的压力测试种子
electron/
  pure/         零 Electron 依赖、可在裸 Node 下测试的纯逻辑（含 netease-bootstrap 的
                重试策略）
  protocols/    三个私有协议：aurora-app:// aurora-media:// aurora-remote://
  netease/      网易云客户端与 IPC
  qq/           QQ 音乐客户端与 IPC，按 transport / normalize / reasons / session 分文件
  main.ts       Electron 主进程
scripts/        开发与审计工具（见下方「审计」）
tests/          单元测试，主要覆盖纯逻辑
```

### 平台层（`src/features/online/`）

在线音乐曾经是硬编码的网易云。结构照参考软件 Folia 的 provider 模式做（分析见
[`reference-players.md`](./reference-players.md)），因为它是被验证过的形状，而自己发明一个
只会得到同一套东西的另一版命名。

- **注册表**：`Map<ProviderId, Provider>`，UI 只调 `listProviders()`，不 import 任何具体平台。
  `providerForTrack(track)` 按歌曲反查平台。
- **契约是一组布尔能力**：`capabilities` 里 `search / playback / lyrics / auth / collections / …`
  全是布尔，每个能力对应一个可选子接口。**平台没有某功能是 `false`，不是在 UI 里判断它是谁。**
- **歌曲自带来源**：`{ kind: 'online', providerId }`，取代了以前的 `track.source === 'netease'`。
- **侧栏与搜索页从注册表生成**：加一个平台不改这两个文件一行代码。
- **可用性三态**：`playable` / `unknown + restricted` / `takenDown`。判决只来自真实请求，
  运行时不回写（这是 Folia 契约里的规则：权限/付费/地区属于「受限」，不能当成「已下架」）。
- **平台专属界面留在平台自己目录里**：两个登录弹窗不共用，因为它们的流程真的不同；
  硬抽象成「通用登录」会比它替换掉的两份代码更长。

## 依赖方向（硬规则）

```
views  →  features  →  ui
app    →  features / views / ui
electron/main  →  electron/pure        （pure 不得反向依赖）
electron/pure  →  只有 node: 内置模块与类型
```

- **`ui/` 不得 import `features/`。** 基元层若依赖功能层，就再也不能当作基元用。
  实测踩过两次：`Bar.tsx`（播放进度条，属播放器）与 `formatTime`（通用格式化，属基元）
  曾都放在 `ui/` 里却引用播放器 store。前者移入 `features/player/`，后者抽成 `ui/format.ts`。
- **`electron/pure/` 不得 import 其它 `electron/` 模块。** 一旦引入 `settings` 这类
  会 `import electron` 的模块，整个目录就无法在测试里加载，`pure` 也就名不副实。
  `ScanProgress` 类型因此定义在 `pure/scan-progress.ts`，由 `library-scan` 转发导出。
- **视图不直接碰 store 之外的接线**：跨功能的编排写进 `app/` 的 hook
  （如 `useLibraryData`），而不是塞进 `App`。

## 一页一个标题、界面规则

见 [`ui-design.md`](./ui-design.md)。要点：标题由外壳打印、页内不重复；本地与在线共用
`ArtCard`；页内不再造侧栏；曲库操作只在 `LIBRARY_VIEWS` 里出现。

## 审计

三个脚本用来自动回答「有没有死代码」，而不是靠印象：

```bash
npm run check     # 类型检查 + 测试 + 下面两个审计
node scripts/audit-reachability.mjs   # 从真实入口走 import 图，找无法加载的文件
node scripts/audit-css.mjs            # 找代码与 HTML 都合成不出来的 CSS 类
node scripts/audit-exports.mjs        # 找只在本文件内使用的导出
```

`audit-css.mjs` 需要理解三类误报，否则会得出错误结论：模板字符串拼接的类名
（`` `lyr--d${n}` ``）、CSS 注释里提到的文件名（`tokens.css`）、以及 HTML 入口里的类名
（`overlay.html` 的 `overlay-body`）。脚本已处理这三类。

## 搬迁工具

`scripts/move-files.mjs` 移动文件并改写所有相对 import（静态、动态、type-only、
`export … from`），基于 TypeScript AST 而不是正则：

```bash
node scripts/move-files.mjs --plan scripts/moves/features.json          # 试运行，打印改动
node scripts/move-files.mjs --plan scripts/moves/features.json --apply  # 执行
```

计划文件在 `scripts/moves/`。工具在动任何文件**之前**会校验全部源路径与目标路径。

## 踩过的坑（避免重复）

- **脚本按行号切分大文件很危险**：一次失败会留下半改的文件。正确做法是写入前完成全部
  自检，失败后**先从 git 恢复再重试**，不要在中间态上打补丁。
- **锚点要用足够精确的文本**：锚 `'Preview benchmark mode'` 命中了另一段注释里提到它的
  那一行，整块提取偏移了六行。用 `' * Preview benchmark mode'` 才唯一。
- **仓库检出是 CRLF**：按 `'\n'` 搜索字符串会全部落空，先规范化行尾。
- **验证打包产物必须用 `@electron/asar`**：手算头部偏移会读到错位数据；在整包里搜字符串
  会误报（被打包的 JS 里也有同样的字符串）。
- **PowerShell 5.1**：不支持 `??`；`Set-Content -Encoding UTF8` 会写入 BOM（JSON 会解析
  失败），需要无 BOM 时用 Node 写文件。

## 尚待完成

按「值不值得」排序，附当前行数（2026-10，平台抽象之后）：

- **`src/App.tsx`（830 行）**仍是最大的渲染层文件：键盘快捷键、播放/导航动作、
  六段视图分发的 JSX 都在其中。`useKeyboardShortcuts` 与 `usePlaybackActions` 已经抽出
  （曾经约 1180 行），剩下的主要是视图分发与头部接线，可以再拆，但收益已经不如从前。
- **`electron/netease/client.ts`（856 行）**按 bootstrap / 会话 / 搜索 / 播放 / 登录拆分。
  它是全项目最大的文件，且 `bootstrap` 那段逻辑（含重试策略）已经证明值得独立。
- **`electron/main.ts`（683 行）**的 IPC 注册可拆到 `electron/ipc/`。
- **`src/features/online/store.ts`（592 行）与 `PlatformView.tsx`（591 行）**是平台层的两个大件；
  前者可分离「搜索 / 目录 / 直链」三块状态，后者可按界面区块拆组件。
- 未统一 store 写法；有一批导出只在本文件内使用，可以收窄（`npm run audit:exports` 是入口）。

**已经做完、不必再列**（这份文档曾经把它们列为待办）：

- `src/features/netease/store.ts` 从 571 行降到 237 行：它现在是**适配器**而非实现，
  内部转发到平台层的共享 store。两套直链缓存合并成了一套——那正是抽象要消灭的重复。
- 在线音乐不再是硬编码网易云：见上方「平台层」。
- 三个死代码审计都接入了 `npm run check`。
