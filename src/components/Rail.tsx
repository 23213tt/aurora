import type { ReactNode } from 'react'
import type { ViewId } from '../types'
import { Album, Folder, List, Mic, Note, Settings, Sidebar, Sliders, User, Wave } from './icons'

interface RailProps {
  view: ViewId
  onView: (view: ViewId) => void
  collapsed: boolean
  onToggleCollapsed: () => void
  counts: { albums: number; artists: number; songs: number; playlists: number }
  /** Name of the profile in use, shown at the foot of the rail. */
  profileLabel: string | null
}

interface NavDef {
  id: ViewId
  label: string
  icon: ReactNode
  count?: number
}

export function Rail({
  view,
  onView,
  collapsed,
  onToggleCollapsed,
  counts,
  profileLabel
}: RailProps) {
  const groups: { heading: string; items: NavDef[] }[] = [
    {
      heading: '曲库',
      items: [
        { id: 'albums', label: '专辑', icon: <Album size={17} />, count: counts.albums },
        { id: 'artists', label: '艺术家', icon: <Mic size={17} />, count: counts.artists },
        { id: 'songs', label: '歌曲', icon: <Note size={17} />, count: counts.songs },
        { id: 'folders', label: '文件夹', icon: <Folder size={17} /> },
        /*
         * The online source sits inside 曲库 rather than under 设置: it is
         * somewhere you listen from, not something you configure. It carries no
         * count on purpose - a remote catalogue has no meaningful total, and a
         * number that is always zero or always stale is worse than none.
         */
        { id: 'netease', label: '网易云音乐', icon: <Wave size={17} /> }
      ]
    },
    {
      heading: '播放',
      items: [
        { id: 'playlists', label: '播放列表', icon: <List size={17} />, count: counts.playlists }
      ]
    },
    {
      heading: '设置',
      items: [
        { id: 'accounts', label: '档案', icon: <User size={17} /> },
        { id: 'sources', label: '音源', icon: <Sliders size={17} /> },
        { id: 'settings', label: '偏好设置', icon: <Settings size={17} /> }
      ]
    }
  ]

  return (
    <nav className="rail" aria-label="主导航">
      <div className="rail__scroll">
        {groups.map((group) => (
          <div className="rail__group" key={group.heading}>
            <div className="rail__heading">{group.heading}</div>
            {group.items.map((item) => (
              <button
                key={item.id}
                className={`nav-item${view === item.id ? ' is-active' : ''}`}
                onClick={() => onView(item.id)}
                aria-current={view === item.id ? 'page' : undefined}
                title={collapsed ? item.label : undefined}
              >
                {item.icon}
                <span className="nav-item__label">{item.label}</span>
                {item.count ? <span className="nav-item__count">{item.count}</span> : null}
              </button>
            ))}
          </div>
        ))}
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
