/**
 * Print the A/B probe result as a Markdown table.
 *
 * Kept separate from the probe so a table can be regenerated from a saved
 * `docs/gpu-composite-probe.json` without re-running the browser.
 *
 *   node scripts/gpu-table.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'gpu-composite-probe.json'), 'utf8'))

const ORDER = [
  ['blank-control', '对照·空白页'],
  ['idle-paused-baseline', '空闲·设置页（暂停播放）基准'],
  ['idle-paused-no-transitions', '空闲·设置页 冻结全部过渡'],
  ['idle-paused-no-backdrop-filter', '空闲·设置页 去 blur(76px)'],
  ['idle-paused-no-backdrop', '空闲·设置页 去整层'],
  ['playing-settings-baseline', '播放·设置页 基准'],
  ['playing-settings-no-backdrop-filter', '播放·设置页 去 blur(76px)'],
  ['playing-settings-no-backdrop', '播放·设置页 去整层'],
  ['playing-settings-no-backdrops-anywhere', '播放·设置页 去全部 backdrop-filter'],
  ['playing-settings-no-transitions', '播放·设置页 冻结全部过渡'],
  ['songs-playing-baseline', '播放·歌曲列表 基准（eq 动画在跑）'],
  ['songs-playing-no-animations', '播放·歌曲列表 暂停所有 CSS 动画'],
  ['songs-playing-no-backdrop-filter', '播放·歌曲列表 去 blur'],
  ['stage-baseline', '舞台 基准'],
  ['stage-playing-baseline', '舞台播放 基准'],
  ['stage-playing-no-backdrop', '舞台播放 去整窗模糊层'],
  ['stage-playing-no-mask', '舞台播放 去 .viz 整窗 mask'],
  ['stage-playing-no-glow', '舞台播放 去进度条光晕'],
  ['stage-playing-no-mask-no-backdrop', '舞台播放 去 mask + 去模糊层'],
  ['stage-no-canvas', '舞台 去 canvas 绘制'],
  ['stage-hidden-baseline', '舞台 切后台（document.hidden）'],
  ['stage-hidden-no-animations', '舞台 切后台 + 暂停所有动画'],
  ['overlay-baseline', '桌面歌词浮窗 基准'],
  ['overlay-no-backdrop-filter', '桌面歌词浮窗 去毛玻璃'],
  ['overlay-no-backdrop-filter-opaque', '桌面歌词浮窗 去毛玻璃 + 加深底板']
]

const rows = []
for (const [id, label] of ORDER) {
  const r = report.results[id]
  if (!r) {
    rows.push([label, '（本次未跑）', '', '', '', '', '', ''])
    continue
  }
  if (r.failed) {
    rows.push([label, 'ERR', '', '', '', '', '', ''])
    continue
  }
  rows.push([
    label,
    String(r.fps),
    r.taskPctOfOneCore?.toFixed(2) ?? '—',
    String(r.styleCount ?? '—'),
    String(r.layoutCount ?? '—'),
    String(r.gpuMs ?? '—'),
    String(r.rendererMs ?? '—'),
    (r.animationTargets ?? []).length ? r.animationTargets.join(', ') : '无'
  ])
}

console.log('| 场景 | rAF fps | 主线程忙时% | StyleCount | LayoutCount | GPU进程ms | 渲染进程ms | 实际在跑的动画 |')
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |')
for (const r of rows) console.log(`| ${r.join(' | ')} |`)
console.log('')
console.log(`窗口 ${report.rig.durationMs} ms/次，取 ${report.rig.reps} 次的中位数；${report.rig.cpu}，${report.rig.cores} 逻辑核心`)
