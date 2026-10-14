import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activeLineAt, emptyLyrics, parseLrc } from '../src/lyrics/lrc.ts'

test('parses plain timestamps', () => {
  const lyrics = parseLrc('[00:12.40]第一行\n[00:18.60]第二行')
  assert.equal(lyrics.empty, false)
  assert.equal(lyrics.lines.length, 2)
  assert.equal(lyrics.lines[0].text, '第一行')
  assert.equal(lyrics.lines[0].time, 12.4)
  assert.equal(lyrics.lines[1].time, 18.6)
})

test('expands one line carrying several timestamps', () => {
  // A repeated chorus is written once in real files.
  const lyrics = parseLrc('[00:10.00][01:20.00]同一句歌词')
  assert.equal(lyrics.lines.length, 2)
  assert.deepEqual(
    lyrics.lines.map((line) => line.time),
    [10, 80]
  )
  assert.equal(lyrics.lines[0].text, '同一句歌词')
  assert.equal(lyrics.lines[1].text, '同一句歌词')
})

test('fraction digits scale by their length', () => {
  // `.5` is 500ms, `.05` is 50ms, `.005` is 5ms.
  const lyrics = parseLrc('[00:01.5]a\n[00:02.05]b\n[00:03.005]c')
  assert.deepEqual(
    lyrics.lines.map((line) => line.time),
    [1.5, 2.05, 3.005]
  )
})

test('a positive offset shifts lines earlier', () => {
  // [offset:+500] means the tags are 500ms late, so lines move 0.5s earlier.
  const lyrics = parseLrc('[offset:+500]\n[00:10.00]x')
  assert.equal(lyrics.offset, 0.5)
  assert.equal(lyrics.lines[0].time, 9.5)
})

test('a negative offset shifts lines later', () => {
  const lyrics = parseLrc('[offset:-250]\n[00:10.00]x')
  assert.equal(lyrics.offset, -0.25)
  assert.equal(lyrics.lines[0].time, 10.25)
})

test('an offset can never push a line before zero', () => {
  const lyrics = parseLrc('[offset:+90000]\n[00:10.00]x')
  assert.equal(lyrics.lines[0].time, 0)
})

test('reads metadata tags', () => {
  const lyrics = parseLrc('[ti:标题]\n[ar:艺术家]\n[al:专辑]\n[by:某人]\n[00:01.00]x')
  assert.equal(lyrics.title, '标题')
  assert.equal(lyrics.artist, '艺术家')
  assert.equal(lyrics.album, '专辑')
  assert.equal(lyrics.by, '某人')
})

test('strips enhanced word timings but keeps the text', () => {
  const lyrics = parseLrc('[00:01.00]<00:01.00>你<00:01.50>好')
  assert.equal(lyrics.lines[0].text, '你好')
})

test('sorts out-of-order lines', () => {
  const lyrics = parseLrc('[00:30.00]later\n[00:10.00]earlier')
  assert.deepEqual(
    lyrics.lines.map((line) => line.text),
    ['earlier', 'later']
  )
})

test('keeps blank lines, which are timing cues', () => {
  const lyrics = parseLrc('[00:05.00]\n[00:09.00]text')
  assert.equal(lyrics.lines.length, 2)
  assert.equal(lyrics.lines[0].text, '')
})

test('ignores lines with no timestamp', () => {
  const lyrics = parseLrc('just a stray line\n[00:01.00]real')
  assert.equal(lyrics.lines.length, 1)
  assert.equal(lyrics.lines[0].text, 'real')
})

test('empty input reports itself as empty', () => {
  assert.equal(parseLrc('').empty, true)
  assert.equal(parseLrc('\n\n').empty, true)
  assert.equal(emptyLyrics().empty, true)
  assert.deepEqual(emptyLyrics().lines, [])
})

test('activeLineAt finds the line in effect', () => {
  const { lines } = parseLrc('[00:10.00]a\n[00:20.00]b\n[00:30.00]c')

  // Before anything starts there is no active line, not line 0.
  assert.equal(activeLineAt(lines, 0), -1)
  assert.equal(activeLineAt(lines, 9.999), -1)

  // Exactly on a timestamp that line is active.
  assert.equal(activeLineAt(lines, 10), 0)
  assert.equal(activeLineAt(lines, 19.99), 0)
  assert.equal(activeLineAt(lines, 20), 1)
  assert.equal(activeLineAt(lines, 30), 2)

  // Past the end the last line stays active.
  assert.equal(activeLineAt(lines, 600), 2)
})

test('activeLineAt copes with an empty lyric', () => {
  assert.equal(activeLineAt([], 5), -1)
})
