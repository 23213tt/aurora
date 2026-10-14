import dns from 'node:dns'
import net from 'node:net'

/**
 * A private, standard, secure scheme for media that lives on someone else's
 * server.
 *
 * Why proxy at all: the production renderer is served from `aurora-app://app`
 * with a CSP that allows no external origin, and the player routes its element
 * through Web Audio, which outputs silence for any source the page is not
 * allowed to read. Both problems have the same fix - the main process fetches
 * the upstream address and re-serves it from this app's own origin, with the
 * CORS and range behaviour an `<audio>` element and the Web Audio graph expect.
 *
 * `stream: true` is what allows range requests, and `corsEnabled` is what makes
 * `crossOrigin="anonymous"` succeed; without either, seeking breaks or the
 * output is silent. The privileges must be registered before `app.ready`, so
 * this runs next to `registerMediaScheme()` in `main.ts`.
 *
 * Electron is loaded lazily, in `handleRemoteProtocol` only. That keeps this
 * module importable from a plain Node process - the smoke probe and the unit
 * tests drive `handleRemoteRequest` and the address checks directly, and an
 * `electron` import that resolves to a path string at the top would break both.
 */

export const REMOTE_SCHEME = 'aurora-remote'

export function registerRemoteScheme(): void {
  const { protocol } = electronProtocol()
  protocol.registerSchemesAsPrivileged([
    {
      scheme: REMOTE_SCHEME,
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

/** The slice of Electron's protocol module this file uses. */
interface ElectronProtocol {
  registerSchemesAsPrivileged(schemes: { scheme: string; privileges: Record<string, boolean> }[]): void
  handle(scheme: string, handler: (request: Request) => Promise<Response> | Response): void
}

function electronProtocol(): { protocol: ElectronProtocol } {
  return require('electron') as { protocol: ElectronProtocol }
}

const CORS_HEADERS: Record<string, string> = {
  // Web Audio refuses to read a source it cannot CORS-check, and a refused read
  // is silence rather than an error - the worst kind of bug to debug.
  'access-control-allow-origin': '*',
  'accept-ranges': 'bytes'
}

/** A Range request is a CORS-preflighted one once a scheme is corsEnabled. */
const PREFLIGHT_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  'access-control-allow-methods': 'GET, HEAD, OPTIONS',
  'access-control-allow-headers': 'range',
  'access-control-expose-headers': 'content-range, content-length, accept-ranges',
  'access-control-max-age': '600'
}

/** Response headers worth keeping; upstream's CSP and cookies are not. */
const PASSTHROUGH = ['content-type', 'content-length', 'content-range', 'etag', 'last-modified']

/**
 * Addresses this proxy must never reach.
 *
 * The renderer decides which upstream URL to ask for, so without this check the
 * scheme is a general-purpose request forwarder inside the user's network - a
 * router admin page, a NAS, or the cloud metadata endpoint on 169.254.169.254.
 * The ranges below are the usual "somewhere private" set; 224/4 and 0/8 are
 * included because they are never a music CDN either.
 */
export function isPrivateAddress(address: string): boolean {
  const version = net.isIP(address)

  if (version === 4) {
    const [a, b] = address.split('.').map(Number)
    if (a === 0 || a === 127 || a === 10) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    // Carrier-grade NAT, which is still somebody's private network.
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a >= 224) return true
    return false
  }

  if (version === 6) {
    const lower = address.toLowerCase()
    if (lower === '::' || lower === '::1') return true
    if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true

    /*
     * Three ways IPv6 carries an IPv4 address inside it, all of which can point
     * at the local network:
     *
     *   ::ffff:a.b.c.d  IPv4-mapped
     *   64:ff9b::a.b.c.d NAT64 well-known prefix
     *   2002:AABB:CCDD:: 6to4, where AABB:CCDD is the IPv4 address
     *   ::a.b.c.d       the deprecated IPv4-compatible form
     *
     * The URL parser rewrites the mapped form into hex - `http://[::ffff:127.0.0.1]`
     * arrives as `::ffff:7f00:1` - so matching only the dotted spelling let
     * loopback, 10/8 and 192.168/16 through a door the renderer can open on
     * purpose. Both spellings are decoded here, and anything embedded that
     * cannot be decoded is refused rather than assumed public.
     */
    const embedded =
      /^::ffff:(.+)$/.exec(lower)?.[1] ??
      /^64:ff9b::(.+)$/.exec(lower)?.[1] ??
      /^2002:([0-9a-f]{1,4}:[0-9a-f]{1,4})/.exec(lower)?.[1] ??
      // The deprecated IPv4-compatible form, `::127.0.0.1` = `::7f00:1`. `::1`
      // is loopback and caught above, so only the two-group form is left here.
      /^::([0-9a-f]{1,4}:[0-9a-f]{1,4})$/.exec(lower)?.[1] ??
      null
    if (embedded) {
      const dotted = dottedQuadOf(embedded)
      return dotted ? isPrivateAddress(dotted) : true
    }
    return false
  }

  // Not an IP literal at all: refuse rather than guess.
  return true
}

/**
 * `7f00:1` or `127.0.0.1` -> `127.0.0.1`, or null when it is neither.
 *
 * The hex pair is the same 32 bits the dotted form spells out, which is the
 * whole trick behind the bypass this helper exists to close.
 */
function dottedQuadOf(embedded: string): string | null {
  if (net.isIP(embedded) === 4) return embedded
  const pair = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(embedded)
  if (!pair) return null
  const high = Number.parseInt(pair[1], 16)
  const low = Number.parseInt(pair[2], 16)
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`
}

/**
 * Host decisions are cached for a minute.
 *
 * A seek costs several range requests, and resolving the same CDN name for each
 * one would add a DNS round trip to every scrub. The TTL keeps the cache from
 * outliving a DNS change for long.
 */
const hostVerdicts = new Map<string, { allowed: boolean; at: number }>()
const HOST_TTL_MS = 60_000

/**
 * Whether a hostname (a literal address or a name) may be fetched.
 *
 * Exported for the unit tests, which check the private-range refusals without
 * touching the network. Note that this resolves names: a public name pointing
 * at 127.0.0.1 is exactly the case a literal-only check would miss.
 */
export async function isAllowedHost(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return false

  const cached = hostVerdicts.get(host)
  if (cached && Date.now() - cached.at < HOST_TTL_MS) return cached.allowed

  let allowed = true
  if (net.isIP(host)) {
    allowed = !isPrivateAddress(host)
  } else {
    try {
      // A public name that resolves to a private address is still a private
      // address; checking the literal alone would only catch the naive case.
      const addresses = await dns.promises.lookup(host, { all: true })
      allowed = addresses.every((entry) => !isPrivateAddress(entry.address))
    } catch {
      allowed = false
    }
  }

  hostVerdicts.set(host, { allowed, at: Date.now() })
  return allowed
}

/** `aurora-remote://stream/<percent-encoded http(s) URL>` -> the upstream URL. */
function targetOf(url: URL): string | null {
  const encoded = url.pathname.replace(/^\/+/, '')
  if (!encoded) return null
  try {
    const target = new URL(decodeURIComponent(encoded))
    // Anything but plain web traffic is a different protocol smuggled through
    // a URL parser - `file:`, `data:`, `ftp:` - and has no business here.
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return null
    return target.toString()
  } catch {
    return null
  }
}

/** How many hops a stream may be bounced through before we give up. */
const MAX_REDIRECTS = 4

/**
 * Fetch upstream, re-checking the host on every hop.
 *
 * `redirect: 'follow'` would be one line shorter and would also hand the whole
 * protection away: any public host that answers 302 with `Location:
 * http://127.0.0.1/…` would have already been fetched by the time we saw the
 * response. Following manually keeps every hop behind `isAllowedHost`.
 *
 * One residual hole worth naming: the host check resolves DNS, and the fetch
 * resolves it again, so a name that answers "public" then "private" between the
 * two (DNS rebinding) is not caught. Closing that needs a pinned-address
 * dispatcher; the renderer is our own code and this guard is the second line,
 * not the first.
 */
async function fetchUpstream(target: string, range: string | null): Promise<Response> {
  let current = target

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(current, {
      // Forwarding the range rather than the whole file is what makes seeking
      // work: a lossless track is tens of megabytes and the player wants 4KB of
      // it at a time.
      headers: range ? { range } : undefined,
      redirect: 'manual'
    })

    const location = response.headers.get('location')
    if (response.status < 300 || response.status >= 400 || !location) return response

    // Release the redirect's own (empty) body, or the socket sits until GC.
    try {
      await response.body?.cancel()
    } catch {
      /* a body that cannot be cancelled is not worth failing the request over */
    }

    const next = new URL(location, current)
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      return new Response('bad redirect', { status: 400, headers: CORS_HEADERS })
    }
    if (!(await isAllowedHost(next.hostname))) {
      return new Response('forbidden', { status: 403, headers: CORS_HEADERS })
    }
    current = next.toString()
  }

  return new Response('too many redirects', { status: 502, headers: CORS_HEADERS })
}

async function proxy(target: string, request: Request, image: boolean): Promise<Response> {
  const upstream = await fetchUpstream(target, request.headers.get('range'))

  const headers = new Headers(CORS_HEADERS)
  for (const name of PASSTHROUGH) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  if (!headers.has('content-type')) {
    headers.set('content-type', image ? 'image/jpeg' : 'audio/mpeg')
  }
  // Cover URLs are stable; stream URLs are signed and expire, so caching one
  // past its lifetime would serve a 403 from a stale entry.
  headers.set('cache-control', image ? 'public, max-age=86400' : 'no-store')
  // The renderer needs `content-range` to size a seek, and it is not readable
  // from a cross-origin response unless it is exposed.
  headers.set('access-control-expose-headers', 'content-range, content-length, accept-ranges')

  const noBody = request.method === 'HEAD' || upstream.status === 204 || upstream.status === 304
  return new Response(noBody ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers
  })
}

