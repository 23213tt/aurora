/**
 * Why a Netease track will not play, and what the user is told about it.
 *
 * Upstream answers almost every refusal with the same shape - `url: null` - so
 * the tempting shortcut is to call all of them "已下架". That is wrong in a way
 * the user feels: a VIP track, a track that needs a login, a track that is not
 * licensed here and a track that really is gone are four different problems,
 * and only one of them is fixed by trying again. This module is the single
 * place that tells them apart.
 *
 * It is deliberately dependency-free - no electron, no upstream package, no
 * `%TEMP%` files, no network - because the mapping is the part worth testing
 * and a test runner has none of those. Do not add an import here.
 *
 * Rules are evaluated in a fixed order and the first match wins; the order is
 * itself part of the behaviour, because upstream happily returns a body code
 * *and* a per-track code that disagree.
 */

export type NeteaseFailureReason =
  | 'login-required'
  | 'vip-required'
  | 'region-limited'
  | 'trial-only'
  | 'taken-down'
  | 'network'
  | 'rate-limited'
  | 'service-unavailable'
  | 'unknown'

export interface StreamFailureInput {
  /** Envelope `body.code`; null when there was no usable response. */
  code?: number | null
  /** Per-track `body.data[0].code`. */
  songCode?: number | null
  /** Per-track `body.data[0].url`; null or empty means nothing playable. */
  url?: string | null
  /** `body.data[0].freeTrialInfo`; a non-empty object marks a trial fragment. */
  freeTrialInfo?: unknown
  /** Upstream `fee`: 0 free, 1 VIP, 4 paid album, 8 low-quality free. */
  fee?: number | null
  /** Whether a session cookie exists - it changes what a refusal means. */
  loggedIn?: boolean
  /** The rejection, when the call itself threw. */
  error?: unknown
}

/**
 * Upstream codes, from the observed behaviour of `song_url_v1` and friends:
 * 301/-447 want a login, -128 wants a membership, 403 is a licence refusal
 * (region or copyright), 404 is gone, -460 is the anti-abuse bucket, 429 is a
 * plain rate limit and 5xx is the service being unwell.
 */
export function classifyStreamFailure(input: StreamFailureInput): NeteaseFailureReason {
  // A thrown call never reached the track: it is the transport talking - unless
  // the throw *is* the upstream's verdict. The package signals every non-200
  // answer by rejecting with the decoded envelope, so an error carrying a code
  // is a real refusal and is classified like any other.
  if (input.error) {
    if (httpStatusOf(input.error) === 429) return 'rate-limited'
    const embedded = envelopeCodeOf(input.error)
    if (embedded !== null) return classifyStreamFailure({ ...input, error: null, code: embedded })
    return 'network'
  }

  const code = numberOrNull(input.code)
  const songCode = numberOrNull(input.songCode)
  const fee = numberOrNull(input.fee) ?? 0
  const loggedIn = Boolean(input.loggedIn)
  const playable = typeof input.url === 'string' && input.url.length > 0
  const trial = isPresent(input.freeTrialInfo)

  if (code === 429 || code === -460) return 'rate-limited'
  if (code === 301 || code === -447) return 'login-required'
  if (code === -128) return 'vip-required'
  // 502 is the package's own marker for "the HTTP call itself failed", so it
  // describes the network rather than the service being unwell.
  if (code === 502) return 'network'
  if (code !== null && code >= 500) return 'service-unavailable'
  // 403 is "no licence for you" - but for a signed-out user the honest answer
  // is still "sign in first", because that is the actionable one.
  if (code === 403) return loggedIn ? 'region-limited' : 'login-required'
  if (code === -110) return 'region-limited'
  if (code === 404) return 'taken-down'

  if (playable) {
    // The caller hands a trial fragment to the player and flags it; reaching
    // here means it decided the fragment was not worth offering.
    return trial ? 'trial-only' : 'unknown'
  }

  if (trial) return 'trial-only'

  // Nothing playable and no code to go on. `fee` is the only remaining signal,
  // and it is a good one: 1 and 4 are paywalled by definition.
  if (fee === 1 || fee === 4) return loggedIn ? 'vip-required' : 'login-required'
  if (songCode === 404 || songCode === -200) return 'taken-down'
  // A 200 with an empty url and a free, unremarkable track: upstream has the
  // metadata but serves no stream, which is what a delisted track looks like.
  if (code === 200 || code === null) return 'taken-down'

  return 'unknown'
}

/**
 * The one place the user-facing wording lives.
 *
 * The renderer shows these verbatim, so a second copy of the strings there
 * would eventually contradict this one.
 */
export function describeFailure(reason: NeteaseFailureReason): string {
  switch (reason) {
    case 'login-required':
      return '这首歌需要登录网易云账号后才能播放'
    case 'vip-required':
      return '这首歌需要网易云会员。Aurora 不提供绕过付费的能力'
    case 'region-limited':
      return '这首歌在当前地区没有播放授权'
    case 'trial-only':
      return '这首歌只能试听片段，完整播放需要会员'
    case 'taken-down':
      return '这首歌已下架，或版权方停止了授权'
    case 'network':
      return '连不上网易云，请检查网络后重试'
    case 'rate-limited':
      return '请求太频繁了，网易云暂时限流，请稍后再试'
    case 'service-unavailable':
      return '网易云接口暂时不可用，请稍后再试'
    case 'unknown':
      return '无法播放这首歌，原因未知'
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isPresent(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  return Object.keys(value).length > 0
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

/**
 * The code inside a thrown upstream envelope (`{status, body:{code}, cookie}`).
 *
 * `util/request.js` rejects rather than resolves for any answer whose code is
 * not 200, so this is how a "not available" reaches the caller. Kept separate
 * so the classifier can tell that shape apart from a genuine transport error,
 * which carries no code at all.
 */
export function envelopeCodeOf(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const body = (error as { body?: unknown }).body
  if (body && typeof body === 'object') {
    const code = numberOrNull((body as { code?: unknown }).code)
    if (code !== null) return code
  }
  return numberOrNull((error as { code?: unknown }).code)
}
