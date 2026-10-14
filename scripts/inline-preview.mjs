/**
 * Folds the built pages into self-contained HTML files for design review.
 *
 * Vite always emits external stylesheet and script references. The review path
 * loads these from `file://`, where both the module-script fetch and the
 * `crossorigin` stylesheet request are blocked, so everything has to be inlined.
 *
 * Two pages are produced:
 *   - the player, one file per screen, so any view can be screenshotted
 *   - the desktop lyric overlay, which is a transparent window and therefore
 *     needs a stand-in desktop behind it to be reviewable at all
 */
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const playerDir = path.join(root, process.argv[2] ?? 'dist-preview')
const overlayDir = path.join(root, process.argv[3] ?? 'dist-preview-overlay')
const outDir = path.join(root, 'preview-dist')

const BANNER = '<!-- GENERATED design harness. Not a shipping artifact. -->'

/*
 * Surfaces startup crashes in the screenshot itself.
 *
 * The headless renderer reports nothing back, so an exception during module init
 * just produces a blank page with no explanation. This trap paints the error over
 * the page, which turns "it is blank" into "here is the stack". Registered
 * immediately before the bundle so it catches init-time throws.
 */
const ERROR_TRAP = `<script>
(function () {
  function show(kind, message, stack) {
    var el = document.getElementById('__harness_error__')
    if (!el) {
      el = document.createElement('pre')
      el.id = '__harness_error__'
      el.style.cssText =
        'position:fixed;inset:0;z-index:9999;margin:0;padding:24px;overflow:auto;' +
        'background:#2a0f10;color:#ffd9d6;font:13px/1.55 Consolas,monospace;white-space:pre-wrap'
      ;(document.body || document.documentElement).appendChild(el)
    }
    el.textContent += kind + ': ' + message + '\\n' + (stack || '') + '\\n\\n'
  }
  window.addEventListener('error', function (e) {
    show('error', e.message, e.error && e.error.stack)
  })
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason
    show('unhandledrejection', r && r.message ? r.message : String(r), r && r.stack)
  })
})()
</script>`

/**
 * Stand-in wallpaper for the overlay review.
 *
 * The real window is transparent, so a headless screenshot would composite the
 * white lyric text onto white and show nothing. This is a fake desktop, not part
 * of the overlay.
 */
const DESKTOP_BACKDROP = `<style>
  html, body.overlay-body { background:
    radial-gradient(120% 120% at 20% 10%, #2a3550 0%, #141a26 45%, #0a0d12 100%) !important; }
  body.overlay-body::after {
    content: '（预览用背景，实际是透明窗口）';
    position: fixed; left: 10px; bottom: 8px;
    font: 11px/1 "Segoe UI", sans-serif; color: rgb(255 255 255 / 0.28);
  }
  /* Preview only: there is no pointer in a screenshot, so the hover-revealed
     control strip would otherwise be invisible and unreviewable. */
  .stage-lyric__controls { opacity: 1 !important; }
</style>`

function assertParses(code, label) {
  try {
    // Compiles without executing, which is exactly what the browser will do.
    // eslint-disable-next-line no-new-func
    new Function(code)
  } catch (error) {
    const dump = path.join(outDir, `failing-${label}.js`)
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(dump, code, 'utf8')
    console.error(`\nsyntax error in ${label}: ${error.message}`)
    console.error(`wrote the offending code to ${path.relative(root, dump)}`)
    console.error(`run: node --check ${path.relative(root, dump)}`)
    process.exit(1)
  }
}

function insertBeforeBodyClose(document, payload) {
  if (!document.includes('</body>')) {
    throw new Error('built HTML has no </body> to anchor the inlined script to')
  }
  /*
   * Insert with a replacement *function*, never a replacement string.
   *
   * `String.prototype.replace` expands `$&`, "$`", "$'" and `$n` inside a string
   * replacement. The bundle is generated code and can contain any of those
   * sequences; when it does, the match (`</body>`) is spliced into the middle of
   * the script, splitting it and surfacing in the browser as a syntax error
   * about an unexpected `<`. A function replacement disables that expansion.
   */
  return document.replace('</body>', () => `${payload}</body>`)
}

