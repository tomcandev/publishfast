import { randomUUID } from 'node:crypto'
import { eq, isNotNull, like, sql } from 'drizzle-orm'
import { db, sqlite } from '../db/index.js'
import { publications, soundSightings, sounds, type SOUND_SOURCES, type Sound } from '../db/schema.js'
import { canonicalVideoUrl, copyText, soundUrl, type ParsedSound, type ParsedVideo } from './tiktok.js'

/**
 * The sound bank (contract section 13): storing what the server read, and
 * the one ranking function.
 */

const DAY_MS = 86_400_000

/* ---------- storing ---------- */

/**
 * Inserts or refreshes a sound. `seenAt` is the time of the evidence (a
 * sighting: now; one of our posts: its publication time): first_seen_at
 * keeps the oldest, last_seen_at the newest. Title, author and kind are
 * what TikTok says now. Status and note (the admin's) are never touched.
 */
export function upsertSound(sound: ParsedSound, seenAt: string) {
  db.insert(sounds)
    .values({
      id: sound.id,
      title: sound.title || null,
      author: sound.author || null,
      original: sound.original,
      url: soundUrl(sound),
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
    })
    .onConflictDoUpdate({
      target: sounds.id,
      set: {
        title: sql`excluded.title`,
        author: sql`excluded.author`,
        original: sql`excluded.original`,
        url: sql`excluded.url`,
        firstSeenAt: sql`min(${sounds.firstSeenAt}, excluded.first_seen_at)`,
        lastSeenAt: sql`max(${sounds.lastSeenAt}, excluded.last_seen_at)`,
      },
    })
    .run()
}

export type SightingInput = {
  source: (typeof SOUND_SOURCES)[number]
  region?: string
  rank?: number
}

/**
 * Records one video seen using a sound, as one IMMEDIATE transaction.
 * A video already in the bank is refreshed (its counts, sound, seen time,
 * and the source/region/rank this call gave) and answers `known`.
 */
export function recordSighting(
  parsed: ParsedVideo & { sound: ParsedSound },
  finalUrl: string,
  input: SightingInput,
  tokenId: string | null,
  now = new Date(),
): 'recorded' | 'known' {
  const nowIso = now.toISOString()
  const videoUrl = canonicalVideoUrl(parsed, finalUrl)
  return sqlite
    .transaction(() => {
      upsertSound(parsed.sound, nowIso)
      const fields = {
        soundId: parsed.sound.id,
        videoAuthor: parsed.author,
        plays: parsed.plays,
        likes: parsed.likes,
        postedAt: parsed.postedAt,
        source: input.source,
        seenAt: nowIso,
        ...(input.region !== undefined ? { region: input.region } : {}),
        ...(input.rank !== undefined ? { rank: input.rank } : {}),
      }
      const existing = db.select({ id: soundSightings.id }).from(soundSightings).where(eq(soundSightings.videoUrl, videoUrl)).get()
      if (existing) {
        db.update(soundSightings).set(fields).where(eq(soundSightings.id, existing.id)).run()
        return 'known' as const
      }
      db.insert(soundSightings).values({ id: randomUUID(), videoUrl, tokenId, ...fields }).run()
      return 'recorded' as const
    })
    .immediate()
}

/** True when one of our own publications links this TikTok video id. */
export function isOurVideo(videoId: string | null) {
  if (!videoId || !/^\d{1,30}$/.test(videoId)) return false
  return !!db
    .select({ id: publications.id })
    .from(publications)
    .where(like(publications.publishedUrl, `%/video/${videoId}%`))
    .get()
}

/* ---------- ranking ---------- */

