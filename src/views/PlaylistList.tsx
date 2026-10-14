import { useState } from 'react'
import type { Playlist } from '../features/playlists/store'
import { List, Plus, Trash } from '../ui/icons'

interface PlaylistListProps {
  playlists: Playlist[]
  onOpen(id: string): void
  onCreate(name: string): void
  onRemove(id: string): void
  onImport(): void
}

export function PlaylistList({ playlists, onOpen, onCreate, onRemove, onImport }: PlaylistListProps) {
  const [draft, setDraft] = useState('')

  const commit = () => {
    const name = draft.trim()
    if (!name) return
    onCreate(name)
    setDraft('')
  }

  return (
    <div className="playlists">
      <form
        className="playlists__new"
        onSubmit={(event) => {
          event.preventDefault()
          commit()
        }}
      >
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="新播放列表的名字"
          aria-label="新播放列表的名字"
          maxLength={80}
        />
        <button className="btn" type="submit" disabled={!draft.trim()}>
          <Plus size={15} />
          新建
        </button>
        <button className="btn" type="button" onClick={onImport} title="从 .m3u / .m3u8 文件导入">
          导入 m3u
        </button>
      </form>

      {playlists.length === 0 ? (
        <div className="notice">还没有播放列表</div>
      ) : (
        <ul className="playlist-rows">
          {playlists.map((playlist) => (
            <li className="playlist-row" key={playlist.id}>
              <button className="playlist-row__main" onClick={() => onOpen(playlist.id)}>
                <List size={16} />
                <span className="playlist-row__name">{playlist.name}</span>
              </button>
              <span className="playlist-row__count tnum">{playlist.trackIds.length} 首</span>
              <button
                className="icon-btn"
                onClick={() => onRemove(playlist.id)}
                title="删除播放列表"
                aria-label={`删除播放列表 ${playlist.name}`}
              >
                <Trash size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
