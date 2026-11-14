import { statfs } from 'node:fs/promises'
import { Transform } from 'node:stream'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { assets, contents } from '../db/schema.js'
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

/** Bytes an ingest token holds in assets of its DRAFT and READY items. */
export function ingestBytesHeld(tokenId: string) {
  const row = db
    .select({ n: sql<number>`coalesce(sum(${assets.size}), 0)` })
    .from(assets)
    .innerJoin(contents, eq(contents.id, assets.contentId))
    .where(and(eq(contents.createdByToken, tokenId), inArray(contents.status, ['DRAFT', 'READY'])))
    .get()
  return Number(row?.n ?? 0)
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
