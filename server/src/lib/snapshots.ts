import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db/index.js'
import { metricSnapshots, publications, type Publication } from '../db/schema.js'

export type SnapshotInput = {
  takenAt: string
  label?: string | null
  views?: number | null
  likes?: number | null
  comments?: number | null
  shares?: number | null
  extra?: Record<string, unknown> | null
  tokenId?: string | null
}

/**
 * Stores one metric reading and, when it is at least as new as the
 * publication's last check, makes its counts the publication's latest ones.
 * A reading back-filled for an older moment (a late "24h" after a newer
 * "7d") is kept in the history but does not overwrite newer counts.
 * Both writes happen in one transaction.
 */
export function recordSnapshot(pub: Publication, input: SnapshotInput) {
  const id = randomUUID()
  db.transaction((tx) => {
    tx.insert(metricSnapshots)
      .values({
        id,
        publicationId: pub.id,
        takenAt: input.takenAt,
        label: input.label ?? null,
        views: input.views ?? null,
        likes: input.likes ?? null,
        comments: input.comments ?? null,
        shares: input.shares ?? null,
        extra: input.extra ?? null,
        tokenId: input.tokenId ?? null,
      })
      .run()

    const current = tx.select().from(publications).where(eq(publications.id, pub.id)).get()
    if (current && (!current.lastCheckedAt || input.takenAt >= current.lastCheckedAt)) {
      const latest: Partial<Publication> = { lastCheckedAt: input.takenAt }
      for (const key of ['views', 'likes', 'comments', 'shares'] as const) {
        const value = input[key]
        if (typeof value === 'number') latest[key] = value
      }
      tx.update(publications).set(latest).where(eq(publications.id, pub.id)).run()
    }
  })
  return db.select().from(metricSnapshots).where(eq(metricSnapshots.id, id)).get()!
}

/** A snapshot as returned to clients: never the token that wrote it. */
export function publicSnapshot(row: typeof metricSnapshots.$inferSelect) {
  const { tokenId: _omit, ...rest } = row
  return rest
}
