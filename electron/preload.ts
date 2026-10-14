import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { LibraryIndex, ScanProgress } from './library-scan'
import type { UpdateResult } from './updates'
import type { LyricsHit, LyricsQuery } from './lyrics'
import type { OverlayState, OverlayStatus } from './lyrics-overlay'
import type { MediaCommand } from './tray'

/**
 * The only surface the renderer gets. Everything crossing this bridge is an
 * explicit, named capability - no `ipcRenderer` handle ever reaches page code.
 *
 * The `library-scan` import is type-only, so it is erased at compile time and
 * does not pull main-process code into the preload bundle.
 */
const api = {
  info: () => ipcRenderer.invoke('app:info') as Promise<{
    version: string
    electron: string
    chrome: string
    node: string
    platform: string
    userData: string
  }>,

  library: {
    getRoots: () => ipcRenderer.invoke('library:getRoots') as Promise<string[]>,
    addRoots: () => ipcRenderer.invoke('library:addRoots') as Promise<string[]>,
    removeRoot: (root: string) => ipcRenderer.invoke('library:removeRoot', root) as Promise<string[]>,

    readLyrics: (trackPath: string) =>
      ipcRenderer.invoke('library:readLyrics', trackPath) as Promise<string | null>,

    reveal: (trackPath: string) =>
      ipcRenderer.invoke('library:reveal', trackPath) as Promise<boolean>,

    getIndex: () => ipcRenderer.invoke('library:getIndex') as Promise<LibraryIndex>,
    scan: () => ipcRenderer.invoke('library:scan') as Promise<LibraryIndex>,
    cancelScan: () => ipcRenderer.invoke('library:cancelScan') as Promise<boolean>,

    /** Returns an unsubscribe function; call it or the listener leaks. */
    onProgress: (handler: (progress: ScanProgress) => void) => {
      const listener = (_event: IpcRendererEvent, progress: ScanProgress) => handler(progress)
      ipcRenderer.on('library:progress', listener)
      return () => {
        ipcRenderer.removeListener('library:progress', listener)
      }
    }
  },

  playlists: {
    import: () =>
      ipcRenderer.invoke('playlists:import') as Promise<{
        name: string
        dir: string
        text: string
      } | null>,
    export: (name: string, text: string) =>
      ipcRenderer.invoke('playlists:export', { name, text }) as Promise<boolean>
  },

  updates: {
    check: () => ipcRenderer.invoke('updates:check') as Promise<UpdateResult>,
    /** Opens the release page in the system browser. */
    open: (url: string) => ipcRenderer.invoke('updates:open', url) as Promise<boolean>,
    getAutoCheck: () => ipcRenderer.invoke('updates:getAutoCheck') as Promise<boolean>,
    setAutoCheck: (enabled: boolean) =>
      ipcRenderer.invoke('updates:setAutoCheck', enabled) as Promise<boolean>,
    /** Fires when the daily background check finds a newer release. */
    onAvailable: (handler: (result: UpdateResult) => void) => {
      const listener = (_event: IpcRendererEvent, result: UpdateResult) => handler(result)
      ipcRenderer.on('updates:available', listener)
      return () => {
        ipcRenderer.removeListener('updates:available', listener)
      }
    }
  },

  player: {
    /** Lets the main process swap the taskbar thumbnail button between play and pause. */
    reportState: (state: { playing: boolean }) =>
      ipcRenderer.invoke('player:reportState', state) as Promise<boolean>,
    /** Transport commands from the tray menu and the thumbnail toolbar. */
    onCommand: (handler: (command: MediaCommand) => void) => {
      const listener = (_event: IpcRendererEvent, command: MediaCommand) => handler(command)
      ipcRenderer.on('media:command', listener)
      return () => {
        ipcRenderer.removeListener('media:command', listener)
      }
    }
  },

  lyrics: {
    /** Returns null when the feature is off, the track is unknown, or offline. */
    lookup: (query: LyricsQuery) =>
      ipcRenderer.invoke('lyrics:lookup', query) as Promise<LyricsHit | null>,
    isOnlineEnabled: () => ipcRenderer.invoke('lyrics:isOnlineEnabled') as Promise<boolean>,
    setOnlineEnabled: (enabled: boolean) =>
      ipcRenderer.invoke('lyrics:setOnlineEnabled', enabled) as Promise<boolean>
  },

  /**
   * Shared by both windows: the player window opens and feeds the overlay, the
   * overlay window consumes the state and reports lock changes.
   */
  overlay: {    toggle: (enabled?: boolean) =>
      ipcRenderer.invoke('overlay:toggle', enabled) as Promise<OverlayStatus>,
    getStatus: () => ipcRenderer.invoke('overlay:status') as Promise<OverlayStatus>,
    setLocked: (locked: boolean) =>
      ipcRenderer.invoke('overlay:setLocked', locked) as Promise<boolean>,
    close: () => ipcRenderer.invoke('overlay:close') as Promise<OverlayStatus>,
    push: (state: OverlayState) => ipcRenderer.invoke('overlay:push', state) as Promise<boolean>,
    /** Fired in the overlay window whenever the lyric line changes. */
    onState: (handler: (state: OverlayState) => void) => {
      const listener = (_event: IpcRendererEvent, state: OverlayState) => handler(state)
      ipcRenderer.on('overlay:state', listener)
      return () => {
        ipcRenderer.removeListener('overlay:state', listener)
      }
    },
    /** Fired in the player window when the overlay opens, closes or locks. */
    onStatus: (handler: (status: OverlayStatus) => void) => {
      const listener = (_event: IpcRendererEvent, status: OverlayStatus) => handler(status)
      ipcRenderer.on('overlay:status', listener)
      return () => {
        ipcRenderer.removeListener('overlay:status', listener)
      }
    }
  },

  /**
   * Netease Cloud Music, through a third-party reverse-engineered API.
   *
   * Every call is a plain invoke: the main process owns the upstream client, the
   * cookie jar and the bootstrapped device credentials, so no credential and no
   * raw upstream URL ever reaches page code. Audio and artwork are proxied
   * through the `aurora-remote:` scheme for the same reason.
   */
  netease: {
    status: () => ipcRenderer.invoke('netease:status'),
    search: (keywords: string, type: string, limit?: number) =>
      ipcRenderer.invoke('netease:search', { keywords, type, limit }),
    streamUrl: (songId: number, quality?: string) =>
      ipcRenderer.invoke('netease:streamUrl', { songId, quality }),
    lyrics: (songId: number) => ipcRenderer.invoke('netease:lyrics', songId),
    album: (id: number) => ipcRenderer.invoke('netease:album', id),
    artistTopSongs: (id: number, limit?: number) =>
      ipcRenderer.invoke('netease:artistTopSongs', { id, limit }),
    songDetail: (ids: number[]) => ipcRenderer.invoke('netease:songDetail', ids),

    qrCreate: () => ipcRenderer.invoke('netease:qrCreate'),
    qrCheck: (key: string) => ipcRenderer.invoke('netease:qrCheck', key),
    loginCellphone: (phone: string, password: string) =>
      ipcRenderer.invoke('netease:loginCellphone', { phone, password }),
    loginStatus: () => ipcRenderer.invoke('netease:loginStatus'),
    logout: () => ipcRenderer.invoke('netease:logout'),

    myPlaylists: () => ipcRenderer.invoke('netease:myPlaylists'),
    playlistTracks: (id: number) => ipcRenderer.invoke('netease:playlistTracks', id),
    dailySongs: () => ipcRenderer.invoke('netease:dailySongs'),
    cloudSongs: () => ipcRenderer.invoke('netease:cloudSongs'),
    likeList: () => ipcRenderer.invoke('netease:likeList'),

    getQuality: () => ipcRenderer.invoke('netease:getQuality'),
    setQuality: (quality: string) => ipcRenderer.invoke('netease:setQuality', quality)
  }
}

contextBridge.exposeInMainWorld('aurora', api)

export type AuroraApi = typeof api
