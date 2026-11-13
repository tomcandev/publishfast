import { and, eq, isNotNull, lte } from 'drizzle-orm'
import { db } from '../db/index.js'
import { contents } from '../db/schema.js'

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

function runOnce() {
  try {
    const released = releaseDueDrafts()
    if (released > 0) console.log(`Release scheduler: released ${released} draft(s) to the queue`)
  } catch (err) {
    console.warn('Error running release scheduler:', err)
  }
}

/** Same pattern as the reminder scheduler: every 60 seconds, first run 5 seconds after start. */
export function startReleaseScheduler() {
  if (intervalTimer) return
  intervalTimer = setInterval(runOnce, 60000)
  setTimeout(runOnce, 5000)
}

export function stopReleaseScheduler() {
  if (intervalTimer) {
    clearInterval(intervalTimer)
    intervalTimer = null
  }
}
