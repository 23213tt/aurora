import { useCallback, useEffect } from 'react'
import { bridge, isNative } from '../../bridge'
import { usePlaylists } from './store'
import { buildM3u, parseM3u, resolveEntries } from './m3u'

/**
 * Importing and exporting `.m3u` playlists.
 *
 * Pulled out of `App` because it is a self-contained errand - read a file, match
 * its entries against the library, create a playlist, report what did not match -
 * and because the reporting is the part worth reading: an import that silently
 * dropped entries would look like a successful import of fewer songs.
 *
 * The dependencies are passed in rather than read from stores, so this stays a
 * description of the flow and not another place that knows how the app is wired.
 */
export function usePlaylistFiles(options: {
  tracks: Track[]
  activePlaylist: { id: string; name: string } | null
  playlistTracks: Track[]
  navigate(route: { view: 'playlists'; playlistId: string }): void
  onMessage(message: string): void
}) {
  const { tracks, activePlaylist, playlistTracks, navigate, onMessage } = options

  const importPlaylist = useCallback(async () => {
    const file = await bridge.playlists.import()
    if (!file) return
    const entries = parseM3u(file.text)
    const { ids, missing } = resolveEntries(entries, tracks, file.dir)
    const created = usePlaylists.getState().create(file.name, ids)
    // Navigate first: navigation clears any previous flash.
    navigate({ view: 'playlists', playlistId: created.id })
    onMessage(
      missing > 0
        ? `从「${file.name}.m3u」导入 ${ids.length} 首，另有 ${missing} 个条目在曲库里找不到`
        : `从「${file.name}.m3u」导入 ${ids.length} 首`
    )
  }, [tracks, navigate, onMessage])

  const exportPlaylist = useCallback(async () => {
    if (!activePlaylist) return
    const ok = await bridge.playlists.export(activePlaylist.name, buildM3u(playlistTracks))
    onMessage(ok ? `已导出「${activePlaylist.name}.m3u」` : '已取消导出')
  }, [activePlaylist, playlistTracks, onMessage])

  /*
   * Harness only: drive the import so its parsing, path resolution and
   * missing-entry reporting can be inspected without a file dialog.
   */
  useEffect(() => {
    if (isNative) return
    if (window.location.hash.replace(/^#/, '') !== 'import') return
    void importPlaylist()
    // Runs once: the harness hash does not change during a session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return { importPlaylist, exportPlaylist }
}
