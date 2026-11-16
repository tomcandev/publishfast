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
  _clearRankingCache()
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
      const existing = db
        .select({ id: soundSightings.id, source: soundSightings.source })
        .from(soundSightings)
        .where(eq(soundSightings.videoUrl, videoUrl))
        .get()
      // A person's paste (manual) never overwrites what a trend or viral report said about the video.
      const keepListing = !!existing && input.source === 'manual' && existing.source !== 'manual'
      const fields = {
        soundId: parsed.sound.id,
        videoAuthor: parsed.author,
        plays: parsed.plays,
        likes: parsed.likes,
        saves: parsed.saves,
        postedAt: parsed.postedAt,
        seenAt: nowIso,
        ...(keepListing
          ? {}
          : {
              source: input.source,
              ...(input.region !== undefined ? { region: input.region } : {}),
              ...(input.rank !== undefined ? { rank: input.rank } : {}),
            }),
      }
      if (existing) {
        db.update(soundSightings).set(fields).where(eq(soundSightings.id, existing.id)).run()
        return 'known' as const
      }
      db.insert(soundSightings).values({ id: randomUUID(), videoUrl, tokenId, source: input.source, ...fields }).run()
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

/* ---------- the quality gate ---------- */

/**
 * The list people see is background audio, not someone talking. A sound is
 * shown when one of these holds (checked in this order):
 *
 *   ours   — at least ENOUGH_OWN_POSTS of our posts with it in the window, and
 *            their median views ratio is at least OURS_RATIO;
 *   trend  — a sighting by another creator has a trending-list rank;
 *   plays  — a sighting by another creator has at least PLAYS_FLOOR plays.
 *
 * An original sound (TikTok's flag, or a title like "original sound…") must
 * also be used by at least MIN_REUSERS creators other than its own author
 * before trend or plays count: one person's original sound is almost always
 * their voice. "Another creator" is the sighting video's handle (stored, else
 * from `/@handle/video/<id>`), minus the sound's own author: a handle whose
 * letters match the sound's author or the name after "original sound -", or
 * whose video id was made within ORIGIN_SECONDS of the sound id (TikTok ids
 * carry their creation second in the high 32 bits, and an original sound is
 * made with the video that uploaded it).
 */
export const MIN_REUSERS = 2
export const PLAYS_FLOOR = 20_000
export const OURS_RATIO = 1.25
export const ORIGIN_SECONDS = 300

export type QualityReason = 'ours' | 'trend' | 'plays' | 'speech' | 'no_evidence'
export type Quality = { pass: boolean; reason: QualityReason }

/** TikTok's "original sound" title in the languages seen in the bank (and a few more). */
const GENERIC_ORIGINAL =
  /^\s*(original sound|originalton|original audio|som original|sonido original|son original|suono originale|âm thanh gốc|suara asli|เสียงต้นฉบับ|оригинальный звук|orijinal ses|原声|オリジナル楽曲)/i

/** True for a sound that is (or is titled as) one creator's original sound. */
export function isOriginalLike(s: { original: boolean; title: string | null }) {
  return s.original || GENERIC_ORIGINAL.test(s.title ?? '')
}

/** Letters and digits only, lower case, fancy Unicode letters folded ("𝐈𝐯𝐚́𝐧" -> "ivan"). */
export function foldName(s: string) {
  return s.normalize('NFKC').normalize('NFD').toLowerCase().replace(/[^a-z0-9]/g, '')
}

/** The names a sound's own author may post under: its author, and the name after "original sound -". */
function ownerNames(s: { title: string | null; author: string | null }) {
  const names = new Set<string>()
  const add = (v: string | null | undefined) => {
    const f = foldName(v ?? '')
    if (f.length >= 3) names.add(f)
  }
  add(s.author)
  const title = s.title ?? ''
  const m = GENERIC_ORIGINAL.exec(title)
  if (m) add(title.slice(m[0].length).replace(/^\s*[-–—:]\s*/, ''))
  return names
}

