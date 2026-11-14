import type { FastifyInstance, FastifyReply } from 'fastify'
import { and, asc, eq, gte, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/sqlite-core'
import { z } from 'zod'
import { db } from '../db/index.js'
import { contents, metricSnapshots, publications, users } from '../db/schema.js'
import { captionFirstLine, isoTime } from '../lib/fields.js'
import { requireExport } from '../lib/guards.js'

/**
 * Exports for analysis. Deliberately narrow columns: content code, title,
 * the caption's first line (the hook), hook id, source and usernames
 * identify a row; there are no emails, notes, asset paths, full captions,
 * meta or token data in either export.
 */

const querySchema = z.object({
  since: isoTime.optional(),
  assignee: z.string().trim().min(1).max(64).optional(),
  format: z.enum(['json', 'csv']).default('json'),
})

const MAX_ROWS = 50_000

const assignee = alias(users, 'assignee')
const poster = alias(users, 'poster')

const identity = {
  publicationId: publications.id,
  code: contents.code,
  title: contents.title,
  caption: contents.caption,
  hookId: contents.hookId,
  source: contents.source,
  assignee: assignee.username,
  poster: poster.username,
  platform: publications.platform,
  url: publications.publishedUrl,
}

type Row = Record<string, unknown>

/** The identifying columns, in order; the caption itself never leaves: only its first line. */
const IDENTITY_COLUMNS = ['publicationId', 'code', 'title', 'captionFirstLine', 'hookId', 'source', 'assignee', 'poster', 'platform', 'url']

function identify<T extends { caption: string | null; hookId: string | null }>(rows: T[]) {
  return rows.map(({ caption, hookId, ...rest }) => {
    const r = rest as Row
    const out: Row = {}
    for (const c of IDENTITY_COLUMNS) {
      out[c] = c === 'captionFirstLine' ? captionFirstLine(caption) : c === 'hookId' ? (hookId ?? '') : r[c]
    }
    for (const [k, v] of Object.entries(r)) if (!(k in out)) out[k] = v
    return out
  })
}

/** RFC 4180 quoting, plus a leading ' on text that a spreadsheet would run as a formula. */
function csvCell(value: unknown) {
  if (value === null || value === undefined) return ''
  let text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function send(reply: FastifyReply, format: 'json' | 'csv', name: string, columns: string[], rows: Row[]) {
  if (format === 'json') return { rows }
  const lines = [columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))]
  return reply
    .header('Content-Type', 'text/csv; charset=utf-8')
    .header('Content-Disposition', `attachment; filename="${name}.csv"`)
    .send(lines.join('\r\n') + '\r\n')
}

function parse(query: unknown, reply: FastifyReply) {
  const parsed = querySchema.safeParse(query ?? {})
  if (!parsed.success) {
    reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid query' })
    return null
  }
  let assigneeId: string | undefined
  if (parsed.data.assignee) {
    const row = db
      .select({ id: users.id })
      .from(users)
      .where(eq(sql`lower(${users.username})`, parsed.data.assignee.toLowerCase()))
      .get()
    if (!row) {
      reply.code(400).send({ error: 'Unknown assignee' })
      return null
    }
    assigneeId = row.id
  }
  return { ...parsed.data, assigneeId }
}

export async function exportRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireExport)

  /** One row per publication, with its latest counts. */
  app.get('/api/export/publications', async (req, reply) => {
    const q = parse(req.query, reply)
    if (!q) return reply

    const filters: SQL[] = []
    if (q.since) filters.push(gte(sql`coalesce(${publications.publishedAt}, ${publications.createdAt})`, q.since))
    if (q.assigneeId) filters.push(eq(contents.assignedUserId, q.assigneeId))

    const rows = db
      .select({
        ...identity,
        publishedAt: publications.publishedAt,
        publishAt: contents.publishAt,
        views: publications.views,
        likes: publications.likes,
        comments: publications.comments,
        shares: publications.shares,
        lastCheckedAt: publications.lastCheckedAt,
      })
      .from(publications)
      .innerJoin(contents, eq(contents.id, publications.contentId))
      .leftJoin(assignee, eq(assignee.id, contents.assignedUserId))
      .leftJoin(poster, eq(poster.id, publications.userId))
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(asc(sql`coalesce(${publications.publishedAt}, ${publications.createdAt})`))
      .limit(MAX_ROWS)
      .all()

    const columns = [...IDENTITY_COLUMNS, 'publishedAt', 'publishAt', 'views', 'likes', 'comments', 'shares', 'lastCheckedAt']
    return send(reply, q.format, 'publications', columns, identify(rows))
  })

  /** One row per metric snapshot, with the same identifying columns. */
  app.get('/api/export/metrics', async (req, reply) => {
    const q = parse(req.query, reply)
    if (!q) return reply

    const filters: SQL[] = []
    if (q.since) filters.push(gte(metricSnapshots.takenAt, q.since))
    if (q.assigneeId) filters.push(eq(contents.assignedUserId, q.assigneeId))

    const rows = db
      .select({
        ...identity,
        takenAt: metricSnapshots.takenAt,
        label: metricSnapshots.label,
        views: metricSnapshots.views,
        likes: metricSnapshots.likes,
        comments: metricSnapshots.comments,
        shares: metricSnapshots.shares,
        extra: metricSnapshots.extra,
      })
      .from(metricSnapshots)
      .innerJoin(publications, eq(publications.id, metricSnapshots.publicationId))
      .innerJoin(contents, eq(contents.id, publications.contentId))
      .leftJoin(assignee, eq(assignee.id, contents.assignedUserId))
      .leftJoin(poster, eq(poster.id, publications.userId))
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(asc(metricSnapshots.takenAt))
      .limit(MAX_ROWS)
      .all()

    const columns = [...IDENTITY_COLUMNS, 'takenAt', 'label', 'views', 'likes', 'comments', 'shares', 'extra']
    return send(reply, q.format, 'metrics', columns, identify(rows))
  })
}
