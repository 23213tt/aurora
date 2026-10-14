import { useEffect, useState } from 'react'
import type {
  NeteaseAccount,
  NeteasePlaylistSummary,
  NeteaseQuality,
  NeteaseSong,
  NeteaseStream
} from '../../env'
import type { Track } from '../../types'
import {
  onlineStoreState,
  useOnlineStore,
  type OnlineStore,
  type PlatformFail
} from '../online/store'
import { cachedStream } from '../online/streams'
import type { OnlineCollectionKind, OnlineSearchKind } from '../online/types'

/**
 * The Netease screen's state, as the rest of the app sees it.
 *
 * This file used to hold the whole state machine: search with a stale-response
 * guard, a catalogue cache, an eight-minute stream cache with retries, an account,
 * a classified failure, and profile binding. All of that now lives in
 * `features/online/store.ts`, driven by this platform's `backend` - the same code
 * QQ runs on. What remains is an adapter, so the screens and the playback wiring
 * that already import `useNetease` keep working while the behaviour moves
 * underneath them.
 *
 * Deliberately an adapter and not a second implementation: two copies of a stream
 * cache is exactly the duplication the provider layer exists to remove.
 */

export type { PlatformFail as NeteaseFail }
export { toTrack, songCover } from './track'

/** The generated collections this platform declares, as the screen's own name for them. */
 type NeteaseCategory = OnlineCollectionKind

/**
 * What a selector may read.
 *
 * A structural view of the shared store, using this platform's old field names for
 * the two things that were named after it (`category` for the open collection,
 * `searchType` for the active result tab). A type rather than a mapped object, so
 * there is no second copy of the state to keep in sync.
 */
 interface NeteaseStateView {
  ready: boolean
  backendBlocked: boolean
  statusDetail: string | null
  account: NeteaseAccount | null
  quality: NeteaseQuality
  delivered: string | null
  query: string
  searchType: OnlineSearchKind
  searching: boolean
  searched: boolean
  songs: NeteaseSong[]
  albums: { id: number; name: string; artist: string; picUrl: string | null; year: number | null; songCount: number }[]
  artists: { id: number; name: string; picUrl: string | null; albumCount: number }[]
  category: NeteaseCategory | null
  openId: number | null
  openName: string | null
  openCover: string | null
  collection: NeteaseSong[]
  playlists: NeteasePlaylistSummary[]
  playlistsLoading: boolean
  fail: PlatformFail | null
  loadingTracks: boolean
  /** Whether this platform's sign-in dialog should be showing. */
  loginOpen: boolean
}

/**
 * Rename the shared fields onto this platform's vocabulary, once.
 *
 * `account` is the same object the backend produced, so the cast is a narrowing
 * rather than a conversion: `NeteaseAccount` and `OnlineAccount` are structurally
 * the same record with different field names for the id, and the backend's
 * `loginStatus` is what produced it.
 */
function viewOf(state: OnlineStore): NeteaseStateView {
  return {
    ready: state.ready,
    backendBlocked: state.backendBlocked,
    statusDetail: state.statusDetail,
    account: state.account as NeteaseAccount | null,
    quality: state.quality as NeteaseQuality,
    delivered: state.delivered,
    query: state.query,
    searchType: state.searchKind,
    searching: state.searching,
    searched: state.searched,
    songs: state.songs,
    albums: state.albums,
    artists: state.artists,
    category: state.collectionKind,
    openId: state.openId,
    openName: state.openName,
    openCover: state.openCover,
    collection: state.collection,
    playlists: state.playlists,
    playlistsLoading: state.playlistsLoading,
    fail: state.fail,
    loadingTracks: state.loadingTracks,
    loginOpen: loginOpen()
  }
}

/**
 * Whether the sign-in dialog is open.
 *
 * Kept outside the shared store on purpose: the dialog is a piece of this
 * platform's *interface*, not of the state machine every platform shares. QQ's
 * dialog has a different flow, and neither belongs in a structure the other has to
 * carry.
 */
let loginOpenFlag = false
const loginListeners = new Set<() => void>()

export function loginOpen(): boolean {
  return loginOpenFlag
}

export function setLoginOpen(open: boolean): void {
  if (loginOpenFlag === open) return
  loginOpenFlag = open
  for (const listener of loginListeners) listener()
}

