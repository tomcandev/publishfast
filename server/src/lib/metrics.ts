import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { contents, metricSnapshots, publications, users } from '../db/schema.js'
import { upsertSound } from './sounds.js'
import { GuardedFetchError, guardedFetch, upgradeToHttps } from './guardedFetch.js'
import {
  TIKTOK_HOSTS,
  TikTokFetchError,
  allowedTikTokUrl,
  fetchTikTokPage,
  parseTikTokVideoPage,
  soundOf,
  type ParsedSound,
  type TikTokPage,
} from './tiktok.js'

export interface MetricResult {
  views: number
  likes: number
  comments: number
  shares: number
  error: string | null
  /** TikTok only: the post's sound, when the page (or tikwm) named one. */
  sound?: ParsedSound | null
  /** TikTok only: the save count (collectCount), when it was read. */
  saves?: number | null
}

export interface HookPerformanceItem {
  hookId: string
  title: string
  category: string
  totalPosts: number
  totalViews: number
  totalLikes: number
  avgViews: number
  topPostUrl?: string
  status: 'viral' | 'good' | 'average' | 'underperforming' | 'new'
  recommendation: string
}

/**
 * Standard mapping of known Hook IDs to their category and description
 */
export const KNOWN_HOOKS: Record<string, { title: string; category: string }> = {
  h_score_viral_01: {
    title: 'How I jumped from 50 to 90 in 1 week',
    category: 'score_boost',
  },
  h_score_01: {
    title: 'How I boosted my PTE by 25 points in 7 days',
    category: 'score_boost',
  },
  h_score_02: {
    title: 'From 58 to 88: The ONE change that fixed my score',
    category: 'score_boost',
  },
  h_trigger_02: {
    title: 'Visa expiring in 30 days. Here is my 79+ game plan:',
    category: 'external_trigger',
  },
  h_hack_01: {
    title: '3 words PTE always repeats in Write From Dictation',
    category: 'quick_tip',
  },
  h_hack_02: {
    title: 'The 2-second pause trick for Repeat Sentence',
    category: 'strategy',
  },
  h_hack_03: {
    title: 'How to memorize 50 WFD sentences in 15 minutes',
    category: 'strategy',
  },
  h_mistake_01: {
    title: 'Stop practicing full mock tests. Do this instead:',
    category: 'mistake',
  },
  h_myth_01: {
    title: 'Myth: You need perfect British accent to get 90 in PTE',
    category: 'myth_busting',
  },
  h_data_01: {
    title: 'Why Write From Dictation is worth 40+ PTE points',
    category: 'score_data',
  },
}

/**
 * Automatically infer hook_id from title or caption text if not explicitly provided
 */
export function inferHookId(title?: string | null, caption?: string | null): string {
  const text = `${title || ''} ${caption || ''}`.toLowerCase()
  if (text.includes('50 to 90') || text.includes('jumped from 50')) return 'h_score_viral_01'
  if (text.includes('58 to 88') || text.includes('58 to 8')) return 'h_score_02'
  if (text.includes('25 point') || text.includes('boosted my pte by 25')) return 'h_score_01'
  if (text.includes('visa expiring') || text.includes('visa deadline') || text.includes('30 day')) return 'h_trigger_02'
  if (text.includes('2-second pause') || text.includes('pause trick') || text.includes('repeat sentence fluency')) return 'h_hack_02'
  if (text.includes('3 words pte always') || text.includes('3 patterns')) return 'h_hack_01'
  if (text.includes('memorize 50 wfd') || text.includes('50 wfd sentences')) return 'h_hack_03'
  if (text.includes('stop practicing full mock') || text.includes('full mock test')) return 'h_mistake_01'
  if (text.includes('perfect british accent') || text.includes('accent to get 90')) return 'h_myth_01'
  if (text.includes('40+ pte points') || text.includes('worth 40+')) return 'h_data_01'
  return 'custom_hook'
}

/** YouTube hosts the sync reads (https only, through the guard). */
export const YOUTUBE_HOSTS: ReadonlySet<string> = new Set(['www.youtube.com', 'youtube.com', 'm.youtube.com', 'youtu.be'])
const TIKWM_HOSTS: ReadonlySet<string> = new Set(['www.tikwm.com'])

const zeroResult = (): MetricResult => ({ views: 0, likes: 0, comments: 0, shares: 0, error: null })
const failed = (error: string): MetricResult => ({ views: 0, likes: 0, comments: 0, shares: 0, error })

