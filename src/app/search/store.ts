import { create } from 'zustand'
import { hasNeteaseBackend, netease } from '../../features/netease/api'
import { toTrack } from '../../features/netease/track'
import { searchLocalTracks } from '../../features/library/search'
import type { NeteaseSong } from '../../env'
import type { Track } from '../../types'

/**
 * The search screen's state, and the one place that decides what "search" means.
 *
 * Modelled on the reference player's search store: **one query, an explicit source
 * tab, and results per source.** The earlier arrangement had no such model - the
 * shell's field filtered the library on local screens and quietly became a Netease
 * request on the online screen - so "where am I searching" was implied by which
 * page happened to be open. Here it is a value the user can see and change.
 *
 * Why a store rather than component state: the query has to survive leaving the
 * screen (the field in the title bar owns the text) and coming back, and the
 * online results have to survive a re-render triggered by a local keystroke.
 */
export type SearchSource = 'local' | 'online'

export const SEARCH_SOURCES: { id: SearchSource; label: string; note: string }[] = [
  { id: 'online', label: '网易云音乐', note: '联网搜索在线曲库' },
  { id: 'local', label: '本机曲库', note: '只搜这台电脑上已有的文件' }
]

interface SearchState {
  query: string
  source: SearchSource
  /** True while an online request is in flight. */
  searching: boolean
  /** Results as of the last submit, per source. */
  local: Track[]
  online: Track[]
  /** Set when the last online request failed, so the screen can say so. */
  error: string | null
  /** Whether the current query has been submitted for the active source. */
  submitted: boolean

  setQuery(query: string): void
  setSource(source: SearchSource): void
  /** Run the query for whichever source is active. */
  submit(tracks: Track[]): Promise<void>
  clear(): void
}

export const useSearch = create<SearchState>((set, get) => ({
  query: '',
  source: 'online',
  searching: false,
  local: [],
  online: [],
  error: null,
  submitted: false,

  setQuery(query) {
    /*
     * Local results follow the text as it is typed; online results do not.
     * Filtering a list already in memory costs nothing and needs no commit, while
     * a request per keystroke would be both slow and rude to the upstream. So the
     * field is live for one source and explicit for the other, and `submitted`
     * records whether the online answer belongs to the text on screen.
     */
    set({ query, submitted: false })
  },

  setSource(source) {
    set({ source, submitted: false })
  },

  async submit(tracks) {
    const { query, source } = get()
    const trimmed = query.trim()

    if (source === 'local') {
      set({ local: searchLocalTracks(tracks, trimmed), submitted: true, error: null })
      return
    }

    if (!trimmed) {
      set({ online: [], submitted: true, error: null })
      return
    }
    if (!hasNeteaseBackend) {
      set({ online: [], submitted: true, error: '浏览器预览模式没有主进程，无法联网搜索' })
      return
    }

    set({ searching: true, error: null })
    try {
      const result = await netease.search(trimmed, 'song', 50)
      const songs: NeteaseSong[] = result.songs ?? []
      set({ online: songs.map((song) => toTrack(song)), searching: false, submitted: true })
    } catch (failure) {
      set({
        online: [],
        searching: false,
        submitted: true,
        error: failure instanceof Error ? failure.message : String(failure)
      })
    }
  },

  clear() {
    set({ query: '', local: [], online: [], submitted: false, error: null })
  }
}))

/** The rows to show for the active source. */
export function searchResultsFor(state: Pick<SearchState, 'source' | 'local' | 'online'>): Track[] {
  return state.source === 'local' ? state.local : state.online
}
