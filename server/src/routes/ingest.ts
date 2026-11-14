import { randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index.js'
import { CONTENT_TYPES, assets, contents, publications, users, type Content } from '../db/schema.js'
import { config } from '../lib/config.js'
import { isActiveContent } from '../lib/download.js'
import { META_MAX_BYTES, isoTime, jsonObject } from '../lib/fields.js'
import { requireIngest } from '../lib/guards.js'

import { inferHookId } from '../lib/metrics.js'

const createSchema = z.object({
  code: z.string().min(1).max(120),
  title: z.string().max(300).optional(),
  caption: z.string().optional(),
  contentType: z.enum(CONTENT_TYPES).default('video'),
  status: z.enum(['DRAFT', 'READY']).default('DRAFT'),
  /** A user id, or a username. */
  assignedUserId: z.string().optional(),
  hookId: z.string().optional(),
  /** A DRAFT with releaseAt is flipped to READY by the server when the time comes. */
  releaseAt: isoTime.nullable().optional(),
  /** When the post should go public on its platform (information for the poster). */
  publishAt: isoTime.nullable().optional(),
  meta: jsonObject(META_MAX_BYTES, 'meta').nullable().optional(),
  source: z.string().max(200).nullable().optional(),
})

/** True for a token limited to the ingest scope (not an old or admin token). */
function ingestScoped(req: FastifyRequest) {
  return req.apiToken?.scope === 'ingest' ? req.apiToken : null
}

/** Resolves an assignee given as a user id or a username. */
function resolveAssignee(value: string) {
  const byId = db.select({ id: users.id }).from(users).where(eq(users.id, value)).get()
  if (byId) return byId.id
  const byName = db
    .select({ id: users.id })
    .from(users)
    .where(eq(sql`lower(${users.username})`, value.trim().toLowerCase()))
    .get()
  return byName?.id ?? null
}

function withAssets(rows: Content[]) {
  if (rows.length === 0) return []
  const assetRows = db
    .select()
    .from(assets)
    .where(
      inArray(
        assets.contentId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(assets.sortOrder))
    .all()
  return rows.map((row) => ({
    ...row,
    assets: assetRows
      .filter((a) => a.contentId === row.id)
      // Never expose on-disk paths to the client.
      .map(({ filePath: _hidden, ...rest }) => rest),
  }))
}

/**
 * True inside a statement when the item has no publication. Withdraw and the
 * deletes put it in their compare-and-swap, so a link recorded at any moment
 * (and the metric history under it) can never be erased by a cascade.
 */
const hasNoPublications = (contentId: typeof contents.id | typeof assets.contentId) =>
  sql`NOT EXISTS (SELECT 1 FROM ${publications} WHERE ${publications.contentId} = ${contentId})`

function hasPublications(contentId: string) {
  return !!db.select({ id: publications.id }).from(publications).where(eq(publications.contentId, contentId)).get()
}

const HAS_PUBLICATIONS = {
  error: 'This item already has a published link; it cannot be withdrawn or deleted',
  reason: 'has_publications',
}

const ASSIGNEE_REQUIRED = 'This token must assign every item to one of its assignees'

/** Names whose bytes are clearly not media, for uploads sent as application/octet-stream. */
const NON_MEDIA_EXT = new Set(['.srt', '.vtt', '.ass', '.ssa', '.txt', '.json', '.csv', '.md', '.pdf', '.zip'])

/**
 * Asset type. video/* and image/* as always; any other declared type is a
 * `file` (subtitles and the like). A generic application/octet-stream keeps
 * the old fallback (`image`), which existing pipelines that upload without a
 * type rely on, unless the name is plainly not media.
 */
function assetType(mime: string, filename: string): 'video' | 'image' | 'file' {
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('image/')) return 'image'
  if (mime === 'application/octet-stream') {
    return NON_MEDIA_EXT.has(extname(filename).toLowerCase()) ? 'file' : 'image'
  }
  return 'file'
}

async function unlinkUpload(filePath: string) {
  const root = config.uploadsDir
  const abs = join(root, filePath)
  if (!abs.startsWith(root + '/')) return
  await unlink(abs).catch(() => {})
}

export async function ingestRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireIngest)

  /** Create a content item. Used by the AI generator. */
  app.post('/api/ingest/contents', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid input' })
    }

    let assignedUserId: string | null = null
    if (parsed.data.assignedUserId !== undefined) {
      assignedUserId = resolveAssignee(parsed.data.assignedUserId)
      if (!assignedUserId) return reply.code(400).send({ error: 'Unknown assignedUserId' })
    }

    const scoped = ingestScoped(req)
    if (scoped && scoped.assignees.length > 0) {
      // Never defaulted to the open queue: the item must name one of the token's assignees.
      if (!assignedUserId || !scoped.assignees.includes(assignedUserId)) {
        return reply.code(400).send({ error: ASSIGNEE_REQUIRED })
      }
    }

    const existing = db.select().from(contents).where(eq(contents.code, parsed.data.code)).get()
    if (existing) return reply.code(409).send({ error: `Code "${parsed.data.code}" already exists` })

    const id = randomUUID()
    const hookId = parsed.data.hookId || inferHookId(parsed.data.title, parsed.data.caption)

    db.insert(contents)
      .values({
        id,
        ...parsed.data,
        hookId,
        assignedUserId,
        createdByToken: req.apiToken?.id ?? null,
      })
      .run()

    req.audit = { contentId: id }
    return reply.code(201).send({ content: db.select().from(contents).where(eq(contents.id, id)).get() })
  })

  /**
   * Read back items, e.g. to resume an interrupted upload: `?code=` finds one
   * by its code. An ingest-scope token only ever sees items it created.
   */
  app.get('/api/ingest/contents', async (req) => {
    const { code } = req.query as { code?: string }
    const scoped = ingestScoped(req)
    const filters = [
      typeof code === 'string' && code ? eq(contents.code, code) : undefined,
      scoped ? eq(contents.createdByToken, scoped.id) : undefined,
    ].filter((f) => f !== undefined)

    const rows = db
      .select()
      .from(contents)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(contents.createdAt))
      .limit(200)
      .all()
    return { contents: withAssets(rows) }
  })

  app.get('/api/ingest/contents/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const scoped = ingestScoped(req)
    const row = db.select().from(contents).where(eq(contents.id, id)).get()
    if (!row || (scoped && row.createdByToken !== scoped.id)) {
      return reply.code(404).send({ error: 'Not found' })
    }
    return { content: withAssets([row])[0] }
  })

  app.patch('/api/ingest/contents/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const parsed = createSchema.partial().safeParse(req.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid input' })

    const scoped = ingestScoped(req)
    const existing = db.select().from(contents).where(eq(contents.id, id)).get()
    if (!existing || (scoped && existing.createdByToken !== scoped.id)) {
      return reply.code(404).send({ error: 'Not found' })
    }
    if (scoped && existing.status !== 'DRAFT') {
      return reply.code(409).send({ error: 'This item is no longer a draft and cannot be changed', reason: 'not_draft' })
    }

    const patch: Partial<typeof contents.$inferInsert> = { ...parsed.data }
    if (parsed.data.assignedUserId !== undefined) {
      const resolved = resolveAssignee(parsed.data.assignedUserId)
      if (!resolved) return reply.code(400).send({ error: 'Unknown assignedUserId' })
      patch.assignedUserId = resolved
    }
    if (scoped && scoped.assignees.length > 0) {
      const finalAssignee = patch.assignedUserId ?? existing.assignedUserId
      if (!finalAssignee || !scoped.assignees.includes(finalAssignee)) {
        return reply.code(400).send({ error: ASSIGNEE_REQUIRED })
      }
    }
    // Moving an item back to DRAFT cancels a pending release unless a new one is given.
    if (patch.status === 'DRAFT' && existing.status !== 'DRAFT' && patch.releaseAt === undefined) {
      patch.releaseAt = null
    }
    if (Object.keys(patch).length === 0) return { content: existing }

    try {
      // For an ingest-scope token the DRAFT and ownership checks are repeated
      // inside the UPDATE, so a release that lands in between wins.
      const result = db
        .update(contents)
        .set(patch)
        .where(
          scoped
            ? and(eq(contents.id, id), eq(contents.status, 'DRAFT'), eq(contents.createdByToken, scoped.id))
            : eq(contents.id, id),
        )
        .run()
      if (result.changes === 0) {
        return reply.code(409).send({ error: 'This item is no longer a draft and cannot be changed', reason: 'not_draft' })
      }
    } catch (err) {
      if ((err as Error).message.includes('UNIQUE')) {
        return reply.code(409).send({ error: `Code "${parsed.data.code}" already exists` })
      }
      throw err
    }
    return { content: db.select().from(contents).where(eq(contents.id, id)).get() }
  })

  /**
   * Attach media. Accepts one or more files in a multipart request; each is
   * streamed straight to disk so a large video never sits in memory.
   */
  app.post('/api/ingest/contents/:id/assets', async (req, reply) => {
    const { id } = req.params as { id: string }
    const scoped = ingestScoped(req)
    const content = db.select().from(contents).where(eq(contents.id, id)).get()
    if (!content || (scoped && content.createdByToken !== scoped.id)) {
      return reply.code(404).send({ error: 'Post not found' })
    }
    const notDraft = () =>
      reply.code(409).send({ error: 'This item is no longer a draft and cannot be changed', reason: 'not_draft' })
    if (scoped && content.status !== 'DRAFT') return notDraft()

    if (!req.isMultipart()) {
      return reply.code(400).send({ error: 'Content-Type must be multipart/form-data' })
    }

    const nextOrder =
      (db
        .select({ n: sql<number>`coalesce(max(${assets.sortOrder}), -1)` })
        .from(assets)
        .where(eq(assets.contentId, id))
        .get()?.n ?? -1) + 1

    const created: string[] = []
    const writtenPaths: string[] = []
    let index = 0

    try {
      for await (const part of req.files()) {
        // Scoped tokens may never store something a browser could run (svg, html, xml…).
        // Old admin tokens still may; such files are only ever served as attachments.
        if (req.apiToken?.scope && isActiveContent(part.mimetype || '', part.filename || '')) {
          part.file.resume()
          throw Object.assign(new Error('This file type is not accepted (svg, html and xml are refused)'), {
            statusCode: 400,
          })
        }
        const ext = extname(part.filename || '').slice(0, 12) || ''
        const stored = `${randomUUID()}${ext}`
        const abs = join(config.uploadsDir, stored)

        await pipeline(part.file, createWriteStream(abs))
        if (part.file.truncated) {
          throw Object.assign(new Error('File size exceeds allowed limit'), { statusCode: 413 })
        }
        writtenPaths.push(abs)

        if (scoped) {
          // The item may have been released while the file streamed in.
          const now = db.select({ status: contents.status }).from(contents).where(eq(contents.id, id)).get()
          if (now?.status !== 'DRAFT') {
            throw Object.assign(new Error('This item is no longer a draft and cannot be changed'), {
              statusCode: 409,
            })
          }
        }

        const mime = part.mimetype || 'application/octet-stream'
        const assetId = randomUUID()
        db.insert(assets)
          .values({
            id: assetId,
            contentId: id,
            filePath: stored,
            originalName: part.filename || stored,
            mime,
            size: (await import('node:fs')).statSync(abs).size,
            sortOrder: nextOrder + index,
            type: assetType(mime, part.filename || ''),
          })
          .run()
        created.push(assetId)
        index++
      }
    } catch (err) {
      // Don't leave orphaned files behind if the upload fails partway.
      await Promise.all(writtenPaths.map((p) => unlink(p).catch(() => {})))
      // ...nor rows pointing at the files just removed.
      if (created.length > 0) db.delete(assets).where(inArray(assets.id, created)).run()
      const status = (err as { statusCode?: number }).statusCode ?? 400
      return reply.code(status).send({ error: (err as Error).message })
    }

    if (created.length === 0) return reply.code(400).send({ error: 'No files were uploaded' })

    return reply.code(201).send({
      assets: db
        .select()
        .from(assets)
        .where(eq(assets.contentId, id))
        .orderBy(asc(assets.sortOrder))
        .all()
        .map(({ filePath: _hidden, ...rest }) => rest),
    })
  })

  /**
   * Take an item back to DRAFT so it can be made again: only when it is READY
   * and nobody holds it, as one compare-and-swap. A pending timed release is
   * cancelled too. 409 with the current status when it is claimed or done.
   */
  app.post('/api/ingest/contents/:id/withdraw', async (req, reply) => {
    const { id } = req.params as { id: string }
    const scoped = ingestScoped(req)
    const existing = db.select().from(contents).where(eq(contents.id, id)).get()
    if (!existing || (scoped && existing.createdByToken !== scoped.id)) {
      return reply.code(404).send({ error: 'Not found' })
    }
    if (existing.status === 'DRAFT') return { content: withAssets([existing])[0] }

    const result = db
      .update(contents)
      .set({ status: 'DRAFT', releaseAt: null })
      .where(
        and(eq(contents.id, id), eq(contents.status, 'READY'), isNull(contents.claimedBy), hasNoPublications(contents.id)),
      )
      .run()
    const now = db.select().from(contents).where(eq(contents.id, id)).get()!
    if (result.changes === 0 && now.status === 'READY' && hasPublications(id)) {
      return reply.code(409).send({ ...HAS_PUBLICATIONS, status: now.status })
    }
    if (result.changes === 0 && now.status !== 'DRAFT') {
      return reply.code(409).send({
        error: `This item is ${now.status} and can no longer be withdrawn`,
        reason: 'not_withdrawable',
        status: now.status,
      })
    }
    return { content: withAssets([now])[0] }
  })

  /** Delete one asset of an item still in DRAFT (its bytes too). */
  app.delete('/api/ingest/contents/:id/assets/:assetId', async (req, reply) => {
    const { id, assetId } = req.params as { id: string; assetId: string }
    const scoped = ingestScoped(req)
    const content = db.select().from(contents).where(eq(contents.id, id)).get()
    if (!content || (scoped && content.createdByToken !== scoped.id)) {
      return reply.code(404).send({ error: 'Not found' })
    }
    const asset = db
      .select()
      .from(assets)
      .where(and(eq(assets.id, assetId), eq(assets.contentId, id)))
      .get()
    if (!asset) return reply.code(404).send({ error: 'Not found' })
    // DRAFT and no publication, checked inside the DELETE.
    const result = db
      .delete(assets)
      .where(
        and(
          eq(assets.id, asset.id),
          sql`EXISTS (SELECT 1 FROM ${contents} WHERE ${contents.id} = ${assets.contentId} AND ${contents.status} = 'DRAFT')`,
          hasNoPublications(assets.contentId),
        ),
      )
      .run()
    if (result.changes === 0) {
      if (hasPublications(id)) return reply.code(409).send(HAS_PUBLICATIONS)
      return reply.code(409).send({ error: 'This item is no longer a draft and cannot be changed', reason: 'not_draft' })
    }
    await unlinkUpload(asset.filePath)
    return { ok: true }
  })

  /** Delete an item still in DRAFT, with its files. */
  app.delete('/api/ingest/contents/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const scoped = ingestScoped(req)
    const content = db.select().from(contents).where(eq(contents.id, id)).get()
    if (!content || (scoped && content.createdByToken !== scoped.id)) {
      return reply.code(404).send({ error: 'Not found' })
    }
    const assetRows = db.select({ filePath: assets.filePath }).from(assets).where(eq(assets.contentId, id)).all()
    // Only a DRAFT, checked inside the DELETE (asset rows go with it by cascade).
    const result = db
      .delete(contents)
      .where(and(eq(contents.id, id), eq(contents.status, 'DRAFT'), hasNoPublications(contents.id)))
      .run()
    if (result.changes === 0) {
      if (hasPublications(id)) return reply.code(409).send({ ...HAS_PUBLICATIONS, status: content.status })
      return reply.code(409).send({ error: 'Only a draft can be deleted', reason: 'not_draft', status: content.status })
    }
    await Promise.all(assetRows.map((a) => unlinkUpload(a.filePath)))
    return { ok: true }
  })
}
