import { create } from 'zustand'
import { searchLocalTracks } from '../../features/library/search'
import { getProvider, listAvailableProviders } from '../../features/online/registry'
import type { Track } from '../../types'
import { readRememberedSource, rememberSource, type SearchSource } from './remembered-source'

/**
 * The search screen's state, and the one place that decides what "search" means.
 *
 * One query, an explicit source tab, and results per source - the model the
 * reference player uses. What changed with the provider layer is where the tabs come
 * from: `sources()` reads the registry, so a build with two platforms offers three
 * tabs and a build with one offers two, with no list to keep in sync.
 *
 * Why a store rather than component state: the query has to survive leaving the
 * screen (the field in the title bar owns the text) and coming back, and online
 * results have to survive a re-render triggered by a local keystroke.
 *
 * The remembered source lives in `./remembered-source`, which has no bundler-only
 * imports and is therefore testable; nothing that touches a platform client can be
 * loaded outside Vite.
 */
export type { SearchSource }

export interface SearchSourceTab {
  id: SearchSource
  label: string
  /** One line describing what this source is, shown with the tab. */
  note: string
  /** True for a remote catalogue, which is the one that needs a submit. */
  remote: boolean
}

/**
 * The tabs to show.
 *
 * A function of the registry rather than a constant: a platform that is not usable
 * in this build must not offer a tab that cannot answer. Local comes first because
 * it is the one that always works and needs no network.
 */
export function searchSources(): SearchSourceTab[] {
  const tabs: SearchSourceTab[] = [
    { id: 'local', label: '本机曲库', note: '只搜这台电脑上已有的文件', remote: false }
  ]
  for (const provider of listAvailableProviders()) {
    if (!provider.search) continue
    tabs.push({
      id: provider.id,
      label: provider.displayName,
      note: `联网搜索${provider.displayName}的曲库`,
      remote: true
    })
  }
  return tabs
}

/** The default tab: the first remote catalogue, or local when there is none. */
export function defaultSource(): SearchSource {
  return searchSources().find((tab) => tab.remote)?.id ?? 'local'
}

interface SearchState {
  query: string
  source: SearchSource
  /** True while a remote request is in flight. */
  searching: boolean
  /** Results as of the last submit, per source. */
  results: Record<SearchSource, Track[]>
  /** Set when the last remote request failed, so the screen can say so. */
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
  // Whatever was used last, or the first platform on a first visit. A remembered
  // platform that this build cannot serve falls back rather than leaving the screen
  // pointed at a tab that is not drawn.
  source: resolveInitialSource(),
  searching: false,
  results: {},
  error: null,
  submitted: false,

  setQuery(query) {
    /*
     * Local results follow the text as it is typed; remote results do not.
     * Filtering a list already in memory costs nothing and needs no commit, while a
     * request per keystroke would be both slow and rude to the upstream. So the
     * field is live for one kind of source and explicit for the other, and
     * `submitted` records whether the remote answer belongs to the text on screen.
     */
    set({ query, submitted: false })
  },

  setSource(source) {
    // Persisted because the choice is a preference, not a per-visit decision:
    // whoever searches one catalogue nearly always wants that same one next time.
    rememberSource(source)
    set({ source, submitted: false })
  },

  async submit(tracks) {
    const { query, source } = get()
    const trimmed = query.trim()

    if (source === 'local') {
      set((state) => ({
        results: { ...state.results, local: searchLocalTracks(tracks, trimmed) },
        submitted: true,
        error: null
      }))
      return
    }

    if (!trimmed) {
      set((state) => ({ results: { ...state.results, [source]: [] }, submitted: true, error: null }))
      return
    }

    const provider = getProvider(source)
    if (!provider?.search || !provider.available()) {
      set({
        searching: false,
        submitted: true,
        error: `${provider?.displayName ?? source}在这个构建里不可用`
      })
      return
    }

    set({ searching: true, error: null })
    try {
      /*
       * The platform's own client does the request, through its backend.
       *
       * Reusing the backend rather than calling the bridge here is what keeps one
       * implementation of "search a platform": the song -> track mapping (and
       * therefore the id prefix) stays the platform's business, and this screen
       * never learns which fields an upstream returns.
       */
      const backend = provider.backend as {
        search(keywords: string, kind: 'song', limit: number): Promise<{ songs: unknown[] }>
        toTrack(song: never): Track
      }

      const result = await backend.search(trimmed, 'song', 50)
      set((state) => ({
        results: { ...state.results, [source]: result.songs.map((song) => backend.toTrack(song as never)) },
        searching: false,
        submitted: true,
        error: null
      }))
    } catch (failure) {
      set({
        searching: false,
        submitted: true,
        error: failure instanceof Error ? failure.message : String(failure)
      })
    }
  },

  clear() {
    set({ query: '', results: {}, submitted: false, error: null })
  }
}))

/** The platform's song -> track mapping, which is where the id prefix lives. */
function resolveInitialSource(): SearchSource {
  const tabs = searchSources()
  // Validated against the live registry, so a remembered platform this build cannot
  // serve falls back rather than leaving the screen pointed at a tab that is not
  // drawn.
  const remembered = readRememberedSource(tabs.map((tab) => tab.id))
  if (remembered && tabs.some((tab) => tab.id === remembered)) return remembered
  return defaultSource()
}

/** The rows to show for the active source. */
export function searchResultsFor(state: Pick<SearchState, 'source' | 'results'>): Track[] {
  return state.results[state.source] ?? []
}
