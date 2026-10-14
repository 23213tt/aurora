import { ipcMain } from 'electron'
import { write } from '../startup-log'
import { loadSettings, saveSettings } from '../settings'
import * as client from './client'
import { describeFailure } from './reasons'
import { isNeteaseQuality, isUsableId } from './types'
import type {
  NeteaseAccount,
  NeteaseAlbum,
  NeteaseLoginResult,
  NeteasePlaylistSummary,
  NeteaseQrResult,
  NeteaseQrSession,
  NeteaseQuality,
  NeteaseSearchResult,
  NeteaseSong,
  NeteaseStatusResult,
  NeteaseStreamResult
} from './types'

/**
 * The `netease:*` channels, and the place renderer input stops being trusted.
 *
 * Everything here arrives as `unknown` from the page, so each argument is
 * checked for the shape the channel needs before it reaches the client. That is
 * not paranoia about the user: the renderer runs third-party song metadata and
 * cover images, and a wrong type that reaches the upstream package turns into a
 * confusing network error far from its cause.
 *
 * No channel rejects. A rejected `invoke` arrives in page code as an unhandled
 * rejection in the middle of a render, which for a player means a blank view
 * with no explanation; an empty result plus `netease:status` is the honest,
 * survivable failure.
 */

const MAX_KEYWORDS = 100
const MAX_IDS = 1000
const SEARCH_TYPES = ['song', 'album', 'artist'] as const
type SearchType = (typeof SEARCH_TYPES)[number]

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/**
 * Song, album, artist and playlist ids are all positive integers upstream.
 * `isUsableId` already rejects anything past the safe integer range, so this
 * only has to narrow `unknown` before handing the value over.
 */
function asId(value: unknown): number | null {
  return typeof value === 'number' && isUsableId(value) ? value : null
}

function asText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, max)
}

function asQuality(value: unknown): NeteaseQuality | null {
  return isNeteaseQuality(value) ? value : null
}

function asSearchType(value: unknown): SearchType {
  return typeof value === 'string' && (SEARCH_TYPES as readonly string[]).includes(value)
    ? (value as SearchType)
    : 'song'
}

function asIds(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const ids = value.map(asId).filter((id): id is number => id !== null)
  return Array.from(new Set(ids)).slice(0, MAX_IDS)
}

const currentQuality = (): NeteaseQuality => {
  // settings.json is a file the user can edit, so a value that is not one of
  // the four levels is possible; upstream would answer such a request with a
  // generic error rather than a useful one.
  const stored = loadSettings().neteaseQuality
  return isNeteaseQuality(stored) ? stored : 'exhigh'
}

/** The shared "something went wrong" answer for a stream that never resolved. */
const unknownStream = (): NeteaseStreamResult => ({
  ok: false,
  reason: 'unknown',
  message: describeFailure('unknown')
})

async function guard<T>(label: string, fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    const value = await run()
    // 成功路径也记（只记失败看不出是哪一步返回了空结果）。label 不含参数，避免密码进日志。
    write(`netease:${label} ok`)
    return value
  } catch (error) {
    // 上游用普通对象 reject，String() 会得到 "[object Object]"（日志里就是这么丢掉原因的）。
    const detail = (value: unknown): string => {
      if (value instanceof Error) return value.message
      if (value && typeof value === 'object') {
        const record = value as { body?: unknown; status?: unknown; message?: unknown }
        const body = record.body as { msg?: unknown; message?: unknown; code?: unknown } | undefined
        const msg = body?.msg ?? body?.message ?? record.message
        if (typeof msg === 'string' && msg) return `${msg}${body?.code !== undefined ? ` (code ${String(body.code)})` : ''}${record.status !== undefined ? ` [http ${String(record.status)}]` : ''}`
        try {
          return JSON.stringify(value).slice(0, 200)
        } catch {
          return '[unserialisable error]'
        }
      }
      return String(value)
    }
    const message = detail(error)
    write(`netease:${label} FAILED ${message}`)
    console.error(`[aurora] netease:${label} failed`, message)
    return fallback
  }
}

/**
 * Kick off the upstream bootstrap from `app.whenReady`, without awaiting it.
 *
 * `electron/main.ts` calls this fire-and-forget: the handshake only needs to be
 * finished before the user opens the online tab, and awaiting a network round
 * trip there would put the upstream's latency in front of the app's first
 * window. Failures are recorded in the client and reported by `netease:status`.
 */
export function warmUpNetease(): Promise<void> {
  return client.neteaseWarmUp()
}

