import type { ReactNode } from 'react'
import { useAvailableProviders } from '../features/online/hooks'
import { platformView } from '../features/online/registry'
import { useOnlineStore } from '../features/online/store'
import type { OnlineCollectionKind, OnlineMusicProvider } from '../features/online/types'
import type { ViewId } from '../types'
import { Album, Folder, List, Mic, Note, Refresh, Search, Settings, Sidebar, Sliders, User, Wave } from '../ui/icons'

/**
 * The rail: one section per platform, with the local library as its own group.
 *
 * The structure follows `docs/ui-design.md` - online is the main body and local
 * files are the supplement - but the *number* of online sections is no longer one.
 * Each platform in the registry gets a peer entry of its own ("网易云音乐",
 * "QQ 音乐"), which is what "本地分那么多、网易云怎么就一个" was really asking for.
 *
 * Two rules make that work without the rail knowing any platform by name:
 *
 * - the platform list comes from `useAvailableProviders()`, so a build without a
 *   given client shows no entry for it rather than a dead one;
 * - each platform's generated collections come from its own `collections` field,
 *   so "每日推荐 / 红心 / 云盘" appear because Netease declares them, and QQ's rail
 *   section is short because QQ declares less. No branch here tests for a platform.
 */

interface RailProps {
  view: ViewId
  onView: (view: ViewId) => void
  collapsed: boolean
  onToggleCollapsed: () => void
  counts: { albums: number; artists: number; songs: number }
  /** Name of the profile in use, shown at the foot of the rail. */
  profileLabel: string | null
  onOpenPlaylist(id: string): void
  localPlaylists: { id: string; name: string }[]
  activePlaylistId: string | null
}

export function Rail({
  view,
  onView,
  collapsed,
  onToggleCollapsed,
  counts,
  profileLabel,
  onOpenPlaylist,
  localPlaylists,
  activePlaylistId
}: RailProps) {
  const providers = useAvailableProviders()

  return (
    <nav className="rail" aria-label="主导航">
      <div className="rail__scroll">
        {/*
          Search sits above both sources because it spans them: it answers from
          whichever catalogue its tabs name. Putting it inside one section would say
          it belongs to that one.
        */}
        <div className="rail__group">
          <NavRow view={view} own="search" onView={onView} icon={<Search size={17} />} label="搜索" collapsed={collapsed} />
        </div>

        {/*
          One group per platform. The heading is the platform's name, which is the
          only place a platform is named in this file - and it comes from the
          provider rather than from a literal.
        */}
        {providers.map((provider) => (
          <PlatformSection
            key={provider.id}
            provider={provider}
            view={view}
            onView={onView}
            collapsed={collapsed}
          />
        ))}

        {/*
          One group, two sources of playlists. A playlist is a playlist whether its
          songs are files or a remote collection, and the row looks the same either
          way - which is the merge the app was missing.
        */}
        <div className="rail__group">
          <div className="rail__heading">歌单</div>
          <button
            className={`nav-item${view === 'playlists' && !activePlaylistId ? ' is-active' : ''}`}
            onClick={() => onView('playlists')}
            title={collapsed ? '管理歌单' : undefined}
          >
            <List size={17} />
            <span className="nav-item__label">播放列表</span>
            {localPlaylists.length > 0 ? <span className="nav-item__count">{localPlaylists.length}</span> : null}
          </button>

          {localPlaylists.map((playlist) => (
            <button
              key={playlist.id}
              className={`nav-item nav-item--sub${
                view === 'playlists' && activePlaylistId === playlist.id ? ' is-active' : ''
              }`}
              onClick={() => onOpenPlaylist(playlist.id)}
              title={collapsed ? playlist.name : `${playlist.name}（本机歌单）`}
            >
              <span className="nav-item__dot" aria-hidden="true" />
              <span className="nav-item__label">{playlist.name}</span>
            </button>
          ))}
        </div>

        <div className="rail__group">
          <div className="rail__heading">本地音乐</div>
          <NavRow view={view} own="songs" onView={onView} icon={<Note size={17} />} label="歌曲" count={counts.songs} collapsed={collapsed} />
          <NavRow view={view} own="albums" onView={onView} icon={<Album size={17} />} label="专辑" count={counts.albums} collapsed={collapsed} />
          <NavRow view={view} own="artists" onView={onView} icon={<Mic size={17} />} label="艺术家" count={counts.artists} collapsed={collapsed} />
          <NavRow view={view} own="folders" onView={onView} icon={<Folder size={17} />} label="文件夹" collapsed={collapsed} />
        </div>

        <div className="rail__group">
          <div className="rail__heading">设置</div>
          <NavRow view={view} own="accounts" onView={onView} icon={<User size={17} />} label="档案" collapsed={collapsed} />
          <NavRow view={view} own="sources" onView={onView} icon={<Sliders size={17} />} label="音源" collapsed={collapsed} />
          <NavRow view={view} own="settings" onView={onView} icon={<Settings size={17} />} label="偏好设置" collapsed={collapsed} />
        </div>
      </div>

      <div className="rail-toggle">
        {/* A profile system needs a permanent "who is active" indicator; without
            one, switching profiles is invisible and therefore untrustworthy. */}
        <button
          className="nav-item rail__profile"
          onClick={() => onView('accounts')}
          title={profileLabel ? `当前档案：${profileLabel}` : '选择档案'}
        >
          <User size={17} />
          <span className="nav-item__label">{profileLabel ?? '未选择档案'}</span>
        </button>

        <button
          className="nav-item"
          onClick={onToggleCollapsed}
          title={collapsed ? '展开侧栏' : '收起侧栏'}
          aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
        >
          <Sidebar size={17} />
          <span className="nav-item__label">收起侧栏</span>
        </button>
      </div>
    </nav>
  )
}

