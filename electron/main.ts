import { app, BrowserWindow, dialog, globalShortcut, ipcMain, shell } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { isInsideRoots, loadSettings, saveSettings } from './settings'
import { handleMediaProtocol, registerMediaScheme } from './media-protocol'
import { APP_ORIGIN, handleAppProtocol, registerAppScheme } from './app-protocol'
import { loadIndex, scanLibrary, type ScanProgress } from './library-scan'
import { autoCheck, checkForUpdate, openReleasePage, type UpdateResult } from './updates'
import { lookupLyrics, type LyricsQuery } from './lyrics'
import {
  createTray,
  destroyTray,
  hasTray,
  installThumbar,
  refreshTrayMenu,
  type MediaCommand,
  type TrayHandlers
} from './tray'
import {
  destroyOverlay,
  initOverlay,
  isLocked as isOverlayLocked,
  pushOverlayState,
  setLocked as setOverlayLocked,
  status as overlayStatus,
  toggleOverlay,
  type OverlayState
} from './lyrics-overlay'

const isDev = process.argv.includes('--dev')
const DEV_URL = 'http://127.0.0.1:5173'
const captureArg = process.argv.find((arg) => arg.startsWith('--capture='))

// Makes Chromium route the Media Session API into the Windows SMTC
// (System Media Transport Controls), which is what gives us the volume-flyout
// overlay, hardware media keys and the taskbar preview controls.
app.commandLine.appendSwitch('enable-features', 'HardwareMediaKeyHandling,MediaSessionService')

app.setAppUserModelId('com.aurora.player')

// Must run before the app is ready, or Chromium will not treat these schemes as
// standard/secure and range requests and module loading will not be permitted.
registerMediaScheme()
registerAppScheme()

interface WinState {
  width: number
  height: number
  x?: number
  y?: number
  maximized?: boolean
}

let mainWindow: BrowserWindow | null = null

/** Set while a scan is running so it can be abandoned from the UI. */
let activeScan: { cancelled: boolean } | null = null

/** Set on the way out, so the close handler stops hiding the window. */
let isQuitting = false

/** Mirrors the renderer's playback state so the thumbnail button shows the right glyph. */
let lastPlaying = false

function sendMediaCommand(command: MediaCommand): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('media:command', command)
  }
}

function showWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function toggleWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  // Minimised counts as hidden: clicking the tray should bring it back, not
  // hide it further.
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) mainWindow.hide()
  else showWindow()
  refreshTrayMenu(trayHandlers())
}

const trayHandlers = (): TrayHandlers => ({
  toggleWindow,
  isWindowVisible: () => Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()),
  command: sendMediaCommand,
  quit: () => {
    isQuitting = true
    app.quit()
  },
  extraItems: () => [
    { type: 'separator' },
    {
      label: overlayStatus().open ? '隐藏桌面歌词' : '显示桌面歌词',
      accelerator: 'Control+Alt+L',
      click: () => toggleOverlay()
    },
    {
      label: isOverlayLocked() ? '解锁桌面歌词（可拖动）' : '锁定桌面歌词（鼠标穿透）',
      accelerator: 'Control+Alt+K',
      enabled: overlayStatus().open,
      click: () => setOverlayLocked(!isOverlayLocked())
    }
  ]
})

/**
 * The overlay is useless if it can only be reached by clicking a window that is
 * already behind something else, so both actions get a global shortcut.
 */
function registerGlobalShortcuts(): void {
  const bindings: [string, () => void][] = [
    ['Control+Alt+L', () => toggleOverlay()],
    ['Control+Alt+K', () => setOverlayLocked(!isOverlayLocked())]
  ]

  for (const [accelerator, handler] of bindings) {
    try {
      const registered = globalShortcut.register(accelerator, handler)
      if (!registered) console.error('[aurora] shortcut already taken:', accelerator)
    } catch (error) {
      console.error('[aurora] could not register shortcut', accelerator, error)
    }
  }
}

const stateFile = (): string => path.join(app.getPath('userData'), 'window-state.json')

function loadWinState(): WinState {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as WinState
    if (typeof raw.width === 'number' && typeof raw.height === 'number') return raw
  } catch {
    /* first run, or a corrupt file we simply ignore */
  }
  return { width: 1360, height: 860 }
}

function saveWinState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const bounds = mainWindow.getNormalBounds()
  const next: WinState = {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    maximized: mainWindow.isMaximized()
  }
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true })
    fs.writeFileSync(stateFile(), JSON.stringify(next))
  } catch {
    /* losing window geometry is never worth crashing over */
  }
}

function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let timer: NodeJS.Timeout | undefined
  return ((...args: never[]) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }) as T
}

/**
 * Decode a lyrics file. Chinese `.lrc` files are still very often GBK-encoded
 * rather than UTF-8, and a strict UTF-8 decode is the only reliable way to tell
 * the difference before falling back.
 */
