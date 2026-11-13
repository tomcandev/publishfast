import type { FastifyInstance } from 'fastify'
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { assets, contents, publications, users, type Content, type User } from '../db/schema.js'
import { claimContent, claimNext, claimableBy, releaseContent } from '../lib/claim.js'
import { requireUser } from '../lib/guards.js'

/**
 * What a KOL is allowed to see: unclaimed work that is up for grabs, plus
 * anything they themselves claimed. Never another KOL's items.
 *
 * This is the isolation that Directus's free tier silently dropped — there it
 * was a permission filter that the API refused to save, leaving every KOL able
 * to read and edit every row. Here it is an ordinary WHERE clause that cannot
 * be configured away.
 */
function visibleToKol(user: User) {
  // An assigned_only user never sees the open queue (see claimableBy).
  return or(claimableBy(user.id, user.assignedOnly), eq(contents.claimedBy, user.id))
}

function scopeFor(user: User) {
  return user.role === 'admin' ? undefined : visibleToKol(user)
}

/** Attaches assets and publications to a set of contents in two queries. */
function hydrate(rows: Content[]) {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)

  const assetRows = db
    .select()
    .from(assets)
    .where(inArray(assets.contentId, ids))
    .orderBy(asc(assets.sortOrder))
    .all()

  const pubRows = db.select().from(publications).where(inArray(publications.contentId, ids)).all()

  // created_by_token is internal bookkeeping for ingest tokens; the queue never needs it.
  return rows.map(({ createdByToken: _internal, ...row }) => ({
    ...row,
    assets: assetRows
      .filter((a) => a.contentId === row.id)
      // Never expose on-disk paths to the client; downloads go through /api/assets/:id.
      .map(({ filePath: _hidden, ...rest }) => rest),
    publications: pubRows.filter((p) => p.contentId === row.id),
  }))
}

export async function contentRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser)

  /** Queue listing, already scoped to what the caller may see. */
  app.get('/api/contents', async (req) => {
    const { status } = req.query as { status?: string }
    const user = req.user!

    const filters = [scopeFor(user), status ? eq(contents.status, status as Content['status']) : undefined]
      .filter(Boolean)

    const rows = db
      .select()
      .from(contents)
      .where(filters.length ? and(...(filters as any[])) : undefined)
      .orderBy(desc(contents.createdAt))
      .limit(200)
      .all()

    return { contents: hydrate(rows) }
  })

  /** Counters for the queue screen. */
  app.get('/api/contents/stats', async (req) => {
    const user = req.user!
    const available = db
      .select({ n: sql<number>`count(*)` })
      .from(contents)
      .where(claimableBy(user.id, user.assignedOnly))
      .get()

    const mine = db
      .select({ n: sql<number>`count(*)` })
      .from(contents)
      .where(and(eq(contents.claimedBy, user.id), eq(contents.status, 'CLAIMED')))
      .get()

    const done = db
      .select({ n: sql<number>`count(*)` })
      .from(contents)
      .where(and(eq(contents.claimedBy, user.id), eq(contents.status, 'PUBLISHED')))
      .get()

    return { available: available?.n ?? 0, claimed: mine?.n ?? 0, published: done?.n ?? 0 }
  })

  app.get('/api/contents/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const user = req.user!
    const scope = scopeFor(user)

    const row = db
      .select()
      .from(contents)
      .where(scope ? and(eq(contents.id, id), scope) : eq(contents.id, id))
      .get()

    // 404 rather than 403 so a KOL can't probe which ids exist.
    if (!row) return reply.code(404).send({ error: 'Post not found' })
    return { content: hydrate([row])[0] }
  })

  /** Claim the next available item — the "Claim next post" button. */
  app.post('/api/contents/claim-next', async (req, reply) => {
    const user = req.user!
    const result = claimNext(user.id, { assignedOnly: user.assignedOnly })
    if (!result.ok) {
      return reply.code(404).send({ error: 'No posts are currently ready', reason: result.reason })
    }
    req.audit = { contentId: result.content.id }
    return { content: hydrate([result.content])[0] }
  })

  app.post('/api/contents/:id/claim', async (req, reply) => {
    const { id } = req.params as { id: string }
    const result = claimContent(id, req.user!.id, { assignedOnly: req.user!.assignedOnly })
    if (!result.ok) {
      const code = result.reason === 'not_found' ? 404 : 409
      const error =
        result.reason === 'not_found' ? 'Post not found' : 'This post was just claimed by someone else'
      return reply.code(code).send({ error, reason: result.reason })
    }
    return { content: hydrate([result.content])[0] }
  })

  app.post('/api/contents/:id/release', async (req, reply) => {
    const { id } = req.params as { id: string }
    const user = req.user!
    const ok = releaseContent(id, user.id, user.role === 'admin')
    if (!ok) return reply.code(409).send({ error: 'Cannot return this post' })
    return { ok: true }
  })

  /** Mark a claimed item finished once its links are recorded. */
  app.post('/api/contents/:id/complete', async (req, reply) => {
    const { id } = req.params as { id: string }
    const user = req.user!

    const owned = and(
      eq(contents.id, id),
      eq(contents.status, 'CLAIMED'),
      ...(user.role === 'admin' ? [] : [eq(contents.claimedBy, user.id)]),
    )

    const existing = db.select().from(contents).where(owned).get()
    if (!existing) return reply.code(409).send({ error: 'This post is not in claimed status' })

    const pubCount = db
      .select({ n: sql<number>`count(*)` })
      .from(publications)
      .where(and(eq(publications.contentId, id), eq(publications.status, 'PUBLISHED')))
      .get()

    if (!pubCount?.n) {
      return reply.code(400).send({ error: 'At least one published link is required before completing' })
    }

    db.update(contents).set({ status: 'PUBLISHED' }).where(eq(contents.id, id)).run()
    return { content: hydrate([db.select().from(contents).where(eq(contents.id, id)).get()!])[0] }
  })

  /** This KOL's published history. */
  app.get('/api/history', async (req) => {
    const user = req.user!
    const rows = db
      .select()
      .from(contents)
      .where(and(eq(contents.claimedBy, user.id), eq(contents.status, 'PUBLISHED')))
      .orderBy(desc(contents.claimedAt))
      .limit(100)
      .all()
    return { contents: hydrate(rows) }
  })
}
