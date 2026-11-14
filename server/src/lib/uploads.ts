import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { and, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { contents, uploads } from '../db/schema.js'
import { config } from './config.js'

/** Unfinished uploads older than this are swept. */
export const UPLOAD_TTL_MS = 24 * 3_600_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The folder of one upload's parts. The id is always a server-made uuid. */
export function partsFolder(uploadId: string) {
  if (!UUID.test(uploadId)) throw new Error('bad upload id')
  return join(config.partsDir, uploadId)
}

/** Path of part n (1-based), server-made: <partsDir>/<uuid>/<n>.part */
export function partPath(uploadId: string, n: number) {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('bad part number')
  return join(partsFolder(uploadId), `${n}.part`)
}

async function removeUploads(ids: string[]) {
  if (ids.length === 0) return 0
  db.delete(uploads).where(inArray(uploads.id, ids)).run() // upload_parts cascade
  await Promise.all(ids.map((id) => rm(partsFolder(id), { recursive: true, force: true }).catch(() => {})))
  return ids.length
}

/** Drops the unfinished uploads of an item (it left DRAFT or is being deleted). */
export async function discardUploads(contentId: string) {
  const ids = db
    .select({ id: uploads.id })
    .from(uploads)
    .where(and(eq(uploads.contentId, contentId), isNull(uploads.assetId)))
    .all()
    .map((r) => r.id)
  return removeUploads(ids)
}

/** Deletes one upload's parts, keeping the row (a completed upload stays answerable). */
export async function removeParts(uploadId: string) {
  await rm(partsFolder(uploadId), { recursive: true, force: true }).catch(() => {})
}

/**
 * Scheduler sweep: unfinished uploads older than 24 hours, unfinished uploads
 * whose item is no longer a DRAFT (released by the scheduler or an admin),
 * and the bookkeeping rows of completed uploads older than 24 hours.
 * Rows and bytes. Returns how many uploads were removed.
 */
export async function sweepUploads(now = new Date()) {
  const cutoff = new Date(now.getTime() - UPLOAD_TTL_MS).toISOString()
  const ids = db
    .select({ id: uploads.id })
    .from(uploads)
    .leftJoin(contents, eq(contents.id, uploads.contentId))
    .where(
      or(
        lt(uploads.createdAt, cutoff),
        and(isNull(uploads.assetId), or(isNull(contents.id), ne(contents.status, 'DRAFT'))),
      ),
    )
    .all()
    .map((r) => r.id)
  const removed = await removeUploads(ids)
  // Folders whose row went with a deleted item (FK cascade) are removed too.
  // (Listed before the rows are read, so an upload started meanwhile is never touched.)
  const folders = await readdir(config.partsDir).catch(() => [] as string[])
  const known = new Set(db.select({ id: uploads.id }).from(uploads).all().map((r) => r.id))
  for (const name of folders) {
    if (UUID.test(name) && !known.has(name)) await rm(partsFolder(name), { recursive: true, force: true }).catch(() => {})
  }
  return removed
}

/** Sum of the part sizes received so far, and which parts. */
export function receivedParts(uploadId: string) {
  return db.all<{ n: number; size: number }>(
    sql`SELECT n, size FROM upload_parts WHERE upload_id = ${uploadId} ORDER BY n`,
  )
}
