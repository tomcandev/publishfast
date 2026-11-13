import { unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { and, eq, lte } from 'drizzle-orm'
import { db } from '../db/index.js'
import { files } from '../db/schema.js'
import { config } from './config.js'

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/

/**
 * A drop-box key: a slash-separated path of 1-200 characters, every segment
 * `[A-Za-z0-9._-]+` and not starting with a dot (so no `.`, `..` or hidden
 * names), no empty segments. Keys are never used as file names on disk.
 */
export function isValidFileKey(key: string) {
  if (key.length < 1 || key.length > 200) return false
  return key.split('/').every((s) => SEGMENT.test(s))
}

/** A prefix as the CLI accepts it: key characters only, no dot segments. */
export function isValidFilePrefix(prefix: string) {
  if (prefix.length < 1 || prefix.length > 200) return false
  if (!/^[A-Za-z0-9._/-]+$/.test(prefix)) return false
  return prefix.split('/').every((s, i, all) => (s === '' ? i === all.length - 1 : !s.startsWith('.')))
}

/** Absolute path of a stored name, refusing anything that escapes the files directory. */
export function storedFilePath(storedPath: string) {
  const root = resolve(config.filesDir)
  const abs = resolve(join(root, storedPath))
  return abs.startsWith(root + '/') ? abs : null
}

export async function removeStoredFile(storedPath: string) {
  const abs = storedFilePath(storedPath)
  if (abs) await unlink(abs).catch(() => {})
}

/**
 * Deletes every expired file, row and bytes. Each row is removed with a
 * compare-and-swap DELETE (still expired, same stored file), so a key that
 * was just replaced is never touched and several processes cannot collide.
 */
export async function sweepExpiredFiles(now = new Date()) {
  const nowIso = now.toISOString()
  const expired = db.select().from(files).where(lte(files.expiresAt, nowIso)).all()
  let removed = 0
  for (const row of expired) {
    const result = db
      .delete(files)
      .where(and(eq(files.id, row.id), eq(files.storedPath, row.storedPath), lte(files.expiresAt, nowIso)))
      .run()
    if (result.changes === 1) {
      await removeStoredFile(row.storedPath)
      removed++
    }
  }
  return removed
}
