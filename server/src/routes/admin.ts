import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index.js'
import { ROLES, apiTokens, assets, contents, publications, pushSubscriptions, reminderSettings, users } from '../db/schema.js'
import { createApiToken, createUser, hashPassword, publicUser } from '../lib/auth.js'
import { releaseStaleClaims } from '../lib/claim.js'
import { config } from '../lib/config.js'
import { isoTime } from '../lib/fields.js'
import { requireAdmin } from '../lib/guards.js'
import { stripTokenIds, withClaimInfo } from '../lib/holds.js'
import { getHookPerformanceSummary, syncAllPublicationMetrics } from '../lib/metrics.js'
import { storageReport } from '../lib/prune.js'

const userSchema = z.object({
  username: z.string().min(2).max(31),
  email: z.string().email().optional().or(z.literal('')),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  displayName: z.string().max(120).optional(),
  role: z.enum(ROLES).default('kol'),
  notes: z.string().max(1000).optional(),
  bioLink: z.string().url().optional().or(z.literal('')).nullable(),
})

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  /* ---------- users ---------- */

  app.get('/api/admin/users', async () => ({
    users: db.select().from(users).orderBy(desc(users.createdAt)).all().map(publicUser),
  }))

  app.post('/api/admin/users', async (req, reply) => {
    const parsed = userSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid input' })
    }
    try {
      const user = await createUser({
        ...parsed.data,
        email: parsed.data.email || null,
        notes: parsed.data.notes || null,
        bioLink: parsed.data.bioLink || null,
      })
      return reply.code(201).send({ user: publicUser(user) })
    } catch (err) {
      const message = (err as Error).message
      const conflict = message.includes('UNIQUE')
        ? 'Username or email already exists'
        : message
      return reply.code(400).send({ error: conflict })
    }
  })

  app.patch('/api/admin/users/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = z
      .object({
        displayName: z.string().max(120).optional(),
        email: z.string().email().optional().or(z.literal('')).nullable(),
        role: z.enum(ROLES).optional(),
        active: z.boolean().optional(),
        password: z.string().min(8, 'Password must be at least 8 characters').optional().or(z.literal('')),
        notes: z.string().max(1000).optional().or(z.literal('')).nullable(),
        bioLink: z.string().url().optional().or(z.literal('')).nullable(),
        /** Only ever sees content assigned to them, never the open queue. */
        assignedOnly: z.boolean().optional(),
      })
      .safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Invalid input' })

    const existing = db.select().from(users).where(eq(users.id, id)).get()
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const { password, email, notes, bioLink, ...rest } = body.data
    const patch: Record<string, unknown> = { ...rest }
    if (email !== undefined) patch.email = email ? email.trim().toLowerCase() : null
    if (notes !== undefined) patch.notes = notes ? notes.trim() : null
    if (bioLink !== undefined) patch.bioLink = bioLink ? bioLink.trim() : null
    if (password && password.trim().length > 0) patch.passwordHash = await hashPassword(password)

    try {
      db.update(users).set(patch).where(eq(users.id, id)).run()
      return { user: publicUser(db.select().from(users).where(eq(users.id, id)).get()!) }
    } catch (err) {
      const message = (err as Error).message
      const conflict = message.includes('UNIQUE') ? 'Email already in use' : message
      return reply.code(400).send({ error: conflict })
    }
  })

  app.get('/api/admin/users/:id/notifications', async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = db.select().from(users).where(eq(users.id, id)).get()
    if (!existing) return reply.code(404).send({ error: 'User not found' })

    const subs = db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, id)).all()
    const setting = db.select().from(reminderSettings).where(eq(reminderSettings.userId, id)).get()

    return {
      subscriptionCount: subs.length,
      enabled: setting ? Boolean(setting.enabled) : false,
      reminderTimes: setting ? setting.reminderTimes.split(',').map((t) => t.trim()).filter(Boolean) : ['18:00'],
      lastNotifiedDate: setting?.lastNotifiedDate || null,
    }
  })

  app.post('/api/admin/users/:id/reset-notifications', async (req, reply) => {
    const { id } = req.params as { id: string }
    const existing = db.select().from(users).where(eq(users.id, id)).get()
    if (!existing) return reply.code(404).send({ error: 'User not found' })

    const result = db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, id)).run()
    db.update(reminderSettings)
      .set({ lastNotifiedDate: null, updatedAt: new Date().toISOString() })
      .where(eq(reminderSettings.userId, id))
      .run()

    return { ok: true, cleared: result.changes }
  })

  /* ---------- contents ---------- */

  app.get('/api/admin/contents', async (req) => {
    const rows = db.select().from(contents).orderBy(desc(contents.createdAt)).limit(500).all()
    if (rows.length === 0) return { contents: [] }
    const ids = rows.map((r) => r.id)
    const assetRows = db
      .select()
      .from(assets)
      .where(inArray(assets.contentId, ids))
      .orderBy(asc(assets.sortOrder))
      .all()
    const pubRows = db.select().from(publications).where(inArray(publications.contentId, ids)).all()

    return {
      contents: withClaimInfo(req, rows).map((row) => ({
        ...stripTokenIds(row),
        assets: assetRows
          .filter((a) => a.contentId === row.id)
          .map(({ filePath: _hidden, ...rest }) => rest),
        publications: pubRows.filter((p) => p.contentId === row.id),
      })),
    }
  })

  app.patch('/api/admin/contents/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = z
      .object({
        code: z.string().min(1).max(120).optional(),
        title: z.string().max(300).optional().or(z.literal('')).nullable(),
        caption: z.string().optional().or(z.literal('')).nullable(),
        contentType: z.enum(['video', 'carousel']).optional(),
        status: z.enum(['DRAFT', 'READY', 'CLAIMED', 'PUBLISHED', 'FAILED']).optional(),
        assignedUserId: z.string().nullable().optional(),
        /** The assignment ends at this time (READY, unclaimed items go back to the open queue). */
        assignExpiresAt: isoTime.nullable().optional(),
      })
      .safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'Invalid input' })

    const existing = db.select().from(contents).where(eq(contents.id, id)).get()
    if (!existing) return reply.code(404).send({ error: 'Not found' })
    const finalAssignee = body.data.assignedUserId !== undefined ? body.data.assignedUserId || null : existing.assignedUserId
    if (body.data.assignExpiresAt && !finalAssignee) {
      return reply.code(400).send({ error: 'assignExpiresAt needs an assignee' })
    }

    const patch: Record<string, unknown> = {}
    if (body.data.code !== undefined) patch.code = body.data.code.trim()
    if (body.data.title !== undefined) patch.title = body.data.title?.trim() || null
    if (body.data.caption !== undefined) patch.caption = body.data.caption?.trim() || null
    if (body.data.contentType !== undefined) patch.contentType = body.data.contentType
    if (body.data.status !== undefined) patch.status = body.data.status
    if (body.data.assignedUserId !== undefined) patch.assignedUserId = body.data.assignedUserId || null
    if (body.data.assignExpiresAt !== undefined) patch.assignExpiresAt = body.data.assignExpiresAt
    // Clearing the assignee clears its expiry.
    if (!finalAssignee) patch.assignExpiresAt = null
    // Sending an item back to DRAFT (soft-archive) also cancels a pending timed release,
    // otherwise the release scheduler would put it straight back in the queue.
    if (body.data.status === 'DRAFT' && existing.status !== 'DRAFT') patch.releaseAt = null

    try {
      db.update(contents).set(patch).where(eq(contents.id, id)).run()
      const updated = db.select().from(contents).where(eq(contents.id, id)).get()!
      const assetRows = db
        .select()
        .from(assets)
        .where(eq(assets.contentId, id))
        .orderBy(asc(assets.sortOrder))
        .all()
        .map(({ filePath: _hidden, ...rest }) => rest)
      const pubRows = db.select().from(publications).where(eq(publications.contentId, id)).all()
      return { content: { ...stripTokenIds(withClaimInfo(req, [updated])[0]!), assets: assetRows, publications: pubRows } }
    } catch (err) {
      const message = (err as Error).message
      const conflict = message.includes('UNIQUE') ? `Code "${body.data.code}" already exists` : message
      return reply.code(400).send({ error: conflict })
    }
  })

  app.delete('/api/admin/contents/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const assetRows = db
      .select({ filePath: assets.filePath })
      .from(assets)
      .where(eq(assets.contentId, id))
      .all()
    for (const a of assetRows) {
      if (a.filePath) {
        unlink(join(config.uploadsDir, a.filePath)).catch(() => {})
      }
    }
    const result = db.delete(contents).where(eq(contents.id, id)).run()
    if (result.changes === 0) return reply.code(404).send({ error: 'Not found' })
    return { ok: true }
  })

  const bulkDeleteSchema = z.object({
    ids: z.array(z.string().min(1)).min(1, 'At least one content ID required'),
  })

  app.post('/api/admin/contents/bulk-delete', async (req, reply) => {
    const parsed = bulkDeleteSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid input' })
    }
    const { ids } = parsed.data
    const assetRows = db
      .select({ filePath: assets.filePath })
      .from(assets)
      .where(inArray(assets.contentId, ids))
      .all()
    for (const a of assetRows) {
      if (a.filePath) {
        unlink(join(config.uploadsDir, a.filePath)).catch(() => {})
      }
    }
    const result = db.delete(contents).where(inArray(contents.id, ids)).run()
    return { deleted: result.changes }
  })

  const bulkStatusSchema = z.object({
    ids: z.array(z.string().min(1)).min(1, 'At least one content ID required'),
    status: z.enum(['DRAFT', 'READY', 'CLAIMED', 'PUBLISHED', 'FAILED']),
  })

  app.post('/api/admin/contents/bulk-status', async (req, reply) => {
    const parsed = bulkStatusSchema.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid input' })
    }
    const { ids, status } = parsed.data
    // As in PATCH: moving an item to DRAFT cancels its pending timed release
    // (items that already were drafts keep theirs; SET sees the old status).
    const result = db
      .update(contents)
      .set(
        status === 'DRAFT'
          ? { status, releaseAt: sql`CASE WHEN ${contents.status} = 'DRAFT' THEN ${contents.releaseAt} ELSE NULL END` }
          : { status },
      )
      .where(inArray(contents.id, ids))
      .run()
    return { updated: result.changes }
  })

  app.delete('/api/admin/assets/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const asset = db.select().from(assets).where(eq(assets.id, id)).get()
    if (asset?.filePath) {
      unlink(join(config.uploadsDir, asset.filePath)).catch(() => {})
    }
    const result = db.delete(assets).where(eq(assets.id, id)).run()
    if (result.changes === 0) return reply.code(404).send({ error: 'Not found' })
    return { ok: true }
  })

  /** Return items stuck in CLAIMED back to the queue. */
  app.post('/api/admin/release-stale', async (req) => {
    const { hours } = (req.body ?? {}) as { hours?: number }
    return { released: releaseStaleClaims(hours && hours > 0 ? hours : 24) }
  })

  /** Bytes and file counts by item status, pruned so far, drop box, unfinished uploads, free disk. */
  app.get('/api/admin/storage', async () => storageReport())

  /* ---------- API tokens for the AI pipeline ---------- */

  app.get('/api/admin/tokens', async () => ({
    tokens: db
      .select({
        id: apiTokens.id,
        name: apiTokens.name,
        role: apiTokens.role,
        createdAt: apiTokens.createdAt,
        lastUsedAt: apiTokens.lastUsedAt,
        scope: apiTokens.scope,
        expiresAt: apiTokens.expiresAt,
        revokedAt: apiTokens.revokedAt,
      })
      .from(apiTokens)
      .orderBy(desc(apiTokens.createdAt))
      .all(),
  }))

  app.post('/api/admin/tokens', async (req, reply) => {
    const body = z
      .object({ name: z.string().min(1).max(120), role: z.enum(ROLES).default('admin') })
      .safeParse(req.body)
    if (!body.success) return reply.code(400).send({ error: 'Token name is required' })

    // Stays an unscoped token, exactly as before; scoped tokens are made with the CLI.
    const token = createApiToken(body.data.name, body.data.role, { createdBy: req.user?.id ?? null })
    // Shown once — only the hash is stored.
    return reply.code(201).send({ token })
  })

  app.delete('/api/admin/tokens/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const result = db.delete(apiTokens).where(eq(apiTokens.id, id)).run()
    if (result.changes === 0) return reply.code(404).send({ error: 'Not found' })
    return { ok: true }
  })

  app.get('/api/admin/publications', async () => ({
    publications: db.select().from(publications).orderBy(desc(publications.createdAt)).limit(500).all(),
  }))

  /* ---------- Social Metrics & Hook Analytics ---------- */

  app.get('/api/admin/metrics', async () => {
    return getHookPerformanceSummary()
  })

  app.post('/api/admin/metrics/sync', async () => {
    const result = await syncAllPublicationMetrics()
    const summary = getHookPerformanceSummary()
    return { ...result, summary }
  })

  app.patch('/api/admin/publications/:id/metrics', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = z
      .object({
        views: z.number().int().min(0).optional(),
        likes: z.number().int().min(0).optional(),
        comments: z.number().int().min(0).optional(),
        shares: z.number().int().min(0).optional(),
      })
      .safeParse(req.body)

    if (!body.success) {
      return reply.code(400).send({ error: 'Invalid metrics data' })
    }

    const existing = db.select().from(publications).where(eq(publications.id, id)).get()
    if (!existing) return reply.code(404).send({ error: 'Publication not found' })

    db.update(publications)
      .set({
        ...body.data,
        lastCheckedAt: new Date().toISOString(),
      })
      .where(eq(publications.id, id))
      .run()

    return { publication: db.select().from(publications).where(eq(publications.id, id)).get() }
  })
}
