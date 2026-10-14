import type { ReactNode } from 'react'
import type { ViewId } from '../types'
import { useNetease } from '../features/netease/store'
import { Album, Folder, List, Mic, Note, Refresh, Search, Settings, Sidebar, Sliders, User, Wave } from './icons'

/**
 * The rail, and the reason the app stopped looking like two applications.
 *
 * Local and online used to be two destinations with two layouts: a library of
 * local views on one side, and a self-contained "Netease screen" with its own
 * sidebar, its own header and its own cards on the other. Choosing what to play
 * meant choosing which app you were in.
 *
 * Here they are the same list. Your playlists - local and online - sit in one
 * group; picking any of them shows its songs in the main area, which never
 * needed to know where the songs came from. The online account is not a place
 * you visit, it is a section you sign into.
 */

interface RailProps {
  view: ViewId
  onView: (view: ViewId) => void
  collapsed: boolean
  onToggleCollapsed: () => void
  counts: { albums: number; artists: number; songs: number }
  /** Name of the profile in use, shown at the foot of the rail. */
  profileLabel: string | null
  /** Opens a local playlist's detail screen. */
  onOpenPlaylist(id: string): void
  /** Local playlist names, for the 歌单 group. */
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
  const account = useNetease((s) => s.account)
  const neteasePlaylists = useNetease((s) => s.playlists)
  const neteaseLoading = useNetease((s) => s.playlistsLoading)
  const category = useNetease((s) => s.category)
  const openId = useNetease((s) => s.openId)

  /** Switching into the online view and asking for something, in one gesture. */
  const openCategory = (next: 'daily' | 'like' | 'cloud') => {
    onView('netease')
    if (!account) {
      useNetease.getState().setLoginOpen(true)
      return
    }
    void useNetease.getState().openCategory(next)
  }

  const openOnlinePlaylist = (id: number) => {
    onView('netease')
    void useNetease.getState().openPlaylist(id)
  }

  return (
    <nav className="rail" aria-label="主导航">
      <div className="rail__scroll">
        {/*
          Online first.
          In a streaming-era player the catalogue is the product and the local
          files are the supplement - so the main section is the online one, and
          "本地音乐" is a compact block below it, not a four-entry equal half.
          The previous order had it exactly backwards, and gave the smaller half
          the longer menu.
        */}
        <div className="rail__group">
          <div className="rail__heading">在线音乐</div>
          {account ? (
            <>
              <SubRow label="每日推荐" icon={<Note size={17} />} active={view === 'netease' && category === 'daily'} onClick={() => openCategory('daily')} />
              <SubRow label="我喜欢的音乐" icon={<Note size={17} />} active={view === 'netease' && category === 'like'} onClick={() => openCategory('like')} />
              <SubRow label="我的音乐云盘" icon={<Wave size={17} />} active={view === 'netease' && category === 'cloud'} onClick={() => openCategory('cloud')} />
            </>
          ) : (
            <button className="rail__note rail__note--action" onClick={() => useNetease.getState().setLoginOpen(true)}>
              登录后显示每日推荐、红心与云盘
            </button>
          )}
          <button
            className={`nav-item${view === 'netease' && !category ? ' is-active' : ''}`}
            onClick={() => {
              onView('netease')
              if (!account) useNetease.getState().setLoginOpen(true)
            }}
            title={collapsed ? '搜索在线音乐' : '搜索在线音乐；在线歌单都在上面的「歌单」里'}
          >
            <Search size={17} />
            <span className="nav-item__label">搜索在线音乐</span>
          </button>
          {account ? (
            <button
              className="rail__note rail__note--action"
              onClick={() => void useNetease.getState().loadPlaylists()}
              disabled={neteaseLoading}
            >
              <Refresh size={12} />
              {neteaseLoading ? '读取中…' : '刷新在线歌单'}
            </button>
          ) : null}
        </div>

        {/*
          One group, two sources of playlists. A playlist is a playlist whether
          its songs are files or a remote collection, and the row looks the same
          either way - which is the merge the app was missing.
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
            {localPlaylists.length > 0 ? (
              <span className="nav-item__count">{localPlaylists.length}</span>
            ) : null}
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

          {account
            ? neteasePlaylists.map((playlist) => (
                <button
                  key={`ne-${playlist.id}`}
                  className={`nav-item nav-item--sub${
                    view === 'netease' && category === 'playlist' && openId === playlist.id ? ' is-active' : ''
                  }`}
                  onClick={() => openOnlinePlaylist(playlist.id)}
                  title={collapsed ? playlist.name : `${playlist.name} · ${playlist.creator || '网易云'}`}
                >
                  <span className="nav-item__dot" aria-hidden="true" />
                  <span className="nav-item__label">{playlist.name}</span>
                </button>
              ))
            : null}

          {account && neteaseLoading && neteasePlaylists.length === 0 ? (
            <div className="rail__note">正在读取在线歌单…</div>
          ) : null}
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

/** An indented entry: a real destination, but visibly part of the section above. */
function SubRow({
  label,
  icon,
  active,
  onClick
}: {
  label: string
  icon: ReactNode
  active: boolean
  onClick(): void
}) {
  return (
    <button className={`nav-item${active ? ' is-active' : ''}`} onClick={onClick}>
      {icon}
      <span className="nav-item__label">{label}</span>
    </button>
  )
}
