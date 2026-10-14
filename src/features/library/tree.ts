import type { Track } from '../../types'

/**
 * Folder hierarchy for the "by directory" view.
 *
 * Built from track paths rather than by walking the disk again: the scanner
 * already visited every file, and a second walk could disagree with the index
 * (a folder added between scans, an unreadable subdirectory). Deriving the tree
 * from the tracks guarantees the view shows exactly what the library holds.
 */

export interface FolderNode {
  /** Absolute directory path; also the React key and expansion-state key. */
  path: string
  /** Last path segment, or the drive/root label for a root node. */
  name: string
  /** Files directly in this folder. */
  directCount: number
  /** Files in this folder and everything below it. */
  totalCount: number
  children: FolderNode[]
}

interface MutableNode {
  path: string
  name: string
  directCount: number
  totalCount: number
  children: Map<string, MutableNode>
}

function labelFor(dirPath: string): string {
  const parts = dirPath.split(/[\\/]/).filter(Boolean)
  if (parts.length === 0) return dirPath
  // "C:" alone is the whole drive; make that read as a drive, not a letter.
  const last = parts[parts.length - 1]
  return /^[a-zA-Z]:$/.test(last) ? `${last}\\` : last
}

export function buildFolderTree(tracks: Track[]): FolderNode[] {
  const roots = new Map<string, MutableNode>()

  for (const track of tracks) {
    const directory = track.path.replace(/[\\/][^\\/]*$/, '')
    if (!directory || directory === track.path) continue

    const segments = directory.split(/[\\/]/).filter(Boolean)
    if (segments.length === 0) continue

    // The first segment is the root: a drive on Windows, "" then a name on POSIX.
    const rootKey = /^[a-zA-Z]:$/.test(segments[0])
      ? segments[0]
      : `${segments[0] === '' ? '/' : ''}${segments[0]}`

    let node = roots.get(rootKey)
    if (!node) {
      node = {
        path: rootKey,
        name: labelFor(rootKey),
        directCount: 0,
        totalCount: 0,
        children: new Map()
      }
      roots.set(rootKey, node)
    }

    let current = node
    current.totalCount += 1

    for (let i = 1; i < segments.length; i += 1) {
      const childPath = `${current.path}${current.path.endsWith('\\') || current.path.endsWith('/') ? '' : '\\'}${segments[i]}`
      let child = current.children.get(childPath)
      if (!child) {
        child = {
          path: childPath,
          name: segments[i],
          directCount: 0,
          totalCount: 0,
          children: new Map()
        }
        current.children.set(childPath, child)
      }
      child.totalCount += 1
      current = child
    }

    current.directCount += 1
  }

  const finalise = (node: MutableNode): FolderNode => ({
    path: node.path,
    name: node.name,
    directCount: node.directCount,
    totalCount: node.totalCount,
    // Folders with content first, then alphabetically: the useful end of a
    // music tree is where the files actually are.
    children: [...node.children.values()]
      .map(finalise)
      .sort((a, b) => b.totalCount - a.totalCount || a.name.localeCompare(b.name, 'zh-Hans-CN'))
  })

  return [...roots.values()]
    .map(finalise)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
}

/**
 * Every track at or below a folder path, in library order.
 *
 * The comparison requires a trailing separator. Matching on the bare prefix
 * would make "C:\Music" also match "C:\Music2", so playing a folder would pull
 * in every sibling folder whose name merely starts the same way.
 */
export function tracksUnder(tracks: Track[], folderPath: string): Track[] {
  const normalised = folderPath.replace(/\//g, '\\').replace(/\\+$/, '')
  if (!normalised) return []

  const prefix = `${normalised}\\`
  return tracks.filter((track) => track.path.replace(/\//g, '\\').startsWith(prefix))
}

/** All folders on the path to a node, so the tree can reveal it. */
export function ancestorPaths(folderPath: string): string[] {
  const segments = folderPath.split(/[\\/]/).filter(Boolean)
  const result: string[] = []
  for (let i = 1; i <= segments.length; i += 1) {
    result.push(segments.slice(0, i).join('\\'))
  }
  return result
}
