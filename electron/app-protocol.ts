import { protocol } from 'electron'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import fs from 'node:fs'
import path from 'node:path'
import { resolveAppAsset } from './app-paths'

/**
 * Serves the built renderer over a private scheme instead of `file://`.
 *
 * This is not cosmetic. A `file://` document has an *opaque* origin, which
 * breaks the production build two different ways:
 *
 *  1. Vite emits `<script type="module" crossorigin src="./assets/…">`. Module
 *     scripts require CORS, and an opaque origin fails that check - the page
 *     loads and stays blank.
 *  2. The app's own CSP says `script-src 'self'`. For an opaque origin, `'self'`
 *     matches nothing, so the policy blocks the app's own bundle.
 *
 * Neither shows up in development, because the dev server is real HTTP. Serving
 * from `aurora-app://app/` gives the document a real, secure origin where module
 * loading, `crossorigin` stylesheets and `'self'` all behave normally.
 */

export const APP_SCHEME = 'aurora-app'
export const APP_ORIGIN = `${APP_SCHEME}://app`

/** Where the built renderer lives, inside the asar when packaged. */
const distRoot = (): string => path.resolve(__dirname, '..', 'dist')

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
}

export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
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

export function handleAppProtocol(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('bad url', { status: 400 })
    }

    if (url.host !== 'app') return new Response('not found', { status: 404 })

    const root = distRoot()
    /*
     * Containment is decided on the resolved path, not the raw string: `..`
     * segments, encoded traversal and absolute paths (including a Windows drive
     * letter) all have to be caught, and only the resolved form catches all of
     * them.
     */
    const target = resolveAppAsset(root, url.pathname)
    if (!target) return new Response('forbidden', { status: 403 })

    let stat: fs.Stats
    try {
      stat = await fs.promises.stat(target)
    } catch {
      return new Response('not found', { status: 404 })
    }
    if (!stat.isFile()) return new Response('not found', { status: 404 })

    const type = MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream'
    const stream = fs.createReadStream(target)

    return new Response(Readable.toWeb(stream) as WebReadableStream, {
      status: 200,
      headers: {
        'content-type': type,
        'content-length': String(stat.size),
        // Hashed asset filenames make the renderer safe to cache hard; the HTML
        // itself must not be, or a new build would never be picked up.
        'cache-control': path.extname(target) === '.html' ? 'no-store' : 'public, max-age=31536000, immutable'
      }
    })
  })
}
