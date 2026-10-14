import type { RepeatMode, Track } from '../../types'

/**
 * Play-order maths, kept separate from both the store and the audio engine so
 * it can be reasoned about (and tested) on its own.
 *
 * `order` is a permutation of queue indices. With shuffle off it is the identity
 * permutation; with shuffle on it is a fixed random permutation generated once,
 * which is what makes "previous track" actually go back to the track you just
 * heard rather than to a fresh random one.
 */

export function identityOrder(length: number): number[] {
  return Array.from({ length }, (_, i) => i)
}

export function shuffledOrder(length: number, current: number): number[] {
  const order = identityOrder(length)
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[order[i], order[j]] = [order[j], order[i]]
  }
  // Keep whatever is playing in front, so enabling shuffle never interrupts it.
  const at = order.indexOf(current)
  if (at > 0) {
    order.splice(at, 1)
    order.unshift(current)
  }
  return order
}

export interface StepResult {
  index: number
  /** False when playback should stop because the queue ran out. */
  play: boolean
}

/**
 * Resolve the next queue index.
 * Returns null when there is nowhere to go and playback should halt.
 */
export function step(
  order: number[],
  current: number,
  direction: 1 | -1,
  repeat: RepeatMode
): StepResult | null {
  if (order.length === 0) return null
  if (repeat === 'one' && direction === 1) return { index: current, play: true }

  const at = order.indexOf(current)
  if (at === -1) return { index: order[0], play: true }

  const nextAt = at + direction
  if (nextAt >= 0 && nextAt < order.length) return { index: order[nextAt], play: true }

  if (repeat === 'all') {
    const wrapped = direction === 1 ? 0 : order.length - 1
    return { index: order[wrapped], play: true }
  }

  // Off the end with repeat off: stop at the end, or restart on a backwards step.
  return direction === 1 ? null : { index: order[0], play: true }
}

/** Drop indices that no longer exist, and re-point the order at `current`. */
export function reconcile(
  queue: Track[],
  order: number[],
  current: number
): { order: number[]; index: number } {
  const valid = order.filter((i) => i >= 0 && i < queue.length)
  const seen = new Set(valid)
  for (let i = 0; i < queue.length; i += 1) {
    if (!seen.has(i)) valid.push(i)
  }
  const index = current >= 0 && current < queue.length ? current : valid[0] ?? -1
  return { order: valid, index }
}
