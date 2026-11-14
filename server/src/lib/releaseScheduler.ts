import { and, eq, isNotNull, lte } from 'drizzle-orm'
import { db } from '../db/index.js'
import { contents } from '../db/schema.js'
import { sweepExpiredFiles } from './files.js'
import { pruneIfDue, pruneSettingLine } from './prune.js'
import { sweepUploads } from './uploads.js'

let intervalTimer: NodeJS.Timeout | null = null

/**
 * Puts every DRAFT whose release_at has come into the queue, as one
 * compare-and-swap UPDATE: only rows that are still DRAFT at that instant
 * change, so it is idempotent and safe with several processes. Drafts
 * without a release_at are never touched. Returns how many it released.
 */
export function releaseDueDrafts(now = new Date()) {
  return db
    .update(contents)
    .set({ status: 'READY' })
    .where(
      and(
        eq(contents.status, 'DRAFT'),
        isNotNull(contents.releaseAt),
        lte(contents.releaseAt, now.toISOString()),
      ),
    )
    .run().changes
}

async function runOnce() {
  try {
    const released = releaseDueDrafts()
    if (released > 0) console.log(`Release scheduler: released ${released} draft(s) to the queue`)
  } catch (err) {
    console.warn('Error running release scheduler:', err)
  }
  // The same tick sweeps the drop box (contract section 9).
  try {
    const removed = await sweepExpiredFiles()
    if (removed > 0) console.log(`Release scheduler: deleted ${removed} expired file(s)`)
  } catch (err) {
    console.warn('Error sweeping expired files:', err)
  }
  // ...and uploads in parts left unfinished for 24 hours (section 12).
  try {
    const removed = await sweepUploads()
    if (removed > 0) console.log(`Release scheduler: removed ${removed} unfinished or stale upload(s)`)
  } catch (err) {
    console.warn('Error sweeping uploads:', err)
  }
  // ...and, once a day when PRUNE_PUBLISHED_AFTER_DAYS is set, the media of done posts (section 14).
  try {
    const r = await pruneIfDue()
    if (r) {
      console.log(
        `Media prune: deleted ${r.deleted} file(s), ${formatMb(r.bytesFreed ?? 0)} freed ` +
          `(${r.alreadyMissing} already missing, ${r.failed} failed, ${r.changed} skipped as changed, ` +
          `${r.leftoversDeleted} leftover(s) from earlier runs)`,
      )
    }
  } catch (err) {
    console.warn('Error pruning media:', err)
  }
}

function formatMb(bytes: number) {
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

/** Same pattern as the reminder scheduler: every 60 seconds, first run 5 seconds after start. */
export function startReleaseScheduler() {
  if (intervalTimer) return
  console.log(pruneSettingLine())
  intervalTimer = setInterval(() => void runOnce(), 60000)
  setTimeout(() => void runOnce(), 5000)
}

export function stopReleaseScheduler() {
  if (intervalTimer) {
    clearInterval(intervalTimer)
    intervalTimer = null
  }
}
