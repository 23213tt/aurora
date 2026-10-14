/**
 * URL builders for the private media scheme.
 *
 * Kept in their own module with no imports so both the audio engine and the
 * library-source layer can use them without a circular dependency.
 */

export const MEDIA_SCHEME = 'aurora-media'

/**
 * Stream URL for a local audio file.
 *
 * The path is fully percent-encoded and placed in a single path segment, which
 * avoids the ambiguity of putting a Windows drive letter into a URL path.
 */
export function mediaUrl(filePath: string): string {
  return `${MEDIA_SCHEME}://file/${encodeURIComponent(filePath)}`
}

/** Cover art for a track, resolved main-side (embedded tag, then folder image). */
export function artUrl(filePath: string): string {
  return `${MEDIA_SCHEME}://art/${encodeURIComponent(filePath)}`
}
