import type { NeteaseQuality, NeteaseSong } from '../../env'
import type { Track } from '../../types'
import { netease, hasNeteaseBackend } from './api'
import { mergeTranslation } from './lrc'
import { neteaseSongId, toTrack as toNeteaseTrack } from './track'
import { rememberNeteaseCover } from '../library/source'
import { registerProvider } from '../online/registry'
import { previewBackendsForced } from '../online/preview-harness'
import { registerResumeHandler } from '../online/store'
import type { PlatformBackend } from '../online/store'
import {
  playable,
  unknownAvailability,
  type OnlineCollection,
  type OnlineMusicProvider,
  type OnlinePlaylistSummary,
  type ProviderCapabilities,
  type QualityTier
} from '../online/types'

/**
 * Netease Cloud Music as a provider.
 *
 * Everything this platform *is* - its id, its capabilities, which collections it
 * offers, how a song becomes a `Track` - is declared here. The shared state
 * machine in `features/online/store.ts` drives it, and no view names Netease.
 *
 * The client access, the song mapping and the lyric merging stay in this module
 * because they are this platform's own code and are covered by tests. A rewrite
 * would buy nothing but risk.
 */

/**
 * The bridge calls whose signatures this adapter needs and the shared contract
 * does not describe.
 *
 * Typed through one narrow view rather than restating them, so what the bridge
 * promises stays `src/env.d.ts`'s business. The optional members are optional
 * there because a browser build has no session to bind and no account to look up.
 */
type NeteaseExtras = {
  setProfile?(profileId: string): Promise<boolean>
  songDetail(ids: number[]): Promise<NeteaseSong[]>
  accountFor?(profileId: string): Promise<import('../../env').NeteaseAccount | null>
}

const extras = netease as unknown as NeteaseExtras

/** Netease's tiers, worst to best, exactly as the main process accepts them. */
const TIERS: QualityTier[] = ['standard', 'higher', 'exhigh', 'lossless']

/**
 * Which generated collections this platform has.
 *
 * Declared rather than inferred by a view from the platform's name. A platform
 * without daily recommendations simply does not list it, and the rail and the
 * screen follow without knowing which platform they are showing.
 */
const COLLECTIONS: OnlineCollection[] = [
  { kind: 'daily', label: '每日推荐', requiresAccount: true },
  { kind: 'likes', label: '我喜欢的音乐', requiresAccount: true },
  { kind: 'cloud', label: '我的音乐云盘', requiresAccount: true },
  { kind: 'playlists', label: '我的歌单', requiresAccount: true }
]

const CAPABILITIES: ProviderCapabilities = {
  search: true,
  playback: true,
  lyrics: true,
  auth: true,
  playlists: true,
  albums: true,
  artists: true,
  recommendations: true,
  userCloud: true,
  likes: true
}

