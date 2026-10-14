import type { NeteaseFailureReason, NeteaseQuality, NeteaseStream } from '../env'

/**
 * Quality arithmetic and failure wording: pure, no store, no network.
 *
 * Kept apart from the store so the two questions the interface actually asks -
 * "was I served a lower quality than I asked for" and "what do I tell the user
 * about this failure" - can be tested and read on their own.
 */

/** Ascending. The upstream names, in the order the upstream ranks them. */
export const QUALITY_ORDER: NeteaseQuality[] = ['standard', 'higher', 'exhigh', 'lossless']

export const QUALITY_LABEL: Record<NeteaseQuality | 'hires', string> = {
  standard: '标准 128k',
  higher: '较高 192k',
  exhigh: '极高 320k',
  lossless: '无损 FLAC',
  hires: 'Hi-Res'
}

/** `hires` sits above the four selectable tiers, hence the explicit case. */
export function qualityRank(level: NeteaseQuality | 'hires'): number {
  const at = QUALITY_ORDER.indexOf(level as NeteaseQuality)
  return at === -1 ? QUALITY_ORDER.length : at
}

/**
 * Whether the delivered stream is below what was asked for.
 *
 * The upstream never refuses a high request - it hands back the best it can
 * serve for this account and track, which may be a lower tier or a trial
 * fragment. That is reported, not retried: asking again cannot produce a tier
 * the account is not entitled to, so a retry loop here would only add load and
 * latency. `stream.trial` is a separate axis and is surfaced on its own.
 */
export function isFallback(level: NeteaseQuality | 'hires', requested: NeteaseQuality): boolean {
  return qualityRank(level) < qualityRank(requested)
}

/**
 * Whether asking again is worth anything.
 *
 * Server-side and account-side refusals are final for this session; network
 * faults, rate limits and a backend that has not bootstrapped yet are not.
 */
export function isTransient(reason: NeteaseFailureReason): boolean {
  return reason === 'network' || reason === 'rate-limited' || reason === 'service-unavailable'
}

/**
 * One line per failure reason.
 *
 * The whole point of the failure taxonomy is that a signed-out user and a user
 * without the right subscription must not be shown the same sentence: "已下架"
 * for a VIP track sends people looking for a legal problem that does not exist.
 */
export function failureText(reason: NeteaseFailureReason): string {
  switch (reason) {
    case 'login-required':
      return '这首歌需要登录后才能获取播放地址'
    case 'vip-required':
      return '这首歌需要会员，当前账号没有权限'
    case 'region-limited':
      return '这首歌在你所在地区没有版权'
    case 'trial-only':
      return '只能试听片段，完整版需要会员'
    case 'taken-down':
      return '这首歌已下架或没有版权'
    case 'network':
      return '网络请求失败，请检查连接后重试'
    case 'rate-limited':
      return '请求太频繁了，稍等一下再试'
    case 'service-unavailable':
      return '网易云接口暂时不可用'
    default:
      return '播放失败，原因未知'
  }
}

/**
 * Seconds -> `3:07`, for rows the upstream shortened to a trial fragment.
 *
 * Zero is a real time point, not a missing one: a free trial almost always runs
 * from 0. Only a negative or non-finite value means "unknown".
 */
export function shortDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
  const total = Math.round(seconds)
  const min = Math.floor(total / 60)
  const sec = total % 60
  return `${min}:${String(sec).padStart(2, '0')}`
}

/** The UI's one-line description of a resolved stream. */
export function streamSummary(stream: NeteaseStream, requested: NeteaseQuality): string {
  const parts = [QUALITY_LABEL[stream.level]]
  if (stream.br > 0) parts.push(`${stream.br}kbps`)
  if (stream.trial) {
    parts.push(
      stream.trialFrom !== undefined && stream.trialTo !== undefined
        ? `试听 ${shortDuration(stream.trialFrom)}–${shortDuration(stream.trialTo)}`
        : '试听片段'
    )
  } else if (isFallback(stream.level, requested)) {
    parts.push(`低于所选 ${QUALITY_LABEL[requested]}，上游没有更高档`)
  }
  return parts.join(' · ')
}
