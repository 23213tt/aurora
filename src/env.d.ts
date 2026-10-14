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

// --- 网易云（第三方逆向接口）---------------------------------------------
//
// 这一层是「在线音源」的全部能力面。它与本地曲库严格分离：网易云的歌从不进入
// library store，而是由 src/netease 自己的 store 持有。所有网络与 cookie 都在
// 主进程，渲染层只拿到已经归一化的数据。

/** Why a track cannot play. Drives the message; never collapse these into "下架". */
export type NeteaseFailureReason =
  | 'login-required'
  | 'vip-required'
  | 'region-limited'
  | 'trial-only'
  | 'taken-down'
  | 'network'
  | 'rate-limited'
  | 'service-unavailable'
  | 'unknown'

export interface NeteaseArtist {
  id: number
  name: string
}

export interface NeteaseAlbumRef {
  id: number
  name: string
  picUrl: string | null
}

export interface NeteaseSong {
  id: number
  name: string
  artists: NeteaseArtist[]
  album: NeteaseAlbumRef
  /** Seconds. Upstream reports milliseconds. */
  duration: number
  /** Upstream `fee`: 0 free, 1 vip, 8 low-quality free, 4 paid album. */
  fee: number
}

export type NeteaseQuality = 'standard' | 'higher' | 'exhigh' | 'lossless'

export interface NeteaseStream {
  /** Upstream http(s) URL. The renderer must proxy it, not fetch it. */
  url: string
  /** kbps */
  br: number
  level: NeteaseQuality | 'hires'
  /** Seconds of what this URL actually delivers (a trial is shorter). */
  duration: number
  trial: boolean
  trialFrom?: number
  trialTo?: number
}

export type NeteaseStreamResult =
  | { ok: true; stream: NeteaseStream }
  | { ok: false; reason: NeteaseFailureReason; message?: string }

export interface NeteasePlaylistSummary {
  id: number
  name: string
  coverUrl: string | null
  trackCount: number
  playCount: number
  creator: string
  subscribed: boolean
}

export interface NeteaseAccount {
  userId: number
  nickname: string
  avatarUrl: string | null
  vip: boolean
  level: number
}

export interface NeteaseSearchResult {
  songs: NeteaseSong[]
  albums: {
    id: number
    name: string
    artist: string
    picUrl: string | null
    year: number | null
    songCount: number
  }[]
  artists: { id: number; name: string; picUrl: string | null; albumCount: number }[]
}

export interface NeteaseApi {
  /** Upstream self-check: whether the client bootstrapped and whether a cookie exists. */
  status(): Promise<{ ready: boolean; loggedIn: boolean; detail?: string }>

  search(
    keywords: string,
    type: 'song' | 'album' | 'artist',
    limit?: number
  ): Promise<NeteaseSearchResult>

  /** Resolve a playable URL. Failures are classified, not thrown. */
  streamUrl(songId: number, quality?: NeteaseQuality): Promise<NeteaseStreamResult>

  lyrics(songId: number): Promise<{ lrc: string | null; translation: string | null } | null>

  album(id: number): Promise<{
    id: number
    name: string
    artist: string
    coverUrl: string | null
    year: number | null
    songs: NeteaseSong[]
  } | null>

  artistTopSongs(id: number, limit?: number): Promise<NeteaseSong[]>
  songDetail(ids: number[]): Promise<NeteaseSong[]>

  qrCreate(): Promise<{ key: string; url: string; imageDataUrl: string }>
  qrCheck(key: string): Promise<{
    status: 'waiting' | 'scanned' | 'expired' | 'confirmed' | 'failed'
    account?: NeteaseAccount
    message?: string
  }>
  loginCellphone(
    phone: string,
    password: string
  ): Promise<{ ok: boolean; account?: NeteaseAccount; message?: string }>
  loginStatus(): Promise<NeteaseAccount | null>
  logout(): Promise<boolean>

  /** Personal music. Empty arrays (not errors) when signed out. */
  myPlaylists(): Promise<NeteasePlaylistSummary[]>
  playlistTracks(id: number): Promise<NeteaseSong[]>
  dailySongs(): Promise<NeteaseSong[]>
  cloudSongs(): Promise<NeteaseSong[]>
  likeList(): Promise<NeteaseSong[]>

  getQuality(): Promise<NeteaseQuality>
  setQuality(quality: NeteaseQuality): Promise<NeteaseQuality>
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
  netease: NeteaseApi
}

declare global {
  interface Window {
    aurora?: AuroraApi
  }
}

export {}
