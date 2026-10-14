import { useCallback } from 'react'
import { useLibrary } from '../../features/library/store'
import { player } from '../../features/player/actions'
import { usePlayer } from '../../features/player/store'
import { TrackList, type TrackMenuRequest } from '../../ui/TrackList'
import type { Track } from '../../types'
import { searchResultsFor, searchSources, useSearch } from '../search/store'

/**
 * The search screen: one query, an explicit source, results from that source.
 *
 * The source tabs are generated from the provider registry, so the screen offers
 * exactly the catalogues this build can serve: local, plus one per registered
 * platform that declares search. Nothing here names a platform, and adding one adds
 * a tab without touching this file.
 *
 * Both kinds of source answer with the same `Track` shape - a platform maps its own
 * songs - so one list renders them all and the transport needs no special case.
 */
export function SearchView({ onMenu }: { onMenu(request: TrackMenuRequest): void }) {
  const query = useSearch((s) => s.query)
  const source = useSearch((s) => s.source)
  const searching = useSearch((s) => s.searching)
  const submitted = useSearch((s) => s.submitted)
  const error = useSearch((s) => s.error)
  const results = useSearch((s) => s.results)

  const tracks = useLibrary((s) => s.tracks)
  const currentTrack = usePlayer((s) => (s.index >= 0 ? (s.queue[s.index] ?? null) : null))
  const playing = usePlayer((s) => s.playing)

  const tabs = searchSources()
  const active = tabs.find((tab) => tab.id === source) ?? tabs[0]
  const rows = searchResultsFor({ source, results })
  const currentId = currentTrack?.id ?? null

  const submit = useCallback(() => {
    void useSearch.getState().submit(tracks)
  }, [tracks])

  const switchTo = (next: string) => {
    useSearch.getState().setSource(next)
    // Local also stays current as you type, so switching tabs never shows a stale
    // answer for the same text.
    void useSearch.getState().submit(tracks)
  }

  const showEmpty = submitted && !searching && rows.length === 0

  return (
    <div className="search-view">
      <div className="search-view__tabs" role="tablist" aria-label="搜索范围">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={source === tab.id}
            className={`search-view__tab${source === tab.id ? ' is-active' : ''}`}
            onClick={() => switchTo(tab.id)}
            title={tab.note}
          >
            {tab.label}
            {/* A count only once that source has answered, so "0" never means
                "not asked yet". */}
            {submitted && source === tab.id ? (
              <em className="tnum">{rows.length}</em>
            ) : (results[tab.id]?.length ?? 0) > 0 ? (
              <em className="tnum">{results[tab.id]?.length}</em>
            ) : null}
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
          <h2>正在搜索{active?.label}</h2>
        </div>
      ) : showEmpty ? (
        <div className="empty">
          <div className="empty__art">
            <em className="tnum">0</em>
          </div>
          <h2>{query.trim() ? `没有找到「${query.trim()}」` : '先输入要搜的内容'}</h2>
          <p className="search-view__hint">
            {active?.remote
              ? `在线搜索是向${active.label}发送一次请求，所以要点「搜索」或按回车。`
              : '本机搜索只在这台电脑已有的文件里找，边打边出结果。'}
          </p>
        </div>
      ) : !submitted && query.trim() ? (
        <div className="empty">
          <div className="empty__art">
            <em className="tnum">⏎</em>
          </div>
          <h2>按回车搜索「{query.trim()}」</h2>
          <p className="search-view__hint">搜索{active?.label}需要联网，所以不会边打边搜。</p>
        </div>
      ) : (
        <>
          {/*
            With more than one catalogue in play, a results list has to say where
            each row came from - that was a known gap while only one online platform
            existed, and it is what the source reference on each track answers.
          */}
          {tabs.filter((tab) => tab.remote).length > 1 ? (
            <div className="search-view__legend">结果来自：{active?.label}</div>
          ) : null}
          <TrackList
            tracks={rows as Track[]}
            currentId={currentId}
            playing={playing}
            onPlayAt={(index) => player.playQueue(rows as Track[], index)}
            onMenu={onMenu}
          />
        </>
      )}
    </div>
  )
}

