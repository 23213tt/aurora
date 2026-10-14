import { protocol } from 'electron'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import fs from 'node:fs'
import path from 'node:path'
import { isInsideRoots } from '../settings'
import { readEmbeddedArt, readFolderArt } from '../library-scan'

export const MEDIA_SCHEME = 'aurora-media'

/**
 * A private, standard, secure scheme for local media.
 *
 * Why not `file://`: the renderer runs on `http://127.0.0.1:5173` in dev and
 * `file://` in production, and `<audio>` routed through Web Audio outputs
 * silence for cross-origin sources. Serving from one scheme with CORS headers
 * makes the origin relationship explicit and identical in both modes.
 *
 * `stream: true` is what allows range requests, and therefore seeking.
 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true
      }
    }
  ])
}

const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.wv': 'audio/x-wavpack',
  '.ape': 'audio/x-ape',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.wma': 'audio/x-ms-wma',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp'
}

function mimeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

const CORS = {
  // Without this the Web Audio graph receives silence instead of samples.
  'access-control-allow-origin': '*',
  'accept-ranges': 'bytes'
}

/**
 * Stream a file range rather than buffering it. A lossless album can be
 * hundreds of megabytes, and Chromium issues a range request per seek, so
 * reading whole files into memory per request would be both slow and dangerous.
 */
function bodyOf(file: string, start?: number, end?: number): WebReadableStream {
  const stream = fs.createReadStream(file, start === undefined ? undefined : { start, end })
  return Readable.toWeb(stream) as WebReadableStream
}

async function serveAudio(target: string, request: Request): Promise<Response> {
  if (!isInsideRoots(target)) return new Response('forbidden', { status: 403 })

  let size: number
  try {
    const stat = await fs.promises.stat(target)
    if (!stat.isFile()) return new Response('not a file', { status: 404 })
    size = stat.size
  } catch {
    return new Response('not found', { status: 404 })
  }

  const type = mimeFor(target)
  const range = request.headers.get('range')

  if (!range) {
    return new Response(bodyOf(target), {
      status: 200,
      headers: { ...CORS, 'content-type': type, 'content-length': String(size) }
    })
  }

  // `bytes=start-end`, where either side may be omitted.
  const match = /bytes=(\d*)-(\d*)/.exec(range)
  if (!match || (match[1] === '' && match[2] === '')) {
    return new Response(null, {
      status: 416,
      headers: { ...CORS, 'content-range': `bytes */${size}` }
    })
  }

  let start: number
  let end: number
  if (match[1] === '') {
    // Suffix range: the last N bytes.
    const suffix = Number.parseInt(match[2], 10)
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number.parseInt(match[1], 10)
    end = match[2] === '' ? size - 1 : Math.min(Number.parseInt(match[2], 10), size - 1)
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return new Response(null, {
      status: 416,
      headers: { ...CORS, 'content-range': `bytes */${size}` }
    })
  }

  return new Response(bodyOf(target, start, end), {
    status: 206,
    headers: {
      ...CORS,
      'content-type': type,
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${size}`
    }
  })
}

async function serveArt(target: string): Promise<Response> {
  if (!isInsideRoots(target)) return new Response('forbidden', { status: 403 })

  // Embedded picture first, then a folder image beside the file.
  const embedded = await readEmbeddedArt(target)
  if (embedded) {
    return new Response(new Uint8Array(embedded.data), {
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'content-type': embedded.mime,
        'cache-control': 'no-store'
      }
    })
  }

  const folderImage = await readFolderArt(target)
  if (folderImage) {
    try {
      const data = await fs.promises.readFile(folderImage)
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: {
          'access-control-allow-origin': '*',
          'content-type': mimeFor(folderImage),
          'cache-control': 'no-store'
        }
      })
    } catch {
      /* fall through to 404 */
    }
  }

  return new Response('no artwork', { status: 404 })
}

export function handleMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('bad url', { status: 400 })
    }

    const target = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    if (!target) return new Response('bad request', { status: 400 })

    try {
      if (url.host === 'art') return await serveArt(target)
      if (url.host === 'file') return await serveAudio(target, request)
    } catch (error) {
      console.error('[aurora] media protocol failed', target, error)
      return new Response('internal error', { status: 500 })
    }
    return new Response('not found', { status: 404 })
  })
}
