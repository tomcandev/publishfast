import { isIP } from 'node:net'

/**
 * The one way the server fetches a URL that came from a caller (a token, a
 * person's paste, a saved post link). See AGENTS.md, "Server-side fetch rule".
 *
 * Every URL it touches, the first one and every redirect, must pass
 * allowedUrl() for the caller's host set:
 *   - parsed with the WHATWG URL parser (what fetch itself uses), and the
 *     parsed href is what is fetched, never the raw string;
 *   - https only;
 *   - host exactly one of the set (so no IP literal, no other subdomain, no
 *     lookalike, no trailing dot);
 *   - no userinfo, no explicit port (the parser drops a default :443);
 *   - at most 2048 characters.
 * Redirects are followed by hand, at most MAX_REDIRECTS, each Location
 * re-checked against the same set. One timeout covers the whole read (all
 * hops and the body); the body is capped. Callers never get upstream error
 * text: only a GuardedFetchError reason.
 */

export const FETCH_TIMEOUT_MS = 15_000
export const FETCH_MAX_BYTES = 3 * 1024 * 1024
export const MAX_REDIRECTS = 5
const MAX_URL_LENGTH = 2048
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

export type FetchFailure = 'refused' | 'redirect_refused' | 'too_many_redirects' | 'too_large' | 'timeout' | 'unreachable'

const FAILURE_TEXT: Record<FetchFailure, string> = {
  refused: 'Not a link this server may read',
  redirect_refused: 'The link redirected somewhere this server may not read',
  too_many_redirects: 'Too many redirects',
  too_large: 'The page was too large',
  timeout: 'The page did not answer in time',
  unreachable: 'The page could not be reached',
}

/** A failed guarded read. `message` is ours, never upstream text. */
export class GuardedFetchError extends Error {
  constructor(readonly reason: FetchFailure) {
    super(FAILURE_TEXT[reason])
    this.name = 'GuardedFetchError'
  }
}

/** The URL guard. Returns the parsed URL (fragment dropped) when it may be fetched, else null. */
export function allowedUrl(raw: unknown, hosts: ReadonlySet<string>): URL | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  if (url.username !== '' || url.password !== '') return null
  if (url.port !== '') return null
  const host = url.hostname
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0) return null
  if (!hosts.has(host)) return null
  url.hash = ''
  return url
}

export type GuardedPage = { url: string; status: number; body: string }

async function readCapped(res: Response, maxBytes: number) {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {})
    throw new GuardedFetchError('too_large')
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new GuardedFetchError('too_large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Reads a page through the guard for `hosts`. Answers the final URL, its HTTP
 * status and its body (whatever the status: callers decide), or throws a
 * GuardedFetchError. Uses globalThis.fetch at call time (tests stub it).
 */
export async function guardedFetch(
  raw: string,
  hosts: ReadonlySet<string>,
  opts: { timeoutMs?: number; maxBytes?: number; maxRedirects?: number; accept?: string } = {},
): Promise<GuardedPage> {
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS
  let url = allowedUrl(raw, hosts)
  if (!url) throw new GuardedFetchError('refused')
  const signal = AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS)
  try {
    for (let hop = 0; ; hop++) {
      const res = await globalThis.fetch(url.href, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: opts.accept ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      })
      if (REDIRECT_STATUSES.has(res.status)) {
        await res.body?.cancel().catch(() => {})
        if (hop >= maxRedirects) throw new GuardedFetchError('too_many_redirects')
        const location = res.headers.get('location')
        let next: URL | null = null
        if (location) {
          try {
            next = allowedUrl(new URL(location, url).href, hosts)
          } catch {
            next = null
          }
        }
        if (!next) throw new GuardedFetchError('redirect_refused')
        url = next
        continue
      }
      return { url: url.href, status: res.status, body: await readCapped(res, opts.maxBytes ?? FETCH_MAX_BYTES) }
    }
  } catch (err) {
    if (err instanceof GuardedFetchError) throw err
    if (signal.aborted) throw new GuardedFetchError('timeout')
    throw new GuardedFetchError('unreachable')
  }
}

/** A saved link's http:// is read as https:// for a known host set (the host itself is still checked). */
export function upgradeToHttps(raw: string, hosts: ReadonlySet<string>): URL | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (!hosts.has(url.hostname)) return null
  if (url.protocol === 'http:') {
    url.protocol = 'https:'
    // An explicit :80 belonged to http; keep any other port so the guard refuses it.
    if (url.port === '80') url.port = ''
  }
  return url.protocol === 'https:' ? url : null
}