/**
 * One platform's section.
 *
 * The named entry comes first - it is where the platform's own screen lives - and
 * its declared collections follow as indented rows. A platform whose collections
 * all require an account shows a single sign-in row while signed out instead of a
 * list of doors that all lead to the same dialog.
 */
function PlatformSection({
  provider,
  view,
  onView,
  collapsed
}: {
  provider: OnlineMusicProvider
  view: ViewId
  onView: (view: ViewId) => void
  collapsed: boolean
}) {
  const store = useOnlineStoreFor(provider)
  const account = store.account
  const collections = provider.collections ?? []

  const openCollection = (kind: OnlineCollectionKind) => {
    onView(platformView(provider))
    // A collection that needs an account is still listed, because "sign in to get
    // your daily recommendations" is information. The sign-in row below it is the
    // action, so this one only selects what it can serve.
    if (!account) return
    void store.openCollection(kind)
  }

  return (
    <div className="rail__group">
      <div className="rail__heading">{provider.displayName}</div>

      <button
        className={`nav-item${view === platformView(provider) ? ' is-active' : ''}`}
        onClick={() => onView(platformView(provider))}
        aria-current={view === platformView(provider) ? 'page' : undefined}
        title={collapsed ? provider.displayName : provider.summary}
      >
        <Wave size={17} />
        <span className="nav-item__label">{provider.shortName ?? provider.displayName}</span>
      </button>

      {collections.map((collection) => (
        <button
          key={collection.kind}
          className={`nav-item nav-item--sub${
            view === platformView(provider) && store.collectionKind === collection.kind ? ' is-active' : ''
          }`}
          onClick={() => openCollection(collection.kind)}
          title={collection.requiresAccount && !account ? `登录后查看${collection.label}` : collection.label}
        >
          <span className="nav-item__dot" aria-hidden="true" />
          <span className="nav-item__label">{collection.label}</span>
        </button>
      ))}

      {!account && collections.some((collection) => collection.requiresAccount) ? (
        <div className="rail__note">登录后显示{collections.map((item) => item.label).join('、')}</div>
      ) : null}

      {account ? (
        <button
          className="rail__note rail__note--action"
          onClick={() => void store.loadPlaylists()}
          disabled={store.playlistsLoading}
        >
          <Refresh size={12} />
          {store.playlistsLoading ? '读取中…' : '刷新歌单'}
        </button>
      ) : null}

      {/* Online playlists live with the platform they belong to, so a section can
          be read on its own without consulting another. */}
      {account
        ? store.playlists.map((playlist) => (
            <button
              key={`${provider.id}-${playlist.id}`}
              className={`nav-item nav-item--sub${
                view === platformView(provider) && store.openId === playlist.id ? ' is-active' : ''
              }`}
              onClick={() => {
                onView(platformView(provider))
                void store.openPlaylist(playlist.id)
              }}
              title={collapsed ? playlist.name : `${playlist.name} · ${playlist.creator || provider.displayName}`}
            >
              <span className="nav-item__dot" aria-hidden="true" />
              <span className="nav-item__label">{playlist.name}</span>
            </button>
          ))
        : null}
    </div>
  )
}

/** The store for a platform, subscribed so the section re-renders with it. */
function useOnlineStoreFor(provider: OnlineMusicProvider) {
  return useOnlineStore(provider.id)()
}

interface NavRowProps {
  view: ViewId
  own: ViewId
  onView: (view: ViewId) => void
  icon: ReactNode
  label: string
  count?: number
  collapsed: boolean
}

function NavRow({ view, own, onView, icon, label, count, collapsed }: NavRowProps) {
  return (
    <button
      className={`nav-item${view === own ? ' is-active' : ''}`}
      onClick={() => onView(own)}
      aria-current={view === own ? 'page' : undefined}
      title={collapsed ? label : undefined}
    >
      {icon}
      <span className="nav-item__label">{label}</span>
      {count ? <span className="nav-item__count">{count}</span> : null}
    </button>
  )
}
