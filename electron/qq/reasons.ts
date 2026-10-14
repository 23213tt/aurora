import type { NeteaseFailureReason } from '../netease/reasons'

/**
 * Why a QQ Music track will not play, and what the user is told about it.
 *
 * The **vocabulary** is shared with Netease on purpose - the renderer renders
 * one set of reasons for every platform - so the union is imported as a type
 * and re-exported rather than redeclared. The **wording** is not shared: the
 * Netease messages name Netease, and a QQ user must not be told to check their
 * Netease account. Keeping the words here also keeps this module free of
 * runtime imports, which is what lets a Node test load it (see below).
 *
 * Why it must not collapse into "已下架": mainstream QQ tracks are almost all
 * paywalled, so the common case is a *restricted* track, and the answer to
 * "restricted" is "sign in" or "buy a membership" - not "this song is gone".
 * Folia states the same rule in its own contract (`state 'unavailable'` may
 * only pair with `'taken-down'`; permission and payment limits are `'unknown'`
 * plus `'restricted'`, decided at request time).
 *
 * This file imports nothing at runtime, so `node --test` can load it directly.
 * Do not add an import here.
 */

export type QqFailureReason = NeteaseFailureReason

export interface QqStreamFailureInput {
  /** The rejection, when the call itself threw (transport level). */
  error?: unknown
  /** `req_0.code` / `body.response.code` - the request-level verdict. */
  code?: number | null
  /**
   * `midurlinfo[].result` - the per-song verdict, and the only field that
   * decides whether *this* track can be played. `104003` is the paywalled code
   * observed against the live service.
   */
  result?: number | null
  /** The playable path upstream handed back; empty when it refused. */
  purl?: string | null
  /**
   * The search-stage hint (`pay.payplay === 1`).
   *
   * Used **only as a tiebreaker** when the vkey request refuses without saying
   * why. Mineradio's lesson is exactly this: upstream field names and shapes
   * change, so no single field may be the whole verdict - but a hint plus a
   * refusal is better evidence than a refusal alone.
   */
  paidHint?: boolean
  /** Whether a session cookie exists; it changes what a refusal means. */
  loggedIn?: boolean
}

/**
 * QQ's observed codes:
 *   - `1000`   not signed in (a bogus or absent cookie; verified live)
 *   - `104003` paywalled: the track needs a membership, or a login first
 *   - `502`    the package's own marker for "the HTTP call itself failed"
 *   - `429`    a plain rate limit
 * Anything else is reported as unknown *with the code in the message* rather
 * than guessed into a bucket.
 */
export function classifyStreamFailure(input: QqStreamFailureInput): QqFailureReason {
  // Total by construction. TypeScript callers always pass an object, but this
  // module is also loaded by tests and by plain JavaScript, and a classifier
  // that throws on a missing argument would turn "we do not know" into a crash
  // in the one place that exists to avoid saying the wrong thing.
  const failure: QqStreamFailureInput = input ?? {}

  if (failure.error) {
    return httpStatusOf(failure.error) === 429 ? 'rate-limited' : 'network'
  }

  const code = numberOrNull(failure.code)
  const result = numberOrNull(failure.result)
  const loggedIn = Boolean(failure.loggedIn)
  const playable = typeof failure.purl === 'string' && failure.purl.length > 0
  const restricted = () => (loggedIn ? 'vip-required' : 'login-required')

  if (code === 429) return 'rate-limited'
  // The package reports a failed HTTP call as its own 502 envelope.
  if (code === 502) return 'network'
  // Verified live: the account endpoint answers 1000 for a bogus or missing
  // cookie, which is the one code that reliably means "sign in".
  if (code === 1000) return 'login-required'
  if (code !== null && code >= 500) return 'service-unavailable'

  if (playable) {
    // Unreachable from the client, which treats a non-empty purl as success.
    return 'unknown'
  }

  // The per-song verdict wins when it is present.
  if (result === 104003) return restricted()
  /*
   * 101404 is "there is no such file name", verified live: it is exactly what
   * upstream answers when a numeric `songid` is handed to the vkey route, which
   * is built from `songmid`. It must be answered *before* the pay hint, because
   * an unresolvable identifier is a client-side problem and reporting it as
   * "needs a membership" would send the user to buy something they may already
   * have.
   */
  if (result === 101404) return 'unknown'
  if (result !== null && result !== 0) {
    // An unobserved refusal code: the pay hint decides, otherwise admit we do
    // not know. Both are better than inventing a meaning for the number.
    return failure.paidHint ? restricted() : 'unknown'
  }

  // No verdict and nothing playable. The hint is all that is left.
  if (failure.paidHint) return restricted()
  return 'unknown'
}

/**
 * The one place QQ's user-facing wording lives. The renderer shows these
 * verbatim.
 */
export function describeFailure(reason: QqFailureReason): string {
  switch (reason) {
    case 'login-required':
      return '这首歌需要登录 QQ 音乐账号后才能播放'
    case 'vip-required':
      return '这首歌需要 QQ 音乐会员。Aurora 不提供绕过付费的能力'
    case 'region-limited':
      return '这首歌在当前地区没有播放授权'
    case 'trial-only':
      return '这首歌只能试听片段，完整播放需要会员'
    case 'taken-down':
      return '这首歌已下架，或版权方停止了授权'
    case 'network':
      return '连不上 QQ 音乐，请检查网络后重试'
    case 'rate-limited':
      return '请求太频繁了，QQ 音乐暂时限流，请稍后再试'
    case 'service-unavailable':
      return 'QQ 音乐接口暂时不可用，请稍后再试'
    case 'unknown':
      return '无法播放这首歌，原因未知'
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Axios puts the status on `response.status`; our own fetch errors use `status`. */
function httpStatusOf(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const direct = numberOrNull((error as { status?: unknown }).status)
  if (direct !== null) return direct
  const response = (error as { response?: unknown }).response
  if (response && typeof response === 'object') {
    return numberOrNull((response as { status?: unknown }).status)
  }
  return null
}
