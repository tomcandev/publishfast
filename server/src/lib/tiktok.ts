import { cleanText } from './fields.js'
import {
  FETCH_MAX_BYTES,
  FETCH_TIMEOUT_MS,
  GuardedFetchError,
  MAX_REDIRECTS,
  allowedUrl,
  guardedFetch,
  type FetchFailure,
  type GuardedPage,
} from './guardedFetch.js'

/**
 * Server-side reads of TikTok video pages (contract section 13, and the
 * TikTok part of the public-count sync in lib/metrics.ts), through the one
 * guarded fetch in lib/guardedFetch.ts with the TikTok host set: https only,
 * host exactly one of TIKTOK_HOSTS, no userinfo, port or IP literal, at most
 * 5 redirects each re-checked, 15 s, 3 MB, no upstream text to the caller.
 * The public tikwm endpoint is asked about a link only after it passed that
 * guard, without its query string, through the same guarded fetch with
 * TIKWM_HOSTS.
 */

export const TIKTOK_HOSTS: ReadonlySet<string> = new Set(['www.tiktok.com', 'tiktok.com', 'vt.tiktok.com', 'vm.tiktok.com', 'm.tiktok.com'])
export const TIKWM_HOSTS: ReadonlySet<string> = new Set(['www.tikwm.com'])
export { FETCH_MAX_BYTES, FETCH_TIMEOUT_MS, MAX_REDIRECTS }
export type TikTokFetchFailure = FetchFailure
export type TikTokPage = GuardedPage
/** A failed guarded read (the same class for every host set). */
export const TikTokFetchError = GuardedFetchError
export type TikTokFetchError = GuardedFetchError

/** The URL guard for TikTok. */
export function allowedTikTokUrl(raw: unknown): URL | null {
  return allowedUrl(raw, TIKTOK_HOSTS)
}

/** Reads a TikTok page through the guard. */
export function fetchTikTokPage(raw: string, opts: { timeoutMs?: number; maxBytes?: number; maxRedirects?: number } = {}) {
  return guardedFetch(raw, TIKTOK_HOSTS, opts)
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
  /** TikTok's collectCount: how many people saved the video. */
  saves: number | null
  postedAt: string | null
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null)

/** Text from a page, made safe to store and show (lib/fields.ts). */
export { cleanText }

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

/** A video author's handle (uniqueId), else null. */
function handleOf(v: unknown) {
  return typeof v === 'string' && /^[A-Za-z0-9._]{1,64}$/.test(v) ? v : null
}

/** How many `id="…"` matches are looked at before giving up (a hostile page could repeat it). */
const MAX_SCRIPT_TRIES = 8

/**
 * The JSON of `<script … id="<id>" …>…</script>`, found with indexOf only
 * (linear time: a regex here was quadratic on a hostile page).
 */
function scriptJson(html: string, id: string): unknown {
  for (const q of ['"', "'"]) {
    const needle = `id=${q}${id}${q}`
    let at = html.indexOf(needle)
    for (let tries = 0; at !== -1 && tries < MAX_SCRIPT_TRIES; tries++) {
      const open = html.lastIndexOf('<script', at)
      const tagEnd = html.indexOf('>', at + needle.length)
      // The id must sit inside that <script …> tag: no ">" between "<script" and the id.
      if (open !== -1 && tagEnd !== -1 && html.indexOf('>', open) > at) {
        const close = html.indexOf('</script>', tagEnd + 1)
        if (close === -1) return null
        try {
          return JSON.parse(html.slice(tagEnd + 1, close))
        } catch {
          return null
        }
      }
      if (tagEnd === -1) return null
      at = html.indexOf(needle, at + needle.length)
    }
  }
  return null
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
    author: handleOf(handle),
    sound: soundOf(item.music),
    plays: countOf(stats.playCount, statsV2.playCount),
    likes: countOf(stats.diggCount, statsV2.diggCount),
    comments: countOf(stats.commentCount, statsV2.commentCount),
    shares: countOf(stats.shareCount, statsV2.shareCount),
    saves: countOf(stats.collectCount, statsV2.collectCount),
    postedAt: postedAtOf(item.createTime),
  }
}

/* ---------- tikwm ---------- */

/** The `data` of a tikwm answer (only the fields we read; every one is untrusted). */
export type TikwmVideo = {
  id?: unknown
  author?: unknown
  create_time?: unknown
  play_count?: number
  digg_count?: number
  comment_count?: number
  share_count?: number
  collect_count?: number
  music_info?: unknown
}

/**
 * tikwm's answer for a guard-passed TikTok URL, query string removed; null
 * when it has nothing (code ≠ 0, no data, a non-2xx answer, a failed read).
 */
export async function readTikwm(target: URL): Promise<TikwmVideo | null> {
  const clean = allowedTikTokUrl(target.href)
  if (!clean) return null
  clean.search = ''
  clean.hash = ''
  try {
    const page = await guardedFetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(clean.href)}`, TIKWM_HOSTS, {
      accept: 'application/json',
    })
    if (page.status < 200 || page.status >= 300) return null
    const data = JSON.parse(page.body) as { code?: number; data?: TikwmVideo }
    return data && data.code === 0 && data.data ? data.data : null
  } catch {
    return null
  }
}

/**
 * What a tikwm `data` object says about the video, in the page parser's
 * shape and with the same checks. Null when it is not an object.
 */
export function parseTikwmVideo(data: unknown): ParsedVideo | null {
  const d = obj(data)
  if (!d) return null
  return {
    videoId: digits(d.id),
    author: handleOf(obj(d.author)?.unique_id),
    sound: soundOf(d.music_info),
    plays: countOf(d.play_count),
    likes: countOf(d.digg_count),
    comments: countOf(d.comment_count),
    shares: countOf(d.share_count),
    saves: countOf(d.collect_count),
    postedAt: postedAtOf(d.create_time),
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
