import { app } from 'electron'
import path from 'node:path'
import { pickMusicRoots } from './library-discovery-rules'

/**
 * Where to look for music already on this machine.
 *
 * The library used to start empty and stay empty until the user found the "add
 * folder" button. For an app whose whole point is playing what you already have,
 * that is the wrong first impression - it looks like it did not work - so the
 * first run looks in the places music actually lands and adds what it finds.
 *
 * The decision of *which* folders to keep lives in `library-discovery-rules.ts`,
 * which has no Electron dependency and is covered by tests. This file only knows
 * the OS paths.
 */

export { pickMusicRoots }

/**
 * Candidates, most likely first.
 *
 * Boring on purpose: the OS music folder first (where someone who uses several
 * players keeps everything), then the two names Windows uses for it in a
 * localized profile, then the places a download actually lands.
 */
export function candidateBases(): string[] {
  const home = app.getPath('home')
  const bases = [app.getPath('music')]
  for (const name of ['Music', '音乐']) bases.push(path.join(home, name))
  bases.push(app.getPath('downloads'), app.getPath('documents'))

  // De-duplicate without reordering: the first hit should win.
  return Array.from(new Set(bases.map((base) => path.resolve(base))))
}

/** The folders this machine should start with. Never throws; empty is valid. */
export function discoverMusicFolders(): string[] {
  try {
    return pickMusicRoots(candidateBases())
  } catch (error) {
    console.error('[aurora] music auto-discovery failed', error)
    return []
  }
}
