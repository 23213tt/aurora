import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AccountsView } from './components/AccountsView'
import { AlbumDetail } from './components/AlbumDetail'
import { AlbumGrid } from './components/AlbumGrid'
import { ArtistList } from './components/ArtistList'
import { EqPanel } from './components/EqPanel'
import { FolderTree } from './components/FolderTree'
import { NeteaseView } from './components/NeteaseView'
import { PlayerBar } from './components/PlayerBar'
import { PlaylistDetail } from './components/PlaylistDetail'
import { PlaylistList } from './components/PlaylistList'
import { QueuePanel } from './components/QueuePanel'
import { Rail } from './components/Rail'
import { TitleBar } from './components/TitleBar'
import { TrackList, type TrackMenuRequest } from './components/TrackList'
import { TrackMenu } from './components/TrackMenu'
import { ChevronLeft, Close, Folder, Plus, Refresh, Trash, Wave } from './components/icons'
import { bridge, isNative } from './bridge'
import { demoLibrary } from './library/demo'
import { useLyrics, usePalette } from './library/hooks'
import { useRoots } from './library/roots'
import { loadInitialIndex, runScan } from './library/scan'
import { albumKey, groupAlbums, groupArtists, scoreTrack, useLibrary } from './library/store'
import { SOURCES, artworkFor } from './library/source'
import { buildFolderTree, tracksUnder } from './library/tree'
import { player } from './player/actions'
import { driver } from './player/driver'
import { usePlayer } from './player/store'
import { buildM3u, parseM3u, resolveEntries } from './playlists/m3u'
import { loadProfilePlaylists, usePlaylists } from './playlists/store'
import { useAccounts } from './accounts/store'
import { useNetease } from './netease/store'
import { DesktopLyricsBridge } from './overlay/DesktopLyricsBridge'
import { SettingsView } from './settings/SettingsView'
import { useWindowVisibility } from './visibility'
import { LyricsStage } from './stage/LyricsStage'
import type { OverlayStatus } from './env'
import type { Track, ViewId } from './types'

const VIEW_TITLES: Record<ViewId, string> = {
  albums: '专辑',
  artists: '艺术家',
  songs: '歌曲',
  folders: '文件夹',
  playlists: '播放列表',
  accounts: '档案',
  sources: '音源',
  netease: '网易云音乐',
  settings: '偏好设置'
}

/**
 * One entry in the navigation stack. Keeping the artist drill-down in the route
 * rather than in separate state is what makes the title bar's back and forward
 * buttons real instead of decorative.
 */
interface Route {
  view: ViewId
  artistId?: string
  albumId?: string
  playlistId?: string
}

/**
 * Design-harness affordance.
 *
 * The browser preview can open straight to a screen via the fragment
 * (`#artists`, `#folders`, `#songs`, `#eq`, `#stage`) so a screenshot can be
 * taken of any view without clicking through the UI. Electron ignores this
 * entirely and always starts on the album grid.
 */
/**
 * Preview benchmark mode (`#perf`).
 *
 * A headless renderer barely runs `requestAnimationFrame`, so the 60 Hz position
 * stream a visible window produces cannot be reproduced by letting the synthetic
 * driver run - the first attempt measured six renders in six seconds, which was
 * the rig failing rather than the app performing well. `#perf` drives the same
 * store update from a timer instead, which is what makes the render-cost claim
 * reproducible: 403 app renders before the playhead subscription was moved out
 * of the root, 4 after, for the same six seconds at 60 Hz.
 */
