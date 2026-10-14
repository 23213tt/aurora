/**
 * Version comparison, with no Electron dependency so it can be tested directly.
 *
 * Release tags are not reliably well-formed: they arrive as `v1.2.3`, `1.2.3`,
 * `1.2`, or `1.2.3-beta.1`. This treats anything after the first `-` as a
 * pre-release marker and compares only the numeric triple, which is the right
 * call for "is there something newer to tell the user about" - a beta tag should
 * not outrank the release it precedes.
 */

export function parseVersion(value: string): number[] {
  return value
    .trim()
    .replace(/^v/i, '')
    .split('-')[0]
    .split('.')
    .map((part) => {
      const parsed = Number.parseInt(part, 10)
      return Number.isFinite(parsed) ? parsed : 0
    })
}

/** True when `candidate` is a strictly newer release than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate)
  const b = parseVersion(current)
  for (let i = 0; i < 3; i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left > right
  }
  return false
}