/** The second a TikTok id was made (its high 32 bits), or null. */
export function idSeconds(id: string | null | undefined) {
  if (!id || !/^\d{15,25}$/.test(id)) return null
  return Number(BigInt(id) >> 32n)
}

/** The video's handle (lower case): the stored author, else the `/@handle/video/` part of its URL. */
export function sightingHandle(x: { videoAuthor: string | null; videoUrl: string }) {
  if (x.videoAuthor?.trim()) return x.videoAuthor.trim().toLowerCase()
  const at = x.videoUrl.indexOf('/@')
  if (at < 0) return null
  const end = x.videoUrl.indexOf('/', at + 2)
  const handle = x.videoUrl.slice(at + 2, end < 0 ? undefined : end)
  return handle ? handle.toLowerCase() : null
}

function videoIdOf(url: string) {
  const at = url.indexOf('/video/')
  if (at < 0) return null
  const id = /^\d+/.exec(url.slice(at + 7, at + 7 + 30))
  return id ? id[0] : null
}

type SightingEvidence = { handle: string | null; videoId: string | null; plays: number; rank: number | null }

/**
 * What the sightings by creators other than the sound's own author show:
 * how many of them there are, their best plays and their best rank.
 */
export function outsideEvidence(s: { id: string; title: string | null; author: string | null }, list: SightingEvidence[]) {
  const names = ownerNames(s)
  const soundAt = idSeconds(s.id)
  const owners = new Set<string>()
  for (const x of list) {
    if (!x.handle) continue
    const at = idSeconds(x.videoId)
    const madeTogether = soundAt !== null && at !== null && Math.abs(at - soundAt) <= ORIGIN_SECONDS
    if (madeTogether || names.has(foldName(x.handle))) owners.add(x.handle)
  }
  const reusers = new Set<string>()
  let bestPlays = 0
  let bestRank: number | null = null
  for (const x of list) {
    if (!x.handle || owners.has(x.handle)) continue
    reusers.add(x.handle)
    if (x.plays > bestPlays) bestPlays = x.plays
    if (x.rank !== null && (bestRank === null || x.rank < bestRank)) bestRank = x.rank
  }
  return { reusers: reusers.size, bestPlays, bestRank }
}

/** The gate itself (see the comment above MIN_REUSERS). */
export function soundQuality(i: {
  originalLike: boolean
  ours: { enough: boolean; medianRatio: number | null }
  outside: { reusers: number; bestPlays: number; bestRank: number | null }
}): Quality {
  if (i.ours.enough && i.ours.medianRatio !== null && i.ours.medianRatio >= OURS_RATIO) return { pass: true, reason: 'ours' }
  if (i.originalLike && i.outside.reusers < MIN_REUSERS) return { pass: false, reason: 'speech' }
  if (i.outside.bestRank !== null) return { pass: true, reason: 'trend' }
  if (i.outside.bestPlays >= PLAYS_FLOOR) return { pass: true, reason: 'plays' }
  return { pass: false, reason: 'no_evidence' }
}

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
    /** Creators other than the sound's own author seen using it. */
    reusers: number
  }
  /** Whether the sound passes the quality gate, and why (or why not). */
  quality: Quality
  score: number
  lastSeenAt: string
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d

/**
 * The ranked bank. Our posts count when their publication time
 * (published_at, else created_at) is inside the window; sightings count
 * whenever they were seen (staleness ages them). Every row carries its
 * quality verdict; `onlyQualified` drops the ones that fail it.
 */
