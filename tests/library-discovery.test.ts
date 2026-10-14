import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { countAudio, isAudioFile, pickMusicRoots } from '../electron/library-discovery-rules.ts'

/**
 * Auto-discovery decides which folders become the library on first run, so a
 * wrong answer is either an empty app or a library full of unrelated files.
 * These run against real temporary directories - the rule is about folder shape,
 * and mocking a file system would only test the mock.
 */

function scratch(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aurora-discovery-'))
}

function touch(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, 'x')
}

/**
 * Compare as sets: `readdirSync` order is not guaranteed, and a rule about which
 * folders are picked should not be sensitive to the order the OS lists them in.
 */
function sorted(values: string[]): string[] {
  return [...values].sort()
}

test('only extensions the indexer reads count as music', () => {
  assert.equal(isAudioFile('a.mp3'), true)
  assert.equal(isAudioFile('a.FLAC'), true)
  assert.equal(isAudioFile('a.ogg'), true)
  // Not music: the scanner would skip these, so discovery must too.
  assert.equal(isAudioFile('cover.jpg'), false)
  assert.equal(isAudioFile('notes.txt'), false)
  assert.equal(isAudioFile('a.mp3.bak'), false)
})

test('a curated library keeps its album folders inside one root', () => {
  const base = scratch()
  // 音乐/某专辑/01.mp3 - the album folder must NOT become a root of its own, or
  // the album is torn apart in the sidebar.
  touch(path.join(base, '专辑甲', '01.mp3'))
  touch(path.join(base, '专辑乙', '02.flac'))

  // No loose files at the top level: the music is one level down.
  const picked = pickMusicRoots([base])
  assert.deepEqual(sorted(picked), sorted([path.join(base, '专辑甲'), path.join(base, '专辑乙')]))

  fs.rmSync(base, { recursive: true, force: true })
})

test('a folder holding loose files is itself the root', () => {
  const base = scratch()
  touch(path.join(base, '01.mp3'))
  touch(path.join(base, '专辑甲', '02.mp3'))

  const picked = pickMusicRoots([base])
  assert.deepEqual(picked, [base], 'the parent wins and the album stays part of it')

  fs.rmSync(base, { recursive: true, force: true })
})

test('client folders each become their own root', () => {
  const base = scratch()
  // The shape both Netease and QQ clients create: nothing at the top level.
  touch(path.join(base, '网易云音乐', '歌手', '专辑', '01.mp3'))
  touch(path.join(base, 'QQ音乐', '歌手', '02.flac'))
  // A folder with no audio at all must not be added.
  fs.mkdirSync(path.join(base, '说明'), { recursive: true })

  const picked = pickMusicRoots([base])
  assert.deepEqual(sorted(picked), sorted([path.join(base, 'QQ音乐'), path.join(base, '网易云音乐')]))

  fs.rmSync(base, { recursive: true, force: true })
})

test('a folder with no music anywhere is not added', () => {
  const base = scratch()
  fs.mkdirSync(path.join(base, '空目录'), { recursive: true })
  touch(path.join(base, 'readme.txt'))

  assert.deepEqual(pickMusicRoots([base]), [])

  fs.rmSync(base, { recursive: true, force: true })
})

test('a missing base is skipped rather than throwing', () => {
  const base = scratch()
  const missing = path.join(base, '不存在')
  assert.deepEqual(pickMusicRoots([missing]), [])
  fs.rmSync(base, { recursive: true, force: true })
})

test('a folder already inside a picked root is not added twice', () => {
  const base = scratch()
  touch(path.join(base, '01.mp3'))
  const child = path.join(base, '专辑甲')
  touch(path.join(child, '02.mp3'))

  // Both candidates passed in: the parent covers the child.
  const picked = pickMusicRoots([base, child])
  assert.deepEqual(picked, [base], 'double-indexing the same files must not happen')

  fs.rmSync(base, { recursive: true, force: true })
})

test('counting stops early instead of walking a huge folder', () => {
  const base = scratch()
  for (let index = 0; index < 120; index += 1) {
    touch(path.join(base, `track-${String(index).padStart(3, '0')}.mp3`))
  }
  const counted = countAudio(base)
  assert.ok(counted >= 40, `expected the walk to stop at the cap, got ${counted}`)
  assert.ok(counted < 120, `expected an early stop, but it walked everything (${counted})`)

  fs.rmSync(base, { recursive: true, force: true })
})
