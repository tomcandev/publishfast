import { isIP } from 'node:net'

/**
 * Server-side reads of TikTok video pages (contract section 13, and the
 * TikTok part of the public-count sync in lib/metrics.ts).
 *
 * The URL comes from a caller (a token, a person's paste, a saved post
 * link), so this is an SSRF surface. Every such fetch goes through
 * fetchTikTokPage(), and every URL it touches, the first one and every
 * redirect, must pass allowedTikTokUrl():
 *   - parsed with the WHATWG URL parser (what fetch itself uses), and the
 *     parsed href is what is fetched, never the raw string;
 *   - https only;
 *   - host exactly www.tiktok.com, vt.tiktok.com, vm.tiktok.com or m.tiktok.com
 *     (so no IP literal, no other subdomain, no lookalike such as
 *     tiktok.com.evil.example, no trailing dot);
 *   - no userinfo, no explicit port (the parser drops a default :443);
 *   - at most 2048 characters.
 * Redirects are followed by hand, at most MAX_REDIRECTS, each Location
 * re-checked by the same rule. One timeout covers the whole read (all hops
 * and the body); the body is capped at FETCH_MAX_BYTES. Callers never get
 * the upstream error text: only a TikTokFetchError reason.
 */

export const TIKTOK_HOSTS: ReadonlySet<string> = new Set(['www.tiktok.com', 'vt.tiktok.com', 'vm.tiktok.com', 'm.tiktok.com'])
export const FETCH_TIMEOUT_MS = 15_000
export const FETCH_MAX_BYTES = 3 * 1024 * 1024
export const MAX_REDIRECTS = 5
const MAX_URL_LENGTH = 2048
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

export type TikTokFetchFailure = 'refused' | 'redirect_refused' | 'too_many_redirects' | 'too_large' | 'timeout' | 'unreachable'

const FAILURE_TEXT: Record<TikTokFetchFailure, string> = {
  refused: 'Not a TikTok link this server may read',
  redirect_refused: 'The link redirected away from TikTok',
  too_many_redirects: 'Too many redirects',
  too_large: 'The page was too large',
  timeout: 'TikTok did not answer in time',
  unreachable: 'TikTok could not be reached',
}

/** A failed guarded read. `message` is ours, never upstream text. */
export class TikTokFetchError extends Error {
  constructor(readonly reason: TikTokFetchFailure) {
    super(FAILURE_TEXT[reason])
    this.name = 'TikTokFetchError'
  }
}

/** The URL guard. Returns the parsed URL (fragment dropped) when it may be fetched, else null. */
export function allowedTikTokUrl(raw: unknown): URL | null {
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
  if (!TIKTOK_HOSTS.has(host)) return null
  url.hash = ''
  return url
}

export type TikTokPage = { url: string; status: number; body: string }

async function readCapped(res: Response, maxBytes: number) {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {})
    throw new TikTokFetchError('too_large')
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
      throw new TikTokFetchError('too_large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Reads a TikTok page through the guard. Answers the final URL, its HTTP
 * status and its body (whatever the status: callers decide), or throws a
 * TikTokFetchError. Uses globalThis.fetch at call time (tests stub it).
 */
export async function fetchTikTokPage(
  raw: string,
  opts: { timeoutMs?: number; maxBytes?: number; maxRedirects?: number } = {},
): Promise<TikTokPage> {
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS
  let url = allowedTikTokUrl(raw)
  if (!url) throw new TikTokFetchError('refused')
  const signal = AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS)
  try {
    for (let hop = 0; ; hop++) {
      const res = await globalThis.fetch(url.href, {
        method: 'GET',
        redirect: 'manual',
        signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      })
      if (REDIRECT_STATUSES.has(res.status)) {
        await res.body?.cancel().catch(() => {})
        if (hop >= maxRedirects) throw new TikTokFetchError('too_many_redirects')
        const location = res.headers.get('location')
        let next: URL | null = null
        if (location) {
          try {
            next = allowedTikTokUrl(new URL(location, url).href)
          } catch {
            next = null
          }
        }
        if (!next) throw new TikTokFetchError('redirect_refused')
        url = next
        continue
      }
      return { url: url.href, status: res.status, body: await readCapped(res, opts.maxBytes ?? FETCH_MAX_BYTES) }
    }
  } catch (err) {
    if (err instanceof TikTokFetchError) throw err
    if (signal.aborted) throw new TikTokFetchError('timeout')
    throw new TikTokFetchError('unreachable')
  }
}

/* ---------- the video page parser ---------- */

export type ParsedSound = { id: string; title: string; author: string; original: boolean }

export type ParsedVideo = {
  videoId: string | null
  /** The video's author handle (uniqueId). */
  author: string | null
  sound: ParsedSound | null
  plays: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  postedAt: string | null
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null)