export function rankSounds(opts: {
  windowDays: number
  limit: number
  includeHidden?: boolean
  withNotes?: boolean
  /** Leave out sounds that fail the quality gate. */
  onlyQualified?: boolean
  now?: Date
}): RankedSound[] {
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
    const list = viewsByAccount.get(key)
    if (list) list.push(p.views)
    else viewsByAccount.set(key, [p.views])
  }
  const accountMedian = new Map<string, number>()
  for (const [k, v] of viewsByAccount) accountMedian.set(k, median(v) ?? 0)
  const oursBySound = new Map<string, { posts: number; ratios: number[] }>()
  for (const p of pubs) {
    if (!p.soundId) continue
    let entry = oursBySound.get(p.soundId)
    if (!entry) oursBySound.set(p.soundId, (entry = { posts: 0, ratios: [] }))
    entry.posts++
    const m = accountMedian.get(`${p.userId}|${p.platform}`) ?? 0
    if (m > 0) entry.ratios.push(p.views / m)
  }

  // One pass over the sightings: per sound, count, best plays, best rank, sources, newest and best example.
  type Seen = {
    count: number
    bestPlays: number
    bestRank: number | null
    sources: Set<string>
    newest: { seenAt: string; videoUrl: string } | null
    best: { plays: number; seenAt: string; videoUrl: string; rawPlays: number | null } | null
    evidence: SightingEvidence[]
  }
  const seenBySound = new Map<string, Seen>()
  for (const x of db.select().from(soundSightings).all()) {
    let e = seenBySound.get(x.soundId)
    if (!e) seenBySound.set(x.soundId, (e = { count: 0, bestPlays: 0, bestRank: null, sources: new Set(), newest: null, best: null, evidence: [] }))
    e.count++
    const plays = x.plays ?? 0
    if (plays > e.bestPlays) e.bestPlays = plays
    if (typeof x.rank === 'number' && x.rank > 0 && (e.bestRank === null || x.rank < e.bestRank)) e.bestRank = x.rank
    e.sources.add(x.source)
    if (!e.newest || x.seenAt > e.newest.seenAt) e.newest = { seenAt: x.seenAt, videoUrl: x.videoUrl }
    if (!e.best || plays > e.best.plays || (plays === e.best.plays && x.seenAt > e.best.seenAt)) {
      e.best = { plays, seenAt: x.seenAt, videoUrl: x.videoUrl, rawPlays: x.plays }
    }
    e.evidence.push({
      handle: sightingHandle(x),
      videoId: videoIdOf(x.videoUrl),
      plays,
      rank: typeof x.rank === 'number' && x.rank > 0 ? x.rank : null,
    })
  }

  const ranked = bank.map((s): RankedSound & { rawScore: number } => {
    const ours = oursBySound.get(s.id) ?? { posts: 0, ratios: [] }
    const seen = seenBySound.get(s.id)
    const ourMedianRatio = median(ours.ratios)
    const bestPlays = seen?.bestPlays ?? 0
    const bestRank = seen?.bestRank ?? null
    const rawScore = soundScore({ ourMedianRatio, ourPosts: ours.posts, bestPlays, bestRank, lastSeenAt: s.lastSeenAt, now })
    const enough = ours.posts >= ENOUGH_OWN_POSTS
    const outside = outsideEvidence(s, seen?.evidence ?? [])
    const quality = soundQuality({ originalLike: isOriginalLike(s), ours: { enough, medianRatio: ourMedianRatio }, outside })
    return {
      id: s.id,
      title: s.title,
      author: s.author,
      original: s.original,
      url: s.url,
      copyText: copyText(s),
      status: s.status,
      ...(opts.withNotes ? { note: s.note } : {}),
      ours: { posts: ours.posts, medianRatio: ourMedianRatio === null ? null : round(ourMedianRatio, 2), enough },
      sightings: {
        count: seen?.count ?? 0,
        bestPlays,
        bestRank,
        sources: seen ? [...seen.sources].sort() : [],
        newestVideoUrl: seen?.newest?.videoUrl ?? null,
        bestVideoUrl: seen?.best?.videoUrl ?? null,
        bestVideoPlays: seen?.best?.rawPlays ?? null,
        reusers: outside.reusers,
      },
      quality,
      score: round(rawScore, 3),
      lastSeenAt: s.lastSeenAt,
      rawScore,
    }
  })
  ranked.sort((a, b) => b.rawScore - a.rawScore || b.lastSeenAt.localeCompare(a.lastSeenAt) || a.id.localeCompare(b.id))
  const shown = opts.onlyQualified ? ranked.filter((r) => r.quality.pass) : ranked
  return shown.slice(0, opts.limit).map(({ rawScore: _raw, ...row }) => row)
}

