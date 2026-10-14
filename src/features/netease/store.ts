import { create } from 'zustand'
import type {
  NeteaseAccount,
  NeteaseFailureReason,
  NeteasePlaylistSummary,
  NeteaseQuality,
  NeteaseSong,
  NeteaseStream
} from '../../env'
import { player } from '../player/actions'
import type { Track } from '../../types'
import { useAccounts } from '../accounts/store'
import { hasNeteaseBackend, netease } from './api'
import { isTransient, streamSummary } from './stream'
import { toTrack } from './track'

/**
 * The profile whose account this store currently holds.
 *
 * Everything here - the account, the playlists, the open collection, the cached
 * stream URLs - belongs to one Netease account, and therefore to one profile.
 * When the active profile changes, all of it is dropped rather than reused; the
 * alternative is showing one profile the previous profile's music.
 */
let boundProfile: string | null = null

function activeProfileId(): string | null {
  return useAccounts.getState().activeId
}

/** Drop every trace of the previous account. Cached URLs are unusable anyway. */
function resetForProfile(set: (partial: Partial<NeteaseState>) => void): void {
  streamCache.clear()
  set({
    account: null,
    playlists: [],
    playlistsLoading: false,
    category: null,
    openId: null,
    openName: null,
    openCover: null,
    collection: [],
    songs: [],
    albums: [],
    artists: [],
    searched: false,
    fail: null,
    loadingTracks: false
  })
}

/**
 * The pure half of the online source lives in `./track` so it can be imported
 * without a bundler (see that file); re-exported here so callers have one
 * address for "the Netease store and its mapping".
 */
export { songCover, toTrack } from './track'

/**
 * Online-source state, held apart from the library on purpose.
 *
 * A Netease track has no file, no scan, no tag read and no stable local id, so
 * folding it into `useLibrary` would mean a second meaning for every field in
 * `Track`. Instead this store owns everything online, and the two stores meet at
 * exactly one point: `player.playQueue(tracks)`. Nothing in the local library
 * knows this store exists.
 */

/**
 * Sound quality has exactly one source of truth: the main process, which holds
 * it in `settings.json` and answers `getQuality`/`setQuality`.
 *
 * This renderer deliberately keeps no copy. A second copy here could only ever
 * disagree with the first - after a failed write, a settings reset, or a second
 * window - and the only thing it would buy is showing the previous tier for the
 * fraction of a second before `init()` reads the real one. A default of `exhigh`
 * covers that window, which is worth more than the risk of playing at a tier the
 * user did not choose.
 */
const DEFAULT_QUALITY: NeteaseQuality = 'exhigh'

/**
 * Resolved stream URLs live for eight minutes.
 *
 * The upstream signs its CDN links with an expiry of roughly twenty minutes, so
 * eight is a conservative read that leaves a whole track's worth of margin while
 * still being long enough that a queue of songs is not re-resolved as it plays.
 */
const STREAM_TTL_MS = 8 * 60 * 1000

/** How long a failed resolution is remembered, by whether retrying can help. */
const FAILURE_TTL_MS = 45 * 1000
const FAILURE_TTL_PERMANENT_MS = 5 * 60 * 1000

/** How long after a load attempt a late-arriving URL may still auto-recover it. */
const RECOVER_WINDOW_MS = 20 * 1000

/**
 * Fetched collections are cached for ten minutes.
 *
 * The personal lists come from endpoints the upstream rate-limits, and they
 * change on the order of hours, so re-fetching them on every tab switch would be
 * load without information.
 */
const CATALOG_TTL_MS = 10 * 60 * 1000

export type NeteaseCategory = 'daily' | 'cloud' | 'like' | 'playlist'

export interface NeteaseFail {
  reason: NeteaseFailureReason
  message: string
  /** Song id when the failure is about one track, null when it is global. */
  songId: number | null
  at: number
}