/** Text from a page, made safe to store and show: no control or direction characters, trimmed, capped. */
export function cleanText(v: unknown, max = 200) {
  if (typeof v !== 'string') return ''
  return v
    .replace(/[\u0000-\u001f\u007f-\u009f​‎‏‪-‮⁦-⁩﻿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** An id of digits only. A JSON number is accepted only while it is exact. */
function digits(v: unknown) {
  if (typeof v === 'number') return Number.isSafeInteger(v) && v > 0 ? String(v) : null
  return typeof v === 'string' && /^\d{1,30}$/.test(v) ? v : null
}

function countOf(...values: unknown[]) {
  for (const v of values) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,16}$/.test(v) ? Number(v) : NaN
    if (Number.isSafeInteger(n) && n >= 0) return n
  }
  return null
}

const EARLIEST_POST = Date.parse('2016-01-01T00:00:00Z')

function postedAtOf(v: unknown) {
  const seconds = countOf(v)
  if (seconds === null) return null
  const ms = seconds * 1000
  return ms >= EARLIEST_POST && ms <= Date.now() + 86_400_000 ? new Date(ms).toISOString() : null
}

/** A sound object as TikTok writes it in a page ({id, title, authorName, original}) or tikwm ({id, title, author, original}). */
export function soundOf(music: unknown): ParsedSound | null {
  const m = obj(music)
  if (!m) return null
  const id = digits(m.id ?? m.idStr)
  if (!id) return null
  return {
    id,
    title: cleanText(m.title),
    author: cleanText(m.authorName ?? m.author),
    original: m.original === true,
  }
}

function scriptJson(html: string, id: string): unknown {
  const match = new RegExp(`<script\\b[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)</script>`, 'i').exec(html)
  if (!match) return null
  try {
    return JSON.parse(match[1]!)
  } catch {
    return null
  }
}

/** The video item of a page: the current format (__UNIVERSAL_DATA_FOR_REHYDRATION__), else the older SIGI_STATE. */
function videoItem(html: string): Json | null {
  const universal = obj(scriptJson(html, '__UNIVERSAL_DATA_FOR_REHYDRATION__'))
  const detail = obj(obj(universal?.__DEFAULT_SCOPE__)?.['webapp.video-detail'])
  const fromUniversal = obj(obj(detail?.itemInfo)?.itemStruct)
  if (fromUniversal) return fromUniversal
  const sigi = obj(scriptJson(html, 'SIGI_STATE'))
  const items = obj(sigi?.ItemModule)
  if (!items) return null
  for (const v of Object.values(items)) {
    const item = obj(v)
    if (item) return item
  }
  return null
}

/**
 * Reads what a TikTok video page says about the video: its sound, author,
 * counts and posting time. Null when the page carries no video data (a
 * login wall, an error page, a page without the JSON).
 */
export function parseTikTokVideoPage(html: string): ParsedVideo | null {
  const item = videoItem(html)
  if (!item) return null
  const author = obj(item.author)
  const handle = typeof item.author === 'string' ? item.author : author?.uniqueId
  const stats = obj(item.stats) ?? {}
  const statsV2 = obj(item.statsV2) ?? {}
  return {
    videoId: digits(item.id),
    author: typeof handle === 'string' && /^[A-Za-z0-9._]{1,64}$/.test(handle) ? handle : null,
    sound: soundOf(item.music),
    plays: countOf(stats.playCount, statsV2.playCount),
    likes: countOf(stats.diggCount, statsV2.diggCount),
    comments: countOf(stats.commentCount, statsV2.commentCount),
    shares: countOf(stats.shareCount, statsV2.shareCount),
    postedAt: postedAtOf(item.createTime),
  }
}

/** The canonical address of a video we read: https://www.tiktok.com/@<author>/video/<id>, else the final URL without its query. */
export function canonicalVideoUrl(parsed: ParsedVideo, finalUrl: string) {
  if (parsed.author && parsed.videoId) return `https://www.tiktok.com/@${parsed.author}/video/${parsed.videoId}`
  const u = new URL(finalUrl)
  u.search = ''
  u.hash = ''
  return u.href
}

/** The sound's own TikTok page. TikTok reads the id at the end; the words before it are for people. */
export function soundUrl(sound: { id: string; title: string | null }) {
  if (!/^\d{1,30}$/.test(sound.id)) return null
  const slug = (sound.title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '')
  return `https://www.tiktok.com/music/${slug || 'sound'}-${sound.id}`
}

/**
 * What to type in TikTok's "Add sound" search to find it:
 * `<title> <author>` for a named track, `original sound <author>` for an original sound.
 */
export function copyText(sound: { title: string | null; author: string | null; original: boolean }) {
  const author = cleanText(sound.author ?? '')
  const text = sound.original ? `original sound ${author}` : `${cleanText(sound.title ?? '')} ${author}`
  return text.replace(/\s+/g, ' ').trim()
}
