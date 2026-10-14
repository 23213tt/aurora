import { useEffect, useState } from 'react'
import { bridge, isNative } from '../bridge'
import type { NeteaseQuality, UpdateResult } from '../env'
import { usePlayer } from '../player/store'
import { UpdatePanel } from '../components/UpdatePanel'
import { Refresh } from '../components/icons'
import { formatBytes, formatCheckedAt, useSettingsPage } from './store'
import './settings.css'

/**
 * The settings page.
 *
 * Organised the way desktop players organise theirs - one section per area of
 * the app, each row a label plus the control - so nothing has to be discovered.
 * The list is deliberately short: a settings page that mirrors every panel is
 * worse than one that only holds the things that have nowhere else to live.
 *
 * Everything here reads and writes the main process. That is not ceremony: the
 * desktop lyric strip is a second window, and the theme is a Chromium-level
 * setting, so neither can be stored in the page's own `localStorage`.
 */

const QUALITY_LABELS: { value: NeteaseQuality; label: string; hint: string }[] = [
  { value: 'standard', label: '标准', hint: '128kbps，最省流量' },
  { value: 'higher', label: '较高', hint: '192kbps' },
  { value: 'exhigh', label: '极高', hint: '320kbps，无会员时通常能拿到的最高档' },
  { value: 'lossless', label: '无损', hint: '需要会员，否则上游会自动降档' }
]

