/// <reference types="vite/client" />

import type { Track } from './types'

/**
 * The bridge surface the renderer depends on, declared here rather than
 * imported from the main process so main-process code never leaks into the
 * page bundle. Optional because the renderer must also run in a plain browser,
 * where `src/bridge.ts` substitutes an in-memory implementation.
 */

export interface ScanProgress {
  phase: 'walking' | 'reading' | 'done'
  found: number
  scanned: number
  cached: number
  current: string
}

export interface LibraryIndex {
  version: number
  scannedAt: number
  roots: string[]
  tracks: Track[]
}

export interface LibraryApi {
  getRoots(): Promise<string[]>
  addRoots(): Promise<string[]>
  removeRoot(root: string): Promise<string[]>
  /** Raw LRC text from a sidecar file next to the audio, or null. */
  readLyrics(trackPath: string): Promise<string | null>
  /** Ask the OS file manager to show this file. False if it is outside the library. */
  reveal(trackPath: string): Promise<boolean>
  getIndex(): Promise<LibraryIndex>
  scan(): Promise<LibraryIndex>
  cancelScan(): Promise<boolean>
  onProgress(handler: (progress: ScanProgress) => void): () => void
}

export interface PlaylistsApi {
  /** Opens a file picker and returns the m3u text plus its directory. */
  import(): Promise<{ name: string; dir: string; text: string } | null>
  export(name: string, text: string): Promise<boolean>
}

export interface UpdateInfo {
  version: string
  name: string
  notes: string
  url: string
  publishedAt: string
}

/**
 * Mirrors the main process union. `unconfigured` is a real state, not an error:
 * a fresh clone has placeholder publish settings and must say so rather than
 * claim it is up to date.
 */
export type UpdateResult =
  | { state: 'current'; current: string; checkedAt: number }
  | { state: 'available'; current: string; checkedAt: number; info: UpdateInfo }
  | { state: 'unconfigured'; current: string; message: string }
  | { state: 'error'; current: string; checkedAt: number; message: string }

export interface UpdatesApi {
  check(): Promise<UpdateResult>
  open(url: string): Promise<boolean>
  getAutoCheck(): Promise<boolean>
  setAutoCheck(enabled: boolean): Promise<boolean>
  onAvailable(handler: (result: UpdateResult) => void): () => void
}

export type MediaCommand = 'toggle' | 'next' | 'prev'

export interface PlayerApi {
  reportState(state: { playing: boolean }): Promise<boolean>
  onCommand(handler: (command: MediaCommand) => void): () => void
}

export interface LyricsQuery {
  title: string
  artist: string
  album: string
  /** Seconds; LRCLIB matches on this, so an accurate duration matters. */
  duration: number
}

export interface LyricsHit {
  text: string
  origin: 'cache' | 'lrclib'
  trackName: string
  artistName: string
  synced: boolean
}

export interface LyricsApi {
  lookup(query: LyricsQuery): Promise<LyricsHit | null>
  isOnlineEnabled(): Promise<boolean>
  setOnlineEnabled(enabled: boolean): Promise<boolean>
}

export interface OverlayState {
  text: string | null
  next: string | null
  title: string
  artist: string
  playing: boolean
}

export interface OverlayStatus {
  open: boolean
  locked: boolean
}

export interface OverlayApi {
  toggle(enabled?: boolean): Promise<OverlayStatus>
  getStatus(): Promise<OverlayStatus>
  setLocked(locked: boolean): Promise<boolean>
  close(): Promise<OverlayStatus>
  push(state: OverlayState): Promise<boolean>
  onState(handler: (state: OverlayState) => void): () => void
  onStatus(handler: (status: OverlayStatus) => void): () => void
}

export interface AuroraApi {
  info(): Promise<{
    version: string
    electron: string
    chrome: string
    node: string
    platform: string
    userData: string
  }>
  library: LibraryApi
  playlists: PlaylistsApi
  updates: UpdatesApi
  player: PlayerApi
  lyrics: LyricsApi
  overlay: OverlayApi
}

declare global {
  interface Window {
    aurora?: AuroraApi
  }
}

export {}
