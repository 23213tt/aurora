import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ALPHA_STEPS, buildColorTable } from '../src/stage/colors.ts'

const PALETTE = ['#7d8899', '#9aa5b5', '#d4574f', '#4f9d76']

test('builds every alpha step for every palette colour', () => {
  const table = buildColorTable(PALETTE)
  assert.equal(table.colorCount, PALETTE.length)
  assert.equal(table.rgba.length, PALETTE.length * (ALPHA_STEPS + 1))
  assert.equal(table.builds, table.rgba.length)
})

test('lookups never build a string', () => {
  /*
   * The invariant the frame loop depends on: `get` is a lookup, not a format.
   * It is asserted through the table's own build counter rather than through
   * identity, because `===` on two separately built strings is still true when
   * their contents match - it cannot tell a cache hit from a rebuild. If a future
   * edit moved formatting back into `get`, the counter would climb.
   */
  const table = buildColorTable(PALETTE)
  const before = table.builds
  for (let i = 0; i < 20000; i += 1) {
    table.get(i % 4, (i % 997) / 997)
  }
  assert.equal(table.builds, before)
  assert.equal(table.rgba.length, before)
})

test('the same colour and alpha always return the same table entry', () => {
  const table = buildColorTable(PALETTE)
  const first = table.get(2, 0.42)
  for (let i = 0; i < 100; i += 1) assert.equal(table.get(2, 0.42), first)
  // ...and that entry is literally an element of the table.
  assert.ok(table.rgba.includes(first))
})

test('alpha is quantised to the table resolution, and that error is under half a step', () => {
  const table = buildColorTable(['#7d8899'])
  const step = 1 / ALPHA_STEPS
  // Two alphas inside one step collapse onto the same string: that is the
  // quantisation, and it is what makes the cache hit at all.
  assert.equal(table.get(0, 0.5), table.get(0, 0.5 + step / 3))
  // One step apart is a different string.
  assert.notEqual(table.get(0, 0.5), table.get(0, 0.5 + step * 1.5))
  // And the worst-case error is half a step, i.e. under one 8-bit level.
  assert.ok(step / 2 < 1 / 255)
})

test('clamps out-of-range alpha instead of producing an invalid colour', () => {
  const table = buildColorTable(['#7d8899'])
  assert.equal(table.get(0, -3), table.rgba[0])
  assert.equal(table.get(0, 12), table.rgba[ALPHA_STEPS])
  assert.match(table.get(0, -3), /^rgba\(125,136,153,0\.000\)$/)
})

test('wraps the colour index and survives an empty palette', () => {
  const table = buildColorTable(PALETTE)
  // Ribbons and motes index with `i % colours.length` in the caller's terms;
  // the wrap lives here so a stale index can never hand the canvas `undefined`.
  assert.equal(table.get(PALETTE.length, 0.5), table.get(0, 0.5))
  assert.equal(table.get(9, 0.5), table.get(1, 0.5))
  const empty = buildColorTable([])
  assert.equal(empty.colorCount, 1)
  assert.match(empty.get(0, 0.5), /^rgba\(255,255,255,0\.500\)$/)
})

test('a new palette is a new table, and colours stay with their own index', () => {
  const first = buildColorTable(['#ff0000', '#00ff00'])
  const second = buildColorTable(['#0000ff'])
  assert.match(first.get(0, 1), /^rgba\(255,0,0,1\.000\)$/)
  assert.match(first.get(1, 1), /^rgba\(0,255,0,1\.000\)$/)
  assert.match(second.get(0, 1), /^rgba\(0,0,255,1\.000\)$/)
  // Rebuilding for the same palette produces equal values...
  assert.equal(buildColorTable(['#ff0000']).get(0, 1), first.get(0, 1))
})