interface StreamEntry {
  expiresAt: number
  stream?: NeteaseStream
  fail?: { reason: NeteaseFailureReason; message: string }
  /** Song kept so a failed resolve can be retried without the caller's object. */
  song: NeteaseSong
}

interface CachedSongs {
  at: number
  songs: NeteaseSong[]
}

interface NeteaseState {
  /** The main process can reach the upstream. */
  ready: boolean
  /** The main process answered, but cannot reach the upstream right now. */
  backendBlocked: boolean
  /** Why the online source is unusable, when it is. */
  statusDetail: string | null
  account: NeteaseAccount | null

  quality: NeteaseQuality
  /** The quality the stream in hand was actually delivered at, for the UI note. */
  delivered: string | null

  query: string
  searchType: 'song' | 'album' | 'artist'
  searching: boolean
  songs: NeteaseSong[]
  albums: NeteaseSearchResultAlbums
  artists: NeteaseSearchResultArtists
  /** True once a search has run, so "no results" is not shown before one has. */
  searched: boolean

  category: NeteaseCategory | null
  /** Playlist or album id whose tracks are open, when a collection is. */
  openId: number | null
  openName: string | null
  openCover: string | null
  collection: NeteaseSong[]

  playlists: NeteasePlaylistSummary[]
  playlistsLoading: boolean

  /** Per-track failures, so the view can name the reason for the track that failed. */
  fail: NeteaseFail | null
  loadingTracks: boolean
  loginOpen: boolean

  init(): Promise<void>
  refreshAccount(): Promise<void>

  setQuality(quality: NeteaseQuality): Promise<void>
  setQuery(query: string): void
  setSearchType(type: 'song' | 'album' | 'artist'): void
  runSearch(): Promise<void>

  loadPlaylists(): Promise<void>
  openCategory(category: NeteaseCategory): Promise<void>
  openPlaylist(id: number): Promise<void>
  openAlbum(id: number): Promise<void>
  openArtist(id: number): Promise<void>
  playCollectionAt(index: number): Promise<void>
  playSongsAt(songs: NeteaseSong[], index: number): Promise<void>

  ensureStream(songId: number): Promise<void>
  prefetch(tracks: Track[]): void
  clearFail(): void
  setLoginOpen(open: boolean): void

  loggedIn(account: NeteaseAccount): void
  logout(): Promise<void>
}

type NeteaseSearchResultAlbums = {
  id: number
  name: string
  artist: string
  picUrl: string | null
  year: number | null
  songCount: number
}[]

type NeteaseSearchResultArtists = {
  id: number
  name: string
  picUrl: string | null
  albumCount: number
}[]

/** Every resolved or refused URL, keyed by song. Session state, never persisted. */
const streamCache = new Map<number, StreamEntry>()
/** Collections already fetched, keyed by cache key. */
const catalogCache = new Map<string, CachedSongs>()
/** Songs whose stream is currently being resolved, so a queue does not double-fetch. */
const inFlight = new Map<number, Promise<void>>()

/** A load attempt that found no cached URL, awaiting the fetch that is now running. */
let pendingRecovery: { songId: number; at: number } | null = null

/** Callback from the player's transport, injected by `player/netease.ts` to avoid an import cycle. */
let resumeCurrent: (() => void) | null = null

export function setNeteaseResume(fn: (() => void) | null): void {
  resumeCurrent = fn
}

function songIdOf(track: Track | null): number | null {
  if (!track || track.source !== 'netease') return null
  const id = Number(track.id.slice('netease:'.length))
  return Number.isFinite(id) ? id : null
}

const NO_BACKEND: NeteaseFail = {
  reason: 'service-unavailable',
  message: '这个构建没有网易云后端（浏览器预览模式）',
  songId: null,
  at: 0
}