export function registerNeteaseIpc(): void {
  const statusFailure: NeteaseStatusResult = { ready: false, loggedIn: false }

  /*
   * Which profile the following calls belong to.
   *
   * The session lives here and the notion of "who is using the app" lives in the
   * renderer, so the renderer has to say. Registered first because every other
   * handler below depends on it having been called at least once.
   */
  ipcMain.handle('netease:setProfile', (_event, value: unknown) => {
    const id = typeof value === 'string' ? value : ''
    return client.setActiveProfile(id)
  })

  /** The profiles screen asks about profiles that are not active. */
  ipcMain.handle('netease:accountFor', (_event, value: unknown) =>
    guard('accountFor', null, () => client.neteaseAccountFor(typeof value === 'string' ? value : ''))
  )

  ipcMain.handle('netease:logoutProfile', (_event, value: unknown) => {
    if (typeof value !== 'string') return false
    return client.neteaseLogoutProfile(value)
  })

  ipcMain.handle('netease:status', () => guard('status', statusFailure, () => client.neteaseStatus()))

  ipcMain.handle('netease:search', (_event, payload: unknown) => {
    const args = asRecord(payload)
    const keywords = asText(args.keywords, MAX_KEYWORDS)
    const type = asSearchType(args.type)
    const limit = typeof args.limit === 'number' ? args.limit : 30
    const empty: NeteaseSearchResult = { songs: [], albums: [], artists: [] }
    if (!keywords) return empty
    return guard('search', empty, () => client.neteaseSearch(keywords, type, limit))
  })

  ipcMain.handle('netease:streamUrl', (_event, payload: unknown) => {
    const args = asRecord(payload)
    const songId = asId(args.songId)
    if (songId === null) {
      return { ok: false, reason: 'unknown', message: '歌曲 ID 无效' } satisfies NeteaseStreamResult
    }
    const quality = asQuality(args.quality) ?? currentQuality()
    return guard('streamUrl', unknownStream(), () => client.neteaseStreamUrl(songId, quality))
  })

  ipcMain.handle('netease:lyrics', (_event, value: unknown) => {
    const songId = asId(value)
    if (songId === null) return null
    return guard('lyrics', null, () => client.neteaseLyrics(songId))
  })

  ipcMain.handle('netease:album', (_event, value: unknown) => {
    const id = asId(value)
    if (id === null) return null
    return guard<NeteaseAlbum | null>('album', null, () => client.neteaseAlbum(id))
  })

  ipcMain.handle('netease:artistTopSongs', (_event, payload: unknown) => {
    const args = asRecord(payload)
    const id = asId(args.id)
    const limit = typeof args.limit === 'number' ? args.limit : 50
    if (id === null) return []
    return guard<NeteaseSong[]>('artistTopSongs', [], () => client.neteaseArtistTopSongs(id, limit))
  })

  ipcMain.handle('netease:songDetail', (_event, value: unknown) => {
    const ids = asIds(value)
    if (ids.length === 0) return []
    return guard<NeteaseSong[]>('songDetail', [], () => client.neteaseSongDetail(ids))
  })

  ipcMain.handle('netease:qrCreate', () => {
    const empty: NeteaseQrSession = { key: '', url: '', imageDataUrl: '' }
    return guard('qrCreate', empty, () => client.neteaseQrCreate())
  })

  ipcMain.handle('netease:qrCheck', (_event, value: unknown) => {
    const key = asText(value, 128)
    if (!key) {
      return { status: 'failed', message: '二维码已失效，请重新获取' } satisfies NeteaseQrResult
    }
    const failed: NeteaseQrResult = { status: 'failed', message: '登录状态查询失败，请重试' }
    return guard('qrCheck', failed, () => client.neteaseQrCheck(key))
  })

  ipcMain.handle('netease:loginCellphone', (_event, payload: unknown) => {
    const args = asRecord(payload)
    const phone = typeof args.phone === 'string' ? args.phone.trim() : ''
    const password = typeof args.password === 'string' ? args.password : ''
    // Length only: the values themselves never reach a log or an error message.
    if (!/^\d{5,20}$/.test(phone) || password.length < 1 || password.length > 128) {
      return { ok: false, message: '手机号或密码格式不正确' } satisfies NeteaseLoginResult
    }
    const failed: NeteaseLoginResult = { ok: false, message: '登录失败，请重试' }
    return guard('loginCellphone', failed, () => client.neteaseLoginCellphone(phone, password))
  })

  ipcMain.handle('netease:loginStatus', () =>
    guard<NeteaseAccount | null>('loginStatus', null, () => client.neteaseLoginStatus())
  )

  ipcMain.handle('netease:logout', () => guard('logout', false, () => client.neteaseLogout()))

  ipcMain.handle('netease:myPlaylists', () =>
    guard<NeteasePlaylistSummary[]>('myPlaylists', [], () => client.neteaseMyPlaylists())
  )

  ipcMain.handle('netease:playlistTracks', (_event, value: unknown) => {
    const id = asId(value)
    if (id === null) return []
    return guard<NeteaseSong[]>('playlistTracks', [], () => client.neteasePlaylistTracks(id))
  })

  ipcMain.handle('netease:dailySongs', () =>
    guard<NeteaseSong[]>('dailySongs', [], () => client.neteaseDailySongs())
  )

  ipcMain.handle('netease:cloudSongs', () =>
    guard<NeteaseSong[]>('cloudSongs', [], () => client.neteaseCloudSongs())
  )

  ipcMain.handle('netease:likeList', () =>
    guard<NeteaseSong[]>('likeList', [], () => client.neteaseLikeList())
  )

  ipcMain.handle('netease:getQuality', () => currentQuality())

  ipcMain.handle('netease:setQuality', (_event, value: unknown) => {
    const quality = asQuality(value)
    // An unknown quality is not worth an error: the renderer's own list is the
    // only source, so this is a bug or a stale build, and either way keeping
    // the current value is better than writing nonsense into settings.
    if (!quality) return currentQuality()
    return saveSettings({ neteaseQuality: quality }).neteaseQuality
  })
}
