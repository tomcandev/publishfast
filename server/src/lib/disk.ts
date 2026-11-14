import { statfs } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { assets, contents, uploads } from '../db/schema.js'
import { config } from './config.js'

/** An error that carries the HTTP status the upload routes answer with. */
export function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode })
}

export const NO_SPACE = 'Not enough free disk space on the server'

/**
 * True when writing `incoming` more bytes under `dir` would leave less than
 * MIN_FREE_BYTES free. Checked before any upload is accepted (all callers).
 */
export async function belowFreeSpaceFloor(dir: string, incoming = 0) {
  if (!(config.minFreeBytes > 0)) return false
  const s = await statfs(dir)
  return Number(s.bavail) * Number(s.bsize) - incoming < config.minFreeBytes
}

/**
 * Bytes an ingest token holds: assets of its DRAFT and READY items, plus the
 * declared size of its unfinished uploads in parts (reserved at init).
 */
export function ingestBytesHeld(tokenId: string) {
  const row = db
    .select({ n: sql<number>`coalesce(sum(${assets.size}), 0)` })
    .from(assets)
    .innerJoin(contents, eq(contents.id, assets.contentId))
    .where(and(eq(contents.createdByToken, tokenId), inArray(contents.status, ['DRAFT', 'READY'])))
    .get()
  const reserved = db
    .select({ n: sql<number>`coalesce(sum(${uploads.size}), 0)` })
    .from(uploads)
    .innerJoin(contents, eq(contents.id, uploads.contentId))
    .where(and(eq(contents.createdByToken, tokenId), isNull(uploads.assetId)))
    .get()
  return Number(row?.n ?? 0) + Number(reserved?.n ?? 0)
}

/** A pass-through that fails with `statusCode` once more than `limit` bytes went through it. */
export function byteLimit(limit: number, statusCode: number, message: string) {
  let seen = 0
  const stream = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length
      if (seen > limit) return cb(httpError(statusCode, message))
      cb(null, chunk)
    },
  })
  return Object.assign(stream, { bytes: () => seen })
}

/**
 * Streams a request body through `limit` into a new file at `dest`. Unlike a
 * plain pipeline, a limit or disk error does not destroy the request stream:
 * it is unpiped and paused, so the route can still answer (413 with
 * Connection: close) instead of the client seeing a reset connection. A
 * client that aborts mid-way fails the write. The caller removes `dest` on
 * any error.
 */
export async function writeLimited(source: Readable, limit: Transform, dest: string) {
  const onError = (err: Error) => limit.destroy(err)
  const onClose = () => {
    if (!source.readableEnded) limit.destroy(httpError(400, 'Upload aborted'))
  }
  source.once('error', onError)
  source.once('close', onClose)
  source.pipe(limit)
  try {
    await pipeline(limit, createWriteStream(dest, { flags: 'wx' }))
  } catch (err) {
    source.unpipe(limit)
    source.pause()
    throw err
  } finally {
    source.off('error', onError)
    source.off('close', onClose)
  }
}
