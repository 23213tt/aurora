# 代码结构与约定

这份文档说明代码放在哪里、为什么这样分、以及哪些方向不允许反向依赖。界面设计的决定
另见 [`ui-design.md`](./ui-design.md)。

## 分层

```
src/
  app/          外壳与装配：App、路由、预览开关、Rail、TitleBar、跨功能的派生数据
  features/     功能模块，每个功能自成一目录（store / hooks / 该功能专属组件）
    accounts/     档案、按档案分区存储、在线账号绑定
    library/      本地曲库：store、扫描、来源接缝、封面、歌单树、配色
    lyrics/       歌词解析（LRC）
    netease/      在线音乐：api、store、hooks、歌词、音质、以及它的视图
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
  pure/         零 Electron 依赖、可在裸 Node 下测试的纯逻辑
  protocols/    三个私有协议：aurora-app:// aurora-media:// aurora-remote://
  netease/      网易云客户端与 IPC
  main.ts       Electron 主进程
scripts/        开发与审计工具（见下方「审计」）
tests/          单元测试，主要覆盖纯逻辑
```

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

- `App()` 仍有约 790 行：键盘快捷键、播放/导航动作、以及六段视图分发的 JSX 仍在其中。
  下一步应抽出 `useKeyboardShortcuts`、`usePlaybackActions`，并把视图分发拆到 `views/`。
- `electron/netease/client.ts`（818 行）应按 bootstrap / 会话 / 搜索 / 播放 / 登录 拆分。
- `electron/main.ts`（673 行）的 IPC 注册应拆到 `electron/ipc/` 下的几个模块。
- `src/features/netease/store.ts`（571 行）需要分离在线状态与播放衔接。
- 未统一 store 写法；有一批导出只在本文件内使用，可以收窄。