export const useNetease = create<NeteaseState>()((set, get) => {
  /** Marks a failure and, for a per-track one, stops the transport on it. */
  const reportFail = (fail: NeteaseFail): void => set({ fail })

  const clearOne = (songId: number): void => {
    const { fail } = get()
    if (fail?.songId === songId) set({ fail: null })
  }

  /**
   * Resolve one song's URL, at most once at a time.
   *
   * Refusals are remembered for a while: the upstream rate-limits, and a user
   * clicking a dead track repeatedly should not turn into a burst of requests.
   */
  const fetchStream = (song: NeteaseSong): Promise<void> => {
    const running = inFlight.get(song.id)
    if (running) return running

    const job = (async () => {
      if (!hasNeteaseBackend) {
        streamCache.set(song.id, {
          expiresAt: Date.now() + FAILURE_TTL_PERMANENT_MS,
          fail: { reason: NO_BACKEND.reason, message: NO_BACKEND.message },
          song
        })
        return
      }

      const quality = get().quality
      const result = await netease.streamUrl(song.id, quality)

      if (result.ok) {
        streamCache.set(song.id, {
          expiresAt: Date.now() + STREAM_TTL_MS,
          stream: result.stream,
          song
        })
        set({
          delivered: streamSummary(result.stream, quality),
          // A successful fetch is also the announcement that a trial fragment is
          // the best this account gets; that belongs in the UI, not in a log.
          fail: result.stream.trial
            ? { reason: 'trial-only', message: '只能试听片段', songId: song.id, at: Date.now() }
            : null
        })
        return
      }

      const fail = { reason: result.reason, message: result.message ?? '' }
      streamCache.set(song.id, {
        expiresAt: Date.now() + (isTransient(result.reason) ? FAILURE_TTL_MS : FAILURE_TTL_PERMANENT_MS),
        fail,
        song
      })
      reportFail({ ...fail, songId: song.id, at: Date.now() })
    })()

    inFlight.set(song.id, job)
    return job.finally(() => inFlight.delete(song.id))
  }

  /**
   * Play the track that just lost its source.
   *
   * `engine.load` sets `loading` and, with no URL, leaves the element empty - so
   * `play()` would reject with a "no supported source" error that has nothing to
   * do with the real problem. Reloading the current queue index re-enters the
   * engine with the URL now cached, and seeking to 0 keeps the playhead off the
   * previous track's position.
   */
  const recover = (songId: number): void => {
    if (!pendingRecovery || pendingRecovery.songId !== songId) return
    if (Date.now() - pendingRecovery.at > RECOVER_WINDOW_MS) {
      pendingRecovery = null
      return
    }
    pendingRecovery = null
    const entry = streamCache.get(songId)
    if (!entry?.stream || !resumeCurrent) return
    resumeCurrent()
  }

  return {
    ready: false,
    /** The backend answered, but says it cannot reach the upstream. */
    backendBlocked: false,
    statusDetail: null,
    account: null,

    quality: DEFAULT_QUALITY,
    delivered: null,

    query: '',
    searchType: 'song',
    searching: false,
    songs: [],
    albums: [],
    artists: [],
    searched: false,

    category: null,
    openId: null,
    openName: null,
    openCover: null,
    collection: [],

    playlists: [],
    playlistsLoading: false,

    fail: null,
    loadingTracks: false,
    loginOpen: false,

    /**
     * Ask the main process where it stands.
     *
     * Safe - and expected - to call again later. The upstream bootstrap can fail
     * on a cold start (no network yet, a blocked host) and succeed a minute
     * later, and the main process only caches a *successful* bootstrap before
     * retrying. So this is not a one-shot check: the view re-runs it when it is
     * opened and offers a retry when the backend reports itself blocked, which is
     * what keeps a temporary failure from looking permanent.
     *
     * It also re-binds the session to the active profile. Everything cached on
     * this store belongs to whichever account answered last, so switching
     * profiles has to drop all of it: the account, the playlists, the open
     * collection and any stale failure. Keeping them would show one profile the
     * previous profile's music.
     */
    async init() {
      const profileId = activeProfileId()
      if (profileId && profileId !== boundProfile) {
        boundProfile = profileId
        resetForProfile(set)
      }
      if (profileId) await netease.setProfile(profileId)

      const status = await netease.status()
      set({
        ready: status.ready,
        backendBlocked: !status.ready,
        statusDetail: status.detail ?? null,
        account: status.loggedIn ? await netease.loginStatus() : null
      })
      // The main process owns the stored preference, so the renderer's default
      // is replaced by the real value as soon as the backend can answer.
      if (status.ready) set({ quality: await netease.getQuality() })
      // A signed-in account owns playlists; pull them in so the rail is complete.
      if (status.ready && status.loggedIn) void get().loadPlaylists()
    },

    async refreshAccount() {
      set({ account: await netease.loginStatus() })
    },

    async setQuality(quality) {
      // No local write: the main process persists it. Optimistic locally so the
      // segmented control responds immediately, then reconciled to whatever the
      // main process actually stored.
      streamCache.clear()
      set({ quality, delivered: null, fail: null })
      if (!hasNeteaseBackend) return
      set({ quality: await netease.setQuality(quality) })
    },

    setQuery: (query) => set({ query }),
    setSearchType: (searchType) => set({ searchType }),

    async runSearch() {
      const keywords = get().query.trim()
      if (!keywords) {
        set({ songs: [], albums: [], artists: [], searched: false })
        return
      }
      if (!hasNeteaseBackend) {
        set({ searching: false, searched: true, songs: [], albums: [], artists: [], fail: NO_BACKEND })
        return
      }
      set({ searching: true })
      try {
        const result = await netease.search(keywords, 'song', 50)
        // A slower earlier search must not overwrite a newer one's results.
        if (get().query.trim() !== keywords) return
        set({
          songs: result.songs,
          albums: result.albums,
          artists: result.artists,
          searched: true,
          fail: null
        })
      } catch (error) {
        set({
          searched: true,
          fail: {
            reason: 'network',
            message: error instanceof Error ? error.message : String(error),
            songId: null,
            at: Date.now()
          }
        })
      } finally {
        set({ searching: false })
      }
    },

    async loadPlaylists() {
      if (!hasNeteaseBackend) return
      set({ playlistsLoading: true })
      try {
        set({ playlists: await netease.myPlaylists() })
      } finally {
        set({ playlistsLoading: false })
      }
    },

    async openCategory(category) {
      const cached = catalogCache.get(category)
      if (cached && Date.now() - cached.at < CATALOG_TTL_MS) {
        set({ category, openId: null, openName: null, openCover: null, collection: cached.songs, fail: null })
        return
      }

      set({ category, openId: null, openName: null, openCover: null, loadingTracks: true, fail: null })
      try {
        const songs =
          category === 'daily' ? await netease.dailySongs()
          : category === 'cloud' ? await netease.cloudSongs()
          : await netease.likeList()
        catalogCache.set(category, { at: Date.now(), songs })
        set({ collection: songs })
      } catch (error) {
        set({
          collection: [],
          fail: {
            reason: 'network',
            message: error instanceof Error ? error.message : String(error),
            songId: null,
            at: Date.now()
          }
        })
      } finally {
        set({ loadingTracks: false })
      }
    },

    async openPlaylist(id) {
      const key = `playlist:${id}`
      const cached = catalogCache.get(key)
      if (cached && Date.now() - cached.at < CATALOG_TTL_MS) {
        set({
          category: 'playlist',
          openId: id,
          openName: get().playlists.find((item) => item.id === id)?.name ?? null,
          openCover: get().playlists.find((item) => item.id === id)?.coverUrl ?? null,
          collection: cached.songs,
          fail: null
        })
        return
      }

      const summary = get().playlists.find((item) => item.id === id)
      set({
        category: 'playlist',
        openId: id,
        openName: summary?.name ?? null,
        openCover: summary?.coverUrl ?? null,
        loadingTracks: true,
        fail: null
      })
      try {
        const songs = await netease.playlistTracks(id)
        catalogCache.set(key, { at: Date.now(), songs })
        set({ collection: songs })
      } catch (error) {
        set({
          collection: [],
          fail: {
            reason: 'network',
            message: error instanceof Error ? error.message : String(error),
            songId: null,
            at: Date.now()
          }
        })
      } finally {
        set({ loadingTracks: false })
      }
    },

    async openAlbum(id) {
      set({ category: 'playlist', openId: id, loadingTracks: true, fail: null })
      try {
        const album = await netease.album(id)
        set({
          collection: album?.songs ?? [],
          openName: album?.name ?? null,
          openCover: album?.coverUrl ?? null
        })
      } finally {
        set({ loadingTracks: false })
      }
    },

    async openArtist(id) {
      const name = get().artists.find((artist) => artist.id === id)?.name ?? null
      set({ category: 'playlist', openId: id, openName: name, openCover: null, loadingTracks: true, fail: null })
      try {
        set({ collection: await netease.artistTopSongs(id) })
      } finally {
        set({ loadingTracks: false })
      }
    },

    /**
     * Start a queue at the clicked row.
     *
     * The URL for the first track is fetched before the engine is handed the
     * queue, which is what keeps the common path free of the
     * load-then-recover dance: with the URL cached, `engine.load` finds a source
     * on the first try.
     */
    async playCollectionAt(index) {
      const songs = get().collection
      const first = songs[index]
      if (!first) return
      await get().ensureStream(first.id)
      player.playQueue(songs.map((song) => toTrack(song, streamOf(song.id))), index)
    },

    /**
     * Same, for search results.
     *
     * A separate list because the queue has to be what the user is looking at:
     * pressing "next" in a search result should walk the results, not whatever
     * category happened to be open in the sidebar.
     */
    async playSongsAt(songs, index) {
      const first = songs[index]
      if (!first) return
      await get().ensureStream(first.id)
      player.playQueue(songs.map((song) => toTrack(song, streamOf(song.id))), index)
    },

    async ensureStream(songId) {
      const entry = streamCache.get(songId)
      if (entry && entry.expiresAt > Date.now()) {
        // Still inside the window. A cached refusal is reported rather than
        // re-asked: the point of remembering it is to not hammer the upstream.
        if (entry.stream) {
          clearOne(songId)
          return
        }
        if (entry.fail) reportFail({ ...entry.fail, songId, at: Date.now() })
        return
      }

      const song = entry?.song ?? findSong(get(), songId)
      if (!song) return
      await fetchStream(song)
      if (streamCache.get(songId)?.stream) recover(songId)
    },

    prefetch(tracks) {
      // The opening seconds of the next track are resolved while the current one
      // plays, so a gapless-ish advance does not have to wait on the network.
      for (const track of tracks.slice(0, 3)) {
        const id = songIdOf(track)
        if (id === null) continue
        const entry = streamCache.get(id)
        if (entry && entry.expiresAt > Date.now()) continue
        void get().ensureStream(id)
      }
    },

    clearFail: () => set({ fail: null }),
    setLoginOpen: (loginOpen) => set({ loginOpen }),

    loggedIn(account) {
      set({ account, loginOpen: false, fail: null })
      void get().loadPlaylists()
    },

    async logout() {
      await netease.logout()
      // Personal lists belong to the account that just left, so they go with it.
      catalogCache.clear()
      set({ account: null, playlists: [], collection: [], category: null, openId: null, openName: null })
    }
  }
})

function findSong(state: NeteaseState, songId: number): NeteaseSong | null {
  return (
    state.collection.find((song) => song.id === songId) ??
    state.songs.find((song) => song.id === songId) ??
    null
  )
}

/** The resolved stream for a song, or null. Read directly: it is not reactive state. */
export function streamOf(songId: number): NeteaseStream | null {
  const entry = streamCache.get(songId)
  if (!entry || entry.expiresAt <= Date.now()) return null
  return entry.stream ?? null
}