export function median(values: number[]) {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/**
 * THE ranking score. Our own evidence first, outside evidence second:
 *
 *   score = 3 × clamp(ourMedianRatio, 0, 5) × min(1, ourPosts / 3)
 *         + 2 × log10(1 + bestPlays) / 6
 *         + (bestRank ? (51 − min(bestRank, 50)) / 50 : 0)
 *         − staleness
 *
 * ourMedianRatio: the median, over our posts with this sound in the window,
 * of the post's views divided by its account's median views (same platform,
 * same window); null (= 0) when no post has a usable ratio. bestPlays: the
 * most plays of any sighting (0 when none). bestRank: the best (lowest)
 * trending-list place of any sighting, or null. staleness: 0.1 per day since
 * lastSeenAt beyond 7 days.
 */
export function soundScore(i: {
  ourMedianRatio: number | null
  ourPosts: number
  bestPlays: number
  bestRank: number | null
  lastSeenAt: string
  now: Date
}) {
  const ours = 3 * clamp(i.ourMedianRatio ?? 0, 0, 5) * Math.min(1, i.ourPosts / 3)
  const outside = (2 * Math.log10(1 + Math.max(0, i.bestPlays))) / 6
  const rank = i.bestRank ? (51 - Math.min(i.bestRank, 50)) / 50 : 0
  const days = (i.now.getTime() - Date.parse(i.lastSeenAt)) / DAY_MS
  const staleness = Number.isFinite(days) ? 0.1 * Math.max(0, days - 7) : 0
  return ours + outside + rank - staleness
}

/** At least this many of our own posts before the ratio is trusted (the web shows a note below it). */
export const ENOUGH_OWN_POSTS = 3

export type RankedSound = {
  id: string
  title: string | null
  author: string | null
  original: boolean
  url: string | null
  copyText: string
  status: Sound['status']
  /** Only for admins. */
  note?: string | null
  ours: { posts: number; medianRatio: number | null; enough: boolean }
  sightings: {
    count: number
    bestPlays: number
    bestRank: number | null
    sources: string[]
    newestVideoUrl: string | null
    bestVideoUrl: string | null
    bestVideoPlays: number | null
  }
  score: number
  lastSeenAt: string
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d

/**
 * The ranked bank. Our posts count when their publication time
 * (published_at, else created_at) is inside the window; sightings count
 * whenever they were seen (staleness ages them).
 */
export function rankSounds(opts: { windowDays: number; limit: number; includeHidden?: boolean; withNotes?: boolean; now?: Date }): RankedSound[] {
  const now = opts.now ?? new Date()
  const since = now.getTime() - opts.windowDays * DAY_MS
  const bank = db.select().from(sounds).all().filter((s) => opts.includeHidden || s.status === 'active')
  if (bank.length === 0) return []

  // Our publications in the window, and each account's median views per platform.
  const pubs = db
    .select({
      userId: publications.userId,
      platform: publications.platform,
      views: publications.views,
      soundId: publications.soundId,
      publishedAt: publications.publishedAt,
      createdAt: publications.createdAt,
    })
    .from(publications)
    .where(isNotNull(publications.publishedUrl))
    .all()
    .filter((p) => {
      const t = Date.parse(p.publishedAt ?? p.createdAt)
      return Number.isFinite(t) && t >= since && t <= now.getTime()
    })
  const viewsByAccount = new Map<string, number[]>()
  for (const p of pubs) {
    const key = `${p.userId}|${p.platform}`
    viewsByAccount.set(key, [...(viewsByAccount.get(key) ?? []), p.views])
  }
  const accountMedian = new Map([...viewsByAccount].map(([k, v]) => [k, median(v) ?? 0]))
  const oursBySound = new Map<string, { posts: number; ratios: number[] }>()
  for (const p of pubs) {
    if (!p.soundId) continue
    const entry = oursBySound.get(p.soundId) ?? { posts: 0, ratios: [] }
    entry.posts++
    const m = accountMedian.get(`${p.userId}|${p.platform}`) ?? 0
    if (m > 0) entry.ratios.push(p.views / m)
    oursBySound.set(p.soundId, entry)
  }

  const sightingsBySound = new Map<string, (typeof soundSightings.$inferSelect)[]>()
  for (const s of db.select().from(soundSightings).all()) {
    sightingsBySound.set(s.soundId, [...(sightingsBySound.get(s.soundId) ?? []), s])
  }

  const ranked = bank.map((s): RankedSound & { rawScore: number } => {
    const ours = oursBySound.get(s.id) ?? { posts: 0, ratios: [] }
    const seen = sightingsBySound.get(s.id) ?? []
    const ourMedianRatio = median(ours.ratios)
    const bestPlays = Math.max(0, ...seen.map((x) => x.plays ?? 0))
    const ranks = seen.map((x) => x.rank).filter((r): r is number => typeof r === 'number' && r > 0)
    const bestRank = ranks.length ? Math.min(...ranks) : null
    const newest = [...seen].sort((a, b) => b.seenAt.localeCompare(a.seenAt))[0]
    const best = [...seen].sort((a, b) => (b.plays ?? 0) - (a.plays ?? 0) || b.seenAt.localeCompare(a.seenAt))[0]
    const rawScore = soundScore({ ourMedianRatio, ourPosts: ours.posts, bestPlays, bestRank, lastSeenAt: s.lastSeenAt, now })
    return {
      id: s.id,
      title: s.title,
      author: s.author,
      original: s.original,
      url: s.url,
      copyText: copyText(s),
      status: s.status,
      ...(opts.withNotes ? { note: s.note } : {}),
      ours: { posts: ours.posts, medianRatio: ourMedianRatio === null ? null : round(ourMedianRatio, 2), enough: ours.posts >= ENOUGH_OWN_POSTS },
      sightings: {
        count: seen.length,
        bestPlays,
        bestRank,
        sources: [...new Set(seen.map((x) => x.source))].sort(),
        newestVideoUrl: newest?.videoUrl ?? null,
        bestVideoUrl: best?.videoUrl ?? null,
        bestVideoPlays: best?.plays ?? null,
      },
      score: round(rawScore, 3),
      lastSeenAt: s.lastSeenAt,
      rawScore,
    }
  })
  ranked.sort((a, b) => b.rawScore - a.rawScore || b.lastSeenAt.localeCompare(a.lastSeenAt) || a.id.localeCompare(b.id))
  return ranked.slice(0, opts.limit).map(({ rawScore: _raw, ...row }) => row)
}

/* ---------- limits on server-side fetches ---------- */

/** At most this many TikTok page reads at once for the sounds routes, across the process. */
export const MAX_CONCURRENT_READS = 4
let active = 0
const waiting: (() => void)[] = []

export async function withReadSlot<T>(fn: () => Promise<T>): Promise<T> {
  // A finishing read hands its slot straight to the next waiter, so `active` never overshoots.
  if (active < MAX_CONCURRENT_READS) active++
  else await new Promise<void>((resolve) => waiting.push(resolve))
  try {
    return await fn()
  } finally {
    const next = waiting.shift()
    if (next) next()
    else active--
  }
}

/** One sightings or from-link request at a time per caller (token id or user id). */
const busyCallers = new Set<string>()

export function takeCaller(key: string): (() => void) | null {
  if (busyCallers.has(key)) return null
  busyCallers.add(key)
  let released = false
  return () => {
    if (released) return
    released = true
    busyCallers.delete(key)
  }
}