/** Subscribe a component to the sign-in dialog's open state. */
export function useNeteaseLoginOpen(): boolean {
  const [open, setOpen] = useState(loginOpenFlag)
  useEffect(() => {
    const listener = () => setOpen(loginOpenFlag)
    loginListeners.add(listener)
    return () => {
      loginListeners.delete(listener)
    }
  }, [])
  return open
}

/**
 * Subscribe to this platform's state, or act on it without rendering.
 *
 * The call form is the selector hook every view uses; `getState()` is the
 * imperative form the rail's click handlers and the playback wiring use. Both read
 * the one shared store for this platform, so there is a single copy of the state.
 */
 interface NeteaseStoreHook {
  <T>(selector: (state: NeteaseStateView) => T): T
  getState(): NeteaseActions
}

const neteaseHook = (<T,>(selector: (state: NeteaseStateView) => T): T =>
  useOnlineStore('netease')((state) => selector(viewOf(state)))) as NeteaseStoreHook

neteaseHook.getState = useNeteaseState

export const useNetease = neteaseHook

/**
 * The action surface the app already calls, plus the names it already uses.
 *
 * A live view each time rather than a cached object, so an action invoked after a
 * state change acts on the current state - which is why callers read it through
 * `getState()` in the first place.
 */
 interface NeteaseActions extends NeteaseStateView {
  init(): Promise<void>
  setQuality(quality: NeteaseQuality): Promise<void>
  setQuery(query: string): void
  setSearchType(kind: OnlineSearchKind): void
  runSearch(): Promise<void>
  loadPlaylists(): Promise<void>
  openCategory(kind: OnlineCollectionKind): Promise<void>
  openPlaylist(id: number): Promise<void>
  openAlbum(id: number): Promise<void>
  openArtist(id: number): Promise<void>
  playCollectionAt(index: number): Promise<void>
  playSongsAt(songs: NeteaseSong[], index: number): Promise<void>
  ensureStream(songId: number): Promise<void>
  prefetch(tracks: Track[]): void
  clearFail(): void
  setLoginOpen(open: boolean): void
  refreshAccount(): Promise<void>
  /**
   * The account that just signed in, if the caller already has it.
   *
   * The dialog does not need to pass it: the store re-reads the session from the
   * main process, which is the side holding the cookie, so the renderer's idea of
   * who is signed in is verified rather than assumed. The parameter stays for
   * callers that have a reason to hand the account over directly.
   */
  loggedIn(account?: NeteaseAccount): void
  logout(): Promise<void>
}

 function useNeteaseState(): NeteaseActions {
  const state = onlineStoreState('netease')
  return {
    ...viewOf(state),
    init: state.init,
    setQuality: (quality: NeteaseQuality) => state.setQuality(quality),
    setQuery: state.setQuery,
    setSearchType: (kind: OnlineSearchKind) => state.setSearchKind(kind),
    runSearch: state.submitSearch,
    loadPlaylists: state.loadPlaylists,
    openCategory: (kind: OnlineCollectionKind) => state.openCollection(kind),
    openPlaylist: state.openPlaylist,
    openAlbum: state.openAlbum,
    openArtist: state.openArtist,
    playCollectionAt: (index: number) => state.playAt(state.collection, index),
    playSongsAt: (songs: NeteaseSong[], index: number) => state.playAt(songs, index),
    ensureStream: state.ensureStream,
    prefetch: state.prefetch,
    clearFail: state.clearFail,
    setLoginOpen,
    refreshAccount: state.refreshAccount,
    loggedIn() {
      // The shared store owns the account; the reliable way to learn it is to ask
      // the main process, which is the only side that holds the cookie.
      setLoginOpen(false)
      void state.refreshAccount().then(() => state.loadPlaylists())
    },
    logout: state.logout
  }
}

/** The resolved, unexpired URL for a song, or null. Read by the library source. */
 function neteaseStreamOf(songId: number): NeteaseStream | null {
  return cachedStream('netease', songId) as NeteaseStream | null
}


/**
 * Re-exported for the playback wiring: `features/player/netease.ts` registers the
 * transport's resume callback against this name, and the shared store consumes it
 * through the provider - which is where the platform identity belongs.
 */
export { setNeteaseResumeHandler as setNeteaseResume } from './provider'

/**
 * The resolved URL for a song, under the name the library source and this
 * platform's hooks already import.
 */
export { neteaseStreamOf as streamOf }

