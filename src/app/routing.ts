import { isNative } from '../bridge'
import { MENU_TEST_MODE, PERF_MODE, SCROLL_TEST_MODE } from './preview'
import type { ViewId } from '../types'

/**
 * Routes, screen titles, and which screen the app opens on.
 *
 * A pure function of the environment: it reads the fragment and the platform and
 * returns a route. Kept out of `App` so the decision can be read on its own.
 */

export const VIEW_TITLES: Record<ViewId, string> = {
  albums: '专辑',
  artists: '艺术家',
  songs: '歌曲',
  folders: '文件夹',
  playlists: '播放列表',
  accounts: '档案',
  sources: '音源',
  netease: '网易云音乐',
  search: '搜索',
  settings: '偏好设置'
}

export interface Route {
  view: ViewId
  artistId?: string
  albumId?: string
  playlistId?: string
}

export function initialRoute(): Route {
  if (isNative) return { view: 'albums' }
  if (PERF_MODE) return { view: 'settings' }
  if (SCROLL_TEST_MODE) return { view: 'songs' }
  if (MENU_TEST_MODE) return { view: 'songs' }
  if (!isNative && window.location.hash.replace(/^#/, '') === 'empty') return { view: 'songs' }
  const hash = window.location.hash.replace(/^#/, '')
  if (hash in VIEW_TITLES) return { view: hash as ViewId }
  /*
   * The online catalogue is the front door, not the local folders.
   * A streaming-era player opens on what it can offer you; the files on this
   * machine are the supplement you go looking for. Landing on the album wall
   * made an empty local library look like an empty application.
   */
  return { view: 'netease' }
}

export const LIBRARY_VIEWS: ReadonlySet<ViewId> = new Set<ViewId>([
  'albums',
  'artists',
  'songs',
  'folders',
  'playlists'
])
