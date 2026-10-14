/**
 * Preview harness switches.
 *
 * These exist so the browser harness can screenshot states that would otherwise
 * need a real main process. They are read at call time, default to off, and are
 * named so that nobody mistakes them for product behaviour.
 *
 * Why a shared module rather than a field on each provider: two providers need the
 * same switch, and having one import the other to reach it would create a
 * dependency between two sibling platforms that have nothing to do with each
 * other. This file imports nothing.
 */

/**
 * Makes every registered platform report itself as available.
 *
 * The browser harness has no main process, so `available()` is false for every
 * platform and the preview shows a rail with no platform sections at all. That is
 * honest, but it also means the *layout* with platforms - two peer sections, their
 * generated rows, a placeholder that names them - could only be checked by
 * temporarily editing `available()` and remembering to undo it, which is not a
 * check anyone can repeat.
 *
 * So the harness asserts it instead: set `window.__AURORA_FAKE_BACKENDS = true`
 * before the bundle runs. A shipping build never sets it, and the preview does not
 * set it unless something deliberately asks for it - so an ordinary preview still
 * tells the truth about what works.
 */
export function previewBackendsForced(): boolean {
  return typeof window !== 'undefined' && window.__AURORA_FAKE_BACKENDS === true
}
