import { BrowserWindow, screen, type Rectangle } from 'electron'
import path from 'node:path'
import { APP_ORIGIN } from './app-protocol'
import {
  LYRIC_SIZE_MAX,
  LYRIC_SIZE_MIN,
  loadSettings,
  saveSettings
} from './settings'

/**
 * The desktop lyric window.
 *
 * A separate frameless, transparent, always-on-top `BrowserWindow` that floats
 * over every other window. Two behaviours are the whole design:
 *
 *  - **Locked** (the default) the window ignores the mouse entirely, so it never
 *    eats a click meant for whatever is underneath. `forward: true` keeps
 *    mouse-move delivery so hover styling still works.
 *  - **Unlocked** it can be dragged and its control strip is reachable.
 *
 * It is shown with `showInactive()` so appearing never steals focus from what the
 * user was doing - an overlay that grabs focus on launch is worse than no
 * overlay.
 */

export interface OverlayState {
  /** Current lyric line, or null when there is nothing to show. */
  text: string | null
  /** The following line, rendered dimmed underneath. */
  next: string | null
  title: string
  artist: string
  playing: boolean
}

export interface OverlayStatus {
  open: boolean
  locked: boolean
  /** Font size of the strip, in px. Mirrors `src/env.d.ts`. */
  size: number
}

const DEV_URL = 'http://127.0.0.1:5173'
const isDev = process.argv.includes('--dev')

const DEFAULT_WIDTH = 980
const DEFAULT_HEIGHT = 150
const MIN_WIDTH = 320
const MIN_HEIGHT = 88

let overlay: BrowserWindow | null = null
let locked = true
/** Held while the window is closed so it renders instantly when reopened. */
let latest: OverlayState | null = null
let notify: (status: OverlayStatus) => void = () => undefined

export function initOverlay(onStatus: (status: OverlayStatus) => void): void {
  notify = onStatus
}

function notifyStatus(): void {
  notify(status())
}

function defaultBounds(): Rectangle {
  const { workArea } = screen.getPrimaryDisplay()
  const width = Math.min(DEFAULT_WIDTH, Math.round(workArea.width * 0.72))
  return {
    width,
    height: DEFAULT_HEIGHT,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + workArea.height - DEFAULT_HEIGHT - 72)
  }
}

/**
 * Keep the strip on a display that exists.
 *
 * Monitors get unplugged and resolutions change; a saved position from last
 * month can land entirely off-screen, which looks exactly like the feature being
 * broken.
 */
function clampBounds(bounds: Rectangle): Rectangle {
  const display = screen.getDisplayMatching(bounds)
  const area = display.workArea

  const width = Math.min(Math.max(bounds.width, MIN_WIDTH), area.width)
  const height = Math.min(Math.max(bounds.height, MIN_HEIGHT), area.height)
  const x = Math.min(Math.max(bounds.x, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(bounds.y, area.y), area.y + area.height - height)

  return { x, y, width, height }
}

function applyLock(): void {
  if (!overlay || overlay.isDestroyed()) return
  overlay.setIgnoreMouseEvents(locked, { forward: true })
}

function sendState(): void {
  if (!latest || !overlay || overlay.isDestroyed()) return
  overlay.webContents.send('overlay:state', latest)
}

/**
 * Send the font size to the overlay window.
 *
 * Called on open and on every change; `lastSize` keeps the open path from
 * re-sending on every status update, which happens on show/hide/move too.
 */
let lastSize = 0

function sendSize(force = false): void {
  if (!overlay || overlay.isDestroyed()) return
  const size = lyricSize()
  if (!force && size === lastSize) return
  lastSize = size
  overlay.webContents.send('overlay:size', size)
}

function persistBounds(): void {
  if (!overlay || overlay.isDestroyed()) return
  saveSettings({ lyricsOverlayBounds: overlay.getBounds() })
}

export function status(): OverlayStatus {
  return {
    open: overlay !== null && !overlay.isDestroyed(),
    locked,
    size: lyricSize()
  }
}

/** The size the strip should render at, read from the shared settings. */
function lyricSize(): number {
  const size = loadSettings().desktopLyricsSize
  return Math.min(LYRIC_SIZE_MAX, Math.max(LYRIC_SIZE_MIN, Math.round(size)))
}

/**
 * Change the strip's font size.
 *
 * The value lives in the main process because two windows need it: the settings
 * page writes it and the overlay renders it. Keeping it in the overlay's own
 * `localStorage` - as it was - meant the settings page could not see or change
 * it at all.
 */
export function setLyricSize(size: number): number {
  const next = Math.min(LYRIC_SIZE_MAX, Math.max(LYRIC_SIZE_MIN, Math.round(size)))
  saveSettings({ desktopLyricsSize: next })
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send('overlay:size', next)
  notifyStatus()
  return next
}

function open(): void {
  if (overlay && !overlay.isDestroyed()) {
    overlay.showInactive()
    sendState()
    sendSize(true)
    notifyStatus()
    return
  }

  const bounds = clampBounds(loadSettings().lyricsOverlayBounds ?? defaultBounds())

  overlay = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false,
    transparent: true,
    // A transparent window still needs an explicit fully-transparent colour, or
    // Windows paints it black.
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    title: 'Aurora 桌面歌词',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The strip must keep updating while the player window is minimised.
      backgroundThrottling: false
    }
  })

  // 'screen-saver' is above full-screen apps, which is what a lyric overlay is
  // for. Plain alwaysOnTop is not enough over a full-screen video or game.
  overlay.setAlwaysOnTop(true, 'screen-saver')
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  applyLock()

  overlay.once('ready-to-show', () => {
    overlay?.showInactive()
    sendState()
    sendSize(true)
  })

  overlay.on('closed', () => {
    overlay = null
    notifyStatus()
  })

  let saveTimer: NodeJS.Timeout | undefined
  const saveSoon = () => {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(persistBounds, 500)
  }
  overlay.on('moved', saveSoon)
  overlay.on('resized', saveSoon)
  overlay.on('show', notifyStatus)
  overlay.on('hide', notifyStatus)

  if (isDev) {
    void overlay.loadURL(`${DEV_URL}/overlay.html`)
  } else {
    // Same private-scheme reason as the main window.
    void overlay.loadURL(`${APP_ORIGIN}/overlay.html`)
  }

  notifyStatus()
}

function close(): void {
  if (!overlay || overlay.isDestroyed()) {
    overlay = null
    notifyStatus()
    return
  }
  persistBounds()
  overlay.destroy()
  overlay = null
  notifyStatus()
}

export function toggleOverlay(force?: boolean): OverlayStatus {
  const want = force ?? !status().open
  if (want) open()
  else close()
  return status()
}

export function setLocked(next: boolean): boolean {
  locked = next
  applyLock()
  notifyStatus()
  return locked
}

export function isLocked(): boolean {
  return locked
}

/** Forward the current lyric state. Safe to call whether or not the window is open. */
export function pushOverlayState(state: OverlayState): void {
  latest = state
  sendState()
}

/** Used while quitting, so the overlay does not outlive the app. */
export function destroyOverlay(): void {
  if (overlay && !overlay.isDestroyed()) overlay.destroy()
  overlay = null
}