export function SettingsView() {
  const page = useSettingsPage()
  const [quality, setQuality] = useState<NeteaseQuality>('exhigh')
  const [confirmingClear, setConfirmingClear] = useState(false)

  const crossfadeSec = usePlayer((state) => state.crossfadeSec)
  const setCrossfade = usePlayer((state) => state.setCrossfade)
  const eqEnabled = usePlayer((state) => state.eqEnabled)
  const setEqEnabled = usePlayer((state) => state.setEqEnabled)

  // Quality is stored by the Netease client, not in settings.json, because the
  // online source validates it against the levels it actually supports.
  useEffect(() => {
    void bridge.netease.getQuality().then(setQuality)
  }, [])

  const applyQuality = async (next: NeteaseQuality) => {
    setQuality(await bridge.netease.setQuality(next))
  }

  const { desktopLyrics, onlineLyrics, updateInterval } = page.settings

  /*
   * The slider is local while it is being dragged and writes on release.
   *
   * A range input fires `change` on every pixel of the drag; writing that
   * straight through would mean an IPC round trip and a disk write per step, and
   * the main process then pushes the echoed value back on every one of them. The
   * preview still has to follow the finger, so the local value drives it and the
   * commit happens once the drag ends.
   */
  const [previewSize, setPreviewSize] = useState(desktopLyrics.size)

  useEffect(() => {
    setPreviewSize(desktopLyrics.size)
  }, [desktopLyrics.size])

  return (
    <div className="settings">
      {page.error ? <p className="settings__error">{page.error}</p> : null}

      {/* --- 更新 ---------------------------------------------------------- */}
      <section className="settings__section">
        <h2 className="settings__heading">更新</h2>
        <div className="settings__group">
          <UpdatePanel />

          <Row
            label="检查频率"
            hint={
              updateInterval === 'manual'
                ? '不自动检查，只有你点「检查更新」时才联网'
                : `上次检查：${formatCheckedAt(page.prefs.lastCheck)}`
            }
          >
            <div className="seg">
              {(
                [
                  { value: 'manual', label: '手动' },
                  { value: 'daily', label: '每天' },
                  { value: 'weekly', label: '每周' }
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  className={updateInterval === option.value ? 'is-active' : ''}
                  disabled={page.busy}
                  onClick={() => void page.setUpdateInterval(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </Row>

          <Row
            label="自动下载并安装"
            hint={
              page.prefs.autoInstallAvailable
                ? '开启后，发现新版本会自动下载并在退出时安装。这意味着跳过浏览器与 SmartScreen 的提示：安装包未签名，Aurora 无法验证它将要替换成的那个文件。'
                : '当前构建不支持：需要打包后的应用，并且需要 electron-updater 依赖（见 README「更新」一节）。'
            }
          >
            <Toggle
              checked={page.prefs.autoInstall}
              disabled={page.busy || !page.prefs.autoInstallAvailable}
              label="自动下载并安装更新"
              onChange={(next) => void page.setAutoInstall(next)}
            />
          </Row>

          {page.update && page.update.state !== 'current' ? (
            <UpdateStatus result={page.update} onInstall={() => void page.installUpdate()} />
          ) : null}
        </div>
      </section>

      {/* --- 在线功能 ------------------------------------------------------ */}
      <section className="settings__section">
        <h2 className="settings__heading">在线功能</h2>
        <div className="settings__group">
          <Row
            label="在线歌词"
            hint="本地没有 .lrc 时，把歌名与歌手发送到 lrclib.net 查询。关闭后歌词完全来自本机文件。"
          >
            <Toggle
              checked={onlineLyrics}
              disabled={page.busy}
              label="在线歌词查询"
              onChange={(next) => void page.setOnlineLyrics(next)}
            />
          </Row>

          <Row label="网易云音质" hint={QUALITY_LABELS.find((q) => q.value === quality)?.hint}>
            <div className="seg">
              {QUALITY_LABELS.map((option) => (
                <button
                  key={option.value}
                  className={quality === option.value ? 'is-active' : ''}
                  onClick={() => void applyQuality(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </Row>
        </div>
      </section>

      {/* --- 播放 ---------------------------------------------------------- */}
      <section className="settings__section">
        <h2 className="settings__heading">播放</h2>
        <div className="settings__group">
          <div className="settings__row settings__row--stacked">
            <div className="settings__text">
              <div className="settings__label">交叉淡化</div>
              <p className="settings__hint">
                切歌时前一首淡出、后一首淡入的重叠时长。0 表示直接切换。
              </p>
            </div>
            <div className="settings__slider">
              <input
                type="range"
                min={0}
                max={12}
                step={1}
                value={crossfadeSec}
                aria-label="交叉淡化时长（秒）"
                onChange={(event) => setCrossfade(Number(event.target.value))}
              />
              <span className="settings__number">{crossfadeSec} 秒</span>
            </div>
          </div>

          <Row label="均衡器" hint="开关本身在这里；10 段推子在播放界面按 E 打开。">
            <Toggle
              checked={eqEnabled}
              label="均衡器"
              onChange={(next) => setEqEnabled(next)}
            />
          </Row>
        </div>
      </section>

      {/* --- 外观 ---------------------------------------------------------- */}
      <section className="settings__section">
        <h2 className="settings__heading">外观</h2>
        <div className="settings__group">
          <div className="settings__row settings__row--stacked">
            <div className="settings__text">
              <div className="settings__label">桌面歌词字号</div>
              <p className="settings__hint">
                桌面歌词窗口是独立窗口，这里改的是它的字号；歌词窗口自己也能调，两边始终一致。
              </p>
            </div>
            <div className="settings__preview" style={{ fontSize: `${previewSize}px` }}>
              我把名字写在起雾的玻璃上
            </div>
            <div className="settings__slider">
              <input
                type="range"
                min={desktopLyrics.min}
                max={desktopLyrics.max}
                step={1}
                value={previewSize}
                aria-label="桌面歌词字号"
                onChange={(event) => setPreviewSize(Number(event.target.value))}
                onPointerUp={() => void page.setLyricsSize(previewSize)}
                onKeyUp={() => void page.setLyricsSize(previewSize)}
              />
              <span className="settings__number">{previewSize}px</span>
            </div>
          </div>

        </div>
      </section>

      {/* --- 数据与缓存 ---------------------------------------------------- */}
      <section className="settings__section">
        <h2 className="settings__heading">数据与缓存</h2>
        <div className="settings__group">
          <Row label="数据目录" hint={page.storage?.userData ?? '—'}>
            <span className="settings__number">{formatBytes(page.storage?.userDataBytes ?? null)}</span>
          </Row>

          <Row
            label="缓存"
            hint="浏览器缓存、着色器缓存与封面缓存。清空只是让它们重新下载，不会动你的曲库、歌单、档案或登录状态。"
          >
            <span className="settings__number">{formatBytes(page.storage?.cacheBytes ?? null)}</span>
            <button
              className="btn"
              onClick={() => void page.refreshStorage()}
              title="重新测量占用"
            >
              <Refresh size={14} />
            </button>
          </Row>

          {confirmingClear ? (
            <>
              <p className="settings__confirm">
                清空缓存会删除 {formatBytes(page.storage?.cacheBytes ?? null)}
                的可再生数据（封面、歌词、网络与着色器缓存）。曲库索引、播放列表、档案和网易云登录状态不会被动。
              </p>
              <div className="settings__danger">
                <button
                  className="btn btn--danger"
                  disabled={page.clearing}
                  onClick={() => {
                    setConfirmingClear(false)
                    void page.clearCache()
                  }}
                >
                  {page.clearing ? '正在清空' : '确认清空'}
                </button>
                <button className="btn" onClick={() => setConfirmingClear(false)}>
                  取消
                </button>
              </div>
            </>
          ) : (
            <div className="settings__danger">
              <button className="btn btn--danger" onClick={() => setConfirmingClear(true)}>
                清空缓存
              </button>
            </div>
          )}
        </div>
      </section>

      {/* --- 关于 ---------------------------------------------------------- */}
      <section className="settings__section">
        <h2 className="settings__heading">关于</h2>
        <About />
      </section>
    </div>
  )
}

interface RowProps {
  label: string
  hint?: string
  children: React.ReactNode
}

function Row({ label, hint, children }: RowProps) {
  return (
    <div className="settings__row">
      <div className="settings__text">
        <div className="settings__label">{label}</div>
        {hint ? <p className="settings__hint">{hint}</p> : null}
      </div>
      <div className="settings__control">{children}</div>
    </div>
  )
}

interface ToggleProps {
  checked: boolean
  label: string
  disabled?: boolean
  onChange: (next: boolean) => void
}

/** The same switch the rest of the app uses, so the page reads as one product. */
function Toggle({ checked, label, disabled, onChange }: ToggleProps) {
  return (
    <button
      className={`switch${checked ? ' is-on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="switch__dot" />
    </button>
  )
}

/** Download progress and the restart button, shown only when something is pending. */
function UpdateStatus({ result, onInstall }: { result: UpdateResult; onInstall: () => void }) {
  if (result.state === 'downloading') {
    return (
      <p className="settings__hint">
        正在下载 {Math.round(result.percent)}%（{formatBytes(result.transferred)} /{' '}
        {formatBytes(result.total)}）
      </p>
    )
  }
  if (result.state === 'ready') {
    return (
      <div className="settings__danger">
        <button className="btn btn--accent" onClick={onInstall}>
          重启并安装
        </button>
      </div>
    )
  }
  return null
}

function About() {
  const [info, setInfo] = useState<Awaited<ReturnType<typeof bridge.info>> | null>(null)

  useEffect(() => {
    void bridge.info().then(setInfo)
  }, [])

  return (
    <dl className="specs">
      <dt>应用版本</dt>
      <dd>{info?.version ?? '—'}</dd>
      <dt>运行环境</dt>
      <dd>{isNative ? 'Electron 桌面版' : '浏览器预览模式'}</dd>
      <dt>Electron</dt>
      <dd>{info?.electron ?? '—'}</dd>
      <dt>Chromium</dt>
      <dd>{info?.chrome ?? '—'}</dd>
      <dt>Node</dt>
      <dd>{info?.node ?? '—'}</dd>
      <dt>数据目录</dt>
      <dd className="specs__path">{info?.userData ?? '—'}</dd>
      {!isNative ? (
        <>
          {/* The preview's render counter, kept because the perf harness reads
              it: `#perf` exists only in the browser build. */}
          <dt>App 渲染次数</dt>
          <dd className="tnum">
            {(window as Window & { __auroraRenders?: number }).__auroraRenders ?? 0}
          </dd>
        </>
      ) : null}
    </dl>
  )
}
