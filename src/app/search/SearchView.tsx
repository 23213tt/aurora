import { useCallback } from 'react'
import { player } from '../../features/player/actions'
import { useLibrary } from '../../features/library/store'
import { searchResultsFor, useSearch } from '../search/store'
import { TrackList, type TrackMenuRequest } from '../../ui/TrackList'
import { usePlayer } from '../../features/player/store'
import type { Track } from '../../types'

/**
 * The search screen: one query, an explicit source, results from that source.
 *
 * This replaces a field that changed meaning depending on which page was open.
 * The difference that matters is not the layout, it is that "where am I searching"
 * is now a visible, changeable value rather than something the user has to infer
 * from the effect of typing.
 *
 * Both sources answer with the same `Track` shape - the online side is mapped by
 * `toTrack` - so one list renders both and the transport needs no special case.
 */
export function SearchView({ onMenu }: { onMenu(request: TrackMenuRequest): void }) {
  const query = useSearch((s) => s.query)
  const source = useSearch((s) => s.source)
  const searching = useSearch((s) => s.searching)
  const submitted = useSearch((s) => s.submitted)
  const error = useSearch((s) => s.error)
  const local = useSearch((s) => s.local)
  const online = useSearch((s) => s.online)

  const tracks = useLibrary((s) => s.tracks)
  const currentTrack = usePlayer((s) => (s.index >= 0 ? (s.queue[s.index] ?? null) : null))
  const playing = usePlayer((s) => s.playing)

  const results = searchResultsFor({ source, local, online })
  const currentId = currentTrack?.source === source ? currentTrack.id : null

  const submit = useCallback(() => {
    void useSearch.getState().submit(tracks)
  }, [tracks])

  /*
   * Enter in the shell's field submits for the active source. The local source
   * also keeps its results current as you type, so switching tabs never shows a
   * stale answer for the same text.
   */
  const switchTo = (next: 'local' | 'online') => {
    useSearch.getState().setSource(next)
    void useSearch.getState().submit(tracks)
  }

  const showEmpty = submitted && !searching && results.length === 0

  return (
    <div className="search-view">
      <div className="search-view__tabs" role="tablist" aria-label="搜索范围">
        {[
          { id: 'online' as const, label: '网易云音乐', count: online.length },
          { id: 'local' as const, label: '本机曲库', count: local.length }
        ].map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={source === tab.id}
            className={`search-view__tab${source === tab.id ? ' is-active' : ''}`}
            onClick={() => switchTo(tab.id)}
          >
            {tab.label}
            {/* A count only once that source has answered, so "0" never means
                "not asked yet". */}
            {submitted || tab.count > 0 ? <em className="tnum">{tab.count}</em> : null}
          </button>
        ))}
        <button className="btn btn--small search-view__go" onClick={submit} disabled={searching}>
          {searching ? '搜索中…' : '搜索'}
        </button>
      </div>

      {error ? (
        <div className="notice notice--warn" role="status">
          {error}
        </div>
      ) : null}

      {searching ? (
        <div className="empty">
          <div className="empty__art">
            <em className="tnum">…</em>
          </div>
          <h2>正在搜索网易云</h2>
        </div>
      ) : showEmpty ? (
        <div className="empty">
          <div className="empty__art">
            <em className="tnum">0</em>
          </div>
          <h2>{query.trim() ? `没有找到「${query.trim()}」` : '先输入要搜的内容'}</h2>
          <p className="search-view__hint">
            {source === 'online'
              ? '在线搜索是向网易云发送一次请求，所以要点「搜索」或按回车。'
              : '本机搜索只在这台电脑已有的文件里找，边打边出结果。'}
          </p>
        </div>
      ) : !submitted && query.trim() ? (
        <div className="empty">
          <div className="empty__art">
            <em className="tnum">⏎</em>
          </div>
          <h2>按回车搜索「{query.trim()}」</h2>
          <p className="search-view__hint">搜索网易云需要联网，所以不会边打边搜。</p>
        </div>
      ) : (
        <TrackList
          tracks={results}
          currentId={currentId}
          playing={playing}
          onPlayAt={(index) => player.playQueue(results as Track[], index)}
          onMenu={onMenu}
        />
      )}
    </div>
  )
}
