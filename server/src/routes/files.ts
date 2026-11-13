import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { files, type StoredFile } from '../db/schema.js'
import { config } from '../lib/config.js'
import { isValidFileKey, removeStoredFile, storedFilePath } from '../lib/files.js'
import { requireFileToken } from '../lib/guards.js'

/**
 * The drop box: temporary hand-over files under keys like
 * `nhi/voice/issue-12.zip`. A token touches only keys starting with its
 * file_prefix; anything else, missing or expired answers 404 (never 403), so
 * keys cannot be probed. Admin-power tokens see every key.
 */

const DEFAULT_EXPIRY_DAYS = 7
const MAX_EXPIRY_DAYS = 30
const NOT_FOUND = { error: 'Not found' }

/** The prefix this caller may use: '' for admin power, null for none at all. */
function prefixFor(req: FastifyRequest) {
  if (req.tokenRole === 'admin') return ''
  return req.apiToken?.filePrefix ?? null
}

function keyFrom(req: FastifyRequest) {
  return (req.params as { '*'?: string })['*'] ?? ''
}

function mayTouch(req: FastifyRequest, key: string) {
  const prefix = prefixFor(req)
  return prefix !== null && key.startsWith(prefix)
}

function cleanMime(value: unknown) {
  const mime = typeof value === 'string' ? value.split(';')[0]!.trim().toLowerCase() : ''
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/.test(mime)
    ? mime
    : 'application/octet-stream'
}

/** The live (unexpired) row for a key the caller may touch, or null. */
function liveFile(req: FastifyRequest, key: string) {
  if (!mayTouch(req, key)) return null
  return (
    db
      .select()
      .from(files)
      .where(and(eq(files.key, key), gt(files.expiresAt, new Date().toISOString())))
      .get() ?? null
  )
}

function fileHeaders(reply: FastifyReply, row: StoredFile) {
  const name = row.key.split('/').pop()!
  return reply
    .header('Content-Type', row.mime)
    .header('Content-Length', String(row.size))
    .header('Content-Disposition', `attachment; filename="${name}"`)
    .header('X-Content-Type-Options', 'nosniff')
    .header('X-Sha256', row.sha256)
    .header('X-Expires-At', row.expiresAt)
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { statusCode: status })
}

export async function fileRoutes(app: FastifyInstance) {
  // Raw bodies: hand the request stream to the handler untouched, for any
  // content type. Nothing is buffered, so the app's 2 MB bodyLimit does not
  // apply here; the PUT handler enforces MAX_FILE_BYTES while streaming.
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', (_req, payload, done) => done(null, payload))
  app.addHook('preHandler', requireFileToken)

  app.put('/api/files/*', async (req, reply) => {
    const key = keyFrom(req)
    if (!isValidFileKey(key)) return reply.code(400).send({ error: 'Invalid key' })
    if (!mayTouch(req, key)) return reply.code(404).send(NOT_FOUND)

    const rawDays = req.headers['x-expires-days']
    let days = DEFAULT_EXPIRY_DAYS
    if (rawDays !== undefined) {
      days = typeof rawDays === 'string' && /^\d{1,2}$/.test(rawDays) ? Number(rawDays) : NaN
      if (!(days >= 1 && days <= MAX_EXPIRY_DAYS)) {
        return reply.code(400).send({ error: `X-Expires-Days must be 1 to ${MAX_EXPIRY_DAYS}` })
      }
    }

    const max = config.maxFileBytes
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > max) {
      return reply.code(413).header('Connection', 'close').send({ error: `File is larger than ${max} bytes` })
    }

    const storedPath = `${randomUUID()}.bin`
    const abs = storedFilePath(storedPath)!
    const hash = createHash('sha256')
    let size = 0
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length
        if (size > max) return cb(httpError(413, `File is larger than ${max} bytes`))
        hash.update(chunk)
        cb(null, chunk)
      },
    })

    try {
      const body = (req.body as Readable | undefined) ?? Readable.from([])
      await pipeline(body, meter, createWriteStream(abs, { flags: 'wx' }))
    } catch (err) {
      await removeStoredFile(storedPath)
      const status = (err as { statusCode?: number }).statusCode ?? 400
      if (status === 413) reply.header('Connection', 'close')
      return reply.code(status).send({ error: status === 413 ? (err as Error).message : 'Upload failed' })
    }

    const now = new Date()
    const values = {
      storedPath,
      size,
      sha256: hash.digest('hex'),
      mime: cleanMime(req.headers['content-type']),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + days * 86_400_000).toISOString(),
      createdByToken: req.apiToken?.id ?? null,
    }

    // Replace in one transaction; the old bytes are deleted after it commits.
    let replaced: string | null = null
    db.transaction((tx) => {
      const old = tx.select().from(files).where(eq(files.key, key)).get()
      if (old) {
        tx.update(files).set(values).where(eq(files.id, old.id)).run()
        replaced = old.storedPath
      } else {
        tx.insert(files).values({ id: randomUUID(), key, ...values }).run()
      }
    })
    if (replaced) await removeStoredFile(replaced)

    return reply
      .code(replaced ? 200 : 201)
      .send({ key, size: values.size, sha256: values.sha256, expiresAt: values.expiresAt })
  })

  app.get('/api/files/*', { exposeHeadRoute: false }, async (req, reply) => {
    const key = keyFrom(req)
    if (!isValidFileKey(key)) return reply.code(400).send({ error: 'Invalid key' })
    const row = liveFile(req, key)
    const abs = row ? storedFilePath(row.storedPath) : null
    if (!row || !abs || !existsSync(abs)) return reply.code(404).send(NOT_FOUND)
    fileHeaders(reply, row)
    return reply.send(createReadStream(abs))
  })

  app.head('/api/files/*', async (req, reply) => {
    const key = keyFrom(req)
    if (!isValidFileKey(key)) return reply.code(400).send()
    const row = liveFile(req, key)
    const abs = row ? storedFilePath(row.storedPath) : null
    if (!row || !abs || !existsSync(abs)) return reply.code(404).send()
    fileHeaders(reply, row)
    return reply.send()
  })

  app.delete('/api/files/*', async (req, reply) => {
    const key = keyFrom(req)
    if (!isValidFileKey(key)) return reply.code(400).send({ error: 'Invalid key' })
    if (!mayTouch(req, key)) return reply.code(404).send(NOT_FOUND)
    const row = db.select().from(files).where(eq(files.key, key)).get()
    if (!row) return reply.code(404).send(NOT_FOUND)
    const result = db
      .delete(files)
      .where(and(eq(files.id, row.id), eq(files.storedPath, row.storedPath)))
      .run()
    if (result.changes === 1) await removeStoredFile(row.storedPath)
    return { ok: true }
  })

  /** Keys under the caller's prefix (and the optional ?prefix=), unexpired. */
  app.get('/api/files', async (req) => {
    const own = prefixFor(req)
    if (own === null) return { files: [] }
    const { prefix } = req.query as { prefix?: string }
    const wanted = typeof prefix === 'string' ? prefix : ''
    // Compare by substr so `_` and `%` in a prefix are literal, unlike LIKE.
    const starts = (p: string) => sql`substr(${files.key}, 1, ${p.length}) = ${p}`
    const rows = db
      .select({ key: files.key, size: files.size, sha256: files.sha256, expiresAt: files.expiresAt })
      .from(files)
      .where(and(starts(own), starts(wanted), gt(files.expiresAt, new Date().toISOString())))
      .orderBy(asc(files.key))
      .limit(1000)
      .all()
    return { files: rows }
  })
}
