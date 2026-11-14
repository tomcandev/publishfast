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
 * Bytes of uploads in progress in this process, per ingest token and in
 * total. A request reserves what it may write when it starts and releases
 * it in a finally, so the per-token cap and the free-space floor see
 * concurrent uploads, not only what is already stored.
 */
const inFlightByToken = new Map<string, number>()
let inFlightTotal = 0

export function bytesInFlight(tokenId?: string) {
  return tokenId === undefined ? inFlightTotal : (inFlightByToken.get(tokenId) ?? 0)
}

/** Reserve `bytes` (under `tokenId` when given). Returns the release function; calling it twice is harmless. */
export function reserveInFlight(tokenId: string | null, bytes: number) {
  const n = Math.max(0, Math.floor(bytes))
  inFlightTotal += n
  if (tokenId) inFlightByToken.set(tokenId, bytesInFlight(tokenId) + n)
  let released = false
  return () => {
    if (released) return
    released = true
    inFlightTotal -= n
    if (tokenId) {
      const left = bytesInFlight(tokenId) - n
      if (left > 0) inFlightByToken.set(tokenId, left)
      else inFlightByToken.delete(tokenId)
    }
  }
}

/**
 * True when writing `incoming` more bytes under `dir` (on top of every upload
 * in flight) would leave less than MIN_FREE_BYTES free. Checked before any
 * upload is accepted (all callers), before the caller reserves its bytes.
 */
export async function belowFreeSpaceFloor(dir: string, incoming = 0) {
  if (!(config.minFreeBytes > 0)) return false
  const s = await statfs(dir)
  return Number(s.bavail) * Number(s.bsize) - incoming - inFlightTotal < config.minFreeBytes
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
