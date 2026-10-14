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

/** 渲染层产物目录。本文件编译到 dist-electron/protocols/，所以要上两级。 */

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

    // 任何判断之前先记录：答错时也要能看出请求了什么。
    write(`app-protocol ${request.method} host=${url.host} path=${url.pathname}`)

    if (url.host !== 'app') {
      write(`  -> 404 host is not "app"`)
      return new Response('not found', { status: 404 })
    }

    const root = distRoot()
    // 连路径一起记：只写 404 无法判断是算错了路径还是文件真的不在。
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

    // 以能否读取为准：ENOENT 才算 404。statSync 只用来取 content-length。
    let size = 0
    try {
      const stat = fs.statSync(target)
      if (!stat.isFile()) {
        write(`  -> 404 not a file`)
        return new Response('not found', { status: 404 })
      }
      size = stat.size
    } catch (error) {
      // 真正不存在就是 404，其他原因把话写进响应体，窗口会显示出来。
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
