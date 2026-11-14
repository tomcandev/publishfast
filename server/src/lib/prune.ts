import { statSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { count, eq, isNotNull, isNull, sql } from 'drizzle-orm'
import { db, sqlite } from '../db/index.js'
import { assets, contents, files, uploadParts, uploads } from '../db/schema.js'
import { config } from './config.js'
import { diskSpace } from './disk.js'
import {
  SHARED_FILE_SQL,
  clockProblem,
  itemVerdict,
  listLeftovers,
  refusedReport,
  reportOf,
  selectPrunable as selectOn,
  uploadFilePath,
  type PrunableAsset,
  type PruneReport,
} from './pruneSelect.js'

export { ISO_TIME, itemVerdict, pruneCutoff, strictTime, type PruneReport, type PruneVerdict } from './pruneSelect.js'

/**
 * Media prune (contract section 14): once a post is done, its media files are
 * kept for a few days and then deleted. The asset rows stay, with
 * `pruned_at` set and the size kept, so the post, its links, counts and
 * history remain; downloads of a pruned asset answer 410.
 *
 * Safety rules, enforced here and in lib/pruneSelect.ts (the selection):
 * - off unless PRUNE_PUBLISHED_AFTER_DAYS is set (or `--days` is given to the script);
 * - only items whose status is PUBLISHED and that have at least one publication;
 * - only when every publication's time (the later of its published_at and its
 *   server-written created_at, strict ISO only) is older than the cutoff;
 *   an item with a time that cannot be read is skipped;
 * - never a file attached less than `days` ago, never a file another asset row names;
 * - not at all when the server clock looks wrong (clockProblem);
 * - the dry run and the real run share selectPrunable() and itemVerdict();
 * - the real run re-checks every item inside one IMMEDIATE transaction and marks
 *   each asset with its own compare-and-swap UPDATE before any file is removed,
 *   and removes a file only while no unpruned row names it. A crash leaves the
 *   file, or the mark (the file is then removed on a later run);
 * - once the mark is committed the item cannot be re-opened (409 media_pruned)
 *   and is never claimable (lib/claim.ts);
 * - the drop box (files/) and unfinished uploads (upload-parts/) are never touched.
 */

/** The selection on the server's own database. */
export function selectPrunable(days: number, now = new Date()) {
  return selectOn(sqlite, days, now)
}

/**
 * Marks the item's selected assets as pruned, if the item still passes the
 * rule. One IMMEDIATE transaction (holds the write lock from the first read),
 * one compare-and-swap UPDATE per asset. Returns the assets it marked.
 */
function markItem(contentId: string, candidates: PrunableAsset[], cutoff: Date, nowIso: string) {
  const mark = sqlite.prepare(
    `UPDATE assets SET pruned_at = ?
      WHERE id = ? AND content_id = ? AND pruned_at IS NULL
        AND EXISTS (SELECT 1 FROM contents c WHERE c.id = ? AND c.status = 'PUBLISHED')
        AND NOT ${SHARED_FILE_SQL}`,
  )
  return sqlite
    .transaction(() => {
      const item = sqlite.prepare('SELECT status FROM contents WHERE id = ?').get(contentId) as { status: string } | undefined
      if (!item) return []
      const pubs = sqlite
        .prepare('SELECT published_at AS publishedAt, created_at AS createdAt FROM publications WHERE content_id = ?')
        .all(contentId) as { publishedAt: string | null; createdAt: string }[]
      if (!itemVerdict(item.status, pubs, cutoff).ok) return []
      const marked: PrunableAsset[] = []
      for (const a of candidates) {
        if (mark.run(nowIso, a.id, contentId, contentId, a.filePath, a.id).changes === 1) marked.push(a)
      }
      return marked
    })
    .immediate()
}

type RemoveResult = { result: 'deleted' | 'missing' | 'failed' | 'kept_shared'; diskBytes: number }

/** Deletes a stored file unless an unpruned row still names it. */
async function removeFile(filePath: string): Promise<RemoveResult> {
  const abs = uploadFilePath(config.uploadsDir, filePath)
  if (!abs) return { result: 'failed', diskBytes: 0 }
  if (sqlite.prepare('SELECT 1 FROM assets WHERE file_path = ? AND pruned_at IS NULL').get(filePath)) {
    return { result: 'kept_shared', diskBytes: 0 }
  }
  let diskBytes = 0
  try {
    diskBytes = statSync(abs).size
  } catch {
    // measured as 0; the unlink below decides missing or failed
  }
  try {
    await unlink(abs)
    return { result: 'deleted', diskBytes }
  } catch (err) {
    return { result: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'failed', diskBytes: 0 }
  }
}

/**
 * Runs the prune for `days`. With dryRun, only reports what selectPrunable()
 * picked and which leftovers would go; nothing is written or deleted.
 */
export async function pruneMedia(opts: {
  days: number
  now?: Date
  dryRun?: boolean
  /** Tests only: runs between the selection and the marking, to play a concurrent change. */
  _afterSelect?: () => void
  /** Tests only: runs between the marking and the deleting. */
  _afterMark?: () => void | Promise<void>
}): Promise<PruneReport> {
  const now = opts.now ?? new Date()
  const problem = clockProblem(sqlite, now)
  if (problem) return refusedReport(opts.days, now, problem, !!opts.dryRun)

  const sel = selectOn(sqlite, opts.days, now)
  if (opts.dryRun) {
    const left = listLeftovers(sqlite, config.uploadsDir)
    return reportOf(sel, true, { files: left.length, bytes: left.reduce((n, l) => n + l.bytes, 0) })
  }
  opts._afterSelect?.()

  const cutoff = new Date(sel.cutoff)
  const nowIso = now.toISOString()
  const byItem = new Map<string, PrunableAsset[]>()
  for (const a of sel.assets) {
    const list = byItem.get(a.contentId)
    if (list) list.push(a)
    else byItem.set(a.contentId, [a])
  }

  const done: PrunableAsset[] = []
  for (const [contentId, candidates] of byItem) done.push(...markItem(contentId, candidates, cutoff, nowIso))
  await opts._afterMark?.()

  let deleted = 0
  let bytesFreed = 0
  let diskBytesFreed = 0
  let alreadyMissing = 0
  let failed = 0
  let keptShared = 0
  // Only after the marks are committed.
  for (const a of done) {
    const r = await removeFile(a.filePath)
    if (r.result === 'deleted') {
      deleted++
      bytesFreed += a.size
      diskBytesFreed += r.diskBytes
    } else if (r.result === 'missing') alreadyMissing++
    else if (r.result === 'kept_shared') keptShared++
    else failed++
  }

  // Leftovers of earlier runs (a crash between mark and delete): the same list the dry run prints.
  let leftFiles = 0
  let leftBytes = 0
  for (const l of listLeftovers(sqlite, config.uploadsDir)) {
    const r = await removeFile(l.filePath)
    if (r.result === 'deleted') {
      leftFiles++
      leftBytes += r.diskBytes
    }
  }

  return {
    ...reportOf(sel, false, { files: leftFiles, bytes: leftBytes }),
    marked: done.length,
    deleted,
    bytesFreed,
    diskBytesFreed: diskBytesFreed + leftBytes,
    alreadyMissing,
    failed,
    keptShared,
    changed: sel.assets.length - done.length,
  }
}

/* ---------- once a day, from the release scheduler ---------- */

/** The first scheduled prune waits this long after the process starts, so a wrong setting can be caught. */
export const PRUNE_FIRST_DELAY_MS = 3_600_000
export const PRUNE_INTERVAL_MS = 86_400_000

const processStartedAt = Date.now()
let lastScheduledRun: number | null = null
let running = false

/**
 * Called every scheduler tick. Runs pruneMedia with PRUNE_PUBLISHED_AFTER_DAYS
 * when it is set and a run is due (one hour after start, then every 24 hours);
 * otherwise returns null.
 */
export async function pruneIfDue(now = Date.now(), days = config.prunePublishedAfterDays) {
  if (!days || running) return null
  const due =
    lastScheduledRun === null ? now - processStartedAt >= PRUNE_FIRST_DELAY_MS : now - lastScheduledRun >= PRUNE_INTERVAL_MS
  if (!due) return null
  running = true
  lastScheduledRun = now
  try {
    return await pruneMedia({ days, now: new Date(now) })
  } finally {
    running = false
  }
}

/** One line for the log when the server starts. */
export function pruneSettingLine(days = config.prunePublishedAfterDays) {
  return days
    ? `Media prune: on. Files of PUBLISHED items are deleted ${days} day(s) after their newest publication; first run about ${PRUNE_FIRST_DELAY_MS / 60_000} minutes after start, then daily.`
    : 'Media prune: off (PRUNE_PUBLISHED_AFTER_DAYS is not set).'
}

/* ---------- storage report (GET /api/admin/storage) ---------- */

export async function storageReport() {
  const byStatus = db
    .select({
      status: contents.status,
      files: count(),
      bytes: sql<number>`coalesce(sum(${assets.size}), 0)`,
    })
    .from(assets)
    .innerJoin(contents, eq(contents.id, assets.contentId))
    .where(isNull(assets.prunedAt))
    .groupBy(contents.status)
    .all()
  const pruned = db
    .select({ files: count(), bytes: sql<number>`coalesce(sum(${assets.size}), 0)` })
    .from(assets)
    .where(isNotNull(assets.prunedAt))
    .get()
  const dropBox = db
    .select({ files: count(), bytes: sql<number>`coalesce(sum(${files.size}), 0)` })
    .from(files)
    .get()
  const parts = db
    .select({ uploads: sql<number>`count(distinct ${uploads.id})`, bytes: sql<number>`coalesce(sum(${uploadParts.size}), 0)` })
    .from(uploads)
    .leftJoin(uploadParts, eq(uploadParts.uploadId, uploads.id))
    .where(isNull(uploads.assetId))
    .get()
  const disk = await diskSpace(config.uploadsDir).catch(() => null)
  return {
    byStatus: byStatus.map((r) => ({ status: r.status, files: Number(r.files), bytes: Number(r.bytes) })),
    pruned: { files: Number(pruned?.files ?? 0), bytes: Number(pruned?.bytes ?? 0) },
    dropBox: { files: Number(dropBox?.files ?? 0), bytes: Number(dropBox?.bytes ?? 0) },
    unfinishedUploads: { uploads: Number(parts?.uploads ?? 0), bytes: Number(parts?.bytes ?? 0) },
    disk,
    prune: { afterDays: config.prunePublishedAfterDays || null },
  }
}
