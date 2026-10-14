import { useState, type ReactNode } from 'react'

interface ArtworkProps {
  src: string | null
  alt?: string
  /** Rendered when there is no artwork at all, or when loading it fails. */
  fallback: ReactNode
}

/**
 * Artwork with a graceful fallback.
 *
 * The scanner no longer decodes every file's embedded picture just to answer
 * "does this track have a cover" - that cost a Buffer per file. Artwork is
 * instead resolved lazily by the media protocol, which means `track.hasArt` is
 * an optimistic guess until the request comes back.
 *
 * Without an error handler that guess produces a broken-image icon for every
 * track whose cover is missing, so the failure path is the whole point of this
 * component rather than an edge case.
 */
export function Artwork({ src, alt = '', fallback }: ArtworkProps) {
  const [failed, setFailed] = useState(false)

  if (!src || failed) return <>{fallback}</>

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
    />
  )
}
