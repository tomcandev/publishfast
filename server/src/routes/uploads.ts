import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import type { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index.js'
import { assets, contents, uploadParts, uploads, type Upload } from '../db/schema.js'
import { config } from '../lib/config.js'
import { NO_SPACE, belowFreeSpaceFloor, byteLimit, ingestBytesHeld, writeLimited } from '../lib/disk.js'
import { classifyUpload, isActiveContent } from '../lib/download.js'
import { partPath, partsFolder, receivedParts, removeParts } from '../lib/uploads.js'
import { storedName } from './ingest.js'

/**
 * Uploads in parts (contract section 12). Cloudflare refuses request bodies
 * over 100 MB, so a large video is sent as parts of at most `partSize`
 * (UPLOAD_PART_BYTES, default 32 MB), then joined on the server into one
 * asset exactly as the multipart route would store it.
 *
 * Callers: an ingest-scope token on an item it created that is still DRAFT,
 * or an admin-power token (old admin tokens included). Every path on disk is
 * server-made (upload uuid, part number); nothing a client sends is a path.
 */

const initSchema = z.object({
  // Same rules as a multipart file name, plus: no path separators or control characters.
  name: z
    .string()
    .min(1)
    .max(255)
    .refine((n) => !/[\x00-\x1f\x7f/\\]/.test(n), 'name may not contain / \\ or control characters'),
  size: z.number().int().min(1),
  mime: z.string().max(255).optional(),
  sha256: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'sha256 must be 64 hex characters')
    .transform((h) => h.toLowerCase())
    .optional(),
})

const NOT_FOUND = { error: 'Not found' }
const NOT_DRAFT = { error: 'This item is no longer a draft and cannot be changed', reason: 'not_draft' }
const INIT_MAX_BYTES = 16 * 1024

function scopedTokenId(req: FastifyRequest) {
  return req.apiToken?.scope === 'ingest' ? req.apiToken.id : null
}

/** Ingest-scope tokens and admin-power tokens only (not sessions, not old kol-role tokens). */
async function requireUploader(req: FastifyRequest, reply: FastifyReply) {
  if (req.apiToken?.scope === 'ingest' || req.tokenRole === 'admin') return
  reply.code(req.user || req.apiToken ? 403 : 401).send({ error: 'An ingest or admin token is required' })
  return reply
}

/** The item, if this caller may change it: it exists and (for an ingest token) is its own. */
function ownItem(req: FastifyRequest, id: string) {
  const row = db.select().from(contents).where(eq(contents.id, id)).get()
  const tokenId = scopedTokenId(req)
  if (!row || (tokenId && row.createdByToken !== tokenId)) return null
  return row
}

function ownUpload(req: FastifyRequest, contentId: string, uploadId: string) {
  const item = ownItem(req, contentId)
  if (!item) return null
  const upload = db
    .select()
    .from(uploads)
    .where(and(eq(uploads.id, uploadId), eq(uploads.contentId, contentId)))
    .get()
  return upload ? { item, upload } : null
}

