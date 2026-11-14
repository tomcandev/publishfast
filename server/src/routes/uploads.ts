import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { once } from 'node:events'
import type { Readable } from 'node:stream'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../db/index.js'
import { assets, contents, uploadParts, uploads, type Upload } from '../db/schema.js'
import { config } from '../lib/config.js'
import {
  NO_SPACE,
  belowFreeSpaceFloor,
  byteLimit,
  bytesInFlight,
  ingestBytesHeld,
  reserveInFlight,
  writeLimited,
} from '../lib/disk.js'
import { classifyUpload, isActiveContent } from '../lib/download.js'
import {
  expectedPartMax,
  newPartFile,
  partPath,
  partsFolder,
  receivedParts,
  removeParts,
  staleCompletingBefore,
  unfinishedUploads,
} from '../lib/uploads.js'
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
const COMPLETING = { error: 'This upload is being completed', reason: 'completing' }

function isCompleting(upload: Upload) {
  return !!upload.completingAt && upload.completingAt >= staleCompletingBefore()
}
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

/** A repeated complete: the same asset, or 404 if that asset has since been deleted (never 201 with null). */
function answerDone(reply: FastifyReply, assetId: string) {
  const asset = publicAsset(assetId)
  if (!asset) return reply.code(404).send({ error: 'The asset this upload became no longer exists' })
  return reply.code(201).send({ asset })
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
    if (tokenId && ingestBytesHeld(tokenId) + bytesInFlight(tokenId) + size > config.maxIngestBytes) {
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
    if (isCompleting(upload)) return reply.code(409).send(COMPLETING)
    if (item.status !== 'DRAFT') return reply.code(409).send(NOT_DRAFT)
    const n = /^[1-9][0-9]{0,6}$/.test(rawN) ? Number(rawN) : NaN
    if (!(n >= 1 && n <= upload.parts)) {
      return reply.code(400).send({ error: `Part number must be 1 to ${upload.parts}` })
    }

    // Held to its expected length: partSize, or what is left of the declared size for the last part.
    const max = expectedPartMax(upload, n)
    const tooLarge = `Part ${n} is at most ${max} bytes`
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > max) {
      return reply.code(413).header('Connection', 'close').send({ error: tooLarge })
    }
    if (await belowFreeSpaceFloor(config.partsDir, max)) return reply.code(507).send({ error: NO_SPACE })
    const release = reserveInFlight(null, max)

    try {
      await mkdir(partsFolder(upload.id), { recursive: true })
      const file = newPartFile(n)
      const path = partPath(upload.id, file)
      const limit = byteLimit(max, 413, tooLarge)
      try {
        await writeLimited(req.body as Readable, limit, path)
      } catch (err) {
        await unlink(path).catch(() => {})
        const code = (err as { statusCode?: number }).statusCode ?? 400
        if (code === 413) reply.header('Connection', 'close')
        return reply.code(code).send({ error: code === 413 ? (err as Error).message : 'Upload failed' })
      }
      const size = limit.bytes()
      if (size === 0) {
        await unlink(path).catch(() => {})
        return reply.code(400).send({ error: 'A part may not be empty' })
      }

      // Record the new copy only if the upload is still live, not completing and its item a draft —
      // one transaction, so a join that has started never sees its parts change.
      let previous: string | null | undefined
      let refused = null as object | null
      db.transaction((tx) => {
        const live = tx
          .select({ completingAt: uploads.completingAt })
          .from(uploads)
          .innerJoin(contents, eq(contents.id, uploads.contentId))
          .where(and(eq(uploads.id, upload.id), isNull(uploads.assetId), eq(contents.status, 'DRAFT')))
          .get()
        if (!live) {
          refused = NOT_DRAFT
          return
        }
        if (live.completingAt && live.completingAt >= staleCompletingBefore()) {
          refused = COMPLETING
          return
        }
        // A stale mark (crashed join) is taken over: clear it, so that join can never commit.
        if (live.completingAt) tx.update(uploads).set({ completingAt: null }).where(eq(uploads.id, upload.id)).run()
        previous = tx
          .select({ file: uploadParts.file })
          .from(uploadParts)
          .where(and(eq(uploadParts.uploadId, upload.id), eq(uploadParts.n, n)))
          .get()?.file
        tx.insert(uploadParts)
          .values({ uploadId: upload.id, n, size, file })
          .onConflictDoUpdate({ target: [uploadParts.uploadId, uploadParts.n], set: { size, file } })
          .run()
      })
      if (refused) {
        await unlink(path).catch(() => {})
        return reply.code(409).send(refused)
      }
      if (previous) await unlink(partPath(upload.id, previous)).catch(() => {})
      req.audit = { contentId: id }
      return { part: n, size }
    } finally {
      release()
    }
  })

  /** The item's unfinished uploads, so a client that lost an upload id can resume it. */
  app.get('/api/ingest/contents/:id/uploads', async (req, reply) => {
    const { id } = req.params as { id: string }
    if (!ownItem(req, id)) return reply.code(404).send(NOT_FOUND)
    return { uploads: unfinishedUploads(id) }
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
    if (upload.assetId) return answerDone(reply, upload.assetId)
    if (item.status !== 'DRAFT') return reply.code(409).send(NOT_DRAFT)

    // 1. Mark the upload as completing (compare-and-swap). While the mark is
    //    fresh no part can change and abort is refused; a mark older than 10
    //    minutes is a crashed join and may be taken over.
    const mark = new Date().toISOString()
    const marked = db
      .update(uploads)
      .set({ completingAt: mark })
      .where(
        and(
          eq(uploads.id, upload.id),
          isNull(uploads.assetId),
          or(isNull(uploads.completingAt), lt(uploads.completingAt, staleCompletingBefore())),
        ),
      )
      .run()
    if (marked.changes === 0) {
      const now = db.select().from(uploads).where(eq(uploads.id, upload.id)).get()
      if (now?.assetId) return answerDone(reply, now.assetId)
      return reply.code(409).send(now ? COMPLETING : { error: 'This upload was aborted', reason: 'aborted' })
    }
    const unmark = () =>
      db
        .update(uploads)
        .set({ completingAt: null })
        .where(and(eq(uploads.id, upload.id), eq(uploads.completingAt, mark)))
        .run()

    const parts = receivedParts(upload.id)
    const have = new Set(parts.map((p) => p.n))
    const missing = Array.from({ length: upload.parts }, (_, i) => i + 1).filter((n) => !have.has(n))
    const total = parts.reduce((sum, p) => sum + p.size, 0)
    if (missing.length > 0 || total !== upload.size) {
      unmark()
      return reply.code(409).send({
        error: missing.length ? 'Some parts are missing' : 'The parts do not add up to the declared size',
        reason: 'incomplete',
        missing,
        receivedBytes: total,
        size: upload.size,
      })
    }
    if (await belowFreeSpaceFloor(config.uploadsDir, upload.size)) {
      unmark()
      return reply.code(507).send({ error: NO_SPACE })
    }

    // 2. Join the parts in order, hashing and counting, into a file inside the
    //    upload's own folder (so a crash leaves it where the sweep removes it).
    const release = reserveInFlight(null, upload.size)
    const joined = join(partsFolder(upload.id), `joined.${randomUUID()}.tmp`)
    const stored = storedName(upload.name)
    const abs = join(config.uploadsDir, stored)
    let ownsFile = false // true once the joined bytes sit at `abs`
    try {
      const hash = createHash('sha256')
      let bytes = 0
      await mkdir(partsFolder(upload.id), { recursive: true })
      const out = createWriteStream(joined, { flags: 'wx' })
      try {
        const failed = new Promise<never>((_, reject) => out.once('error', reject))
        failed.catch(() => {})
        for (const p of parts) {
          for await (const chunk of createReadStream(partPath(upload.id, p.file ?? ''))) {
            bytes += (chunk as Buffer).length
            hash.update(chunk as Buffer)
            if (!out.write(chunk)) await Promise.race([once(out, 'drain'), failed])
          }
        }
        out.end()
        await Promise.race([once(out, 'finish'), failed])
      } catch {
        out.destroy()
        await unlink(joined).catch(() => {})
        unmark()
        // The upload or its item went away during the join: a conflict, not a server error.
        const still = db
          .select({ id: uploads.id })
          .from(uploads)
          .innerJoin(contents, eq(contents.id, uploads.contentId))
          .where(and(eq(uploads.id, upload.id), eq(contents.status, 'DRAFT')))
          .get()
        if (!still) return reply.code(409).send(NOT_DRAFT)
        return reply.code(500).send({ error: 'Could not join the parts' })
      }

      if (bytes !== upload.size) {
        await unlink(joined).catch(() => {})
        unmark()
        return reply.code(409).send({ error: 'The joined parts do not match the declared size', reason: 'incomplete', receivedBytes: bytes, size: upload.size })
      }
      const digest = hash.digest('hex')
      if (upload.sha256 && upload.sha256 !== digest) {
        // Nothing is kept: not the joined file, not the parts, not the upload.
        await unlink(joined).catch(() => {})
        db.delete(uploads).where(and(eq(uploads.id, upload.id), eq(uploads.completingAt, mark))).run()
        await removeParts(upload.id)
        return reply.code(422).send({ error: 'The sha256 of the joined file does not match', reason: 'sha256_mismatch', sha256: digest })
      }

      try {
        await rename(joined, abs)
      } catch {
        // The folder went away (the item was released or deleted meanwhile).
        unmark()
        return reply.code(409).send(NOT_DRAFT)
      }
      ownsFile = true

      // 3. Commit: still our mark, still a draft. Only the request that inserts the asset keeps its file.
      const { type, mime } = classifyUpload(upload.mime ?? '', upload.name)
      const assetId = randomUUID()
      let created: typeof assets.$inferSelect | undefined
      let outcome = 'lost' as 'won' | 'not_draft' | 'lost'
      db.transaction((tx) => {
        const stillDraft = tx.select({ s: contents.status }).from(contents).where(eq(contents.id, id)).get()
        if (stillDraft?.s !== 'DRAFT') {
          outcome = 'not_draft'
          return
        }
        const won = tx
          .update(uploads)
          .set({ assetId, completingAt: null })
          .where(and(eq(uploads.id, upload.id), isNull(uploads.assetId), eq(uploads.completingAt, mark)))
          .run()
        if (won.changes === 0) return
        const nextOrder =
          (tx
            .select({ n: sql<number>`coalesce(max(${assets.sortOrder}), -1)` })
            .from(assets)
            .where(eq(assets.contentId, id))
            .get()?.n ?? -1) + 1
        tx.insert(assets)
          .values({ id: assetId, contentId: id, filePath: stored, originalName: upload.name, mime, size: bytes, sortOrder: nextOrder, type })
          .run()
        created = tx.select().from(assets).where(eq(assets.id, assetId)).get()
        outcome = 'won'
      })

      if (outcome !== 'won') {
        // Remove the file before answering, so nothing is ever visible without its row.
        await unlink(abs).catch(() => {})
        ownsFile = false
        unmark()
        return reply.code(409).send(outcome === 'not_draft' ? NOT_DRAFT : { error: 'This upload changed while it was being completed', reason: 'completing' })
      }
      ownsFile = false // the asset row now owns it
      await removeParts(upload.id)
      req.audit = { contentId: id }
      // The row as committed (the item could be deleted a moment later; the answer still names the asset).
      const { filePath: _hidden, ...asset } = created!
      return reply.code(201).send({ asset })
    } finally {
      release()
      await unlink(joined).catch(() => {})
      if (ownsFile) await unlink(abs).catch(() => {})
    }
  })

  app.delete('/api/ingest/contents/:id/uploads/:uploadId', async (req, reply) => {
    const { id, uploadId } = req.params as { id: string; uploadId: string }
    const found = ownUpload(req, id, uploadId)
    if (!found) return reply.code(404).send(NOT_FOUND)
    if (found.upload.assetId) return reply.code(409).send({ error: 'This upload is already complete', reason: 'complete' })
    // Not while a join is running (a fresh completing mark); a stale mark may be aborted.
    const removed = db
      .delete(uploads)
      .where(
        and(
          eq(uploads.id, uploadId),
          isNull(uploads.assetId),
          or(isNull(uploads.completingAt), lt(uploads.completingAt, staleCompletingBefore())),
        ),
      )
      .run()
    if (removed.changes === 0) return reply.code(409).send(COMPLETING)
    await removeParts(uploadId)
    req.audit = { contentId: id }
    return { ok: true }
  })
}
