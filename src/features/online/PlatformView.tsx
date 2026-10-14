import { useEffect, useState } from 'react'
import type { Track } from '../../types'
import { ArtCard } from '../../ui/ArtCard'
import { Artwork } from '../../ui/Artwork'
import { ChevronDown, Note, Refresh, User, Wave } from '../../ui/icons'
import { TrackList, type TrackMenuRequest } from '../../ui/TrackList'
import { usePlayer } from '../player/store'
import { providerSupports } from './registry'
import { failTextFor, useOnlineStore, type OnlineStore, type PlatformFail } from './store'
import {
  QUALITY_LABELS,
  isQualityFallback,
  isTransientFailure,
  paymentLabel,
  qualityRank,
  type OnlineAlbumRef,
  type OnlineArtistRef,
  type OnlineCollectionKind,
  type OnlineMusicProvider,
  type OnlineSearchKind,
  type OnlineSong
} from './types'

/**
 * One screen, every online platform.
 *
 * This replaces the platform-specific screen that predated the provider layer. It
 * reads the platform's capabilities and its declared collections and renders what
 * exists: a platform with no daily recommendations shows no daily-recommendations
 * entry, and a platform without album pages shows no album cards. Nothing here
 * names a platform, so adding one is a provider module and a registration line.
 *
 * Three rules it follows from `docs/ui-design.md`:
 * - one title per page, printed by the shell, so the page prints none;
 * - no sidebar inside the page - collections are a strip, not a column;
 * - colour comes only from artwork, so every surface uses the shared tokens.
 */
export function PlatformView({
  provider,
  onLogin
}: {
  provider: OnlineMusicProvider
  /** Opens this platform's sign-in dialog. Absent when it has no auth. */
  onLogin?(): void
}) {
  const store = useOnlineStore(provider.id)
  const state = store()

  const [menu, setMenu] = useState<TrackMenuRequest | null>(null)

  const currentTrack = usePlayer((s) => (s.index >= 0 ? (s.queue[s.index] ?? null) : null))
  const playing = usePlayer((s) => s.playing)

  /*
   * Ask the backend where it stands every time this screen is opened.
   *
   * A platform's first health check can fail on a cold start and succeed a minute
   * later, and the main process caches only a successful bootstrap. Without this,
   * one failure during startup would mark the screen unusable for the rest of the
   * session - a temporary fault presented as a permanent one.
   */
  useEffect(() => {
    void state.init()
    // Deliberately keyed on the platform: switching platforms re-checks the one
    // being opened, not the one being left.
  }, [provider.id])

  const rows = useSongRows(provider, state.collection)
  const currentId = currentTrack?.source === provider.id ? currentTrack.id : null

  return (
    <div className="online">
      <header className="online__bar">
        <PlatformQuality provider={provider} />
      </header>

      {/*
        Two different "not available" states, said differently. A build with no
        backend for this platform cannot be fixed by waiting; a backend that cannot
        reach its upstream can, so it gets its own line and a retry.
      */}
      {!provider.available() ? (
        <div className="notice">
          {provider.displayName}在这个构建里不可用（浏览器预览模式没有主进程，或这一版还没有对应的客户端）。
        </div>
      ) : state.backendBlocked && !state.ready ? (
        <div className="online__warn" role="status">
          <span>
            {provider.displayName}后端暂时不可用
            {state.statusDetail ? `（${state.statusDetail}）` : ''}。网络恢复后重试即可，不需要重启。
          </span>
          <button className="btn btn--small" onClick={() => void state.init()}>
            <Refresh size={13} />
            重试
          </button>
        </div>
      ) : null}

      <AccountStrip provider={provider} store={state} onLogin={onLogin} />

      <CollectionStrip provider={provider} store={state} onLogin={onLogin} />

      {state.fail ? <FailStrip provider={provider} fail={state.fail} store={state} /> : null}

      <Results
        provider={provider}
        state={state}
        rows={rows}
        currentId={currentId}
        playing={playing}
        onMenu={setMenu}
        onLogin={onLogin}
      />

      {/*
        The disclosure belongs at the foot of the page: it matters, but it is not
        navigation, and it used to take a whole column away from the music.
      */}
      <p className="online__footnote">{provider.disclosure}</p>

      {menu ? (
        <SongMenu provider={provider} request={menu} onClose={() => setMenu(null)} />
      ) : null}
    </div>
  )
}

/**
 * Song rows for a list, built through the platform's own mapping.
 *
 * `toTrack` is the platform's job because the id prefix is: the engine compares
 * `loadedPath === track.path` to decide whether to re-point its audio element, so
 * the path has to identify the *song* and never the resolved URL, which expires.
 */