function inlinePage(sourceDir, htmlFile, { backdrop = false } = {}) {
  const readAsset = (href) => {
    const clean = href.replace(/^\.\//, '').split('?')[0].split('#')[0]
    return fs.readFileSync(path.join(sourceDir, clean), 'utf8')
  }

  let html = fs.readFileSync(path.join(sourceDir, htmlFile), 'utf8')
  const scripts = []

  html = html.replace(/<link\b[^>]*rel="stylesheet"[^>]*>/g, (tag) => {
    const match = /href="([^"]+)"/.exec(tag)
    if (!match) return tag
    return `<style>\n${readAsset(match[1])}\n</style>`
  })

  /*
   * The script is lifted out of <head> and re-inserted before </body>.
   *
   * Vite emits `<script type="module">`, and module scripts are deferred, so the
   * bundle runs after the document is parsed. An inlined *classic* script in
   * <head> runs immediately, finds no #root, and the app throws before it can
   * render. `defer` is ignored on inline classic scripts, so relocating is the
   * only correct fix.
   */
  html = html.replace(/<script\b[^>]*src="([^"]+)"[^>]*><\/script>/g, (_tag, src) => {
    const code = readAsset(src)
    // The HTML parser ends a script block at `</script` followed by whitespace,
    // `/` or `>`, so a bare `</script` truncates it and the rest parses as markup.
    scripts.push(code.replace(/<\/(script)/gi, '<\\/$1'))
    return ''
  })

  scripts.forEach((code, index) => assertParses(code, `${htmlFile.replace(/\W/g, '-')}-${index}`))

  // The app's CSP assumes a real origin. Under file:// there is no origin to be
  // 'self', and inlined code needs 'unsafe-inline'.
  html = html.replace(
    /<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?>/,
    `<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' data: blob: file:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: file:; media-src data: blob: file:; font-src data: file:;">`
  )

  if (backdrop) html = html.replace('</head>', `${DESKTOP_BACKDROP}\n</head>`)

  const bundle = scripts.map((code) => `<script>\n${code}\n</script>`).join('\n')
  return { html, bundle }
}

const written = []
function emit(dir, name, body) {
  const target = path.join(dir, name)
  fs.writeFileSync(target, `${BANNER}\n${body}`, 'utf8')
  written.push([name, fs.statSync(target).size])
}

fs.mkdirSync(outDir, { recursive: true })

// --- the player, one file per screen --------------------------------------

const SCREENS = [
  'albums',
  'album',
  'artists',
  'songs',
  'songs-far',
  'empty',
  'menu',
  'folders',
  'playlists',
  'playlist',
  'accounts',
  'sources',
  'settings',
  'netease',
  'eq',
  'queue',
  'stage',
  'perf',
  'import'
]

const player = inlinePage(playerDir, 'index.html')
const playerPayload = (bootstrap) =>
  `${ERROR_TRAP}\n${bootstrap ? `${bootstrap}\n` : ''}${player.bundle}\n`

emit(outDir, 'aurora-preview.html', insertBeforeBodyClose(player.html, playerPayload(null)))
for (const screen of SCREENS) {
  const bootstrap = `<script>location.hash = ${JSON.stringify(screen)}</script>`
  emit(
    outDir,
    `aurora-preview-${screen}.html`,
    insertBeforeBodyClose(player.html, playerPayload(bootstrap))
  )
}

// --- the desktop lyric overlay --------------------------------------------

const overlay = inlinePage(overlayDir, 'overlay.html', { backdrop: true })
emit(outDir, 'aurora-overlay-preview.html', insertBeforeBodyClose(overlay.html, `${ERROR_TRAP}\n${overlay.bundle}\n`))

console.log(`wrote ${written.length} harness file(s) to preview-dist/`)
for (const [name, size] of written) {
  console.log(`  ${name.padEnd(34)} ${(size / 1024).toFixed(1)} kB`)
}
