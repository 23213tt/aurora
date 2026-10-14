import type { QqApi, QqSong } from '../../env'
import type { QualityTier } from './types'
import { normalizeSearchResult } from './normalize'
import { registerProvider } from './registry'
import type { PlatformBackend } from './store'
import {
  playable,
  unknownAvailability,
  type OnlineCollection,
  type OnlineMusicProvider,
  type OnlineSong,
  type ProviderCapabilities
} from './types'
import type { Track } from '../../types'

/**
 * QQ Music as a provider.
 *
 * A real second platform, and the reason the provider layer exists: everything
 * below is platform-specific and everything above it is not. The shared state
 * machine in `./store` supplies search state, the catalogue cache, the stream cache
 * with retries and the classified failures, so this file is the capability
 * declaration, the id convention and the handful of bridge calls.
 *
 * The bridge itself is typed in `src/env.d.ts` and implemented in the main process
 * (a parallel task), so this adapter consumes the published contract rather than
 * carrying its own copy of it.
 */

/**
 * The client, or null when this build has none.
 *
 * Read on every call rather than captured at module load: the preload script and
 * the main process finish wiring independently of this bundle, and a captured
 * `undefined` would make a working backend look absent for the life of the window.
 */
function client(): QqApi | null {
  if (typeof window === 'undefined') return null
  return window.aurora?.qq ?? null
}

/**
 * QQ's tiers, in the same vocabulary as everyone else's.
 *
 * The upstream names its audio with prefixes (`M500` 128k, `C400` m4a, `M800`
 * 320k, `F000` flac, `A000` ape) and needs no login for the first two. The bridge
 * maps between those and these four, so this layer stays in the shared vocabulary
 * and what a given account can actually get stays the client's business.
 */
const TIERS: QualityTier[] = ['standard', 'higher', 'exhigh', 'lossless']

/**
 * What QQ offers, and nothing more.
 *
 * Declared, not inferred. The client exposes search, playback, lyrics, session and
 * quality; it exposes no playlist, album or artist endpoint, and no daily
 * recommendation, likes or cloud list. Those entries are therefore absent rather
 * than rendered and then found empty - the rail and the screen read this list,
 * which is what keeps "the platform does not have it" from looking like "the
 * platform has it and it is empty".
 */
const COLLECTIONS: OnlineCollection[] = []

const CAPABILITIES: ProviderCapabilities = {
  search: true,
  playback: true,
  lyrics: true,
  auth: true,
  playlists: false,
  albums: false,
  artists: false,
  recommendations: false,
  userCloud: false,
  likes: false
}

const qqBackend: PlatformBackend = {
  id: 'qq',
  displayName: 'QQ 音乐',

  async getQuality() {
    return (await client()?.getQuality()) ?? 'exhigh'
  },

  async setQuality(quality) {
    return (await client()?.setQuality(quality)) ?? quality
  },

  async search(keywords, kind, limit) {
    const result = await client()?.search(keywords, kind, limit)
    // The client already normalises into this shape; the tolerant reader is here
    // for the fields it may add later, and for a build whose client predates one.
    return normalizeSearchResult(result)
  },

  async streamUrl(songId, quality) {
    const result = await client()?.streamUrl(songId, quality)
    if (!result) return { ok: false, reason: 'service-unavailable' }
    if (!result.ok) return { ok: false, reason: result.reason, message: result.message }

    return {
      ok: true,
      stream: {
        url: result.url,
        br: result.br,
        level: result.level,
        // The client reports the tier it actually got and whether the account could
        // not reach the requested one, so nothing has to be inferred here.
        duration: 0,
        trial: result.trial
      }
    }
  },

  async songById() {
    /*
     * The client has no single-song lookup, so a search result is the only source of
     * a record. Answering null is the honest answer: the store then reports that it
     * cannot resolve the track rather than inventing a title from an id.
     */
    return null
  },

  toTrack(song) {
    const id = trackIdFor(song)
    return {
      id,
      path: id,
      source: 'qq',
      title: song.name,
      artist: song.artists.map((artist) => artist.name).join(' / '),
      albumArtist: song.artists[0]?.name ?? '',
      album: song.album.name,
      genre: '',
      year: null,
      trackNo: null,
      discNo: null,
      duration: song.duration,
      bitrate: null,
      sampleRate: null,
      channels: 2,
      codec: 'mp3',
      // The upstream never says which codec came back, so claiming lossless from the
      // requested tier would put a FLAC badge on a 320k stream.
      lossless: false,
      size: 0,
      mtimeMs: 0,
      addedAt: Date.now(),
      hasArt: Boolean(song.album.picUrl),
      gainDb: null,
      peak: null
    }
  },

  songIdOf(track: Track) {
    if (track.source !== 'qq') return null
    const mid = track.id.slice('qq:'.length)
    const id = Number(mid)
    return Number.isFinite(id) ? id : null
  },

  async loginStatus() {
    const account = await client()?.loginStatus()
    if (!account) return null
    return {
      id: account.id,
      nickname: account.nickname,
      avatarUrl: account.avatarUrl,
      // `vip: null` means "not detected", not "not a member", and the client keeps
      // the last known answer across a failed probe. Reporting null as false here
      // would let one network blip tell a paying user they are not a member.
      vip: account.vip === true,
      level: account.level ?? 0
    }
  },

  async logout() {
    await client()?.logout()
  },

  async status() {
    const status = await client()?.status()
    return status ? { ready: status.ready, detail: status.detail } : { ready: false }
  },

  async bindProfile(profileId) {
    if (!profileId) return
    await client()?.setProfile(profileId)
  }
}