function useSongRows(provider: OnlineMusicProvider, songs: OnlineSong[]): Track[] {
  const [rows, setRows] = useState<Track[]>([])
  useEffect(() => {
    // Rebuilt when the list changes, not on every render: `toTrack` stamps
    // `addedAt`, so rebuilding freely would make every row look freshly added.
    setRows(songs.map((song) => (provider.backend as { toTrack(song: OnlineSong): Track }).toTrack(song)))
  }, [provider, songs])
  return rows
}

/** Quality, as a disclosure rather than a control strip competing with the title. */
function PlatformQuality({ provider }: { provider: OnlineMusicProvider }) {
  const store = useOnlineStore(provider.id)
  const quality = store((s) => s.quality)
  const tiers = provider.qualityTiers ?? []
  const deliveredLevel = store((s) => s.deliveredLevel)
  const deliveredLevelSongId = store((s) => s.deliveredLevelSongId)
  const currentSongId = store((s) => s.currentSongId)
  const [open, setOpen] = useState(false)

  /*
   * What this song has actually been proven to serve, if anything.
   *
   * Only trusted for the song it was measured on: the ceiling is a property of one
   * track's entitlement, not of the platform or the account, so applying it to the
   * next song would lock tiers that track can reach. Learned from Mineradio, which
   * keeps a per-song "runtime cap" for the same reason.
   */
  const ceiling = deliveredLevelSongId !== null && deliveredLevelSongId === currentSongId ? deliveredLevel : null
  const effective = ceiling && isQualityFallback(ceiling, quality) ? ceiling : quality

  if (tiers.length === 0 || !provider.setQuality) return null

  return (
    <div
      className="online__quality"
      onBlur={(event) => {
        // Close when focus leaves the whole widget, not when it moves between the
        // button and its menu, or the menu closes before the click lands.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
      }}
    >
      <button
        className="online__quality-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={
          ceiling
            ? `音质：所选 ${QUALITY_LABELS[quality]}，这首歌实际最高 ${QUALITY_LABELS[ceiling]}。`
            : `音质：${QUALITY_LABELS[quality]}。上游给不了这一档时会回退，并在播放失败提示里说明。`
        }
      >
        {/* Show what will actually play, not what was asked for. */}
        {QUALITY_LABELS[effective].split(' ')[0]}
        <ChevronDown size={13} />
      </button>

      {open ? (
        <ul className="online__quality-menu" role="listbox" aria-label="音质">
          {tiers.map((tier) => {
            /*
             * A tier above the measured ceiling is still offered, but marked and
             * disabled: the request would be accepted and then quietly answered
             * with something lower, which is the confusion this note exists to
             * prevent. Disabling says "not for this song" instead.
             */
            const aboveCeiling = ceiling !== null && qualityRank(tier) > qualityRank(ceiling)
            return (
              <li key={tier}>
                <button
                  role="option"
                  aria-selected={quality === tier}
                  aria-disabled={aboveCeiling}
                  disabled={aboveCeiling}
                  className={[quality === tier ? 'is-active' : '', aboveCeiling ? 'is-capped' : '']
                    .filter(Boolean)
                    .join(' ')}
                  title={aboveCeiling && ceiling ? `这首歌最高 ${QUALITY_LABELS[ceiling]}` : undefined}
                  onClick={() => {
                    void store.getState().setQuality(tier)
                    setOpen(false)
                  }}
                >
                  <span className="online__quality-name">{QUALITY_LABELS[tier].split(' ')[0]}</span>
                  <span className="online__quality-note">
                    {aboveCeiling && ceiling ? `当前最高 ${QUALITY_LABELS[ceiling].split(' ')[0]}` : QUALITY_LABELS[tier]}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

/** Who is signed in, and what signing in would add. */
function AccountStrip({
  provider,
  store,
  onLogin
}: {
  provider: OnlineMusicProvider
  store: OnlineStore
  onLogin?(): void
}) {
  const [busy, setBusy] = useState(false)

  // A platform with no session concept has nothing to say here. The capability
  // decides that, not the platform's name.
  if (!providerSupports(provider, 'auth') || !provider.auth) return null

  if (!store.account) {
    return (
      <div className="online__account">
        <span className="online__avatar">
          <User size={16} />
        </span>
        <div className="online__account-text">
          <span className="online__account-name">未登录</span>
          {/* The platform's own account of what works signed out (see the contract). */}
          <span className="online__account-meta">{provider.anonymousNote}</span>
        </div>
        {onLogin ? (
          <button className="btn btn--small" onClick={onLogin}>
            登录
          </button>
        ) : null}
      </div>
    )
  }

  return (
    <div className="online__account">
      <span className="online__avatar">
        <Artwork
          src={store.account.avatarUrl}
          fallback={<User size={16} />}
        />
      </span>
      <div className="online__account-text">
        <span className="online__account-name">{store.account.nickname}</span>
        <span className="online__account-meta">
          Lv.{store.account.level}
          {store.account.vip ? ' · 会员' : ' · 非会员'}
        </span>
      </div>
      <button
        className="btn btn--small"
        disabled={busy}
        onClick={async () => {
          setBusy(true)
          try {
            await store.logout()
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
 * The collections this platform declares.
 *
 * The list comes from the provider, so an entry exists exactly when a platform can
 * serve it. A signed-out visitor still sees them, marked, because "sign in to get
 * your daily recommendations" is information - hiding them would leave the page
 * with nothing to say about what an account is for.
 */
function CollectionStrip({
  provider,
  store,
  onLogin
}: {
  provider: OnlineMusicProvider
  store: OnlineStore
  onLogin?(): void
}) {
  const collections = provider.collections ?? []
  if (collections.length === 0) return null

  return (
    <div className="online__collections">
      {collections.map((collection) => {
        const locked = collection.requiresAccount && !store.account
        const active = store.collectionKind === collection.kind
        return (
          <button
            key={collection.kind}
            className={`online__collection${active ? ' is-active' : ''}`}
            onClick={() => {
              if (locked) {
                onLogin?.()
                return
              }
              if (collection.kind === 'playlists') {
                void store.openCollection('playlists')
                void store.loadPlaylists()
                return
              }
              void store.openCollection(collection.kind)
            }}
            title={locked ? `登录后查看${collection.label}` : collection.label}
          >
            <CollectionIcon kind={collection.kind} />
            <span>{collection.label}</span>
            {locked ? <em>需登录</em> : null}
          </button>
        )
      })}
    </div>
  )
}

/** The mark for a collection row, from the shared icon set. */
function CollectionIcon({ kind }: { kind: OnlineCollectionKind }) {
  // The cloud collection gets its own glyph; the rest are song lists, and drawing
  // them differently would imply a difference that is not there.
  return kind === 'cloud' ? <Wave size={15} /> : <Note size={15} />
}

function FailStrip({
  provider,
  fail,
  store
}: {
  provider: OnlineMusicProvider
  fail: PlatformFail
  store: OnlineStore
}) {
  return (
    <div className="online__fail" role="status">
      <span className="online__fail-text">
        {failTextFor(provider.id, fail.reason)}
        {fail.message ? `（${fail.message}）` : ''}
      </span>
      {fail.songId !== null && isTransientFailure(fail.reason) ? (
        <button className="btn btn--small" onClick={() => void store.ensureStream(fail.songId as number)}>
          重试
        </button>
      ) : null}
      <button className="btn btn--small" onClick={() => store.clearFail()}>
        知道了
      </button>
    </div>
  )
}

/** Search results, a generated collection, or the platform's front page. */
function Results({
  provider,
  state,
  rows,
  currentId,
  playing,
  onMenu,
  onLogin
}: {
  provider: OnlineMusicProvider
  state: OnlineStore
  rows: Track[]
  currentId: string | null
  playing: boolean
  onMenu(request: TrackMenuRequest): void
  onLogin?(): void
}) {
  const tabs: { kind: OnlineSearchKind; label: string; count: number }[] = []
  if (providerSupports(provider, 'search') && provider.search) {
    tabs.push({ kind: 'song', label: '歌曲', count: state.songs.length })
    if (providerSupports(provider, 'albums')) {
      tabs.push({ kind: 'album', label: '专辑', count: state.albums.length })
    }
    if (providerSupports(provider, 'artists')) {
      tabs.push({ kind: 'artist', label: '歌手', count: state.artists.length })
    }
  }

  if (state.searched && tabs.length > 0) {
    return (
      <>
        <div className="online__head">
          <h2 className="online__title">「{state.query}」的结果</h2>
          {tabs.length > 1 ? (
            <div className="seg">
              {tabs.map((tab) => (
                <button
                  key={tab.kind}
                  className={state.searchKind === tab.kind ? 'is-active' : ''}
                  onClick={() => state.setSearchKind(tab.kind)}
                >
                  {tab.label} {tab.count}
                </button>
              ))}
            </div>
          ) : null}
        </div>

        {state.searchKind === 'album' ? (
          <AlbumCards albums={state.albums} onOpen={(id) => void state.openAlbum(id)} />
        ) : state.searchKind === 'artist' ? (
          <ArtistCards artists={state.artists} onOpen={(id) => void state.openArtist(id)} />
        ) : (
          <TrackList
            tracks={rows}
            currentId={currentId}
            playing={playing}
            onPlayAt={(index) => void state.playAt(state.songs, index)}
            onMenu={onMenu}
          />
        )}
      </>
    )
  }

  // A generated collection or a playlist is open.
  if (state.collection.length > 0 || state.collectionKind) {
    return (
      <>
        {state.openName ? (
          <div className="online__head">
            <h2 className="online__title">{state.openName}</h2>
          </div>
        ) : null}
        {state.loadingTracks ? (
          <div className="online__hint">读取中…</div>
        ) : (
          <TrackList
            tracks={rows}
            currentId={currentId}
            playing={playing}
            onPlayAt={(index) => void state.playAt(state.collection, index)}
            onMenu={onMenu}
          />
        )}
      </>
    )
  }

  return <FrontPage provider={provider} state={state} onLogin={onLogin} />
}

/** Nothing chosen yet: the platform's own playlists, or a statement of what is here. */
function FrontPage({
  provider,
  state,
  onLogin
}: {
  provider: OnlineMusicProvider
  state: OnlineStore
  onLogin?(): void
}) {
  const canUsePersonal = Boolean(state.account)

  return (
    <div className="online__welcome">
      <p className="online__welcome-note">
        {canUsePersonal
          ? `已连接${provider.displayName}，当前「${QUALITY_LABELS[state.quality]}」音质。上面选一个列表，也可以直接搜索。`
          : provider.anonymousNote}{' '}
        {!canUsePersonal && onLogin ? (
          <button className="online__link" onClick={onLogin}>
            登录{provider.displayName}
          </button>
        ) : null}
      </p>

      {canUsePersonal && state.playlists.length > 0 ? (
        <div className="grid">
          {state.playlists.map((playlist) => (
            <ArtCard
              key={playlist.id}
              title={playlist.name}
              subtitle={playlist.creator || undefined}
              meta={`${playlist.trackCount} 首`}
              src={playlist.coverUrl}
              onOpen={() => void state.openPlaylist(playlist.id)}
            />
          ))}
        </div>
      ) : canUsePersonal ? (
        <p className="online__hint">{state.playlistsLoading ? '正在读取你的歌单…' : '这个账号还没有歌单'}</p>
      ) : null}
    </div>
  )
}

function AlbumCards({ albums, onOpen }: { albums: OnlineAlbumRef[]; onOpen(id: number): void }) {
  if (albums.length === 0) return <div className="online__hint">没有匹配的专辑</div>
  return (
    <div className="grid">
      {albums.map((album) => (
        <ArtCard
          key={album.id}
          title={album.name}
          subtitle={album.artist}
          meta={`${album.year ?? '—'} · ${album.songCount} 首`}
          src={album.picUrl}
          onOpen={() => onOpen(album.id)}
        />
      ))}
    </div>
  )
}

function ArtistCards({ artists, onOpen }: { artists: OnlineArtistRef[]; onOpen(id: number): void }) {
  if (artists.length === 0) return <div className="online__hint">没有匹配的歌手</div>
  return (
    <div className="grid">
      {artists.map((artist) => (
        <ArtCard
          key={artist.id}
          title={artist.name}
          meta={`${artist.albumCount} 张专辑`}
          src={artist.picUrl}
          icon={<User size={22} />}
          // An artist is not playable as a whole, so no disc on the cover.
          onOpen={() => onOpen(artist.id)}
        />
      ))}
    </div>
  )
}

/**
 * The per-row menu for an online track.
 *
 * Deliberately without an "add to playlist" item. That omission is a decision, not
 * an oversight: a local playlist stores local track ids and resolves them against
 * the scanned library, and an online track has no file and is never scanned - it
 * would sit there as a permanently missing row. Offering an action that silently
 * breaks is worse than not offering it. Supporting it properly is a contract-level
 * change: `Playlist` would need a source dimension per entry, a way to re-resolve
 * an online id that may no longer exist upstream, and playlist views able to render
 * a row with no file behind it.
 */
function SongMenu({
  provider,
  request,
  onClose
}: {
  provider: OnlineMusicProvider
  request: TrackMenuRequest
  onClose(): void
}) {
  const { x, y } = request
  // The upstream record, when the open list still has it, for the fee hint.
  const store = useOnlineStore(provider.id)
  const state = store()
  const song = state.songs.find((item) => `${provider.id}:${item.id}` === request.track.id) ?? null

  return (
    <>
      <div className="online__scrim" onPointerDown={onClose} role="presentation" />
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
        <button className="menu__item" role="menuitem" onClick={onClose}>
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