async function readSmallBody(stream: Readable | undefined) {
  if (!stream) return ''
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of stream) {
    size += (chunk as Buffer).length
    if (size > INIT_MAX_BYTES) throw Object.assign(new Error('Body too large'), { statusCode: 413 })
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function publicAsset(id: string) {
  const row = db.select().from(assets).where(eq(assets.id, id)).get()
  if (!row) return null
  const { filePath: _hidden, ...rest } = row
  return rest
}

function status(upload: Upload) {
  return {
    uploadId: upload.id,
    name: upload.name,
    size: upload.size,
    partSize: upload.partSize,
    parts: upload.parts,
    received: receivedParts(upload.id).map((p) => p.n),
    completed: !!upload.assetId,
  }
}

export async function uploadRoutes(app: FastifyInstance) {
  // Every body here is handed over as a raw stream: parts are streamed to
  // disk, the small JSON of init is read by hand with a 16 KB limit.
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload))
  app.addHook('preHandler', requireUploader)

  app.post('/api/ingest/contents/:id/uploads', async (req, reply) => {
    const { id } = req.params as { id: string }
    let body: unknown
    try {
      const text = await readSmallBody(req.body as Readable | undefined)
      body = text ? JSON.parse(text) : {}
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode ?? 400
      return reply.code(code).send({ error: code === 413 ? 'Body too large' : 'Body must be JSON' })
    }
    const parsed = initSchema.safeParse(body)
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid input' })
    const { name, size, mime, sha256 } = parsed.data

    const item = ownItem(req, id)
    if (!item) return reply.code(404).send(NOT_FOUND)
    if (item.status !== 'DRAFT') return reply.code(409).send(NOT_DRAFT)
    if (req.apiToken?.scope && isActiveContent(mime ?? '', name)) {
      return reply.code(400).send({ error: 'This file type is not accepted (svg, html and xml are refused)' })
    }

    // Every limit a one-request upload has, applied to the declared size before any byte arrives.
    if (size > config.maxUploadBytes) {
      return reply.code(413).send({ error: `The file is larger than ${config.maxUploadBytes} bytes` })
    }
    const tokenId = scopedTokenId(req)
    if (tokenId && ingestBytesHeld(tokenId) + size > config.maxIngestBytes) {
      return reply.code(413).send({ error: 'This token already holds its maximum of draft and ready media' })
    }
    // Room for the parts and, at complete, the joined file.
    if (await belowFreeSpaceFloor(config.partsDir, size * 2)) return reply.code(507).send({ error: NO_SPACE })

    const partSize = config.uploadPartBytes
    const uploadId = randomUUID()
    db.insert(uploads)
      .values({
        id: uploadId,
        contentId: id,
        tokenId: req.apiToken?.id ?? null,
        name,
        size,
        partSize,
        parts: Math.ceil(size / partSize),
        mime: mime ?? null,
        sha256: sha256 ?? null,
      })
      .run()
    req.audit = { contentId: id }
    return reply.code(201).send({ uploadId, partSize, parts: Math.ceil(size / partSize) })
  })

  app.put('/api/ingest/contents/:id/uploads/:uploadId/parts/:n', async (req, reply) => {
    const { id, uploadId, n: rawN } = req.params as { id: string; uploadId: string; n: string }
    const found = ownUpload(req, id, uploadId)
    if (!found) return reply.code(404).send(NOT_FOUND)
    const { item, upload } = found
    if (upload.assetId) return reply.code(409).send({ error: 'This upload is already complete', reason: 'complete' })
    if (item.status !== 'DRAFT') return reply.code(409).send(NOT_DRAFT)
    const n = /^[1-9][0-9]{0,6}$/.test(rawN) ? Number(rawN) : NaN
    if (!(n >= 1 && n <= upload.parts)) {
      return reply.code(400).send({ error: `Part number must be 1 to ${upload.parts}` })
    }

    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > upload.partSize) {
      return reply.code(413).header('Connection', 'close').send({ error: `A part is at most ${upload.partSize} bytes` })
    }
    if (await belowFreeSpaceFloor(config.partsDir, Number.isFinite(declared) ? declared : upload.partSize)) {
      return reply.code(507).send({ error: NO_SPACE })
    }

    await mkdir(partsFolder(upload.id), { recursive: true })
    const final = partPath(upload.id, n)
    const tmp = `${final}.${randomUUID()}.tmp`
    const limit = byteLimit(upload.partSize, 413, `A part is at most ${upload.partSize} bytes`)
    try {
      await writeLimited(req.body as Readable, limit, tmp)
    } catch (err) {
      await unlink(tmp).catch(() => {})
      const code = (err as { statusCode?: number }).statusCode ?? 400
      if (code === 413) reply.header('Connection', 'close')
      return reply.code(code).send({ error: code === 413 ? (err as Error).message : 'Upload failed' })
    }
    const size = limit.bytes()
    if (size === 0) {
      await unlink(tmp).catch(() => {})
      return reply.code(400).send({ error: 'A part may not be empty' })
    }

    // Still a live upload of a draft? Then the part replaces any earlier copy.
    const live = db
      .select({ id: uploads.id })
      .from(uploads)
      .innerJoin(contents, eq(contents.id, uploads.contentId))
      .where(and(eq(uploads.id, upload.id), isNull(uploads.assetId), eq(contents.status, 'DRAFT')))
      .get()
    if (!live) {
      await unlink(tmp).catch(() => {})
      return reply.code(409).send(NOT_DRAFT)
    }
    await rename(tmp, final)
    db.insert(uploadParts)
      .values({ uploadId: upload.id, n, size })
      .onConflictDoUpdate({ target: [uploadParts.uploadId, uploadParts.n], set: { size } })
      .run()
    req.audit = { contentId: id }
    return { part: n, size }
  })

  app.get('/api/ingest/contents/:id/uploads/:uploadId', async (req, reply) => {
    const { id, uploadId } = req.params as { id: string; uploadId: string }
    const found = ownUpload(req, id, uploadId)
    if (!found) return reply.code(404).send(NOT_FOUND)
    return status(found.upload)
  })

  app.post('/api/ingest/contents/:id/uploads/:uploadId/complete', async (req, reply) => {
    const { id, uploadId } = req.params as { id: string; uploadId: string }
    ;(req.body as Readable | undefined)?.resume?.()
    const found = ownUpload(req, id, uploadId)
    if (!found) return reply.code(404).send(NOT_FOUND)
    const { item, upload } = found
    if (upload.assetId) return reply.code(201).send({ asset: publicAsset(upload.assetId) })
    if (item.status !== 'DRAFT') return reply.code(409).send(NOT_DRAFT)

    const parts = receivedParts(upload.id)
    const have = new Set(parts.map((p) => p.n))
    const missing = Array.from({ length: upload.parts }, (_, i) => i + 1).filter((n) => !have.has(n))
    const total = parts.reduce((sum, p) => sum + p.size, 0)
    if (missing.length > 0 || total !== upload.size) {
      return reply.code(409).send({
        error: missing.length ? 'Some parts are missing' : 'The parts do not add up to the declared size',
        reason: 'incomplete',
        missing,
        receivedBytes: total,
        size: upload.size,
      })
    }
    if (await belowFreeSpaceFloor(config.uploadsDir, upload.size)) return reply.code(507).send({ error: NO_SPACE })

    // Join the parts in order into one stored file, hashing as we go.
    const stored = storedName(upload.name)
    const abs = join(config.uploadsDir, stored)
    const hash = createHash('sha256')
    const out = createWriteStream(abs, { flags: 'wx' })
    try {
      const failed = new Promise<never>((_, reject) => out.once('error', reject))
      failed.catch(() => {})
      for (let n = 1; n <= upload.parts; n++) {
        for await (const chunk of createReadStream(partPath(upload.id, n))) {
          hash.update(chunk as Buffer)
          if (!out.write(chunk)) await Promise.race([once(out, 'drain'), failed])
        }
      }
      out.end()
      await Promise.race([once(out, 'finish'), failed])
    } catch {
      out.destroy()
      await unlink(abs).catch(() => {})
      return reply.code(500).send({ error: 'Could not join the parts' })
    }

    const digest = hash.digest('hex')
    if (upload.sha256 && upload.sha256 !== digest) {
      // Nothing is kept: not the joined file, not the parts, not the upload.
      await unlink(abs).catch(() => {})
      await removeParts(upload.id)
      db.delete(uploads).where(eq(uploads.id, upload.id)).run()
      return reply.code(422).send({ error: 'The sha256 of the joined file does not match', reason: 'sha256_mismatch', sha256: digest })
    }

    const { type, mime } = classifyUpload(upload.mime ?? '', upload.name)
    const assetId = randomUUID()
    let winner: string | null = null
    let notDraft = false
    db.transaction((tx) => {
      // Compare-and-swap: still a draft, and nobody completed this upload meanwhile.
      const stillDraft = tx.select({ s: contents.status }).from(contents).where(eq(contents.id, id)).get()
      if (stillDraft?.s !== 'DRAFT') {
        notDraft = true
        return
      }
      const claimed = tx
        .update(uploads)
        .set({ assetId })
        .where(and(eq(uploads.id, upload.id), isNull(uploads.assetId)))
        .run()
      if (claimed.changes === 0) {
        winner = tx.select({ a: uploads.assetId }).from(uploads).where(eq(uploads.id, upload.id)).get()?.a ?? null
        return
      }
      const nextOrder =
        (tx
          .select({ n: sql<number>`coalesce(max(${assets.sortOrder}), -1)` })
          .from(assets)
          .where(eq(assets.contentId, id))
          .get()?.n ?? -1) + 1
      tx.insert(assets)
        .values({
          id: assetId,
          contentId: id,
          filePath: stored,
          originalName: upload.name,
          mime,
          size: upload.size,
          sortOrder: nextOrder,
          type,
        })
        .run()
    })
    if (notDraft || winner) await unlink(abs).catch(() => {})
    if (notDraft) return reply.code(409).send(NOT_DRAFT)
    await removeParts(upload.id)
    req.audit = { contentId: id }
    return reply.code(201).send({ asset: publicAsset(winner ?? assetId) })
  })

  app.delete('/api/ingest/contents/:id/uploads/:uploadId', async (req, reply) => {
    const { id, uploadId } = req.params as { id: string; uploadId: string }
    const found = ownUpload(req, id, uploadId)
    if (!found) return reply.code(404).send(NOT_FOUND)
    if (found.upload.assetId) return reply.code(409).send({ error: 'This upload is already complete', reason: 'complete' })
    db.delete(uploads).where(and(eq(uploads.id, uploadId), isNull(uploads.assetId))).run()
    await removeParts(uploadId)
    req.audit = { contentId: id }
    return { ok: true }
  })
}
