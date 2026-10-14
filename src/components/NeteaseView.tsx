import { useEffect, useState } from 'react'
import type { NeteasePlaylistSummary, NeteaseQuality, NeteaseSong } from '../env'
import { hasNeteaseBackend, remoteImage } from '../netease/api'
import { paymentLabel, useNeteaseTracks } from '../netease/hooks'
import { QUALITY_LABEL, QUALITY_ORDER, failureText, isTransient } from '../netease/stream'
import { useNetease } from '../netease/store'
import { usePlayer } from '../player/store'
import { Artwork } from './Artwork'
import { ArtCard } from './ArtCard'
import { NeteaseLogin } from './NeteaseLogin'
import { ChevronDown, Refresh, Search, User } from './icons'
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

  const submitSearch = (event: React.FormEvent) => {
    event.preventDefault()
    useNetease.getState().setQuery(draft)
    void useNetease.getState().runSearch()
  }

  return (
    <div className="ne">
      {/*
        One title per screen: the shell already prints "网易云音乐" above this
        panel, so the page does not repeat it. What sits here is the one control
        this screen owns - search - with the quality preference tucked inside its
        row, next to the thing it affects.
      */}
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
          <QualityPicker quality={quality} />
        </form>
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
        {/*
          One column, like every other screen in the app.
          This page used to be the only one with its own 268px sidebar, which made
          it look like a second application bolted inside the first: a narrow
          column of small rows next to a wide empty panel. The account and the
          three generated collections are content, so they belong in the body with
          everything else.
        */}
        <AccountCard />

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

          {searched ? (
            <div className="ne__head">
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
            </div>
          ) : null}

          {searched && searchType === 'album' ? (
            albums.length === 0 ? (
              <div className="ne__hint">没有匹配的专辑</div>
            ) : (
              <div className="grid">
                {albums.map((album) => (
                  <ArtCard
                    key={album.id}
                    title={album.name}
                    subtitle={album.artist}
                    meta={`${album.year ?? '—'} · ${album.songCount} 首`}
                    src={album.picUrl ? remoteImage(album.picUrl) : null}
                    onOpen={() => void useNetease.getState().openAlbum(album.id)}
                  />
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
                  <ArtCard
                    key={artist.id}
                    title={artist.name}
                    meta={`${artist.albumCount} 张专辑`}
                    src={artist.picUrl ? remoteImage(artist.picUrl) : null}
                    icon={<User size={22} />}
                    // An artist is not playable as a whole, so no disc on the cover.
                    onOpen={() => void useNetease.getState().openArtist(artist.id)}
                  />
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
               * Nothing opened yet. This used to be an empty state that told the
               * reader to go and pick something - which is an instruction, not a
               * screen, and it left two thirds of the window blank. What a music
               * app should show when you walk into a room is the music: the
               * generated playlists and your own, as artwork you can click.
               */
              <Welcome
                playlists={playlists}
                canUsePersonal={Boolean(account)}
                onOpenPlaylist={(id) => void useNetease.getState().openPlaylist(id)}
                onLogin={() => useNetease.getState().setLoginOpen(true)}
                loadingPlaylists={playlistsLoading}
                quality={quality}
              />
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

        {/*
          The disclosure sits at the foot of the page instead of in a sidebar.
          It matters, but it is not navigation - and it used to take a whole
          column away from the music to say it.
        */}
        <p className="ne__footnote">
          通过第三方逆向接口接入网易云，仅个人学习自用，不是官方客户端，也不提供绕过付费或会员的能力。QQ
          音乐仍未接入。
        </p>
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

/**
 * Quality, as a disclosure rather than a control strip.
 *
 * It used to be four buttons parked in the top-right corner of the screen, far
 * from anything they affect and competing with the title for attention. It is a
 * preference you set once, so it lives behind one small button that says the
 * current choice - discoverable, quiet, and one click from being changed.
 */
function QualityPicker({ quality }: { quality: NeteaseQuality }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="ne__quality" onBlur={(event) => {
      // Close when focus leaves the whole widget, not when it moves between the
      // button and its menu - otherwise the menu closes before the click lands.
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
    }}>
      <button
        className="ne__quality-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={`音质：${QUALITY_LABEL[quality]}。上游给不了这一档时会回退，并在播放失败提示里说明。`}
      >
        {QUALITY_LABEL[quality].split(' ')[0]}
        <ChevronDown size={13} />
      </button>

      {open ? (
        <ul className="ne__quality-menu" role="listbox" aria-label="音质">
          {QUALITY_ORDER.map((tier) => (
            <li key={tier}>
              <button
                role="option"
                aria-selected={quality === tier}
                className={quality === tier ? 'is-active' : ''}
                onClick={() => {
                  void useNetease.getState().setQuality(tier)
                  setOpen(false)
                }}
              >
                <span className="ne__quality-name">{QUALITY_LABEL[tier].split(' ')[0]}</span>
                <span className="ne__quality-note">{QUALITY_LABEL[tier]}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * Nothing chosen yet.
 *
 * The destinations live in the rail now, so this is not a navigation surface -
 * it is the answer to "what is here": one line of state, and your playlists as
 * artwork if there are any. The previous version repeated the rail's entries as
 * three large tiles and gave the page a second title, which is what made the
 * screen feel both crowded and empty at the same time.
 */
function Welcome({
  playlists,
  canUsePersonal,
  loadingPlaylists,
  quality,
  onOpenPlaylist,
  onLogin
}: {
  playlists: NeteasePlaylistSummary[]
  canUsePersonal: boolean
  loadingPlaylists: boolean
  quality: NeteaseQuality
  onOpenPlaylist(id: number): void
  onLogin(): void
}) {
  return (
    <div className="ne__welcome">
      <p className="ne__welcome-note">
        {canUsePersonal
          ? `已连接网易云，当前「${QUALITY_LABEL[quality]}」音质。左边选一个歌单、每日推荐或云盘，也可以直接搜索。`
          : '搜索和播放不需要登录。登录后左边的在线音乐里会多出你的每日推荐、红心与云盘。'}{' '}
        {!canUsePersonal ? (
          <button className="ne__link" onClick={onLogin}>
            登录网易云
          </button>
        ) : null}
      </p>

      {canUsePersonal ? (
        playlists.length === 0 ? (
          <p className="ne__hint">{loadingPlaylists ? '正在读取你的歌单…' : '这个账号还没有歌单'}</p>
        ) : (
          /*
           * The same `ArtCard` the local album wall uses - same cover size, same
           * meta row, same hover. A playlist from Netease and an album on disk
           * are different data and should look like the same kind of thing.
           */
          <div className="grid">
            {playlists.map((playlist) => (
              <ArtCard
                key={playlist.id}
                title={playlist.name}
                subtitle={playlist.creator || undefined}
                meta={`${playlist.trackCount} 首`}
                src={playlist.coverUrl ? remoteImage(playlist.coverUrl) : null}
                onOpen={() => onOpenPlaylist(playlist.id)}
              />
            ))}
          </div>
        )
      ) : null}
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
