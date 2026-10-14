import type { AppSettings, AuroraApi, UpdatePrefs } from './env'
import { demoLibrary } from './library/demo'

/**
 * Single access point for the preload bridge.
 *
 * When the renderer runs in a plain browser (design preview, screenshots, or a
 * future web build) `window.aurora` is absent, so we fall back to an in-memory
 * implementation. That keeps the UI previewable without Electron, which matters
 * because the interface should never be verifiable only by launching the app.
 */
const native: AuroraApi | undefined = typeof window !== 'undefined' ? window.aurora : undefined

export const isNative = Boolean(native)

const demoRoots = ['C:\\Users\\PC\\Music', 'D:\\Audio\\Lossless']

const emptyIndex = () => ({
  version: 1,
  scannedAt: Date.now(),
  roots: demoRoots,
  tracks: []
})

/**
 * Session-only settings for the preview.
 *
 * Held outside the fallback object so a setter can return the new state the way
 * the native implementation does, without the caller having to re-read.
 */
let previewSettings: AppSettings = {
  onlineLyrics: false,
  updateInterval: 'manual',
  updateLastCheck: 0,
  autoInstallUpdates: false,
  desktopLyrics: { size: 34, min: 18, max: 64 }
}

/**
 * Update preferences for the preview.
 *
 * `autoInstallAvailable: false` is the honest answer in a browser: there is no
 * installer to run, so the settings page renders that switch disabled.
 */
let previewPrefs: UpdatePrefs = {
  interval: 'manual',
  lastCheck: 0,
  autoInstall: false,
  autoInstallAvailable: false
}