export const neteaseBackend: PlatformBackend = {
  id: 'netease',
  displayName: '网易云音乐',

  getQuality: () => netease.getQuality() as Promise<QualityTier>,
  setQuality: (quality) => netease.setQuality(quality as NeteaseQuality) as Promise<QualityTier>,

  async search(keywords, _kind, limit) {
    /*
     * One request answers all three kinds: the upstream search returns songs,
     * albums and artists together. `kind` is the caller's choice of what to read,
     * not a parameter of the query - issuing three requests to fill one screen
     * would triple the load for the same bytes.
     */
    const result = await netease.search(keywords, 'song', limit)
    return { songs: result.songs, albums: result.albums, artists: result.artists }
  },

  async streamUrl(songId, quality) {
    const result = await netease.streamUrl(songId, quality as NeteaseQuality)
    if (!result.ok) return { ok: false, reason: result.reason, message: result.message }
    return { ok: true, stream: result.stream }
  },

  async songById(songId) {
    // A restored queue can name a track no list on screen holds; this is how its
    // record is recovered so its URL can be resolved at all.
    const songs = await extras.songDetail([songId]).catch(() => [] as NeteaseSong[])
    return songs[0] ?? null
  },

  toTrack(song) {
    const track = toNeteaseTrack(song)
    // The artwork layer resolves a cover from the track alone, and `Track` has
    // nowhere to carry the upstream URL, so it is registered where the row is built.
    rememberNeteaseCover(track.id, song.album.picUrl)
    return track
  },

  songIdOf: (track: Track) => neteaseSongId(track),

  myPlaylists: () => netease.myPlaylists() as Promise<OnlinePlaylistSummary[]>,
  playlistTracks: (id) => netease.playlistTracks(id),
  artistTopSongs: (id, limit) => netease.artistTopSongs(id, limit),

  async albumSongs(id) {
    const album = await netease.album(id)
    return album?.songs ?? []
  },

  async collection(kind) {
    if (kind === 'daily') return netease.dailySongs()
    if (kind === 'likes') return netease.likeList()
    if (kind === 'cloud') return netease.cloudSongs()
    // 'playlists' is not a song list: the playlists themselves come from
    // `myPlaylists`, and opening one goes through `playlistTracks`.
    return []
  },

  async loginStatus() {
    const account = await netease.loginStatus()
    return account
      ? {
          id: account.userId,
          nickname: account.nickname,
          avatarUrl: account.avatarUrl,
          vip: account.vip,
          level: account.level
        }
      : null
  },

  async logout() {
    await netease.logout()
  },

  async bindProfile(profileId) {
    // Nothing to bind in a build whose bridge has no profile-aware session.
    if (!profileId) return
    await extras.setProfile?.(profileId)
  }
}

 const neteaseProvider: OnlineMusicProvider = {
  id: 'netease',
  displayName: '网易云音乐',
  shortName: '网易云',
  summary: '搜索、歌单、每日推荐、红心与云盘，全部走第三方逆向接口',
  disclosure:
    '通过第三方逆向接口（NeteaseCloudMusicApiEnhanced）接入，仅供个人学习自用，不是官方客户端，也不提供绕过付费或会员的能力。',
  // Verified by measurement, not assumed: signed out, free tracks play in full and
  // paid ones arrive as trial fragments. No sign-in is required to search or play.
  anonymousNote: '搜索和播放不需要登录：免费歌曲可以完整播放，需要会员的歌给试听片段。',
  // True only when the main process actually exposes this client. A browser
  // preview and a build without the Electron half both answer false, and the rail
  // then shows no entry rather than an entry that cannot work. The harness override
  // exists so the layout *with* platforms stays checkable in a preview.
  available: () => previewBackendsForced() || hasNeteaseBackend,
  capabilities: CAPABILITIES,
  collections: COLLECTIONS,
  qualityTiers: TIERS,
  getQuality: neteaseBackend.getQuality,
  setQuality: neteaseBackend.setQuality,
  backend: neteaseBackend,

  search: {
    search: (keywords, kind, limit) => neteaseBackend.search(keywords, kind, limit ?? 50),
    songDetail: (ids) => extras.songDetail(ids)
  },

  playback: {
    streamUrl: (songId, quality) => neteaseBackend.streamUrl(songId, quality ?? 'exhigh'),

    /*
     * A preliminary hint only, never a verdict.
     *
     * The upstream's `fee` says what the *catalogue* requires, not what this
     * account can get: a signed-out listener may still receive a playable stream,
     * and a member may still be refused on region grounds. So a paid song is
     * `unknown` + `restricted` - "this may need a membership, the real request will
     * decide" - and only a free song is called playable.
     *
     * The verdict is never written back here. It arrives from the actual
     * `streamUrl` call and is displayed from there, which is why a wrong guess
     * costs a hint rather than a dead row.
     */
    getAvailability: (song) =>
      song.fee === 0 ? playable() : unknownAvailability('可能需要会员或购买')
  },

  lyrics: {
    async lyrics(songId) {
      const raw = await netease.lyrics(songId)
      return mergeTranslation(raw?.lrc ?? null, raw?.translation ?? null)
    }
  },

  auth: {
    loginStatus: () => neteaseBackend.loginStatus(),
    logout: () => neteaseBackend.logout(),
    // Profiles carry an online account, so the profiles screen asks per profile.
    // The main process answers that question, and its shape is converted here so
    // the shared layer never sees a Netease-specific field name.
    accountFor: async (profileId) => {
      const account = await (extras.accountFor?.(profileId) ?? Promise.resolve(null))
      return account
        ? {
            id: account.userId,
            nickname: account.nickname,
            avatarUrl: account.avatarUrl,
            vip: account.vip,
            level: account.level
          }
        : null
    }
  },

  catalog: {
    album: async (id) => {
      const album = await netease.album(id)
      return album ? { id: album.id, name: album.name, coverUrl: album.coverUrl, songs: album.songs } : null
    },
    artistTopSongs: (id, limit) => netease.artistTopSongs(id, limit),
    playlistTracks: (id) => netease.playlistTracks(id),
    myPlaylists: () => netease.myPlaylists() as Promise<OnlinePlaylistSummary[]>
  },

  recommendations: {
    dailySongs: () => netease.dailySongs(),
    likeList: () => netease.likeList(),
    cloudSongs: () => netease.cloudSongs()
  }
}

/**
 * Let a late-arriving URL re-load the track that is already playing.
 *
 * `features/player/netease.ts` owns the actual re-load - it is the one module
 * allowed to import both the transport and the store - and registers it here at
 * startup. The shared store calls back when a stream it was waiting for lands,
 * which is what makes an expired link recover instead of going silent.
 */
let neteaseResume: (() => void) | null = null

export function setNeteaseResumeHandler(handler: (() => void) | null): void {
  neteaseResume = handler
  registerResumeHandler('netease', () => neteaseResume?.())
}



export function registerNeteaseProvider(): void {
  registerProvider(neteaseProvider)
}
