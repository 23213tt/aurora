import path from 'node:path'

/**
 * Resolve a request path to a file inside the renderer bundle.
 *
 * Split out from the protocol handler so the containment check can be tested:
 * this is the only thing standing between a request and an arbitrary file read,
 * and it is the kind of code that looks obviously correct and is not.
 *
 * Returns null when the request does not resolve to something inside `root`.
 */
export function resolveAppAsset(root: string, requestPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(requestPath)
  } catch {
    // Malformed percent-encoding.
    return null
  }

  // A NUL byte truncates the path in some native APIs, which is a classic way to
  // smuggle a different filename past a string check.
  if (decoded.includes('\0')) return null

  const relative = decoded.replace(/^\/+/, '') || 'index.html'
  const resolvedRoot = path.resolve(root)
  const target = path.resolve(resolvedRoot, relative)

  if (target === resolvedRoot) return null
  if (!target.startsWith(resolvedRoot + path.sep)) return null

  return target
}