/**
 * One proxy request, decoupled from the scheme registration so the smoke probe
 * can drive it without an Electron runtime.
 */
export async function handleRemoteRequest(request: Request): Promise<Response> {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return new Response('bad url', { status: 400, headers: CORS_HEADERS })
  }

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: PREFLIGHT_HEADERS })
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405, headers: CORS_HEADERS })
  }

  const image = url.host === 'image'
  if (!image && url.host !== 'stream') {
    return new Response('not found', { status: 404, headers: CORS_HEADERS })
  }

  const target = targetOf(url)
  if (!target) return new Response('bad target', { status: 400, headers: CORS_HEADERS })

  let hostname: string
  try {
    hostname = new URL(target).hostname
  } catch {
    return new Response('bad target', { status: 400, headers: CORS_HEADERS })
  }
  if (!(await isAllowedHost(hostname))) {
    // Deliberately vague: the answer says "no" without describing the network
    // the caller just tried to reach.
    return new Response('forbidden', { status: 403, headers: CORS_HEADERS })
  }

  try {
    return await proxy(target, request, image)
  } catch (error) {
    // The upstream URL can carry a signed token, so only the host is logged.
    console.error('[aurora] remote stream failed', hostname, error)
    return new Response('upstream error', { status: 502, headers: CORS_HEADERS })
  }
}

export function handleRemoteProtocol(): void {
  const { protocol } = electronProtocol()
  protocol.handle(REMOTE_SCHEME, handleRemoteRequest)
}
