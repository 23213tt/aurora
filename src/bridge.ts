import type { AuroraApi } from './env'
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
    // Nothing to check against in a browser preview, and saying so is more
    // useful than pretending to be current.
    check: async () => ({
      state: 'unconfigured',
      current: '0.1.0-web',
      message: '浏览器预览模式没有更新检查'
    }),
    open: async () => false,
    getAutoCheck: async () => false,
    setAutoCheck: async () => false,
    onAvailable: () => () => undefined
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
    toggle: async () => ({ open: true, locked: false }),
    getStatus: async () => ({ open: true, locked: false }),
    setLocked: async () => true,
    close: async () => ({ open: true, locked: false }),
    push: async () => true,
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
  }
}

export const bridge: AuroraApi = native ?? webFallback
