import type { FastifyInstance, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index.js'
import { SOUND_SOURCES, SOUND_STATUSES, sounds } from '../db/schema.js'
import { requireAdmin, requireSessionOrAdminToken, requireSoundsReader, requireSoundsWriter } from '../lib/guards.js'
import {
  DAILY_PASTES,
  DAILY_SIGHTINGS,
  _clearRankingCache,
  isOurVideo,
  rankSoundsCached,
  recordSighting,
  takeCaller,
  takeDaily,
  withReadSlot,
  type SightingInput,
} from '../lib/sounds.js'
import {
  TikTokFetchError,
  allowedTikTokUrl,
  copyText,
  fetchTikTokPage,
  parseTikTokVideoPage,
  parseTikwmVideo,
  readTikwm,
  type ParsedSound,
  type ParsedVideo,
} from '../lib/tiktok.js'

/**
 * The sound bank (contract section 13). Sounds enter it only from what the
 * server itself reads about a TikTok video: the page, else tikwm. Callers
 * send video links, never sound data. Every read goes through lib/tiktok.ts's
 * guard (tikwm is asked only about a link that passed it).
 */

export const MAX_SIGHTINGS_PER_CALL = 50
/** A sightings call stops starting new reads after this long (the tunnel answers 524 at 100 s). */
export const SIGHTINGS_BUDGET_MS = 75_000

const videoUrl = z.string().trim().min(1, 'videoUrl is required').max(2048, 'videoUrl is too long')

const sightingsSchema = z.object({
  items: z
    .array(
      z.object({
        videoUrl,
        source: z.enum(SOUND_SOURCES),
        region: z
          .string()
          .regex(/^[A-Za-z]{2}$/, 'region must be 2 letters')
          .transform((s) => s.toUpperCase())
          .optional(),
        rank: z.number().int().min(1).max(1000).optional(),
      }),
    )
    .min(1, 'items must not be empty')
    .max(MAX_SIGHTINGS_PER_CALL, `At most ${MAX_SIGHTINGS_PER_CALL} items per call`),
})

const listSchema = z.object({
  window: z.enum(['7', '14', '30']).default('14'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  hidden: z.enum(['0', '1']).optional(),
})

const patchSchema = z
  .object({
    status: z.enum(SOUND_STATUSES).optional(),
    note: z.string().max(300, 'note must be at most 300 characters').nullable().optional(),
  })
  .refine((b) => b.status !== undefined || b.note !== undefined, 'Nothing to change')

export type SightingResult = {
  videoUrl: string
  status: 'recorded' | 'known' | 'unreadable'
  soundId?: string
  /** Why it is unreadable (or `our_post` for one of our own videos). Never upstream text. */
  reason?: string
}

/**
 * Reads one video link and records its sound. Never throws. `admin`: only an
 * admin learns that a video is one of our own posts. `person`: a person's
 * paste, which may use the read slot kept for people.
 */
async function readSighting(
  input: SightingInput & { videoUrl: string },
  tokenId: string | null,
  deadline: number,
  who: { admin: boolean; person: boolean },
): Promise<SightingResult> {
  const base = { videoUrl: input.videoUrl }
  const allowed = allowedTikTokUrl(input.videoUrl)
  if (!allowed) return { ...base, status: 'unreadable', reason: 'refused' }
  return withReadSlot(async (): Promise<SightingResult> => {
    if (Date.now() > deadline) return { ...base, status: 'unreadable', reason: 'time_budget' }
    let read = await readPage(input.videoUrl)
    if ('reason' in read) {
      // TikTok serves some servers (the VPS) an empty shell page: ask tikwm about the same link,
      // unless the call is out of time. Nothing from it: the page's reason stands.
      const fromTikwm = Date.now() > deadline ? null : await readViaTikwm(new URL(read.url ?? allowed.href))
      if (!fromTikwm) return { ...base, status: 'unreadable', reason: read.reason }
      read = fromTikwm
    }
    const { parsed, url } = read
    // A sighting is a video outside our own posts; ours get their sound from the sync.
    if (isOurVideo(parsed.videoId)) {
      return { ...base, status: 'known', soundId: parsed.sound.id, ...(who.admin ? { reason: 'our_post' } : {}) }
    }
    const status = recordSighting(parsed, url, input, tokenId)
    return { ...base, status, soundId: parsed.sound.id }
  }, who.person)
}

type Read = { parsed: ParsedVideo & { sound: ParsedSound }; url: string }

/** The video page, through the guard: what it says, or why not (and the final URL when a page came back). */
async function readPage(videoUrl: string): Promise<Read | { reason: string; url?: string }> {
  let page
  try {
    page = await fetchTikTokPage(videoUrl)
  } catch (err) {
    return { reason: err instanceof TikTokFetchError ? err.reason : 'unreachable' }
  }
  if (page.status < 200 || page.status >= 300) return { reason: 'not_found', url: page.url }
  const parsed = parseTikTokVideoPage(page.body)
  if (!parsed?.sound) return { reason: 'no_sound', url: page.url }
  return { parsed: { ...parsed, sound: parsed.sound }, url: page.url }
}

/**
 * tikwm's answer for a guard-passed link, when it names the video and its
 * sound. The stored URL is the canonical one from tikwm's author and id
 * (else the link without its query): tikwm may have resolved a short link itself.
 */
async function readViaTikwm(target: URL): Promise<Read | null> {
  const parsed = parseTikwmVideo(await readTikwm(target))
  if (!parsed?.sound || !parsed.videoId) return null
  return { parsed: { ...parsed, sound: parsed.sound }, url: target.href }
}

function callerKey(req: FastifyRequest) {
  return req.apiToken ? `token:${req.apiToken.id}` : `user:${req.user?.id ?? 'unknown'}`
}

const BUSY = { error: 'A sound read for this caller is already running; try again when it finishes', reason: 'busy' }

const isAdmin = (req: FastifyRequest) => req.tokenRole === 'admin' || (req.user?.role === 'admin' && !req.apiToken)

const dailyLimit = (cap: number, remaining: number, what: string) => ({
  error: `At most ${cap} ${what} a day; ${remaining} left today`,
  reason: 'daily_limit',
  remaining,
})

export async function soundRoutes(app: FastifyInstance) {
  /** A trend scout reports videos it saw; the server reads each page itself. */
  app.post('/api/sounds/sightings', { preHandler: requireSoundsWriter }, async (req, reply) => {
    const parsed = sightingsSchema.safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid input' })
    const release = takeCaller(callerKey(req))
    if (!release) return reply.code(429).send(BUSY)
    try {
      // A sounds token reports at most DAILY_SIGHTINGS links a day; a call that would go over is refused whole.
      if (req.apiToken?.scope === 'sounds') {
        const allowance = takeDaily(callerKey(req), parsed.data.items.length, DAILY_SIGHTINGS)
        if (!allowance.ok) return reply.code(429).send(dailyLimit(DAILY_SIGHTINGS, allowance.remaining, 'links'))
      }
      const deadline = Date.now() + SIGHTINGS_BUDGET_MS
      const tokenId = req.apiToken?.id ?? null
      const who = { admin: isAdmin(req), person: false }
      const results = await Promise.all(parsed.data.items.map((item) => readSighting(item, tokenId, deadline, who)))
      return { results }
    } finally {
      release()
    }
  })

  /** "Paste a viral video you saw": one link, source manual. */
  app.post('/api/sounds/from-link', { preHandler: requireSessionOrAdminToken }, async (req, reply) => {
    const parsed = z.object({ videoUrl }).safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid input' })
    if (!allowedTikTokUrl(parsed.data.videoUrl)) {
      return reply.code(400).send({
        error: 'Only TikTok video links can be read (https://www.tiktok.com/…, vt.tiktok.com or vm.tiktok.com)',
        reason: 'refused',
      })
    }
    const release = takeCaller(callerKey(req))
    if (!release) return reply.code(429).send(BUSY)
    try {
      const person = !req.apiToken
      // A person may paste DAILY_PASTES links a day.
      if (person) {
        const allowance = takeDaily(callerKey(req), 1, DAILY_PASTES)
        if (!allowance.ok) return reply.code(429).send(dailyLimit(DAILY_PASTES, allowance.remaining, 'pasted links'))
      }
      const result = await readSighting(
        { videoUrl: parsed.data.videoUrl, source: 'manual' },
        req.apiToken?.id ?? null,
        Date.now() + SIGHTINGS_BUDGET_MS,
        { admin: isAdmin(req), person },
      )
      if (result.status === 'unreadable') {
        return reply.code(422).send({ error: 'Could not read a sound from this link', reason: result.reason })
      }
      const sound = db.select().from(sounds).where(eq(sounds.id, result.soundId!)).get()
      return {
        status: result.status,
        ...(result.reason ? { reason: result.reason } : {}),
        sound: sound
          ? { id: sound.id, title: sound.title, author: sound.author, original: sound.original, url: sound.url, copyText: copyText(sound) }
          : { id: result.soundId },
      }
    } finally {
      release()
    }
  })

  /** The ranking. Hidden sounds are left out (admins may ask for them with hidden=1). */
  app.get('/api/sounds', { preHandler: requireSoundsReader }, async (req, reply) => {
    const parsed = listSchema.safeParse(req.query ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid query' })
    const admin = isAdmin(req)
    const windowDays = Number(parsed.data.window)
    return {
      window: windowDays,
      sounds: rankSoundsCached({
        windowDays,
        limit: parsed.data.limit,
        includeHidden: admin && parsed.data.hidden === '1',
        withNotes: admin,
      }),
    }
  })

  app.patch('/api/admin/sounds/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = patchSchema.safeParse(req.body ?? {})
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid input' })
    const patch: { status?: (typeof SOUND_STATUSES)[number]; note?: string | null } = {}
    if (parsed.data.status !== undefined) patch.status = parsed.data.status
    if (parsed.data.note !== undefined) patch.note = parsed.data.note?.trim() || null
    const result = db.update(sounds).set(patch).where(eq(sounds.id, id)).run()
    if (result.changes === 0) return reply.code(404).send({ error: 'Not found' })
    _clearRankingCache()
    return { sound: db.select().from(sounds).where(eq(sounds.id, id)).get() }
  })
}
