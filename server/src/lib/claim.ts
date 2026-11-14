import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'
import { db, sqlite } from '../db/index.js'
import { contents, type Content } from '../db/schema.js'

/**
 * READY items a user may take: those assigned to them, plus the open queue
 * (unassigned items) unless the user is `assigned_only`. The one definition
 * of "claimable", shared by the claim CAS, the queue, assets and reminders.
 */
export function claimableBy(userId: string, assignedOnly = false) {
  return and(
    eq(contents.status, 'READY'),
    assignedOnly
      ? eq(contents.assignedUserId, userId)
      : or(isNull(contents.assignedUserId), eq(contents.assignedUserId, userId)),
    // An item whose media the prune removed can never be handed out (second line of defence).
    sql`NOT ${prunedOnly}`,
  )!
}

/**
 * SQL, true for a `contents` row whose media was removed by the media prune
 * (lib/prune.ts) and that has no live file left: it cannot be posted again.
 * Correlated on `contents.id`, so it is used in queries on `contents`.
 */
export const prunedOnly = sql.raw(
  `(EXISTS (SELECT 1 FROM assets pa WHERE pa.content_id = contents.id AND pa.pruned_at IS NOT NULL)` +
    ` AND NOT EXISTS (SELECT 1 FROM assets la WHERE la.content_id = contents.id AND la.pruned_at IS NULL))`,
)

/** The same rule for one item, read now. */
export function isPrunedOnly(contentId: string) {
  return !!db.select({ id: contents.id }).from(contents).where(and(eq(contents.id, contentId), prunedOnly)).get()
}

export const MEDIA_PRUNED = {
  error: 'This post’s media was removed after it was published; it cannot go back to the queue',
  reason: 'media_pruned',
}

export type ClaimOptions = {
  /** The user never sees the open queue (users.assigned_only). */
  assignedOnly?: boolean
  /** The poster token making the claim; NULL/undefined for a session claim. */
  tokenId?: string | null
}

export type ClaimResult =
  | { ok: true; content: Content }
  | { ok: false; reason: 'not_found' | 'already_claimed' | 'empty_queue' }

/**
 * Claim one specific content item.
 *
 * The guard is the `status = 'READY'` predicate inside the UPDATE itself, not a
 * read-then-write. SQLite serializes writers, so if two KOLs race for the same
 * row exactly one UPDATE matches a READY row and the other matches nothing.
 * `changes === 0` therefore means "someone else won", never "maybe won".
 *
 * This is the requirement (plan.txt §5) that Directus's free tier could not
 * express: filtered permissions are licence-gated there, so the lock had to
 * move into application code.
 */
export function claimContent(contentId: string, userId: string, opts: ClaimOptions = {}): ClaimResult {
  const now = new Date().toISOString()

  const result = db
    .update(contents)
    .set({ status: 'CLAIMED', claimedBy: userId, claimedAt: now, claimedByToken: opts.tokenId ?? null })
    .where(
      and(
        eq(contents.id, contentId),
        // READY, and a pre-assigned item may only be claimed by its assignee.
        claimableBy(userId, opts.assignedOnly),
      ),
    )
    .run()

  if (result.changes === 1) {
    return { ok: true, content: db.select().from(contents).where(eq(contents.id, contentId)).get()! }
  }

  const existing = db.select().from(contents).where(eq(contents.id, contentId)).get()
  if (!existing) return { ok: false, reason: 'not_found' }
  // An assigned-only user may not even know an item outside their assignments exists.
  if (opts.assignedOnly && existing.assignedUserId !== userId) return { ok: false, reason: 'not_found' }
  return { ok: false, reason: 'already_claimed' }
}

/**
 * Claim the oldest available item. Selecting a candidate and claiming it are
 * two statements, so another worker can take the row in between — that is
 * exactly what the retry loop absorbs. Each attempt is still atomic; we simply
 * pick the next candidate when we lose a race.
 */
export function claimNext(userId: string, opts: ClaimOptions & { maxAttempts?: number } = {}): ClaimResult {
  const maxAttempts = opts.maxAttempts ?? 25
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = db
      .select()
      .from(contents)
      .where(claimableBy(userId, opts.assignedOnly))
      // Items explicitly assigned to this user come first, then oldest first.
      .orderBy(sql`${contents.assignedUserId} is null`, asc(contents.createdAt))
      .limit(1)
      .get()

    if (!candidate) return { ok: false, reason: 'empty_queue' }

    const claimed = claimContent(candidate.id, userId, opts)
    if (claimed.ok) return claimed
    // Lost the race for this row — try the next candidate.
  }
  return { ok: false, reason: 'empty_queue' }
}

/**
 * Return a claimed item to the queue. Only the claimant (or an admin) may do
 * this. With `tokenId` (a poster token) the claim must also be held by that
 * very token, checked inside the same UPDATE.
 */
export function releaseContent(contentId: string, userId: string, isAdmin = false, tokenId?: string | null) {
  const result = db
    .update(contents)
    .set({ status: 'READY', claimedBy: null, claimedAt: null, claimedByToken: null })
    .where(
      and(
        eq(contents.id, contentId),
        eq(contents.status, 'CLAIMED'),
        ...(isAdmin ? [] : [eq(contents.claimedBy, userId)]),
        ...(tokenId ? [eq(contents.claimedByToken, tokenId)] : []),
      ),
    )
    .run()
  return result.changes === 1
}

/**
 * Reclaim items stuck in CLAIMED for longer than `hours`. Not scheduled by
 * default — exposed so an admin (or a cron hitting the admin API) can run it.
 */
export function releaseStaleClaims(hours: number) {
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString()
  return db
    .update(contents)
    .set({ status: 'READY', claimedBy: null, claimedAt: null, claimedByToken: null })
    .where(and(eq(contents.status, 'CLAIMED'), sql`${contents.claimedAt} < ${cutoff}`))
    .run().changes
}

/** Exposed for the concurrency test so it can reset between runs. */
export { sqlite as _sqlite }
