import { readdir, rm, stat, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join, resolve, sep } from 'node:path'
import { and, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { assets, contents, uploads } from '../db/schema.js'
import { config } from './config.js'

/**
 * Absolute path of a stored upload (assets.file_path), or null when the
 * stored name would point anywhere but a file inside uploads/. Callers that
 * delete never touch a null path.
 */
export function uploadFilePath(filePath: string) {
  const root = resolve(config.uploadsDir)
  const abs = resolve(join(root, filePath))
  return abs.startsWith(root + sep) ? abs : null
}

/** Unfinished uploads older than this are swept. */
export const UPLOAD_TTL_MS = 24 * 3_600_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The folder of one upload's parts. The id is always a server-made uuid. */
export function partsFolder(uploadId: string) {
  if (!UUID.test(uploadId)) throw new Error('bad upload id')
  return join(config.partsDir, uploadId)
}

const PART_FILE = /^[1-9][0-9]{0,6}\.[0-9a-f-]{36}\.part$/

/** A new server-made file name for a copy of part n: <n>.<uuid>.part */
export function newPartFile(n: number) {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('bad part number')
  return `${n}.${randomUUID()}.part`
}

/** Path of a stored part file, refusing anything that is not a server-made name. */
export function partPath(uploadId: string, file: string) {
  if (!PART_FILE.test(file)) throw new Error('bad part file')
  return join(partsFolder(uploadId), file)
}

/** The largest part n may be: partSize, or what is left for the last part. */
export function expectedPartMax(upload: { size: number; partSize: number; parts: number }, n: number) {
  return n === upload.parts ? upload.size - (upload.parts - 1) * upload.partSize : upload.partSize
}

/** A completing mark older than this counts as a crashed join. */
export const COMPLETING_STALE_MS = 10 * 60_000

export function staleCompletingBefore(now = Date.now()) {
  return new Date(now - COMPLETING_STALE_MS).toISOString()
}

async function removeUploads(ids: string[]) {
  if (ids.length === 0) return 0
  db.delete(uploads).where(inArray(uploads.id, ids)).run() // upload_parts cascade
  await Promise.all(ids.map((id) => rm(partsFolder(id), { recursive: true, force: true }).catch(() => {})))
  return ids.length
}

/**
 * Drops the unfinished uploads of an item (it left DRAFT or is being deleted).
 * An upload being completed right now is left alone: its join is reading the
 * parts; it will find the item no longer a draft, answer 409 and remove its
 * file, and the sweep removes what is left.
 */
export async function discardUploads(contentId: string) {
  const ids = db
    .select({ id: uploads.id })
    .from(uploads)
    .where(
      and(
        eq(uploads.contentId, contentId),
        isNull(uploads.assetId),
        or(isNull(uploads.completingAt), lt(uploads.completingAt, staleCompletingBefore())),
      ),
    )
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
  // Only when the owner turned it on (SWEEP_ORPHAN_UPLOADS); never by default.
  if (config.sweepOrphanUploads) await sweepOrphanUploadFiles(now)
  return removed
}

/** A file in uploads/ younger than this may still be waiting for its row (a multipart upload in progress). */
export const ORPHAN_MIN_AGE_MS = 3_600_000

/**
 * Only called when SWEEP_ORPHAN_UPLOADS is on. Deletes files in uploads/ that
 * no asset row names and that are older than one hour (e.g. left by a process that died between moving a joined upload
 * into place and committing its row). Never younger ones: a multipart
 * upload's file exists on disk before its row.
 */
export async function sweepOrphanUploadFiles(now = new Date()) {
  const names = await readdir(config.uploadsDir).catch(() => [] as string[])
  if (names.length === 0) return 0
  const known = new Set(db.select({ f: assets.filePath }).from(assets).all().map((r) => r.f))
  let removed = 0
  for (const name of names) {
    if (known.has(name)) continue
    const path = join(config.uploadsDir, name)
    const info = await stat(path).catch(() => null)
    if (!info?.isFile() || now.getTime() - info.mtimeMs < ORPHAN_MIN_AGE_MS) continue
    // Re-check just before deleting: a row may have arrived meanwhile.
    if (db.select({ id: assets.id }).from(assets).where(eq(assets.filePath, name)).get()) continue
    await unlink(path).catch(() => {})
    removed++
  }
  return removed
}

/** The parts received so far: number, size and stored file. */
export function receivedParts(uploadId: string) {
  return db.all<{ n: number; size: number; file: string | null }>(
    sql`SELECT n, size, file FROM upload_parts WHERE upload_id = ${uploadId} ORDER BY n`,
  )
}

/** Unfinished uploads of an item, as a resuming client needs them. */
export function unfinishedUploads(contentId: string) {
  return db
    .select()
    .from(uploads)
    .where(and(eq(uploads.contentId, contentId), isNull(uploads.assetId)))
    .orderBy(uploads.createdAt)
    .all()
    .map((u) => ({
      uploadId: u.id,
      name: u.name,
      size: u.size,
      partSize: u.partSize,
      received: receivedParts(u.id).map((p) => p.n),
    }))
}
