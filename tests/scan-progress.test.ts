import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ScanProgress } from '../electron/pure/scan-progress.ts'

/*
 * The scan-progress throttle is the one place where a mistake is invisible in
 * development and obvious to a user: a dropped trailing frame leaves the bar
 * frozen, and a missing immediate delivery makes a finished scan report 97%
 * forever. Both are asserted here rather than checked by eye.
 *
 * The module takes its transport by injection, so it is imported without
 * `electron` - which under bare Node cannot be imported with named ESM exports.
 */
const { sendProgress, resetProgressThrottle, configureProgressTransport, mainWindowVisibility } =
  await import('../electron/pure/scan-progress.ts')

function progress(patch: Partial<ScanProgress> = {}): ScanProgress {
  return { phase: 'reading', found: 0, scanned: 0, cached: 0, current: '', ...patch }
}

function collector() {
  const sent: ScanProgress[] = []
  configureProgressTransport({ send: (next) => sent.push(next) })
  return sent
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 160))

test('the phase change goes out immediately, before any file is indexed', () => {
  resetProgressThrottle()
  const sent = collector()

  // Same shape the scanner reports when the walk ends: still 0 scanned.
  sendProgress(progress({ phase: 'reading', found: 5000, current: '' }))

  assert.equal(sent.length, 1, 'the "reading" transition must not wait for the timer')
  assert.equal(sent[0].phase, 'reading')
  resetProgressThrottle()
})

test('a burst of per-file reports collapses to the first and the last', async () => {
  resetProgressThrottle()
  const sent = collector()

  sendProgress(progress({ phase: 'walking' }))
  const before = sent.length
  // 5,000 files, as fast as the disk allows: the realistic shape of a scan.
  for (let i = 1; i <= 5000; i += 1) {
    sendProgress(progress({ phase: 'walking', found: i }))
  }
  await settle()

  assert.equal(before, 1, 'the first report is the leading edge and must go out')
  assert.equal(sent.length, 2, 'one leading report plus one trailing report, not 5,001')
  assert.equal(sent[1].found, 5000, 'the trailing report must be the newest state, not a dropped one')
  resetProgressThrottle()
})

test('the trailing report always delivers the newest state', async () => {
  resetProgressThrottle()
  const sent = collector()

  sendProgress(progress({ phase: 'reading' }))
  sendProgress(progress({ phase: 'reading', found: 100, scanned: 10, current: 'a.flac' }))
  sendProgress(progress({ phase: 'reading', found: 100, scanned: 11, current: 'b.flac' }))

  assert.equal(sent.length, 1, 'inside the window nothing is delivered synchronously')
  await settle()

  assert.equal(sent.length, 2, 'both coalesced reports arrive as one')
  assert.equal(sent[1].scanned, 11, 'the value that reaches the renderer is the last one reported')
  assert.equal(sent[1].current, 'b.flac')
  resetProgressThrottle()
})

test('done is delivered regardless of how recently anything was sent', () => {
  resetProgressThrottle()
  const sent = collector()

  sendProgress(progress({ phase: 'walking' }))
  // Well inside the throttle window, and it is the report that must not wait.
  sendProgress(progress({ phase: 'done', found: 10, scanned: 10 }))

  assert.equal(sent.length, 2)
  assert.equal(sent[1].phase, 'done')
  resetProgressThrottle()
})

test('the trailing report survives a scan that ends inside one window', async () => {
  resetProgressThrottle()
  const sent = collector()

  sendProgress(progress({ phase: 'reading' }))
  sendProgress(progress({ phase: 'reading', scanned: 40, found: 100 }))
  await settle()

  const last = sent[sent.length - 1]
  assert.equal(last.scanned, 40, 'a stalled-looking 0% must be corrected once the window closes')
  resetProgressThrottle()
})

test('reports spaced further apart than the window are not delayed', async () => {
  resetProgressThrottle()
  const sent = collector()

  sendProgress(progress({ phase: 'reading', scanned: 1 }))
  await settle()
  sendProgress(progress({ phase: 'reading', scanned: 2 }))

  assert.equal(sent.length, 2)
  assert.equal(sent[1].scanned, 2, 'an already-open window must not add latency')
  resetProgressThrottle()
})

test('a second scan is not suppressed by the first one\'s values', () => {
  resetProgressThrottle()
  const sent = collector()

  sendProgress(progress({ phase: 'walking', found: 3 }))
  sendProgress(progress({ phase: 'reading', found: 3, scanned: 3 }))
  sendProgress(progress({ phase: 'done', found: 3, scanned: 3 }))
  const afterFirst = sent.length

  sendProgress(progress({ phase: 'walking', found: 1 }))

  assert.equal(sent.length, afterFirst + 1, 'a new scan reports its walking phase immediately')
  assert.equal(sent[sent.length - 1].phase, 'walking')
  resetProgressThrottle()
})

test('no transport configured is not an error', () => {
  resetProgressThrottle()
  assert.doesNotThrow(() => sendProgress(progress({ phase: 'walking' })))
  resetProgressThrottle()
})

/*
 * Visibility is what the renderer uses to stop visual work, so the two cases
 * that must never be treated as hidden are pinned here.
 */
test('a destroyed or absent window is hidden, not running', () => {
  assert.equal(mainWindowVisibility(null).hidden, true)
  const destroyed = { isDestroyed: () => true } as never
  assert.equal(mainWindowVisibility(destroyed).hidden, true)
})

test('a minimised window counts as hidden even though it is still visible to Electron', () => {
  const window = {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => true
  } as never

  const state = mainWindowVisibility(window)
  assert.equal(state.minimized, true)
  assert.equal(state.hidden, true, 'a minimised window composites nothing worth rendering')
  assert.equal(state.visible, false)
})

test('a visible window stays visible: blur and occlusion are not hidden', () => {
  const window = {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false
  } as never

  assert.deepEqual(mainWindowVisibility(window), { visible: true, minimized: false, hidden: false })
})
