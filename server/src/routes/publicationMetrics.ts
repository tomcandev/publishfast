import type { FastifyInstance, FastifyRequest } from 'fastify'
import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index.js'
import { metricSnapshots, publications } from '../db/schema.js'
import { EXTRA_MAX_BYTES, isoTime, jsonObject } from '../lib/fields.js'
import { requireUserOrAdminToken } from '../lib/guards.js'
import { publicSnapshot, recordSnapshot } from '../lib/snapshots.js'

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)

const snapshotSchema = z.object({
  takenAt: isoTime.optional(),
  label: z.string().trim().min(1).max(20).optional(),
  views: count.optional(),
  likes: count.optional(),
  comments: count.optional(),
  shares: count.optional(),
  extra: jsonObject(EXTRA_MAX_BYTES, 'extra').optional(),
})

/** A reading may be back-dated, but not stamped in the future (it would freeze "latest"). */
const FUTURE_SKEW_MS = 10 * 60_000

/**
 * The publication if the caller may see its metrics: its owner (by session
 * or poster token), an admin session, or an admin-power token. Anyone else
 * gets the same 404 as for a publication that does not exist.
 */
function publicationFor(req: FastifyRequest, id: string) {
  const pub = db.select().from(publications).where(eq(publications.id, id)).get()
  if (!pub) return null
  if (req.tokenRole === 'admin' || req.user?.role === 'admin') return pub
  if (req.user && pub.userId === req.user.id) return pub
  return null
}

export async function publicationMetricRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUserOrAdminToken)

  /** Record one reading (24h, 7d, 28d, daily…) and update the publication's latest counts. */
  app.post('/api/publications/:id/metrics', async (req, reply) => {
    const { id } = req.params as { id: string }
    const pub = publicationFor(req, id)
    if (!pub) return reply.code(404).send({ error: 'Publication not found' })

    const parsed = snapshotSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid input' })
    }
    const takenAt = parsed.data.takenAt ?? new Date().toISOString()
    if (Date.parse(takenAt) > Date.now() + FUTURE_SKEW_MS) {
      return reply.code(400).send({ error: 'takenAt cannot be in the future' })
    }

    const snapshot = recordSnapshot(pub, { ...parsed.data, takenAt, tokenId: req.apiToken?.id ?? null })
    req.audit = { contentId: pub.contentId, publicationId: pub.id }
    return reply.code(201).send({
      snapshot: publicSnapshot(snapshot),
      publication: db.select().from(publications).where(eq(publications.id, pub.id)).get(),
    })
  })

  app.get('/api/publications/:id/metrics', async (req, reply) => {
    const { id } = req.params as { id: string }
    const pub = publicationFor(req, id)
    if (!pub) return reply.code(404).send({ error: 'Publication not found' })

    const rows = db
      .select()
      .from(metricSnapshots)
      .where(eq(metricSnapshots.publicationId, pub.id))
      .orderBy(asc(metricSnapshots.takenAt))
      .all()
    return { publication: pub, snapshots: rows.map(publicSnapshot) }
  })
}
