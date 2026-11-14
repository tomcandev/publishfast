import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { and, count, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'
import { db, sqlite } from '../db/index.js'
import { assets, contents, files, publications, uploadParts, uploads } from '../db/schema.js'
import { config } from './config.js'
import { diskSpace } from './disk.js'
import { uploadFilePath } from './uploads.js'

/**
 * Media prune (contract section 14): once a post is done, its media files are
 * kept for a few days and then deleted. The asset rows stay, with
 * `pruned_at` set and the size kept, so the post, its links, counts and
 * history remain; downloads of a pruned asset answer 410.
 *
 * Safety rules, all enforced here:
 * - off unless PRUNE_PUBLISHED_AFTER_DAYS is set (or `--days` is given to the script);
 * - only items whose status is PUBLISHED and that have at least one publication;
 * - only when the newest publication (published_at, else created_at) is older
 *   than the cutoff; an item with a publication time that cannot be read is skipped;
 * - the dry run and the real run share selectPrunable() and itemVerdict();
 * - the real run re-checks every item inside one IMMEDIATE transaction and marks
 *   each asset with its own compare-and-swap UPDATE (pruned_at IS NULL and the
 *   item still PUBLISHED) before any file is removed. A crash leaves either the
 *   file, or the mark (and possibly the file, removed on a later run): never a
 *   row without pruned_at whose file this code deleted.
 * - the drop box (files/) and unfinished uploads (upload-parts/) are never touched.
 */

const DAY_MS = 86_400_000

type PubTime = { publishedAt: string | null; createdAt: string }

export type PruneVerdict =
  | { ok: true; newestAt: string }
  | { ok: false; reason: 'not_published' | 'no_publication' | 'too_recent' | 'unreadable_time' }

/** The cutoff for `days`: items whose newest publication is strictly before it may go. */
export function pruneCutoff(days: number, now = new Date()) {
  if (!Number.isInteger(days) || days < 1) throw new Error('days must be a positive whole number')
  return new Date(now.getTime() - days * DAY_MS)
}

/** THE rule for one item. Used by the selection (dry run and real run) and the re-check before marking. */
export function itemVerdict(status: string, pubs: PubTime[], cutoff: Date): PruneVerdict {
  if (status !== 'PUBLISHED') return { ok: false, reason: 'not_published' }
  if (pubs.length === 0) return { ok: false, reason: 'no_publication' }
  let newest = -Infinity
  for (const p of pubs) {
    const t = Date.parse(p.publishedAt ?? p.createdAt)
    if (!Number.isFinite(t)) return { ok: false, reason: 'unreadable_time' }
    if (t > newest) newest = t
  }
  if (!(newest < cutoff.getTime())) return { ok: false, reason: 'too_recent' }
  return { ok: true, newestAt: new Date(newest).toISOString() }
}

export type PrunableAsset = {
  id: string
  contentId: string
  code: string
  originalName: string
  size: number
  filePath: string
  newestPublicationAt: string
}

export type PruneSelection = {
  days: number
  cutoff: string
  assets: PrunableAsset[]
  /** PUBLISHED items with unpruned files that were left alone because a publication time cannot be read. */
  skippedUnreadable: number
}

function publicationTimes(contentIds: string[]) {
  const byContent = new Map<string, PubTime[]>()
  for (let i = 0; i < contentIds.length; i += 500) {
    const chunk = contentIds.slice(i, i + 500)
    const rows = db
      .select({ contentId: publications.contentId, publishedAt: publications.publishedAt, createdAt: publications.createdAt })
      .from(publications)
      .where(inArray(publications.contentId, chunk))
      .all()
    for (const r of rows) {
      const list = byContent.get(r.contentId) ?? []
      list.push(r)
      byContent.set(r.contentId, list)
    }
  }
  return byContent
}

/**
 * Every asset the prune would delete now, for `days`. The one selection
 * function: the dry run prints it, the real run acts on it (after re-checking
 * each item under a write lock).
 */
export function selectPrunable(days: number, now = new Date()): PruneSelection {
  const cutoff = pruneCutoff(days, now)
  const rows = db
    .select({
      id: assets.id,
      contentId: assets.contentId,
      code: contents.code,
      status: contents.status,
      originalName: assets.originalName,
      size: assets.size,
      filePath: assets.filePath,
    })
    .from(assets)
    .innerJoin(contents, eq(contents.id, assets.contentId))
    .where(and(isNull(assets.prunedAt), eq(contents.status, 'PUBLISHED')))
    .all()

  const pubs = publicationTimes([...new Set(rows.map((r) => r.contentId))])
  const verdicts = new Map<string, PruneVerdict>()
  const selected: PrunableAsset[] = []
  for (const r of rows) {
    let v = verdicts.get(r.contentId)
    if (!v) {
      v = itemVerdict(r.status, pubs.get(r.contentId) ?? [], cutoff)
      verdicts.set(r.contentId, v)
    }
    if (v.ok) {
      selected.push({
        id: r.id,
        contentId: r.contentId,
        code: r.code,
        originalName: r.originalName,
        size: r.size,
        filePath: r.filePath,
        newestPublicationAt: v.newestAt,
      })
    }
  }
  const skippedUnreadable = [...verdicts.values()].filter((v) => !v.ok && v.reason === 'unreadable_time').length
  return { days, cutoff: cutoff.toISOString(), assets: selected, skippedUnreadable }
}

export type PruneReport = {
  dryRun: boolean
  days: number
  cutoff: string
  /** Selected by selectPrunable(). */
  files: number
  bytes: number
  items: number
  skippedUnreadable: number
  largest: { code: string; name: string; size: number; newestPublicationAt: string }[]
  /** Real run only. */
  marked?: number
  deleted?: number
  bytesFreed?: number
  alreadyMissing?: number
  failed?: number
  /** Selected, but the item changed before it could be marked (re-opened, a new publication…). */
  changed?: number
  /** Files of rows marked by an earlier run that were still on disk (a crash between mark and delete). */
  leftoversDeleted?: number
}

async function removeFile(filePath: string): Promise<'deleted' | 'missing' | 'failed'> {
  const abs = uploadFilePath(filePath)
  if (!abs) return 'failed'
  try {
    await unlink(abs)
    return 'deleted'
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'failed'
  }
}

/**
 * Marks the item's selected assets as pruned, if the item still passes the
 * rule. One IMMEDIATE transaction (holds the write lock from the first read),
 * one compare-and-swap UPDATE per asset. Returns the assets it marked.
 */
function markItem(contentId: string, candidates: PrunableAsset[], cutoff: Date, nowIso: string) {
  return sqlite
    .transaction(() => {
      const item = db.select({ status: contents.status }).from(contents).where(eq(contents.id, contentId)).get()
      if (!item) return []
      const pubs = db
        .select({ publishedAt: publications.publishedAt, createdAt: publications.createdAt })
        .from(publications)
        .where(eq(publications.contentId, contentId))
        .all()
      if (!itemVerdict(item.status, pubs, cutoff).ok) return []
      const marked: PrunableAsset[] = []
      for (const a of candidates) {
        const res = db
          .update(assets)
          .set({ prunedAt: nowIso })
          .where(
            and(
              eq(assets.id, a.id),
              eq(assets.contentId, contentId),
              isNull(assets.prunedAt),
              sql`EXISTS (SELECT 1 FROM contents c WHERE c.id = ${contentId} AND c.status = 'PUBLISHED')`,
            ),
          )
          .run()
        if (res.changes === 1) marked.push(a)
      }
      return marked
    })
    .immediate()
}

function reportOf(sel: PruneSelection, dryRun: boolean): PruneReport {
  return {
    dryRun,
    days: sel.days,
    cutoff: sel.cutoff,
    files: sel.assets.length,
    bytes: sel.assets.reduce((n, a) => n + a.size, 0),
    items: new Set(sel.assets.map((a) => a.contentId)).size,
    skippedUnreadable: sel.skippedUnreadable,
    largest: [...sel.assets]
      .sort((a, b) => b.size - a.size)
      .slice(0, 10)
      .map((a) => ({ code: a.code, name: a.originalName, size: a.size, newestPublicationAt: a.newestPublicationAt })),
  }
}

/**
 * Runs the prune for `days`. With dryRun, only reports what selectPrunable()
 * picked; nothing is written or deleted.
 */
export async function pruneMedia(opts: {
  days: number
  now?: Date
  dryRun?: boolean
  /** Tests only: runs between the selection and the marking, to play a concurrent change. */
  _afterSelect?: () => void
}): Promise<PruneReport> {
  const now = opts.now ?? new Date()
  const sel = selectPrunable(opts.days, now)
  const report = reportOf(sel, !!opts.dryRun)
  if (opts.dryRun) return report
  opts._afterSelect?.()

  const cutoff = new Date(sel.cutoff)
  const nowIso = now.toISOString()
  const byItem = new Map<string, PrunableAsset[]>()
  for (const a of sel.assets) byItem.set(a.contentId, [...(byItem.get(a.contentId) ?? []), a])

  let marked = 0
  let deleted = 0
  let bytesFreed = 0
  let alreadyMissing = 0
  let failed = 0
  for (const [contentId, candidates] of byItem) {
    const done = markItem(contentId, candidates, cutoff, nowIso)
    marked += done.length
    // Only after the marks are committed.
    for (const a of done) {
      const result = await removeFile(a.filePath)
      if (result === 'deleted') {
        deleted++
        bytesFreed += a.size
      } else if (result === 'missing') alreadyMissing++
      else failed++
    }
  }

  return {
    ...report,
    marked,
    deleted,
    bytesFreed,
    alreadyMissing,
    failed,
    changed: sel.assets.length - marked,
    leftoversDeleted: await removeLeftovers(),
  }
}

/**
 * Files whose row an earlier run marked but which are still on disk (the
 * process died between the mark and the delete, or a delete failed). Only
 * for items that are still PUBLISHED.
 */
async function removeLeftovers() {
  const rows = db
    .select({ filePath: assets.filePath })
    .from(assets)
    .innerJoin(contents, eq(contents.id, assets.contentId))
    .where(and(isNotNull(assets.prunedAt), eq(contents.status, 'PUBLISHED')))
    .all()
  let removed = 0
  for (const r of rows) {
    const abs = uploadFilePath(r.filePath)
    if (abs && existsSync(abs) && (await removeFile(r.filePath)) === 'deleted') removed++
  }
  return removed
}

/* ---------- once a day, from the release scheduler ---------- */

/** The first scheduled prune waits this long after the process starts, so a wrong setting can be caught. */
export const PRUNE_FIRST_DELAY_MS = 3_600_000
export const PRUNE_INTERVAL_MS = DAY_MS

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