export const qqProvider: OnlineMusicProvider = {
  id: 'qq',
  displayName: 'QQ 音乐',
  shortName: 'QQ 音乐',
  summary: '搜索并播放 QQ 音乐上的歌曲；高音质需要登录，付费曲目只如实显示原因',
  disclosure:
    '通过第三方逆向接口（qq-music-api）接入，仅供个人学习自用，不是官方客户端，也不提供绕过付费或会员的能力。',
  // True only in a build whose main process exposes the client. A browser preview
  // and any build made before that client landed both answer false, and the rail
  // then shows no entry rather than one that cannot work.
  available: () => client() !== null,
  capabilities: CAPABILITIES,
  collections: COLLECTIONS,
  qualityTiers: TIERS,
  getQuality: qqBackend.getQuality,
  setQuality: qqBackend.setQuality,
  backend: qqBackend,

  search: {
    search: (keywords, kind, limit) => qqBackend.search(keywords, kind, limit ?? 50)
  },

  playback: {
    streamUrl: (songId, quality) => qqBackend.streamUrl(songId, quality ?? 'exhigh'),

    /*
     * A catalogue hint, not a verdict.
     *
     * `pay.payplay === 1` says the track is *priced*, and the upstream refuses every
     * tier of a VIP track at request time with `result=104003`. That refusal is the
     * verdict, and it arrives classified from the client - so a paid track is
     * reported `unknown` + `restricted` here ("this may need a membership, the real
     * request decides") and never `unavailable`, which would claim it is gone.
     */
    getAvailability: (song) => (song.fee === 0 ? playable() : unknownAvailability('可能需要会员'))
  },

  lyrics: {
    async lyrics(songId) {
      // The client returns finished LRC text, translation already merged.
      return (await client()?.lyrics(songId)) ?? null
    }
  },

  auth: {
    loginStatus: () => qqBackend.loginStatus(),
    logout: () => qqBackend.logout(),
    accountFor: async (profileId) => {
      const account = await client()?.accountFor(profileId)
      return account
        ? {
            id: account.id,
            nickname: account.nickname,
            avatarUrl: account.avatarUrl,
            vip: account.vip === true,
            level: account.level ?? 0
          }
        : null
    }
  }
}

/**
 * A song's upstream id inside our track ids: `qq:<songmid>`.
 *
 * The platform identifies a track by `songmid`, a string, while the shared shape
 * carries one numeric id. The string rides alongside on `mid` and is what the
 * bridge is asked for, because that is the identity the upstream actually means.
 */
function trackIdFor(song: OnlineSong): string {
  const qqSong = song as QqSong
  return `qq:${qqSong.mid ?? qqSong.songmid ?? String(song.id)}`
}

export function registerQqProvider(): void {
  registerProvider(qqProvider)
}