const PERF_MODE = !isNative && window.location.hash.replace(/^#/, '') === 'perf'

/**
 * Preview screen for the auto-scroll behaviour (`#songs-far`).
 *
 * With the demo library's 27 rows, starting playback around row 19 puts the
 * playing track below the fold, so the screenshot only shows it if the list
 * really did scroll itself.
 */
const SCROLL_TEST_START = 18
const SCROLL_TEST_MODE = !isNative && window.location.hash.replace(/^#/, '') === 'songs-far'

/** Preview screen for the track actions menu, which otherwise needs a pointer. */
const MENU_TEST_MODE = !isNative && window.location.hash.replace(/^#/, '') === 'menu'

/**
 * Preview stress harness: `window.__AURORA_STRESS = 5000` before the bundle runs.
 *
 * A personal library runs to thousands of rows, and the 27-row demo library cannot
 * answer what that costs. The seeder itself lives in a separate chunk
 * (`src/preview/stress.ts`, fetched on demand below) so the app bundle never
 * contains measurement code - see that file for why that matters more than an
 * `isNative` guard.
 */
const STRESS_TRACKS = !isNative ? Number((window as Window & { __AURORA_STRESS?: number }).__AURORA_STRESS ?? 0) : 0

function initialRoute(): Route {
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

/**
 * Preview-only render counter.
 *
 * The player store publishes `position` on every animation frame. Whether that
 * reaches the whole component tree or only the two leaf components that draw it
 * is the difference between sixty full-tree React renders per second and a
 * handful per song. This counter is how that gets measured rather than asserted;
 * it is skipped entirely in Electron.
 */
let appRenders = 0

/**
 * The screens that show files on this disk.
 *
 * Used to decide where the library actions (rescan, add folder) belong: they are
 * meaningful exactly here, and nowhere else. Cheap to check on every render, and
 * it keeps the condition in one place instead of growing an exception per screen.
 */
const LIBRARY_VIEWS: ReadonlySet<ViewId> = new Set<ViewId>([
  'albums',
  'artists',
  'songs',
  'folders',
  'playlists'
])

export function App() {  if (!isNative) {
    appRenders += 1
    ;(window as Window & { __auroraRenders?: number }).__auroraRenders = appRenders
  }

  const [stack, setStack] = useState<Route[]>(() => [initialRoute()])
  const [cursor, setCursor] = useState(0)
  const route = stack[cursor] ?? { view: 'albums' }
  const view = route.view

  const [collapsed, setCollapsed] = useState(false)
  const [query, setQuery] = useState('')
  const [stageOpen, setStageOpen] = useState(false)
  const [eqOpen, setEqOpen] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  /** Mirrors the desktop lyric window's state, owned by the main process. */
  const [overlayStatus, setOverlayStatus] = useState<OverlayStatus>({
    open: false,
    locked: true,
    size: 34
  })
  /** Transient result message for import/export, dismissed on navigation. */
  const [flash, setFlash] = useState<string | null>(null)
  /** The open per-track actions menu, if any. */
  const [trackMenu, setTrackMenu] = useState<TrackMenuRequest | null>(null)

  const playlists = usePlaylists((s) => s.playlists)

  const accounts = useAccounts((s) => s.accounts)
  const activeAccountId = useAccounts((s) => s.activeId)
  const activeAccount = accounts.find((account) => account.id === activeAccountId) ?? null

  const { roots, add, remove, busy } = useRoots()
  const tracks = useLibrary((s) => s.tracks)
  const setTracks = useLibrary((s) => s.setTracks)
  const ready = useLibrary((s) => s.ready)
  const scanning = useLibrary((s) => s.scanning)
  const progress = useLibrary((s) => s.progress)
  const currentScan = useLibrary((s) => s.currentScan)
  const scanError = useLibrary((s) => s.error)

  const track = usePlayer((s) => (s.index >= 0 ? (s.queue[s.index] ?? null) : null))
  const playing = usePlayer((s) => s.playing)
  const loading = usePlayer((s) => s.loading)
  /*
   * `position` is deliberately absent here.
   *
   * It changes on every animation frame. Subscribing at the app root re-rendered
   * the entire tree sixty times a second - measured at 403 renders in 6.3s with
   * the preview counter. The two leaf components that draw the playhead
   * subscribe themselves instead (components/PlayerBar, stage/LyricsStage).
   */
  const duration = usePlayer((s) => s.duration)
  const volume = usePlayer((s) => s.volume)
  const muted = usePlayer((s) => s.muted)
  const shuffle = usePlayer((s) => s.shuffle)
  const repeat = usePlayer((s) => s.repeat)
  const eqEnabled = usePlayer((s) => s.eqEnabled)
  const eqGains = usePlayer((s) => s.eqGains)

  const palette = usePalette(track)
  const {
    lyrics,
    onlineEnabled: lyricsOnline,
    setOnline: setLyricsOnline
  } = useLyrics(track)
  const backdrop = artworkFor(track)
  const windowVisibility = useWindowVisibility()

  const navigate = useCallback(
    (next: Route) => {
      const current = stack[cursor]
      if (
        current &&
        current.view === next.view &&
        current.artistId === next.artistId &&
        current.playlistId === next.playlistId
      ) {
        return
      }
      const trimmed = stack.slice(0, cursor + 1)
      setStack([...trimmed, next])
      setCursor(trimmed.length)
      setFlash(null)
    },
    [stack, cursor]
  )

  const goBack = useCallback(() => setCursor((c) => Math.max(0, c - 1)), [])
  const goForward = useCallback(
    () => setCursor((c) => Math.min(stack.length - 1, c + 1)),
    [stack.length]
  )

  /**
   * Browser preview only: seed the demo library and start playing, so the
   * visual system has real motion to be judged against. Electron never runs
   * this branch - `isNative` is true there.
   */
  useEffect(() => {
    if (isNative) {
      void loadInitialIndex()
      return
    }
    // A stress run replaces the demo library entirely; seeding both would measure
    // the wrong list. The chunk is fetched only when the flag is set.
    if (STRESS_TRACKS > 0) {
      void import('./preview/stress').then(({ seedStressLibrary }) => {
        seedStressLibrary(STRESS_TRACKS)
        player.playQueue(useLibrary.getState().tracks, 0)
      })
      return
    }
    setTracks(demoLibrary)
    // `#songs-far` starts deep in the list so the auto-scroll is observable.
    player.playQueue(demoLibrary, SCROLL_TEST_MODE ? SCROLL_TEST_START : 0)

    /*
     * `#empty` shows the state that follows adding a folder with no music in it.
     * The folders are already non-empty in the preview (see demoRoots), so
     * clearing the library is enough to reach it.
     */
    if (window.location.hash.replace(/^#/, '') === 'empty') setTracks([])

    // Seed a couple of playlists so the playlists screen has content to judge.
    const store = usePlaylists.getState()
    if (store.playlists.length === 0) {
      const long = store.create('深夜循环', demoLibrary.slice(0, 6).map((t) => t.id))
      store.create('通勤', demoLibrary.slice(10, 16).map((t) => t.id))

      const hash = window.location.hash.replace(/^#/, '')
      if (hash === 'playlist') {
        setStack([{ view: 'playlists', playlistId: long.id }])
        setCursor(0)
      }
      // Opens the album screen on the first album, so the drill-down can be
      // reviewed without a pointer to click with.
      if (hash === 'album') {
        const first = groupAlbums(demoLibrary)[0]
        if (first) {
          setStack([{ view: 'albums', albumId: first.id }])
          setCursor(0)
        }
      }
    }

    const hash = window.location.hash.replace(/^#/, '')
    if (hash === 'stage') setStageOpen(true)
    if (hash === 'eq') setEqOpen(true)
    if (hash === 'queue') setQueueOpen(true)
  }, [setTracks])

  /**
   * Scan once automatically when folders are configured but the index is empty,
   * which is the state right after the user adds their first folder. After
   * that, scanning is explicit: a rescan is a decision, not a surprise.
   */
  const autoScanned = useRef(false)
  useEffect(() => {
    if (!isNative || autoScanned.current) return
    if (ready && tracks.length === 0 && roots.length > 0) {
      autoScanned.current = true
      void runScan()
    }
  }, [ready, tracks.length, roots.length])

  /**
   * Benchmark load, preview only.
   *
   * See PERF_MODE. This exists so the render-cost claim can be re-measured after
   * any change rather than taken on trust.
   */
  useEffect(() => {
    if (!PERF_MODE) return
    const timer = window.setInterval(() => {
      const state = usePlayer.getState()
      state.setPosition(state.position + 1 / 60)
    }, 1000 / 60)
    return () => window.clearInterval(timer)
  }, [])

  /**
   * The Windows thumbnail toolbar shows either play or pause, and the main
   * process cannot know which without being told.
   */
  useEffect(() => {
    if (!isNative) return
    void bridge.player.reportState({ playing })
  }, [playing])

  /** Transport commands from the tray menu and the thumbnail toolbar. */
  useEffect(() => {
    if (!isNative) return
    return bridge.player.onCommand((command) => {
      if (command === 'toggle') player.toggle()
      else if (command === 'next') player.next()
      else player.prev()
    })
  }, [])

  /**
   * The overlay can also be opened from the tray or a global shortcut, so its
   * state is read from the main process rather than assumed locally.
   */
  useEffect(() => {
    if (!isNative) return
    void bridge.overlay.getStatus().then(setOverlayStatus)
    return bridge.overlay.onStatus(setOverlayStatus)
  }, [])

  const toggleDesktopLyrics = useCallback(async () => {
    if (!isNative) return
    setOverlayStatus(await bridge.overlay.toggle(!overlayStatus.open))
  }, [overlayStatus.open])

  /**
   * Say, in the taskbar and window switcher, that the music is still playing.
   *
   * This is the visible half of "background playback": the window stops being
   * observable once it is hidden to the tray, so the one thing a user can still
   * check has to say the truth about what is running.
   */
  useEffect(() => {
    if (!windowVisibility.hidden) {
      document.title = 'Aurora'
      return
    }
    document.title = playing ? `▶ ${track?.title ?? 'Aurora'}` : 'Aurora · 已隐藏'
  }, [windowVisibility.hidden, playing, track?.title])

  /** A fresh install, or a store that lost its active id, still needs a profile. */
  useEffect(() => {
    useAccounts.getState().ensureDefault()

    /*
     * Preview only: give the accounts screen a second profile, so the switch and
     * delete affordances are actually rendered and reviewed rather than assumed.
     */
    if (!isNative && window.location.hash.replace(/^#/, '') === 'accounts') {
      const state = useAccounts.getState()
      if (state.accounts.length < 2) {
        state.create('客厅')
        state.activate(state.accounts[0].id)
      }
    }
  }, [])

  /**
   * Re-point the playlist store at the active profile.
   *
   * This is what makes a profile isolate something. Without it the switcher
   * would only change a label in the sidebar while every profile shared one
   * playlist library - which is worse than not having profiles at all, because
   * it looks like it works.
   *
   * The first run is already taken care of before render (see src/main.tsx);
   * this handles every switch after that.
   */
  useEffect(() => {
    void loadProfilePlaylists(activeAccountId)
    /*
     * The online account is part of the profile too, so it is rebound on the
     * same switch. `init` notices the profile changed, drops the previous
     * account's playlists and collection, and asks the main process to point the
     * session at this profile.
     */
    void useNetease.getState().init()
  }, [activeAccountId])

  /** Preview only: pop the actions menu so it can be reviewed in a screenshot. */
  useEffect(() => {
    if (!MENU_TEST_MODE || tracks.length < 3) return
    setTrackMenu({ track: tracks[2], x: 400, y: 290 })
  }, [tracks])

  // Transport shortcuts, ignored while typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable === true
      if (typing) return

      const mod = event.ctrlKey || event.metaKey

      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        document.getElementById('global-search')?.focus()
        return
      }
      if (event.key === 'Escape') {
        if (stageOpen) setStageOpen(false)
        else if (eqOpen) setEqOpen(false)
        else if (queueOpen) setQueueOpen(false)
        return
      }
      if (event.key.toLowerCase() === 'l') {
        event.preventDefault()
        setStageOpen((open) => !open)
        return
      }
      if (event.key.toLowerCase() === 'e') {
        event.preventDefault()
        setEqOpen((open) => !open)
        return
      }
      if (event.code === 'Space') {
        event.preventDefault()
        player.toggle()
        return
      }
      if (event.key === 'ArrowRight' && mod) {
        event.preventDefault()
        player.next()
        return
      }
      if (event.key === 'ArrowLeft' && mod) {
        event.preventDefault()
        player.prev()
        return
      }
      if (event.key === 'ArrowRight') player.nudge(5)
      else if (event.key === 'ArrowLeft') player.nudge(-5)
      else if (event.key === 'ArrowUp') player.setVolume(volume + 0.05)
      else if (event.key === 'ArrowDown') player.setVolume(volume - 0.05)
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stageOpen, eqOpen, queueOpen, volume])

  const albums = useMemo(() => groupAlbums(tracks), [tracks])
  const artists = useMemo(() => groupArtists(tracks), [tracks])
  const folderTree = useMemo(() => buildFolderTree(tracks), [tracks])
  const trackById = useMemo(() => new Map(tracks.map((item) => [item.id, item])), [tracks])

  const activePlaylist = route.playlistId
    ? (playlists.find((playlist) => playlist.id === route.playlistId) ?? null)
    : null

  /**
   * A playlist stores ids, so a file that was deleted, moved or never scanned
   * simply does not resolve. That gap is the whole reason the missing count
   * exists: it is the difference between "empty playlist" and "broken playlist".
   */
  const playlistTracks = useMemo(() => {
    if (!activePlaylist) return { tracks: [] as Track[], missing: 0 }
    const resolved = activePlaylist.trackIds
      .map((id) => trackById.get(id))
      .filter((item): item is Track => Boolean(item))
    return { tracks: resolved, missing: activePlaylist.trackIds.length - resolved.length }
  }, [activePlaylist, trackById])

  const representative = useMemo(() => {
    const byId = new Map(tracks.map((t) => [t.id, t]))
    const map = new Map<string, (typeof tracks)[number]>()
    for (const album of albums) {
      const first = byId.get(album.trackIds[0])
      if (first) map.set(album.id, first)
    }
    return map
  }, [albums, tracks])

  const band = useMemo(() => {
    if (!route.artistId) return null
    return {
      artist: artists.find((a) => a.id === route.artistId) ?? null,
      albums: albums.filter((album) => album.albumArtist === route.artistId),
      tracks: tracks.filter((item) => item.albumArtist === route.artistId)
    }
  }, [route.artistId, artists, albums, tracks])

  const visibleTracks = useMemo(() => {
    if (!query.trim()) return tracks
    return tracks
      .map((item) => ({ item, score: scoreTrack(item, query) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item)
  }, [tracks, query])

  const currentAlbumId = track ? albumKey(track) : null

  /**
   * The album being viewed, with its tracks in the album's own order.
   *
   * `trackIds` is already sorted by disc and track number when the library is
   * grouped, so this preserves running order rather than re-sorting.
   */
  const albumDetail = useMemo(() => {
    if (!route.albumId) return null
    const album = albums.find((a) => a.id === route.albumId)
    if (!album) return null
    const byId = new Map(tracks.map((item) => [item.id, item]))
    const ordered = album.trackIds
      .map((id) => byId.get(id))
      .filter((item): item is Track => Boolean(item))
    return { album, tracks: ordered }
  }, [route.albumId, albums, tracks])
  const currentArtistId = track?.albumArtist ?? null
  const currentFolder = track ? track.path.replace(/[\\/][^\\/]*$/, '') : null

  const playAlbum = useCallback(
    (albumId: string) => {
      const album = albums.find((a) => a.id === albumId)
      if (!album) return
      const byId = new Map(tracks.map((t) => [t.id, t]))
      const queue = album.trackIds
        .map((id) => byId.get(id))
        .filter((t): t is (typeof tracks)[number] => Boolean(t))
      player.playQueue(queue, 0)
    },
    [albums, tracks]
  )

  const playArtist = useCallback(
    (artistId: string) => {
      const owned = tracks.filter((item) => item.albumArtist === artistId)
      if (owned.length > 0) player.playQueue(owned, 0)
    },
    [tracks]
  )

  const playFolder = useCallback(
    (folderPath: string) => {
      const owned = tracksUnder(tracks, folderPath)
      if (owned.length > 0) player.playQueue(owned, 0)
    },
    [tracks]
  )

  const createPlaylist = useCallback(
    (name: string) => {
      const created = usePlaylists.getState().create(name)
      navigate({ view: 'playlists', playlistId: created.id })
    },
    [navigate]
  )

  const importPlaylist = useCallback(async () => {
    const file = await bridge.playlists.import()
    if (!file) return
    const entries = parseM3u(file.text)
    const { ids, missing } = resolveEntries(entries, tracks, file.dir)
    const created = usePlaylists.getState().create(file.name, ids)
    // Navigate first: navigation clears any previous flash.
    navigate({ view: 'playlists', playlistId: created.id })
    setFlash(
      missing > 0
        ? `从「${file.name}.m3u」导入 ${ids.length} 首，另有 ${missing} 个条目在曲库里找不到`
        : `从「${file.name}.m3u」导入 ${ids.length} 首`
    )
  }, [tracks, navigate])

  const exportPlaylist = useCallback(async () => {
    if (!activePlaylist) return
    const ok = await bridge.playlists.export(
      activePlaylist.name,
      buildM3u(playlistTracks.tracks)
    )
    setFlash(ok ? `已导出「${activePlaylist.name}.m3u」` : '已取消导出')
  }, [activePlaylist, playlistTracks.tracks])

  /**
   * Harness only: drive the m3u import so its parsing, path resolution and
   * missing-entry reporting can be inspected without a file dialog.
   */
  useEffect(() => {
    if (isNative) return
    if (window.location.hash.replace(/^#/, '') !== 'import') return
    void importPlaylist()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** Adding folders is only useful once they are indexed, so scan right after. */
  const addFolders = useCallback(async () => {
    /*
     * Failure has to be visible.
     *
     * This used to be a bare await: if the main process rejected - a dialog that
     * could not open, a settings file that could not be written - the promise
     * rejected into nothing and the button simply did nothing at all. "The button
     * is dead" is indistinguishable from "it worked and found no music", which is
     * the worst possible way to report a problem.
     */
    try {
      const next = await add()
      if (isNative && next.length > 0) await runScan()
    } catch (error) {
      setFlash(`加入文件夹失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [add])

  /*
   * The header says what the screen is, and - only when there is something to
   * report - what is happening. Every view used to carry a one-line description
   * of itself ("按唱片整理"), which is the kind of text you read once and then
   * scroll past forever.
   */
  const headTitle = route.artistId ? (band?.artist?.name ?? '艺术家') : VIEW_TITLES[view]
  const headStatus = scanning
    ? `正在扫描 ${Math.round(progress * 100)}%${
        currentScan ? `，${currentScan.split(/[\\/]/).pop()}` : ''
      }`
    : scanError
      ? scanError
      : query.trim()
        ? `${visibleTracks.length} 首`
        : null

  const body = () => {
    if (view === 'sources') return <Sources roots={roots} onAdd={addFolders} onRemove={remove} busy={busy} />
    if (view === 'settings') return <SettingsView />
    // The online source stands on its own: its tracks never enter the library
    // store, so it must stay reachable with an empty local library - hence
    // before the `tracks.length === 0` check below.
    if (view === 'netease') return <NeteaseView />
    if (view === 'accounts') {
      return (
        <AccountsView
          accounts={accounts}
          activeId={activeAccountId}
          onCreate={(label) => useAccounts.getState().create(label)}
          onActivate={(id) => useAccounts.getState().activate(id)}
          onRename={(id, label) => useAccounts.getState().rename(id, label)}
          onRemove={(id) => useAccounts.getState().remove(id)}
          onUnbindOnline={(id) => {
            void bridge.netease.logoutProfile(id)
            // The account shown on this screen is cached per render; drop the
            // online state so a rebind is reflected without a reload.
            if (id === activeAccountId) void useNetease.getState().init()
          }}
        />
      )
    }

    // Playlists come before the empty-library check: a playlist can hold tracks
    // from a folder that is not currently in the library, and the management UI
    // has to stay reachable when the library happens to be empty.
    if (view === 'playlists') {
      if (activePlaylist) {
        return (
          <PlaylistDetail
            playlist={activePlaylist}
            tracks={playlistTracks.tracks}
            missingCount={playlistTracks.missing}
            currentId={track?.id ?? null}
            playing={playing}
            onPlayAt={(index) => player.playQueue(playlistTracks.tracks, index)}
            onMove={(from, to) => usePlaylists.getState().move(activePlaylist.id, from, to)}
            onRemoveAt={(index) => usePlaylists.getState().removeAt(activePlaylist.id, index)}
            onExport={() => void exportPlaylist()}
            onRename={(name) => usePlaylists.getState().rename(activePlaylist.id, name)}
          />
        )
      }
      return (
        <PlaylistList
          playlists={playlists}
          onOpen={(id) => navigate({ view: 'playlists', playlistId: id })}
          onCreate={createPlaylist}
          onRemove={(id) => usePlaylists.getState().remove(id)}
          onImport={() => void importPlaylist()}
        />
      )
    }

    if (tracks.length === 0) {
      return (
        <EmptyLibrary
          onAdd={addFolders}
          busy={busy}
          scanning={scanning}
          roots={roots}
        />
      )
    }
    if (query.trim()) {
      return (
        <TrackList
          tracks={visibleTracks}
          currentId={track?.id ?? null}
          playing={playing}
          onPlayAt={(index) => player.playQueue(visibleTracks, index)}
          onMenu={setTrackMenu}
        />
      )
    }
    if (band) {
      return (
        <div className="detail">
          <AlbumGrid
            albums={band.albums}
            representative={representative}
            currentAlbumId={currentAlbumId}
            onOpen={(album) => navigate({ view: 'albums', albumId: album.id })}
            onPlay={(album) => playAlbum(album.id)}
          />
          <TrackList
            tracks={band.tracks}
            currentId={track?.id ?? null}
            playing={playing}
            onPlayAt={(index) => player.playQueue(band.tracks, index)}
            onMenu={setTrackMenu}
          />
        </div>
      )
    }
    if (view === 'songs') {
      return (
        <TrackList
          tracks={tracks}
          currentId={track?.id ?? null}
          playing={playing}
          onPlayAt={(index) => player.playQueue(tracks, index)}
          onMenu={setTrackMenu}
        />
      )
    }
    if (view === 'albums') {
      if (albumDetail) {
        return (
          <AlbumDetail
            album={albumDetail.album}
            tracks={albumDetail.tracks}
            currentId={track?.id ?? null}
            playing={playing}
            onPlayAll={() => playAlbum(albumDetail.album.id)}
            onPlayAt={(index) => {
              const byId = new Map(tracks.map((t) => [t.id, t]))
              const ordered = albumDetail.album.trackIds
                .map((id) => byId.get(id))
                .filter((t): t is Track => Boolean(t))
              player.playQueue(ordered, index)
            }}
            onOpenArtist={(artistId) => navigate({ view: 'artists', artistId })}
            onMenu={setTrackMenu}
          />
        )
      }

      return (
        <AlbumGrid
          albums={albums}
          representative={representative}
          currentAlbumId={currentAlbumId}
          onOpen={(album) => navigate({ view: 'albums', albumId: album.id })}
          onPlay={(album) => playAlbum(album.id)}
        />
      )
    }
    if (view === 'artists') {
      return (
        <ArtistList
          artists={artists}
          albums={albums}
          representative={representative}
          currentArtistId={currentArtistId}
          onOpen={(artistId) => navigate({ view: 'artists', artistId })}
          onPlay={playArtist}
        />
      )
    }
    if (view === 'folders') {
      return <FolderTree nodes={folderTree} currentFolder={currentFolder} onPlay={playFolder} />
    }
    return null
  }

  return (
    <>
      <div className={`shell${collapsed ? ' is-collapsed' : ''}${track?.hasArt ? ' has-art' : ''}`}>
        {backdrop ? (
          <div
            className="shell__backdrop"
            // The scrim lives in CSS; only the artwork URL is data.
            style={{ '--backdrop-url': `url("${backdrop}")` } as React.CSSProperties}
            aria-hidden="true"
          />
        ) : null}
        <TitleBar
          query={query}
          onQuery={setQuery}
          onBack={goBack}
          onForward={goForward}
          canBack={cursor > 0}
          canForward={cursor < stack.length - 1}
        />

        <Rail
          view={view}
          onView={(next) => navigate({ view: next })}
          collapsed={collapsed}
          onToggleCollapsed={() => setCollapsed((value) => !value)}
          counts={{
            albums: albums.length,
            artists: artists.length,
            songs: tracks.length
          }}
          profileLabel={activeAccount?.label ?? null}
          onOpenPlaylist={(id) => navigate({ view: 'playlists', playlistId: id })}
          localPlaylists={playlists.map((playlist) => ({ id: playlist.id, name: playlist.name }))}
          activePlaylistId={route.playlistId ?? null}
        />

        <main className="main">
          <div className="main__header">
            {route.artistId ? (
              <button
                className="icon-btn"
                onClick={() => navigate({ view: 'artists' })}
                title="返回艺术家列表"
                aria-label="返回艺术家列表"
              >
                <ChevronLeft size={18} />
              </button>
            ) : null}

            {route.playlistId ? (
              <button
                className="icon-btn"
                onClick={() => navigate({ view: 'playlists' })}
                title="返回播放列表"
                aria-label="返回播放列表"
              >
                <ChevronLeft size={18} />
              </button>
            ) : null}

            {route.albumId ? (
              <button
                className="icon-btn"
                onClick={() => navigate({ view: 'albums' })}
                title="返回专辑列表"
                aria-label="返回专辑列表"
              >
                <ChevronLeft size={18} />
              </button>
            ) : null}

            <div className="main__titles">
              <h1 className="main__title">{headTitle}</h1>
              {headStatus ? <div className="main__sub">{headStatus}</div> : null}
            </div>

            <div className="main__tools">
              {/*
                The library's own actions only belong to the library.
                "Rescan" and "add folder" are about files on this disk, so they
                appear on the screens that show those files and nowhere else. On
                the online screen they were leftovers above someone else's
                catalogue; on the profiles screen they were a stray button about
                folders next to a list of people.
              */}
              {isNative && LIBRARY_VIEWS.has(view) ? (
                <button
                  className="btn"
                  onClick={() => void runScan()}
                  disabled={scanning || roots.length === 0}
                  title={roots.length === 0 ? '先添加一个音乐文件夹' : '重新扫描曲库'}
                >
                  <Refresh size={15} />
                  {scanning ? `${Math.round(progress * 100)}%` : '重新扫描'}
                </button>
              ) : null}
              {LIBRARY_VIEWS.has(view) ? (
                <button className="btn" onClick={() => void addFolders()} disabled={busy}>
                  <Plus size={15} />
                  添加文件夹
                </button>
              ) : null}
            </div>
          </div>

          {scanning ? (
            <div
              className="scanbar"
              role="progressbar"
              aria-label="扫描进度"
              aria-valuenow={Math.round(progress * 100)}
            >
              <div className="scanbar__fill" style={{ width: `${Math.max(2, progress * 100)}%` }} />
            </div>
          ) : null}

          {flash ? (
            <div className="flash" role="status">
              <span>{flash}</span>
              <button className="icon-btn" onClick={() => setFlash(null)} title="关闭" aria-label="关闭提示">
                <Close size={15} />
              </button>
            </div>
          ) : null}

          <div className="main__body">{body()}</div>
        </main>

        <PlayerBar
          track={track}
          playing={playing}
          loading={loading}
          duration={duration}
          volume={volume}
          muted={muted}
          shuffle={shuffle}
          repeat={repeat}
          eqOpen={eqOpen}
          desktopLyricsOpen={overlayStatus.open}
          onToggle={() => player.toggle()}
          onNext={() => player.next()}
          onPrev={() => player.prev()}
          onSeekRatio={(ratio) => player.seekRatio(ratio)}
          onVolume={(next) => player.setVolume(next)}
          onToggleMute={() => player.toggleMute()}
          onToggleShuffle={() => player.toggleShuffle()}
          onCycleRepeat={() => player.cycleRepeat()}
          onOpenStage={() => setStageOpen(true)}
          // The two side panels occupy the same slot, so opening one closes
          // the other rather than stacking them.
          onToggleEq={() => {
            setEqOpen((open) => !open)
            setQueueOpen(false)
          }}
          onOpenQueue={() => {
            setQueueOpen((open) => !open)
            setEqOpen(false)
          }}
          onToggleDesktopLyrics={() => void toggleDesktopLyrics()}
        />

        <EqPanel
          open={eqOpen}
          enabled={eqEnabled}
          gains={eqGains}
          onToggle={(enabled) => player.setEqEnabled(enabled)}
          onGain={(index, gain) => {
            const next = [...eqGains]
            next[index] = gain
            player.setEqGains(next)
          }}
          onPreset={(gains) => player.setEqGains(gains)}
          onClose={() => setEqOpen(false)}
        />

        <QueuePanel open={queueOpen} onClose={() => setQueueOpen(false)} />
      </div>

      {/*
        Actions menu. Held by the app rather than by a row, because only one can
        be open at a time and rows are recycled as the library changes.
      */}
      {trackMenu ? (
        <TrackMenu
          track={trackMenu.track}
          x={trackMenu.x}
          y={trackMenu.y}
          playlists={playlists.map((playlist) => ({ id: playlist.id, name: playlist.name }))}
          onClose={() => setTrackMenu(null)}
          onPlayNext={() => {
            player.addToQueue([trackMenu.track], 'next')
            setTrackMenu(null)
            setFlash(`已把《${trackMenu.track.title}》排到下一首`)
          }}
          onAddToPlaylist={(playlistId) => {
            usePlaylists.getState().addTracks(playlistId, [trackMenu.track.id])
            const target = playlists.find((item) => item.id === playlistId)
            setTrackMenu(null)
            setFlash(`已加入「${target?.name ?? '播放列表'}」`)
          }}
          onReveal={() => {
            void bridge.library.reveal(trackMenu.track.path)
            setTrackMenu(null)
          }}
        />
      ) : null}

      {/* Renders nothing; projects lyric state into the desktop overlay window. */}
      <DesktopLyricsBridge
        lyrics={lyrics}
        track={track}
        playing={playing}
        overlayOpen={overlayStatus.open}
      />

      {/*
        The stage is a sibling of the shell, not a child of it: it is a
        document-level overlay, and keeping it outside the grid makes that
        structural rather than a CSS ordering accident.
      */}
      {stageOpen ? (
        <LyricsStage
          track={track}
          lyrics={lyrics}
          duration={duration}
          playing={playing}
          palette={palette}
          getSpectrum={() => driver.getSpectrum()}
          onlineEnabled={lyricsOnline}
          onEnableOnline={() => void setLyricsOnline(true)}
          onSeek={(seconds) => player.seekTo(seconds)}
          onSeekRatio={(ratio) => player.seekRatio(ratio)}
          onToggle={() => player.toggle()}
          onClose={() => setStageOpen(false)}
        />
      ) : null}
    </>
  )
}

interface EmptyLibraryProps {
  onAdd(): Promise<void>
  busy: boolean
  scanning: boolean
  roots: string[]
}

function EmptyLibrary({ onAdd, busy, scanning, roots }: EmptyLibraryProps) {
  // Three genuinely different states, each with its own next action. Showing
  // "your library is empty" to someone whose scan is running is a lie.
  if (scanning) {
    return (
      <div className="empty">
        <div className="empty__art">
          <Wave size={30} />
        </div>
        <h2>正在读取标签</h2>
      </div>
    )
  }

  if (roots.length > 0) {
    return (
      <div className="empty">
        <div className="empty__art">
          <Refresh size={30} />
        </div>
        <h2>这些文件夹里没有找到音乐</h2>
        {/*
          Naming the folders is the whole point of this state. "Added, but there
          is nothing in it" and "adding did not work at all" look identical
          otherwise, and the second one is the conclusion people reach.
        */}
        <ul className="empty__roots">
          {roots.map((root) => (
            <li key={root} title={root}>
              {root}
            </li>
          ))}
        </ul>
        <button className="btn btn--accent" onClick={() => void onAdd()} disabled={busy}>
          <Plus size={15} />
          换个文件夹
        </button>
      </div>
    )
  }

  return (
    <div className="empty">
      <div className="empty__art">
        <Wave size={30} />
      </div>
      <h2>曲库还是空的</h2>
      <button className="btn btn--accent" onClick={() => void onAdd()} disabled={busy}>
        <Plus size={15} />
        选择音乐文件夹
      </button>
    </div>
  )
}

interface SourcesProps {
  roots: string[]
  busy: boolean
  onAdd(): Promise<void>
  onRemove(root: string): Promise<void>
}

function Sources({ roots, busy, onAdd, onRemove }: SourcesProps) {
  return (
    <div className="stack">
      {/*
       * What can actually play right now, read from the same registry the
       * player dispatches on. The online entry says what it is in one line -
       * a third-party reverse-engineered interface, not an official client -
       * because that is the one consequence a user has to know before using it.
       */}
      <ul className="rows">
        {SOURCES.map((source) => (
          <li className="row" key={source.id}>
            {source.online ? <Wave size={16} /> : <Folder size={16} />}
            <span className="row__path" title={source.summary}>
              {source.name}
            </span>
          </li>
        ))}
      </ul>

      {roots.length === 0 ? (
        <div className="notice">还没有加入任何文件夹</div>
      ) : (
        <ul className="rows">
          {roots.map((root) => (
            <li className="row" key={root}>
              <Folder size={16} />
              <span className="row__path" title={root}>
                {root}
              </span>
              <button
                className="icon-btn"
                onClick={() => void onRemove(root)}
                title="移出曲库"
                aria-label={`移出曲库：${root}`}
              >
                <Trash size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <button className="btn" onClick={() => void onAdd()} disabled={busy}>
        <Plus size={15} />
        添加文件夹
      </button>
    </div>
  )
}