/* ---------- the ranking, cached for the route ---------- */

/** GET /api/sounds is on every claimed-post screen: the ranking is kept this long per window. */
export const RANKING_CACHE_MS = 60_000
const rankingCache = new Map<string, { at: number; rows: RankedSound[] }>()

/** Any change to the bank clears it (upsertSound, recordSighting, the admin PATCH). */
export function _clearRankingCache() {
  rankingCache.clear()
}

/**
 * The ranking as the route serves it: computed at most once a minute per
 * window (and hidden-or-not), notes stripped unless asked for, then cut to
 * `limit`. Without `includeHidden` only sounds that pass the quality gate
 * are served; with it (admins' "Show hidden") everything is, each with its verdict.
 */
export function rankSoundsCached(opts: { windowDays: number; limit: number; includeHidden?: boolean; withNotes?: boolean }, now = Date.now()) {
  const key = `${opts.windowDays}|${opts.includeHidden ? 1 : 0}`
  let entry = rankingCache.get(key)
  if (!entry || now - entry.at >= RANKING_CACHE_MS || now < entry.at) {
    entry = {
      at: now,
      rows: rankSounds({
        windowDays: opts.windowDays,
        limit: Number.MAX_SAFE_INTEGER,
        includeHidden: opts.includeHidden,
        onlyQualified: !opts.includeHidden,
        withNotes: true,
        now: new Date(now),
      }),
    }
    rankingCache.set(key, entry)
  }
  const rows = entry.rows.slice(0, opts.limit)
  return opts.withNotes ? rows : rows.map(({ note: _note, ...row }) => row)
}

/* ---------- limits on server-side fetches ---------- */

/**
 * At most this many TikTok page reads at once for the sounds routes, across
 * the process; one of them is kept for people (a paste never waits behind a
 * scout call's dead links).
 */
export const MAX_CONCURRENT_READS = 4
let active = 0
let activeMachine = 0
const waiting: { person: boolean; start: () => void }[] = []

const canStart = (person: boolean) => active < MAX_CONCURRENT_READS && (person || activeMachine < MAX_CONCURRENT_READS - 1)

function take(person: boolean) {
  active++
  if (!person) activeMachine++
}

function pump() {
  for (let i = 0; i < waiting.length; ) {
    const w = waiting[i]!
    if (canStart(w.person)) {
      waiting.splice(i, 1)
      take(w.person)
      w.start()
    } else i++
  }
}

/** Runs `fn` in a read slot. `person`: a signed-in person's paste (may use the reserved slot). */
export async function withReadSlot<T>(fn: () => Promise<T>, person = false): Promise<T> {
  if (canStart(person)) take(person)
  else await new Promise<void>((start) => waiting.push({ person, start }))
  try {
    return await fn()
  } finally {
    active--
    if (!person) activeMachine--
    pump()
  }
}

/** A person may paste this many links a day (UTC). */
export const DAILY_PASTES = 30
/** A sounds token may report this many links a day (UTC). */
export const DAILY_SIGHTINGS = 600
const dailyUse = new Map<string, { day: string; used: number }>()

const today = () => new Date().toISOString().slice(0, 10)

/** Takes `n` from the caller's daily allowance; refuses (and takes nothing) when it would go over `cap`. */
export function takeDaily(key: string, n: number, cap: number): { ok: true } | { ok: false; remaining: number } {
  const day = today()
  let e = dailyUse.get(key)
  if (!e || e.day !== day) dailyUse.set(key, (e = { day, used: 0 }))
  if (e.used + n > cap) return { ok: false, remaining: Math.max(0, cap - e.used) }
  e.used += n
  return { ok: true }
}

/** Tests only. */
export function _useDaily(key: string, n: number) {
  dailyUse.set(key, { day: today(), used: n })
}
export function _resetDailyCaps() {
  dailyUse.clear()
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
