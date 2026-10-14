import { ipcMain } from 'electron'
import { write } from '../startup-log'
import * as client from './client'
import { describeFailure } from './reasons'
import { isQqQuality } from './types'
import type {
  QqAccount,
  QqQuality,
  QqQrResult,
  QqQrSession,
  QqSearchResult,
  QqStatusResult,
  QqStreamResult
} from './types'

/**
 * The `qq:*` channels, and the place renderer input stops being trusted.
 *
 * Everything arrives as `unknown` from the page, so each argument is checked for
 * the shape its channel needs before it reaches the client. The ids are the
 * interesting case: QQ's playback identity is a `songmid` *string* while the
 * shared render shape is numeric, so both are accepted and the client resolves
 * whichever it gets.
 *
 * No channel rejects. A rejected `invoke` arrives in page code as an unhandled
 * rejection in the middle of a render, which for a player means a blank view
 * with no explanation; an empty result plus `qq:status` is the honest,
 * survivable failure.
 */

const MAX_KEYWORDS = 100
const MAX_SONGMID = 64
const SEARCH_TYPES = ['song', 'album', 'artist'] as const
type SearchType = (typeof SEARCH_TYPES)[number]

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}

/**
 * A song identifier: either the `songmid` string or the numeric `songid`.
 *
 * Both are accepted because the renderer's shared shape carries the numeric id
 * while the play route needs the mid - passing through whichever the page has is
 * what lets one of them work rather than neither.
 */
function asSongId(value: unknown): string | number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed || trimmed.length > MAX_SONGMID) return null
    // A songmid is alphanumeric; a numeric string is a songid. Anything else
    // (spaces, punctuation, a URL) is not an identifier at all.
    return /^[A-Za-z0-9]+$/.test(trimmed) ? trimmed : null
  }
  return null
}

function asText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return trimmed.slice(0, max)
}

function asQuality(value: unknown): QqQuality | null {
  return isQqQuality(value) ? value : null
}

function asSearchType(value: unknown): SearchType {
  return typeof value === 'string' && (SEARCH_TYPES as readonly string[]).includes(value)
    ? (value as SearchType)
    : 'song'
}

async function guard<T>(label: string, fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    const value = await run()
    // 成功路径也记：失败时返回空结果与抛错在界面上一模一样。
    write(`qq:${label} ok`)
    return value
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    write(`qq:${label} FAILED ${message}`)
    console.error(`[aurora] qq:${label} failed`, message)
    return fallback
  }
}


export function registerQqIpc(): void {
  const statusFailure: QqStatusResult = { ready: false, loggedIn: false }

  ipcMain.handle('qq:setProfile', (_event, value: unknown) => {
    const id = asText(value, 64)
    if (!id) return false
    return client.setActiveProfile(id)
  })

  ipcMain.handle('qq:accountFor', (_event, value: unknown) => {
    const id = asText(value, 64)
    if (!id) return null
    return guard<QqAccount | null>('accountFor', null, () => client.qqAccountFor(id))
  })

  ipcMain.handle('qq:logoutProfile', (_event, value: unknown) => {
    const id = asText(value, 64)
    if (!id) return false
    return client.qqLogoutProfile(id)
  })

  ipcMain.handle('qq:status', () => guard('status', statusFailure, () => client.qqStatus()))

  ipcMain.handle('qq:search', (_event, payload: unknown) => {
    const args = asRecord(payload)
    const keywords = asText(args.keywords, MAX_KEYWORDS)
    const type = asSearchType(args.type)
    const limit = typeof args.limit === 'number' ? args.limit : 50
    const empty: QqSearchResult = { songs: [], albums: [], artists: [] }
    if (!keywords) return empty
    return guard('search', empty, () => client.qqSearch(keywords, type, limit))
  })

  ipcMain.handle('qq:streamUrl', (_event, payload: unknown) => {
    const args = asRecord(payload)
    const songId = asSongId(args.songId)
    if (songId === null) {
      return { ok: false, reason: 'unknown', message: '歌曲编号无效' } satisfies QqStreamResult
    }
    // The tier is optional: the client falls back to the profile's saved
    // preference, so a renderer that has not read it yet still gets an answer.
    const quality = asQuality(args.quality)
    const unknown: QqStreamResult = {
      ok: false,
      reason: 'unknown',
      message: describeFailure('unknown')
    }
    return guard('streamUrl', unknown, () => client.qqStreamUrl(songId, quality ?? undefined))
  })

  ipcMain.handle('qq:lyrics', (_event, value: unknown) => {
    const songId = asSongId(value)
    if (songId === null) return null
    return guard('lyrics', null, () => client.qqLyrics(songId))
  })

  ipcMain.handle('qq:qrCreate', () => {
    const empty: QqQrSession = { key: '', imageDataUrl: '' }
    return guard('qrCreate', empty, () => client.qqQrCreate())
  })

  ipcMain.handle('qq:qrCheck', (_event, value: unknown) => {
    const key = asText(value, 128)
    if (!key) {
      return { status: 'failed', message: '二维码已失效，请重新获取' } satisfies QqQrResult
    }
    const failed: QqQrResult = { status: 'failed', message: '登录状态查询失败，请重试' }
    return guard('qrCheck', failed, () => client.qqQrCheck(key))
  })

  ipcMain.handle('qq:loginStatus', () =>
    guard<QqAccount | null>('loginStatus', null, () => client.qqLoginStatus())
  )

  ipcMain.handle('qq:logout', () => guard('logout', false, () => client.qqLogout()))

  ipcMain.handle('qq:getQuality', () => client.qqGetQuality())

  ipcMain.handle('qq:setQuality', (_event, value: unknown) => {
    const quality = asQuality(value)
    // An unknown tier is not worth an error: the renderer's own list is the only
    // source, so this is a bug or a stale build, and either way keeping the
    // current value beats writing nonsense into the profile.
    if (!quality) return client.qqGetQuality()
    return client.qqSetQuality(quality)
  })
}
