import { createReadStream, existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import archiver from 'archiver'
import type { FastifyInstance } from 'fastify'
import { and, asc, eq, or } from 'drizzle-orm'
import { db } from '../db/index.js'
import { assets, contents, type User } from '../db/schema.js'
import { claimableBy } from '../lib/claim.js'
import { config } from '../lib/config.js'
import { SANDBOX_CSP, contentDisposition, sendFileHeaders } from '../lib/download.js'
import { requireUser } from '../lib/guards.js'

/** Same visibility rule as the contents routes, applied to media. */
function canSeeContent(contentId: string, user: User) {
  if (user.role === 'admin') {
    return !!db.select().from(contents).where(eq(contents.id, contentId)).get()
  }
  return !!db
    .select()
    .from(contents)
    .where(
      and(
        eq(contents.id, contentId),
        or(claimableBy(user.id, user.assignedOnly), eq(contents.claimedBy, user.id)),
      ),
    )
    .get()
}

/**
 * Resolve a stored relative path to an absolute one, refusing anything that
 * escapes the uploads directory. Paths are generated server-side, but this
 * keeps a malformed or tampered row from turning into an arbitrary file read.
 */
function safeUploadPath(filePath: string) {
  const abs = resolve(join(config.uploadsDir, filePath))
  const root = resolve(config.uploadsDir)
  if (abs !== root && !abs.startsWith(root + '/')) return null
  return abs
}

function prunedReply(prunedAt: string) {
  return { error: `Media removed ${prunedAt.slice(0, 10)}`, reason: 'pruned', prunedAt }
}

export async function assetRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireUser)

  /** Inline preview (video player / image thumb) and attachment download. */
  for (const [suffix, disposition] of [
    ['', 'inline'],
    ['/download', 'attachment'],
  ] as const) {
    app.get(`/api/assets/:id${suffix}`, async (req, reply) => {
      const { id } = req.params as { id: string }
      const asset = db.select().from(assets).where(eq(assets.id, id)).get()
      if (!asset) return reply.code(404).send({ error: 'File not found' })

      if (!canSeeContent(asset.contentId, req.user!)) {
        return reply.code(404).send({ error: 'File not found' })
      }
      // Deleted by the media prune after the post was done (lib/prune.ts); the row stays.
      if (asset.prunedAt) return reply.code(410).send(prunedReply(asset.prunedAt))

      const abs = safeUploadPath(asset.filePath)
      if (!abs || !existsSync(abs)) return reply.code(404).send({ error: 'File no longer exists on server' })

      // Safe list only inline; anything else (svg, html, …) is an inert attachment.
      sendFileHeaders(reply, {
        mime: asset.mime,
        filename: basename(asset.originalName),
        size: asset.size,
        inline: disposition === 'inline',
      })
      return reply.send(createReadStream(abs))
    })
  }

  /** "Download all images" — stream a carousel as one zip. */
  app.get('/api/contents/:id/assets.zip', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!canSeeContent(id, req.user!)) return reply.code(404).send({ error: 'Post not found' })

    const content = db.select().from(contents).where(eq(contents.id, id)).get()!
    const rows = db
      .select()
      .from(assets)
      .where(eq(assets.contentId, id))
      .orderBy(asc(assets.sortOrder))
      .all()

    if (rows.length === 0) return reply.code(404).send({ error: 'This post has no media files' })
    // Only the files that still exist; 410 when the prune removed all of them.
    const live = rows.filter((a) => !a.prunedAt)
    if (live.length === 0) {
      const newest = rows.map((a) => a.prunedAt!).sort().at(-1)!
      return reply.code(410).send(prunedReply(newest))
    }

    const archive = archiver('zip', { zlib: { level: 0 } }) // media is already compressed
    reply
      .header('Content-Type', 'application/zip')
      .header('Content-Disposition', contentDisposition('attachment', `${content.code}.zip`))
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', SANDBOX_CSP)

    archive.on('warning', (err) => app.log.warn({ err }, 'zip warning'))
    archive.on('error', (err) => {
      app.log.error({ err }, 'zip failed')
      reply.raw.destroy(err)
    })

    for (const [i, asset] of live.entries()) {
      const abs = safeUploadPath(asset.filePath)
      if (!abs || !existsSync(abs)) continue
      const ext = asset.originalName.includes('.') ? asset.originalName.split('.').pop() : 'bin'
      archive.file(abs, { name: `${content.code}-${String(i + 1).padStart(2, '0')}.${ext}` })
    }

    void archive.finalize()
    return reply.send(archive)
  })
}
