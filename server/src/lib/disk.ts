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
  // A client may have sent its headers and gone while the route awaited
  // something: such a stream never ends and never closes again. Fail now,
  // before any file is opened.
  if (isAborted(source)) throw httpError(400, 'Upload aborted')
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

/** True when a request body stream is gone before its end (client closed or aborted). */
export function isAborted(source: Readable) {
  const msg = source as Readable & { aborted?: boolean; complete?: boolean }
  if (msg.complete || source.readableEnded) return false
  return source.destroyed || msg.aborted === true
}

type ReplyLike = { raw: { once(event: 'close', fn: () => void): unknown } }

/**
 * Reserve in-flight bytes for one request, released by the route's finally
 * and, as a backstop, when the response closes (a handler that is stuck or
 * a connection that dies never keeps headroom).
 */
export function reserveForReply(reply: ReplyLike, tokenId: string | null, bytes: number) {
  const release = reserveInFlight(tokenId, bytes)
  reply.raw.once('close', release)
  return release
}

/** At most this many upload requests at once per scoped token (ingest, files). */
export const MAX_UPLOADS_PER_TOKEN = 4
const uploadsByToken = new Map<string, number>()

export function uploadsInProgress(tokenId: string) {
  return uploadsByToken.get(tokenId) ?? 0
}

/**
 * Takes one of the token's upload slots, or returns null when it already has
 * MAX_UPLOADS_PER_TOKEN uploads running (answer 429). Released idempotently by
 * the route's finally and when the response closes. Tokens with a null id
 * (old and admin tokens, sessions) are not limited.
 */
export function takeUploadSlot(reply: ReplyLike, tokenId: string | null): (() => void) | null {
  if (!tokenId) return () => {}
  const n = uploadsInProgress(tokenId)
  if (n >= MAX_UPLOADS_PER_TOKEN) return null
  uploadsByToken.set(tokenId, n + 1)
  let released = false
  const release = () => {
    if (released) return
    released = true
    const left = uploadsInProgress(tokenId) - 1
    if (left > 0) uploadsByToken.set(tokenId, left)
    else uploadsByToken.delete(tokenId)
  }
  reply.raw.once('close', release)
  return release
}

export const TOO_MANY_UPLOADS = {
  error: `At most ${MAX_UPLOADS_PER_TOKEN} uploads at once per token`,
  reason: 'too_many_uploads',
}

/** The token an upload counts against for the slot limit: ingest and files scopes only. */
export function scopedUploader(req: { apiToken?: { id: string; scope: string | null } }) {
  const scope = req.apiToken?.scope
  return scope === 'ingest' || scope === 'files' ? req.apiToken!.id : null
}
