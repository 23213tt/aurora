import { useEffect, useState } from 'react'
import type { NeteaseQuality, NeteaseSong } from '../env'
import { hasNeteaseBackend, remoteImage } from '../netease/api'
import { paymentLabel, useNeteaseTracks } from '../netease/hooks'
import { QUALITY_LABEL, QUALITY_ORDER, failureText, isTransient } from '../netease/stream'
import { useNetease } from '../netease/store'
import { usePlayer } from '../player/store'
import { Artwork } from './Artwork'
import { NeteaseLogin } from './NeteaseLogin'
import { Note, Refresh, Search, User, Wave } from './icons'
import { TrackList, type TrackMenuRequest } from './TrackList'

/**
 * 网易云音乐 - the online source's own screen.
 *
 * Shared with the library views: nothing. Online tracks are not files, so they
 * never enter `useLibrary`; this screen owns its own search, categories and
 * results, and its only contact with the rest of the app is
 * `player.playQueue(tracks)`.
 *
 * Search and playback work signed out - the upstream allows cloudsearch, lyric
 * and a 320k stream without a cookie - so the screen says that in as many words.
 * A blank panel with a login button would read as "broken" rather than as
 * "signing in is optional".
 */
export function NeteaseView() {
  const account = useNetease((s) => s.account)
  const category = useNetease((s) => s.category)
  const openName = useNetease((s) => s.openName)
  const collection = useNetease((s) => s.collection)
  const playlists = useNetease((s) => s.playlists)
  const playlistsLoading = useNetease((s) => s.playlistsLoading)
  const searching = useNetease((s) => s.searching)
  const searched = useNetease((s) => s.searched)
  const query = useNetease((s) => s.query)
  const songs = useNetease((s) => s.songs)
  const albums = useNetease((s) => s.albums)
  const artists = useNetease((s) => s.artists)
  const searchType = useNetease((s) => s.searchType)
  const fail = useNetease((s) => s.fail)
  const loadingTracks = useNetease((s) => s.loadingTracks)
  const loginOpen = useNetease((s) => s.loginOpen)
  const quality = useNetease((s) => s.quality)
  const ready = useNetease((s) => s.ready)
  const backendBlocked = useNetease((s) => s.backendBlocked)
  const statusDetail = useNetease((s) => s.statusDetail)

  const [draft, setDraft] = useState('')
  const [menu, setMenu] = useState<TrackMenuRequest | null>(null)

  const currentTrack = usePlayer((s) => (s.index >= 0 ? (s.queue[s.index] ?? null) : null))
  const playing = usePlayer((s) => s.playing)

  /*
   * Re-ask the backend where it stands every time this screen is opened.
   *
   * The upstream bootstrap can fail on a cold start and succeed a minute later,
   * and the main process caches only a successful one. Without this, a failure
   * during startup would leave the screen marked unusable for the rest of the
   * session even after the network came back - a temporary problem presented as
   * a permanent one. Cheap enough to repeat: it is one IPC call, not a request
   * to the upstream, on a screen the user just chose to open.
   */
  useEffect(() => {
    if (hasNeteaseBackend) void useNetease.getState().init()
  }, [])

  const tracks = useNeteaseTracks(collection)
  const currentId = currentTrack?.source === 'netease' ? currentTrack.id : null

  /** Signed out, the personal entries ask for a login instead of failing. */
  const openCategory = (next: 'daily' | 'like' | 'cloud') => {
    if (!account) {
      useNetease.getState().setLoginOpen(true)
      return
    }
    void useNetease.getState().openCategory(next)
  }

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault()
    useNetease.getState().setQuery(draft)
    void useNetease.getState().runSearch()
  }

  return (
    <div className="ne">
      <header className="ne__bar">
        <form className="ne__search" onSubmit={submitSearch} role="search">
          <Search size={15} />
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="搜索歌曲、专辑或歌手"
            aria-label="搜索网易云音乐"
            maxLength={80}
          />
          <button className="btn btn--small" type="submit" disabled={searching || !draft.trim()}>
            {searching ? '搜索中…' : '搜索'}
          </button>
        </form>

        <QualityPicker quality={quality} />
      </header>

      {/*
        Two different "not available" states, said differently.
        A preview build genuinely has no online source, and no amount of waiting
        changes that. A backend that answered but cannot reach the upstream is a
        condition that can clear, so it gets its own line and a way to re-ask -
        the failure must not be presented as a permanent property of the screen.
      */}
      {!hasNeteaseBackend ? (
        <div className="ne__notice">
          浏览器预览模式没有主进程，网易云这个页面只展示界面，不会真的联网。
        </div>
      ) : backendBlocked && !ready ? (
        <div className="ne__notice ne__notice--warn" role="status">
          <span>
            网易云后端暂时不可用{statusDetail ? `（${statusDetail}）` : ''}。网络恢复后重试即可，不需要重启。
          </span>
          <button className="btn btn--small" onClick={() => void useNetease.getState().init()}>
            <Refresh size={13} />
            重试
          </button>
        </div>
      ) : null}

      <div className="ne__body">
        <aside className="ne__side">
          <AccountCard />

          <div className="ne__group">
            <div className="ne__group-head">
              <span>我的音乐</span>
              {account ? (
                <button
                  className="btn btn--small"
                  onClick={() => void useNetease.getState().loadPlaylists()}
                  disabled={playlistsLoading}
                  title="重新读取我的歌单"
                >
                  <Refresh size={13} />
                  {playlistsLoading ? '读取中' : '刷新'}
                </button>
              ) : null}
            </div>

            <SideRow label="每日推荐" active={category === 'daily'} locked={!account} onClick={() => openCategory('daily')} />
            <SideRow label="我喜欢的音乐" active={category === 'like'} locked={!account} onClick={() => openCategory('like')} />
            <SideRow label="我的音乐云盘" active={category === 'cloud'} locked={!account} onClick={() => openCategory('cloud')} />
          </div>

          <div className="ne__group">
            <div className="ne__group-head">
              <span>我的歌单</span>
            </div>
            {!account ? (
              <div className="ne__hint">登录后在这里显示你的歌单</div>
            ) : playlists.length === 0 ? (
              <div className="ne__hint">{playlistsLoading ? '读取中…' : '这个账号还没有歌单'}</div>
            ) : (
              <div className="ne__playlists">
                {playlists.map((playlist) => (
                  <button
                    key={playlist.id}
                    className={`ne__row${
                      category === 'playlist' && openName === playlist.name ? ' is-active' : ''
                    }`}
                    onClick={() => void useNetease.getState().openPlaylist(playlist.id)}
                    title={`${playlist.name} · ${playlist.creator}`}
                  >
                    <span className="ne__pl-art">
                      <Artwork
                        src={playlist.coverUrl ? remoteImage(playlist.coverUrl) : null}
                        fallback={<Note size={13} />}
                      />
                    </span>
                    <span className="ne__pl-name">{playlist.name}</span>
                    <em className="tnum">{playlist.trackCount}</em>
                  </button>
                ))}
              </div>
            )}
          </div>

          <p className="ne__fine">
            通过第三方逆向接口接入网易云，仅个人学习自用，不是官方客户端，也不提供绕过付费或会员的能力。QQ
            音乐仍未接入。
          </p>
        </aside>

        <section className="ne__main">
          {fail ? (
            <div className="ne__fail" role="status">
              <span className="ne__fail-text">
                {failureText(fail.reason)}
                {fail.message ? `（${fail.message}）` : ''}
              </span>
              {fail.songId !== null && isTransient(fail.reason) ? (
                <button className="btn btn--small" onClick={() => void useNetease.getState().ensureStream(fail.songId as number)}>
                  重试
                </button>
              ) : null}
              <button className="btn btn--small" onClick={() => useNetease.getState().clearFail()}>
                知道了
              </button>
            </div>
          ) : null}

          <div className="ne__head">
            {searched ? (
              <>
                <h2 className="ne__title">「{query}」的结果</h2>
                <div className="seg">
                  <button className={searchType === 'song' ? 'is-active' : ''} onClick={() => useNetease.getState().setSearchType('song')}>
                    歌曲 {songs.length}
                  </button>
                  <button className={searchType === 'album' ? 'is-active' : ''} onClick={() => useNetease.getState().setSearchType('album')}>
                    专辑 {albums.length}
                  </button>
                  <button className={searchType === 'artist' ? 'is-active' : ''} onClick={() => useNetease.getState().setSearchType('artist')}>
                    歌手 {artists.length}
                  </button>
                </div>
              </>
            ) : (
              <h2 className="ne__title">{openName ?? '选择左边的一项，或者直接搜索'}</h2>
            )}
            {!searched && openName ? (
              <span className="ne__meta tnum">{loadingTracks ? '读取中…' : `${collection.length} 首`}</span>
            ) : null}
          </div>

          {searched && searchType === 'album' ? (
            albums.length === 0 ? (
              <div className="ne__hint">没有匹配的专辑</div>
            ) : (
              <div className="grid">
                {albums.map((album) => (
                  <div className="card" key={album.id}>
                    <button
                      className="card__art card__art-open"
                      onClick={() => void useNetease.getState().openAlbum(album.id)}
                      title={`打开 ${album.name}`}
                    >
                      <Artwork src={album.picUrl ? remoteImage(album.picUrl) : null} fallback={<Note size={22} />} />
                    </button>
                    <span className="card__name" title={album.name}>
                      {album.name}
                    </span>
                    <span className="card__meta">
                      <span className="card__artist">{album.artist}</span>
                      <span className="card__size tnum">
                        {album.year ?? '—'} · {album.songCount} 首
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )
          ) : null}

          {searched && searchType === 'artist' ? (
            artists.length === 0 ? (
              <div className="ne__hint">没有匹配的歌手</div>
            ) : (
              <div className="grid">
                {artists.map((artist) => (
                  <div className="card" key={artist.id}>
                    <button
                      className="card__art card__art-open"
                      onClick={() => void useNetease.getState().openArtist(artist.id)}
                      title={`打开 ${artist.name}`}
                    >
                      <Artwork src={artist.picUrl ? remoteImage(artist.picUrl) : null} fallback={<User size={22} />} />
                    </button>
                    <span className="card__name" title={artist.name}>
                      {artist.name}
                    </span>
                    <span className="card__meta">
                      <span className="card__artist">{artist.albumCount} 张专辑</span>
                    </span>
                  </div>
                ))}
              </div>
            )
          ) : null}

          {searched && searchType === 'song' ? (
            <TrackList
              tracks={tracks}
              currentId={currentId}
              playing={playing}
              onPlayAt={(index) => void useNetease.getState().playSongsAt(songs, index)}
              onMenu={setMenu}
            />
          ) : null}

          {!searched ? (
            loadingTracks ? (
              <div className="ne__hint">读取中…</div>
            ) : collection.length === 0 ? (
              /*
               * Nothing opened yet. The shared `TrackList` would draw its own
               * "no matching songs" empty row, which on a screen where nothing
               * has been asked for yet reads as a failed load rather than as an
               * empty state.
               */
              <div className="empty">
                <div className="empty__art">
                  <Wave size={30} />
                </div>
                <h2>还没有打开任何内容</h2>
                <p className="ne__hint">左边选一个列表，或者在上面搜索。搜索和播放都不需要登录。</p>
              </div>
            ) : (
              <TrackList
                tracks={tracks}
                currentId={currentId}
                playing={playing}
                onPlayAt={(index) => void useNetease.getState().playCollectionAt(index)}
                onMenu={setMenu}
              />
            )
          ) : null}
        </section>
      </div>

      {menu ? (
        <SongMenu
          request={menu}
          song={songs.find((item) => `netease:${item.id}` === menu.track.id) ?? null}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {loginOpen ? <NeteaseLogin onClose={() => useNetease.getState().setLoginOpen(false)} /> : null}
    </div>
  )
}

function SideRow({
  label,
  active,
  locked,
  onClick
}: {
  label: string
  active: boolean
  locked: boolean
  onClick(): void
}) {
  return (
    <button className={`ne__row${active ? ' is-active' : ''}`} onClick={onClick}>
      <Note size={15} />
      <span>{label}</span>
      {locked ? <em>需登录</em> : null}
    </button>
  )
}

function QualityPicker({ quality }: { quality: NeteaseQuality }) {
  return (
    <div className="ne__quality" title="音质随请求转发给上游；上游给不了这一档时会回退，并在这里说明">
      <span className="ne__quality-label">音质</span>
      <div className="seg">
        {QUALITY_ORDER.map((tier) => (
          <button
            key={tier}
            className={quality === tier ? 'is-active' : ''}
            onClick={() => void useNetease.getState().setQuality(tier)}
            title={QUALITY_LABEL[tier]}
          >
            {QUALITY_LABEL[tier].split(' ')[0]}
          </button>
        ))}
      </div>
    </div>
  )
}

function AccountCard() {
  const account = useNetease((s) => s.account)
  const [busy, setBusy] = useState(false)

  if (!account) {
    return (
      <div className="ne__account">
        <span className="ne__avatar">
          <User size={16} />
        </span>
        <div className="ne__account-text">
          <span className="ne__account-name">未登录</span>
          {/*
            The sentence that carries this screen: search and playback need no
            account, so nobody should think a phone number is the price of use.
            Kept to one short line - the sidebar is 268px wide, and a paragraph
            wrapped over five lines stops being read.

            Why the source is unusable is not repeated here: the banner above
            already says it, and saying it twice in one screen is noise.
          */}
          <span className="ne__account-meta">搜索和播放不需要登录</span>
        </div>
        <button className="btn btn--small" onClick={() => useNetease.getState().setLoginOpen(true)}>
          登录
        </button>
      </div>
    )
  }

  return (
    <div className="ne__account">
      <span className="ne__avatar">
        <Artwork
          src={account.avatarUrl ? remoteImage(account.avatarUrl) : null}
          fallback={<User size={16} />}
        />
      </span>
      <div className="ne__account-text">
        <span className="ne__account-name">{account.nickname}</span>
        <span className="ne__account-meta">
          Lv.{account.level}
          {account.vip ? ' · 会员' : ' · 非会员'}
        </span>
      </div>
      <button
        className="btn btn--small"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            await useNetease.getState().logout()
          } finally {
            setBusy(false)
          }
        }}
      >
        {busy ? '退出中' : '退出'}
      </button>
    </div>
  )
}

/**
 * The per-track menu for an online row.
 *
 * Deliberately not the library's `TrackMenu`, and deliberately without an
 * "add to playlist" item. That omission is a decision, not an oversight:
 *
 * A local playlist stores local track ids and resolves them against the scanned
 * library (`App.tsx` builds its `trackById` map from `useLibrary`). An online
 * track has no file and is never scanned, so it could never be resolved - it
 * would sit in the playlist as a permanently missing row. Offering the action
 * would therefore produce silent breakage, and "this menu item did nothing" is
 * worse than "this menu item is not offered".
 *
 * Supporting it properly is a contract-level change, not a UI one: `Playlist`
 * would need a source dimension per entry, a way to re-resolve an online id that
 * may no longer exist upstream, and playlist views that can render a row with no
 * file behind it. Until that exists, online tracks are listened to from this
 * screen and can be queued, not saved.
 */
function SongMenu({
  request,
  song,
  onClose
}: {
  request: TrackMenuRequest
  /** The upstream song behind this row, when the list it came from is known. */
  song: NeteaseSong | null
  onClose(): void
}) {
  const { x, y } = request

  return (
    <>
      <div className="ne__scrim" onPointerDown={onClose} role="presentation" />
      <div className="menu" role="menu" style={{ left: x, top: y }} aria-label={`${request.track.title} 的操作`}>
        <button
          className="menu__item"
          role="menuitem"
          onClick={() => {
            usePlayer.getState().enqueue([request.track], 'next')
            onClose()
          }}
        >
          下一首播放
        </button>
        <button
          className="menu__item"
          role="menuitem"
          disabled={!song}
          onClick={() => {
            if (song) void navigator.clipboard?.writeText(`https://music.163.com/#/song?id=${song.id}`)
            onClose()
          }}
        >
          复制歌曲链接
        </button>
        {song ? (
          <>
            <div className="menu__sep" role="separator" />
            <div className="menu__label">{paymentLabel(song)}</div>
          </>
        ) : null}
        <div className="menu__sep" role="separator" />
        <button className="menu__item" role="menuitem" disabled>
          在文件夹中显示（在线歌曲没有文件）
        </button>
      </div>
    </>
  )
}