/**
 * Fetch public video/post metrics for a saved link.
 *
 * The link is parsed with the URL parser. A TikTok link (http is read as
 * https) and an https YouTube link are read only through the guarded fetch
 * (lib/guardedFetch.ts) with their own host sets; redirects must stay inside
 * that set. Every other link gets the zero result without any request: a
 * third-party shortener pointing at TikTok or YouTube is no longer followed.
 */
export async function fetchSocialMetrics(rawUrl: string, _platform?: string): Promise<MetricResult> {
  const cleanUrl = rawUrl.trim()
  if (!cleanUrl) {
    return { views: 0, likes: 0, comments: 0, shares: 0, error: 'Empty URL' }
  }

  const tiktok = upgradeToHttps(cleanUrl, TIKTOK_HOSTS)
  if (tiktok) return fetchTikTokMetrics(tiktok.href)

  const youtube = upgradeToHttps(cleanUrl, YOUTUBE_HOSTS)
  if (youtube) return fetchYouTubeMetrics(youtube.href)

  return zeroResult()
}

/** tikwm's answer for a guard-passed TikTok URL, query string removed; null when it has nothing. */
async function readTikwm(target: URL) {
  const clean = new URL(target.href)
  clean.search = ''
  clean.hash = ''
  try {
    const page = await guardedFetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(clean.href)}`, TIKWM_HOSTS, {
      accept: 'application/json',
    })
    if (page.status < 200 || page.status >= 300) return null
    const data = JSON.parse(page.body) as {
      code?: number
      data?: {
        play_count?: number
        digg_count?: number
        comment_count?: number
        share_count?: number
        collect_count?: number
        music_info?: unknown
      }
    }
    return data && data.code === 0 && data.data ? data.data : null
  } catch {
    return null
  }
}

async function fetchTikTokMetrics(url: string): Promise<MetricResult> {
  // Only a URL that passed the TikTok guard is fetched, or sent to tikwm.
  const allowed = allowedTikTokUrl(url)
  if (!allowed) return failed(new TikTokFetchError('refused').message)

  // The video page, through the guard: TikTok hosts only, redirects checked
  // hop by hop, 15 s, 3 MB. It gives the final URL (short links resolved),
  // the sound, and the counts when tikwm has none.
  let page: TikTokPage | null = null
  let pageError = 'TikTok fetch failed'
  try {
    page = await fetchTikTokPage(allowed.href)
  } catch (err) {
    if (err instanceof TikTokFetchError) pageError = err.message
  }
  const parsed = page ? parseTikTokVideoPage(page.body) : null
  const fromPage = parsed?.sound ?? null

  // 1. The public tikwm endpoint (supports both video and photo/carousel URLs)
  const tikwm = await readTikwm(new URL(page?.url ?? allowed.href))
  if (tikwm) {
    return {
      views: Number(tikwm.play_count) || 0,
      likes: Number(tikwm.digg_count) || 0,
      comments: Number(tikwm.comment_count) || 0,
      shares: Number(tikwm.share_count) || 0,
      error: null,
      sound: fromPage ?? soundOf(tikwm.music_info),
      saves: typeof tikwm.collect_count === 'number' && Number.isSafeInteger(tikwm.collect_count) ? tikwm.collect_count : (parsed?.saves ?? null),
    }
  }

  if (!page) return failed(pageError)

  const html = page.body

  let views = 0
  let likes = 0
  let comments = 0
  let shares = 0

  // Search for playCount, diggCount, commentCount, shareCount in SSR payload
  const playMatch = html.match(/"playCount":\s*(\d+)/)
  if (playMatch) views = parseInt(playMatch[1]!, 10)

  const diggMatch = html.match(/"diggCount":\s*(\d+)/)
  if (diggMatch) likes = parseInt(diggMatch[1]!, 10)

  const commentMatch = html.match(/"commentCount":\s*(\d+)/)
  if (commentMatch) comments = parseInt(commentMatch[1]!, 10)

  const shareMatch = html.match(/"shareCount":\s*(\d+)/)
  if (shareMatch) shares = parseInt(shareMatch[1]!, 10)

  const saveMatch = html.match(/"collectCount":\s*(\d+)/)

  return {
    views,
    likes,
    comments,
    shares,
    error: null,
    sound: fromPage,
    saves: parsed?.saves ?? (saveMatch ? parseInt(saveMatch[1]!, 10) : null),
  }
}

async function fetchYouTubeMetrics(url: string): Promise<MetricResult> {
  let html: string
  try {
    html = (await guardedFetch(url, YOUTUBE_HOSTS)).body
  } catch (err) {
    return failed(err instanceof GuardedFetchError ? err.message : 'YouTube fetch failed')
  }

  let views = 0
  const likes = 0

  // Regex for YouTube view count
  const viewMatch =
    html.match(/"viewCount":\s*"(\d+)"/) ||
    html.match(/\\"viewCount\\":\s*\\"(\d+)\\"/) ||
    html.match(/(\d[\d,.]*)\s+views/i)

  if (viewMatch) {
    const numStr = viewMatch[1]!.replace(/[,.]/g, '')
    views = parseInt(numStr, 10) || 0
  }

  return {
    views,
    likes,
    comments: 0,
    shares: 0,
    error: null,
  }
}

/**
 * Synchronize all publication metrics in database
 */
export async function syncAllPublicationMetrics(): Promise<{
  totalChecked: number
  updated: number
  errors: number
}> {
  const pubs = db.select().from(publications).all()
  let updated = 0
  let errors = 0

  const nowIso = new Date().toISOString()

  for (const pub of pubs) {
    if (!pub.publishedUrl) continue

    const metrics = await fetchSocialMetrics(pub.publishedUrl, pub.platform)

    const counts = {
      views: metrics.views > 0 ? metrics.views : pub.views,
      likes: metrics.likes > 0 ? metrics.likes : pub.likes,
      comments: metrics.comments > 0 ? metrics.comments : pub.comments,
      shares: metrics.shares > 0 ? metrics.shares : pub.shares,
      // Same rule as the other counts: a reading of 0 or none keeps the last one.
      saves: typeof metrics.saves === 'number' && metrics.saves > 0 ? metrics.saves : pub.saves,
    }
    // The post's TikTok sound, when the page named one; a page without one leaves the old value.
    const sound = !metrics.error && metrics.sound ? metrics.sound : null
    db.update(publications)
      .set({
        ...counts,
        lastCheckedAt: nowIso,
        metricError: metrics.error,
        ...(sound
          ? { soundId: sound.id, soundTitle: sound.title || null, soundAuthor: sound.author || null, soundOriginal: sound.original }
          : {}),
      })
      .where(eq(publications.id, pub.id))
      .run()
    if (sound) {
      // Into the bank too, dated by the post's publication time (evidence, not the sync's clock).
      const t = Date.parse(pub.publishedAt ?? pub.createdAt)
      upsertSound(sound, Number.isFinite(t) && t <= Date.now() ? new Date(t).toISOString() : nowIso)
    }

    // Keep the history too. A failed fetch changed no counts, so it adds no reading.
    if (!metrics.error) {
      db.insert(metricSnapshots)
        .values({ id: randomUUID(), publicationId: pub.id, takenAt: nowIso, label: 'auto', ...counts })
        .run()
    }

    if (metrics.error) {
      errors++
    } else {
      updated++
    }

    // Small delay to be polite to host servers
    await new Promise((r) => setTimeout(r, 300))
  }

  return {
    totalChecked: pubs.filter((p) => Boolean(p.publishedUrl)).length,
    updated,
    errors,
  }
}

/**
 * Compute Hook Performance Analytics Summary
 */
export function getHookPerformanceSummary(): {
  summary: {
    totalPublications: number
    totalViews: number
    totalLikes: number
    avgViewsPerPost: number
  }
  kols: {
    totalKols: number
    postedKols: Array<{ id: string; username: string; displayName: string; postCount: number }>
    missingKols: Array<{ id: string; username: string; displayName: string }>
  }
  hooks: HookPerformanceItem[]
  posts: Array<{
    publicationId: string
    contentId: string
    userId: string
    username: string
    displayName: string
    code: string
    title: string
    hookId: string
    hookTitle: string
    platform: string
    publishedUrl: string
    publishedAt: string | null
    views: number
    likes: number
    comments: number
    lastCheckedAt: string | null
  }>
} {
  const allContents = db.select().from(contents).all()
  const allPubs = db.select().from(publications).all()
  const allUsers = db.select().from(users).where(eq(users.active, true)).all()

  // Map lookups
  const contentMap = new Map(allContents.map((c) => [c.id, c]))
  const userMap = new Map(allUsers.map((u) => [u.id, u]))

  const postList = []
  const hookStats = new Map<
    string,
    {
      totalPosts: number
      totalViews: number
      totalLikes: number
      topPostUrl?: string
      maxViews: number
    }
  >()

  const userPostCounts = new Map<string, number>()

  let grandTotalViews = 0
  let grandTotalLikes = 0

  for (const pub of allPubs) {
    if (!pub.publishedUrl) continue
    const c = contentMap.get(pub.contentId)
    const u = userMap.get(pub.userId)
    const hookId = c?.hookId || inferHookId(c?.title, c?.caption)
    const hookTitle = KNOWN_HOOKS[hookId]?.title || c?.title || 'Untitled'

    grandTotalViews += pub.views || 0
    grandTotalLikes += pub.likes || 0

    userPostCounts.set(pub.userId, (userPostCounts.get(pub.userId) || 0) + 1)

    postList.push({
      publicationId: pub.id,
      contentId: pub.contentId,
      userId: pub.userId,
      username: u?.username || 'unknown',
      displayName: u?.displayName || u?.username || 'Unknown',
      code: c?.code || 'UNKNOWN',
      title: c?.title || 'Untitled',
      hookId,
      hookTitle,
      platform: pub.platform,
      publishedUrl: pub.publishedUrl,
      publishedAt: pub.publishedAt,
      views: pub.views || 0,
      likes: pub.likes || 0,
      comments: pub.comments || 0,
      lastCheckedAt: pub.lastCheckedAt,
    })

    const curr = hookStats.get(hookId) || {
      totalPosts: 0,
      totalViews: 0,
      totalLikes: 0,
      maxViews: 0,
    }

    curr.totalPosts += 1
    curr.totalViews += pub.views || 0
    curr.totalLikes += pub.likes || 0
    if ((pub.views || 0) >= curr.maxViews) {
      curr.maxViews = pub.views || 0
      curr.topPostUrl = pub.publishedUrl
    }

    hookStats.set(hookId, curr)
  }

  // Active KOL tracking
  const kolUsers = allUsers.filter((u) => u.role === 'kol')
  const postedKols: Array<{ id: string; username: string; displayName: string; postCount: number }> = []
  const missingKols: Array<{ id: string; username: string; displayName: string }> = []

  for (const k of kolUsers) {
    const count = userPostCounts.get(k.id) || 0
    if (count > 0) {
      postedKols.push({ id: k.id, username: k.username, displayName: k.displayName, postCount: count })
    } else {
      missingKols.push({ id: k.id, username: k.username, displayName: k.displayName })
    }
  }

  // Build ranked hook list
  const hookItems: HookPerformanceItem[] = []
  const allHookIds = new Set([...Object.keys(KNOWN_HOOKS), ...hookStats.keys()])

  for (const hid of allHookIds) {
    const stats = hookStats.get(hid) || {
      totalPosts: 0,
      totalViews: 0,
      totalLikes: 0,
      maxViews: 0,
    }

    const known = KNOWN_HOOKS[hid]
    const title = known ? known.title : hid === 'custom_hook' ? 'Custom Generated Hook' : hid
    const category = known ? known.category : 'general'
    const avgViews = stats.totalPosts > 0 ? Math.round(stats.totalViews / stats.totalPosts) : 0

    let status: HookPerformanceItem['status'] = 'new'
    let recommendation = 'Awaiting more data'

    if (stats.totalPosts === 0) {
      status = 'new'
      recommendation = 'Ready for production batch'
    } else if (avgViews >= 10000) {
      status = 'viral'
      recommendation = '🏆 Top Performer: Scale up & duplicate across all KOLs'
    } else if (avgViews >= 2000) {
      status = 'good'
      recommendation = '🚀 High CTR: Prioritize in daily schedule'
    } else if (avgViews >= 500) {
      status = 'average'
      recommendation = '⭐ Stable: Keep in regular rotation'
    } else {
      status = 'underperforming'
      recommendation = '⚠️ Low views: Soft-archive or refine caption hook'
    }

    hookItems.push({
      hookId: hid,
      title,
      category,
      totalPosts: stats.totalPosts,
      totalViews: stats.totalViews,
      totalLikes: stats.totalLikes,
      avgViews,
      topPostUrl: stats.topPostUrl,
      status,
      recommendation,
    })
  }

  // Sort hooks by avgViews desc
  hookItems.sort((a, b) => {
    if (a.totalPosts > 0 && b.totalPosts === 0) return -1
    if (b.totalPosts > 0 && a.totalPosts === 0) return 1
    return b.avgViews - a.avgViews
  })

  // Sort posts strictly by views descending (highest view first), then publishedAt desc
  const sortedPosts = postList.sort((a, b) => {
    if (b.views !== a.views) return b.views - a.views
    return (b.publishedAt || '').localeCompare(a.publishedAt || '')
  })

  return {
    summary: {
      totalPublications: postList.length,
      totalViews: grandTotalViews,
      totalLikes: grandTotalLikes,
      avgViewsPerPost: postList.length > 0 ? Math.round(grandTotalViews / postList.length) : 0,
    },
    kols: {
      totalKols: kolUsers.length,
      postedKols,
      missingKols,
    },
    hooks: hookItems,
    posts: sortedPosts,
  }
}