function decodeText(buffer: Buffer): string {
  const body =
    buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
      ? buffer.subarray(3)
      : buffer
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body)
  } catch {
    try {
      return new TextDecoder('gbk').decode(body)
    } catch {
      return body.toString('utf8')
    }
  }
}

function createWindow(): void {
  const state = loadWinState()

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#0d1013',
    // Custom chrome: we draw the title bar ourselves, while Windows keeps the
    // real caption buttons overlaid so snap layouts and aero snap still work.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#c8ccd6',
      height: 44
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // A desktop player is not a web page: it may resume playback on launch
      // without waiting for a click it will never get.
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
      webSecurity: true
    }
  })

  if (state.maximized) mainWindow.maximize()

  mainWindow.once('ready-to-show', () => {
    const window = mainWindow
    if (!window) return
    window.show()
    installThumbar(window, lastPlaying, sendMediaCommand)
  })

  mainWindow.on('close', (event) => {
    saveWinState()
    /*
     * Closing a music player should not stop the music. Hide instead - but only
     * when a tray icon actually exists, because hiding without one would leave
     * a running process with no way back to its window.
     */
    if (isQuitting || !hasTray()) return
    event.preventDefault()
    mainWindow?.hide()
    refreshTrayMenu(trayHandlers())
  })

  mainWindow.on('show', () => refreshTrayMenu(trayHandlers()))
  mainWindow.on('hide', () => refreshTrayMenu(trayHandlers()))

  mainWindow.on('resize', debounce(saveWinState, 400))
  mainWindow.on('move', debounce(saveWinState, 400))

  // External links leave the app instead of hijacking the player window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    void mainWindow.loadURL(DEV_URL)
    if (!captureArg) mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    // Served over a private scheme rather than file://. An opaque file:// origin
    // blocks the module script and defeats the app's own `script-src 'self'`;
    // see electron/app-protocol.ts.
    void mainWindow.loadURL(`${APP_ORIGIN}/index.html`)
  }

  if (captureArg) {
    const out = captureArg.slice('--capture='.length)
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void (async () => {
          try {
            const image = await mainWindow?.webContents.capturePage()
            if (image) fs.writeFileSync(out, image.toPNG())
          } catch (error) {
            console.error('[aurora] capture failed', error)
          }
          app.quit()
        })()
      }, 2600)
    })
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function registerIpc(): void {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    userData: app.getPath('userData')
  }))

  ipcMain.handle('library:getRoots', () => loadSettings().roots)

  ipcMain.handle('library:addRoots', async () => {
    const current = loadSettings().roots
    if (!mainWindow) return current
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择音乐文件夹',
      buttonLabel: '加入曲库',
      properties: ['openDirectory', 'multiSelections', 'dontAddToRecent']
    })
    if (result.canceled || result.filePaths.length === 0) return current
    const merged = Array.from(new Set([...current, ...result.filePaths.map((p) => path.resolve(p))]))
    saveSettings({ roots: merged })
    return merged
  })

  ipcMain.handle('library:removeRoot', (_event, root: string) => {
    const next = loadSettings().roots.filter((candidate) => candidate !== root)
    saveSettings({ roots: next })
    return next
  })

  /**
   * Show a track in the OS file manager.
   *
   * The path arrives from the renderer, so it is checked against the folders the
   * user actually added. Without that, a compromised renderer could ask the shell
   * to reveal any path on the machine.
   */
  ipcMain.handle('library:reveal', (_event, trackPath: unknown) => {
    if (typeof trackPath !== 'string' || !trackPath) return false
    if (!isInsideRoots(trackPath)) return false
    shell.showItemInFolder(trackPath)
    return true
  })

  ipcMain.handle('library:readLyrics', async (_event, trackPath: unknown) => {
    if (typeof trackPath !== 'string' || !isInsideRoots(trackPath)) return null
    const directory = path.dirname(trackPath)
    const stem = path.basename(trackPath, path.extname(trackPath))
    const candidates = [
      path.join(directory, `${stem}.lrc`),
      path.join(directory, `${stem}.LRC`),
      // One shared lyric file for a folder, for albums ripped as a single file.
      path.join(directory, 'lyrics.lrc')
    ]
    for (const candidate of candidates) {
      try {
        return decodeText(await fs.promises.readFile(candidate))
      } catch {
        // A missing candidate is the normal case, not an error.
      }
    }
    return null
  })

  ipcMain.handle('library:getIndex', () => loadIndex())

  ipcMain.handle('playlists:import', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '导入 m3u 播放列表',
      filters: [{ name: '播放列表', extensions: ['m3u', 'm3u8'] }],
      properties: ['openFile', 'dontAddToRecent']
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const file = result.filePaths[0]
    try {
      // The directory travels with the text so relative entries in the
      // playlist can be resolved by the renderer.
      return {
        name: path.basename(file, path.extname(file)),
        dir: path.dirname(file),
        text: decodeText(await fs.promises.readFile(file))
      }
    } catch (error) {
      console.error('[aurora] could not read the playlist', error)
      return null
    }
  })

  ipcMain.handle('playlists:export', async (_event, payload: { name: string; text: string }) => {
    if (!mainWindow || typeof payload?.text !== 'string') return false
    const safeName = (payload.name || 'playlist').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120)
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出 m3u 播放列表',
      defaultPath: `${safeName}.m3u`,
      filters: [{ name: '播放列表', extensions: ['m3u'] }]
    })
    if (result.canceled || !result.filePath) return false
    try {
      await fs.promises.writeFile(result.filePath, payload.text, 'utf8')
      return true
    } catch (error) {
      console.error('[aurora] could not write the playlist', error)
      return false
    }
  })

  ipcMain.handle('library:scan', async () => {
    const controller = { cancelled: false }
    activeScan = controller
    try {
      return await scanLibrary({
        cancelled: () => controller.cancelled,
        onProgress: (progress: ScanProgress) => {
          // Progress is advisory; a closed window must not fail the scan.
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('library:progress', progress)
          }
        }
      })
    } finally {
      if (activeScan === controller) activeScan = null
    }
  })

  ipcMain.handle('overlay:toggle', (_event, enabled: unknown) =>
    toggleOverlay(typeof enabled === 'boolean' ? enabled : undefined)
  )

  ipcMain.handle('overlay:status', () => overlayStatus())

  ipcMain.handle('overlay:setLocked', (_event, locked: unknown) => setOverlayLocked(Boolean(locked)))

  ipcMain.handle('overlay:close', () => {
    toggleOverlay(false)
    return overlayStatus()
  })

  ipcMain.handle('overlay:push', (_event, state: unknown) => {
    // Renderer input crossing a trust boundary, so the shape is rebuilt here
    // rather than trusted from the message.
    if (!state || typeof state !== 'object') return false
    const candidate = state as Partial<OverlayState>
    pushOverlayState({
      text: typeof candidate.text === 'string' ? candidate.text : null,
      next: typeof candidate.next === 'string' ? candidate.next : null,
      title: typeof candidate.title === 'string' ? candidate.title : '',
      artist: typeof candidate.artist === 'string' ? candidate.artist : '',
      playing: Boolean(candidate.playing)
    })
    return true
  })

  ipcMain.handle('updates:check', () => checkForUpdate())

  ipcMain.handle('lyrics:isOnlineEnabled', () => loadSettings().onlineLyrics)

  ipcMain.handle('lyrics:setOnlineEnabled', (_event, enabled: unknown) => {
    saveSettings({ onlineLyrics: Boolean(enabled) })
    return loadSettings().onlineLyrics
  })

  ipcMain.handle('lyrics:lookup', (_event, query: unknown) => {
    // The setting is enforced here, not in the renderer: the network egress is
    // the thing being gated, so the gate belongs on the side that does it.
    if (!loadSettings().onlineLyrics) return null
    if (!query || typeof query !== 'object') return null

    const candidate = query as Partial<LyricsQuery>
    if (typeof candidate.title !== 'string' || !candidate.title.trim()) return null

    return lookupLyrics({
      title: candidate.title,
      artist: typeof candidate.artist === 'string' ? candidate.artist : '',
      album: typeof candidate.album === 'string' ? candidate.album : '',
      duration: typeof candidate.duration === 'number' ? candidate.duration : 0
    })
  })

  ipcMain.handle('player:reportState', (_event, state: { playing?: boolean } | null) => {
    const playing = Boolean(state?.playing)
    if (playing === lastPlaying) return true
    lastPlaying = playing
    if (mainWindow && !mainWindow.isDestroyed()) {
      installThumbar(mainWindow, playing, sendMediaCommand)
    }
    return true
  })

  ipcMain.handle('updates:open', (_event, url: unknown) => {
    if (typeof url !== 'string') return false
    return openReleasePage(url).then(() => true)
  })

  ipcMain.handle('updates:getAutoCheck', () => loadSettings().autoCheckUpdates)

  ipcMain.handle('updates:setAutoCheck', (_event, enabled: unknown) => {
    saveSettings({ autoCheckUpdates: Boolean(enabled) })
    return loadSettings().autoCheckUpdates
  })

  ipcMain.handle('library:cancelScan', () => {
    if (activeScan) activeScan.cancelled = true
    return true
  })
}

// Single instance: a second launch focuses the running player instead of
// starting a rival media session.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  void app.whenReady().then(() => {
    handleMediaProtocol()
    handleAppProtocol()
    initOverlay((status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('overlay:status', status)
      }
    })
    registerIpc()
    createWindow()
    createTray(trayHandlers())
    registerGlobalShortcuts()

    // One quiet check a day. It only ever reports; nothing is downloaded or
    // applied without the user going to the release page themselves.
    void autoCheck((result: UpdateResult) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updates:available', result)
      }
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('before-quit', () => {
    isQuitting = true
    globalShortcut.unregisterAll()
    destroyOverlay()
    destroyTray()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
