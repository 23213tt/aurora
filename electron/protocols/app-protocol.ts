import { protocol } from 'electron'
import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import fs from 'node:fs'
import path from 'node:path'
import { resolveAppAsset } from '../pure/app-paths'
import { write } from '../startup-log'

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

 const APP_SCHEME = 'aurora-app'
export const APP_ORIGIN = `${APP_SCHEME}://app`

/**
 * Where the built renderer lives, inside the asar when packaged.
 *
 * Two levels up, not one: this file compiles to `dist-electron/protocols/`, so a
 * single `..` lands on `dist-electron/` and the renderer root is computed as
 * `dist-electron/dist`. That is precisely the bug that shipped in 0.3.0 through
 * 0.3.3 - the file was moved from `electron/` into `electron/protocols/` during a
 * refactor and this relative path was not updated with it, so every request for the
 * renderer answered 404 and the window came up empty.
 *
 * The log line in `handleAppProtocol` is the countermeasure: `root=… exists=false`
 * states this failure outright, where three releases were spent inferring it.
 */
const distRoot = (): string => path.resolve(__dirname, '..', '..', 'dist')
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

    /*
     * Logged before any decision, so the log shows what the renderer actually asked
     * for even when the answer was wrong. A packaged build once showed a blank
     * window and the only trace was a 404 body; without this line there was no way to
     * tell which request produced it.
     */
    write(`app-protocol ${request.method} host=${url.host} path=${url.pathname}`)

    if (url.host !== 'app') {
      write(`  -> 404 host is not "app"`)
      return new Response('not found', { status: 404 })
    }

    const root = distRoot()
    /*
     * The paths themselves, not just the outcome.
     *
     * A log line that said only "404" left the reason ambiguous twice over; printing
     * where the handler thinks it is (`__dirname`), what it therefore computes as the
     * renderer root, and whether that root exists turns the next report into an
     * answer rather than another round of guessing.
     */
    write(`  __dirname=${__dirname}`)
    write(`  module=${__filename}`)
    write(`  root=${root} exists=${fs.existsSync(root)}`)
    /*
     * Containment is decided on the resolved path, not the raw string: `..`
     * segments, encoded traversal and absolute paths (including a Windows drive
     * letter) all have to be caught, and only the resolved form catches all of
     * them.
     */
    const target = resolveAppAsset(root, url.pathname)
    if (!target) {
      write(`  -> 403 resolveAppAsset refused  root=${root}`)
      return new Response('forbidden', { status: 403 })
    }
    write(`  target=${target}`)

    /*
     * Read first, ask questions later.
     *
     * The previous version called `fs.promises.stat` and answered 404 when it threw.
     * That made "the file is not there" and "stat cannot see inside an asar" the same
     * answer - and the second one is not hypothetical: a packaged build shipped with
     * this handler and showed nothing but `not found`, while the very same file was
     * provably inside `app.asar` (checked by extracting it). Reading the file is the
     * operation that actually matters, it works on asar paths, and it needs no
     * separate stat: a failure to read *is* a 404.
     *
     * `statSync` is kept only to fill in `content-length`, where the size is worth
     * having but a failure to obtain it must not turn into a missing page.
     */
    let size = 0
    try {
      const stat = fs.statSync(target)
      if (!stat.isFile()) {
        write(`  -> 404 not a file`)
        return new Response('not found', { status: 404 })
      }
      size = stat.size
    } catch (error) {
      /*
       * Distinguish the two cases in the answer instead of collapsing them: a route
       * that is genuinely absent should stay a plain 404, while anything else is a
       * bug worth seeing. The body is shown in the window, so this is the difference
       * between "blank page" and a sentence naming the file and the reason.
       */
      const code = (error as NodeJS.ErrnoException)?.code
      write(`  -> 404 stat failed code=${code} message=${(error as Error)?.message}`)
      if (code === 'ENOENT') {
        return new Response('not found', { status: 404 })
      }
      return new Response(`cannot stat ${url.pathname}: ${(error as Error)?.message ?? error}`, { status: 404 })
    }

    const type = MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream'
    let stream: fs.ReadStream
    try {
      stream = fs.createReadStream(target)
    } catch (error) {
      write(`  -> 404 createReadStream threw: ${(error as Error)?.message}`)
      return new Response(`cannot read ${url.pathname}: ${(error as Error)?.message ?? error}`, { status: 404 })
    }
    write(`  -> 200 ${type} ${size} bytes`)

    const headers: Record<string, string> = {
      'content-type': type,
      // Hashed asset filenames make the renderer safe to cache hard; the HTML
      // itself must not be, or a new build would never be picked up.
      'cache-control': path.extname(target) === '.html' ? 'no-store' : 'public, max-age=31536000, immutable'
    }
    // Only claim a length when it is known, rather than sending 0 and truncating.
    if (size > 0) headers['content-length'] = String(size)

    return new Response(Readable.toWeb(stream) as WebReadableStream, { status: 200, headers })
  })
}