const webFallback: AuroraApi = {
  info: async () => ({
    version: '0.1.0-web',
    electron: 'n/a',
    chrome: navigator.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? 'n/a',
    node: 'n/a',
    platform: 'win32',
    userData: '（浏览器预览模式，没有数据目录）'
  }),
  library: {
    getRoots: async () => demoRoots,
    // A browser preview has no file system to search.
    autoDiscover: async () => ({ added: [], roots: [] }),
    addRoots: async () => demoRoots,
    removeRoot: async () => demoRoots,
    // The preview has no filesystem; demo lyrics come from the demo dataset.
    readLyrics: async () => null,
    reveal: async () => false,
    getIndex: async () => emptyIndex(),
    scan: async () => emptyIndex(),
    cancelScan: async () => true,
    onProgress: () => () => undefined
  },
  app: {
    // A browser tab is never minimised to a tray, so Chromium's own answer is
    // the accurate one here; the visibility hook reads `document.hidden` too.
    getVisibility: async () => ({
      visible: !document.hidden,
      minimized: false,
      hidden: document.hidden
    }),
    onVisibility: () => () => undefined
  },
  playlists: {
    /*
     * The preview has no file dialog, so import hands back a synthetic m3u
     * built from the demo library - including one path that is not in the
     * library, so the "some entries were skipped" path is exercised too.
     */
    import: async () => {
      const lines = ['#EXTM3U']
      demoLibrary.slice(0, 5).forEach((track, index) => {
        lines.push(`#EXTINF:${Math.round(track.duration)},${track.artist} - ${track.title}`)
        lines.push(index === 4 ? 'C:\\Music\\还没有扫描\\missing.flac' : track.path)
      })
      return { name: '演示导入', dir: 'C:\\Users\\PC\\Music', text: `${lines.join('\r\n')}\r\n` }
    },
    export: async () => true
  },
  updates: {
    /*
     * A browser preview has no main process, so there is nothing to check
     * against. The message says *that*, rather than reusing the packaged
     * build's "这个构建还没有配置发布仓库" - which is what a real packaging bug
     * looked like for every shipped version, and made a preview screenshot
     * indistinguishable from a broken install.
     */
    check: async () => ({
      state: 'unconfigured',
      current: '0.1.0-web',
      message: '浏览器预览模式没有主进程，因此没有更新检查'
    }),
    open: async () => false,
    getAutoCheck: async () => false,
    setAutoCheck: async () => false,
    getPrefs: async () => previewPrefs,
    setInterval: async (interval) => (previewPrefs = { ...previewPrefs, interval }),
    setAutoInstall: async (enabled) => (previewPrefs = { ...previewPrefs, autoInstall: enabled }),
    install: async () => false,
    onStatus: () => () => undefined,
    onAvailable: () => () => undefined
  },
  settings: {
    /*
     * The preview keeps settings in memory for the session. That is enough for
     * the settings page to be reviewed - switches move, sliders drag - without
     * pretending anything was persisted.
     */
    getAll: async () => previewSettings,
    setOnlineLyrics: async (enabled) => (previewSettings = { ...previewSettings, onlineLyrics: enabled }),
    setDesktopLyricsSize: async (size) =>
      (previewSettings = {
        ...previewSettings,
        desktopLyrics: { ...previewSettings.desktopLyrics, size }
      }),
    // A browser has no userData directory, so "nothing to measure" is the
    // honest answer rather than a made-up zero.
    getStorage: async () => ({
      userData: '（浏览器预览模式，没有数据目录）',
      cache: '（浏览器预览模式，没有缓存目录）',
      cacheBytes: null,
      userDataBytes: null
    }),
    clearCache: async () => ({
      userData: '（浏览器预览模式，没有数据目录）',
      cache: '（浏览器预览模式，没有缓存目录）',
      cacheBytes: null,
      userDataBytes: null
    })
  },
  player: {
    reportState: async () => true,
    onCommand: () => () => undefined
  },
  lyrics: {
    // The preview has no network path to the main process, and the demo dataset
    // carries its own lyric, so a lookup is simply empty here.
    lookup: async () => null,
    isOnlineEnabled: async () => false,
    setOnlineEnabled: async () => false
  },
  overlay: {
    /*
     * The preview has no main process to open a second window or push state, so
     * the overlay harness is fed a sample line directly. Without this the desktop
     * lyric design would be unreviewable outside Electron, which is the one
     * window that cannot be screenshotted here.
     */
    toggle: async () => ({ open: true, locked: false, size: previewSettings.desktopLyrics.size }),
    getStatus: async () => ({ open: true, locked: false, size: previewSettings.desktopLyrics.size }),
    setLocked: async () => true,
    close: async () => ({ open: true, locked: false, size: previewSettings.desktopLyrics.size }),
    push: async () => true,
    setSize: async (size) => {
      previewSettings = {
        ...previewSettings,
        desktopLyrics: { ...previewSettings.desktopLyrics, size }
      }
      return size
    },
    onSize: () => () => undefined,
    onState: (handler) => {
      handler({
        text: '我把名字写在起雾的玻璃上',
        next: '写完就擦掉 像没发生过一样',
        title: '站台',
        artist: '陈默',
        playing: true
      })
      return () => undefined
    },
    onStatus: () => () => undefined
  },
  netease: {
    /*
     * The browser preview has no main process and therefore no online source.
     * Every call answers "nothing here" rather than throwing, so the Netease
     * view renders its signed-out empty state in the harness instead of
     * becoming the one screen that can only be reviewed inside Electron.
     */
    status: async () => ({ ready: false, loggedIn: false, detail: '浏览器预览模式没有网易云后端' }),
    // A browser has no profiles and no sessions, so there is nothing to bind.
    setProfile: async () => true,
    accountFor: async () => null,
    logoutProfile: async () => true,
    search: async () => ({ songs: [], albums: [], artists: [] }),
    streamUrl: async () => ({ ok: false, reason: 'service-unavailable' }),
    lyrics: async () => null,
    album: async () => null,
    artistTopSongs: async () => [],
    songDetail: async () => [],
    qrCreate: async () => ({ key: 'preview', url: '', imageDataUrl: '' }),
    qrCheck: async () => ({ status: 'waiting' }),
    loginCellphone: async () => ({ ok: false, message: '浏览器预览模式无法登录' }),
    loginStatus: async () => null,
    logout: async () => true,
    myPlaylists: async () => [],
    playlistTracks: async () => [],
    dailySongs: async () => [],
    cloudSongs: async () => [],
    likeList: async () => [],
    getQuality: async () => 'exhigh',
    setQuality: async () => 'exhigh'
  }
}

export const bridge: AuroraApi = native ?? webFallback
