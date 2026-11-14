import { statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type Database from 'better-sqlite3'

/**
 * The media prune's rules and its read-only selection (contract section 14).
 *
 * Nothing here opens, migrates or writes the database: every function takes
 * a better-sqlite3 connection, so the dry run can use a read-only one, and
 * the real run (lib/prune.ts) uses the server's own. The dry run and the real
 * run therefore select with exactly the same code.
 */

const DAY_MS = 86_400_000

/** The only time format the prune trusts: ISO 8601 with a zone. Anything else is "unreadable". */
export const ISO_TIME = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(\.\d+)?(Z|[+-]\d\d:\d\d)$/

/**
 * Milliseconds for a strict ISO time, or null. Rejects what Date.parse would
 * bend: no zone, a date-only or a bare number, a day that does not exist in
 * that month (2026-02-30), hour 24.
 */
export function strictTime(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const m = ISO_TIME.exec(v)
  if (!m) return null
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number]
  const day = new Date(0)
  day.setUTCFullYear(y, mo - 1, d) // not Date.UTC, which reads years 0-99 as 1900-1999
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return null
  if (h > 23 || mi > 59 || s > 59) return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? t : null
}

/** The cutoff for `days`: a time strictly before it is old enough. */
export function pruneCutoff(days: number, now = new Date()) {
  if (!Number.isInteger(days) || days < 1) throw new Error('days must be a positive whole number')
  return new Date(now.getTime() - days * DAY_MS)
}

type PubTime = { publishedAt: string | null; createdAt: string }

export type PruneVerdict =
  | { ok: true; newestAt: string }
  | { ok: false; reason: 'not_published' | 'no_publication' | 'too_recent' | 'unreadable_time' }

/**
 * THE rule for one item. PUBLISHED, at least one publication, and every
 * publication's time strictly before the cutoff. A publication's time is the
 * later of its published_at (the caller's, may be absent) and its created_at
 * (written by the server), both strict ISO; one unreadable time keeps the
 * whole item.
 */
export function itemVerdict(status: string, pubs: PubTime[], cutoff: Date): PruneVerdict {
  if (status !== 'PUBLISHED') return { ok: false, reason: 'not_published' }
  if (pubs.length === 0) return { ok: false, reason: 'no_publication' }
  let newest = -Infinity
  for (const p of pubs) {
    const created = strictTime(p.createdAt)
    const published = p.publishedAt === null || p.publishedAt === undefined ? created : strictTime(p.publishedAt)
    if (created === null || published === null) return { ok: false, reason: 'unreadable_time' }
    newest = Math.max(newest, created, published)
  }
  if (!(newest < cutoff.getTime())) return { ok: false, reason: 'too_recent' }
  return { ok: true, newestAt: new Date(newest).toISOString() }
}

/** The absolute path of a stored upload, or null unless it is a file name strictly inside uploadsDir. */
export function uploadFilePath(uploadsDir: string, filePath: string) {
  const root = resolve(uploadsDir)
  const abs = resolve(join(root, filePath))
  return abs.startsWith(root + sep) ? abs : null
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
  /** PUBLISHED items with unpruned files left alone because a publication time cannot be read. */
  skippedUnreadable: number
  /** Files another asset row also names: never deleted by the prune. */
  skippedShared: number
  /** Files attached less than `days` ago (by their own created_at), or whose created_at cannot be read. */
  skippedYoung: number
}

type AssetRow = {
  id: string
  contentId: string
  code: string
  status: string
  originalName: string
  size: number
  filePath: string
  createdAt: string
  shared: number
}

/** True when another asset row (any state) names the same stored file. */
export const SHARED_FILE_SQL = 'EXISTS (SELECT 1 FROM assets b WHERE b.file_path = ? AND b.id <> ?)'

/** Every asset the prune would delete now, for `days`. The one selection, for the dry run and the real run. */
export function selectPrunable(conn: Database.Database, days: number, now = new Date()): PruneSelection {
  const cutoff = pruneCutoff(days, now)
  const rows = conn
    .prepare(
      `SELECT a.id, a.content_id AS contentId, c.code, c.status, a.original_name AS originalName, a.size,
              a.file_path AS filePath, a.created_at AS createdAt,
              EXISTS (SELECT 1 FROM assets b WHERE b.file_path = a.file_path AND b.id <> a.id) AS shared
         FROM assets a JOIN contents c ON c.id = a.content_id
        WHERE a.pruned_at IS NULL AND c.status = 'PUBLISHED'`,
    )
    .all() as AssetRow[]
  const pubs = new Map<string, PubTime[]>()
  for (const p of conn
    .prepare(
      `SELECT p.content_id AS contentId, p.published_at AS publishedAt, p.created_at AS createdAt
         FROM publications p JOIN contents c ON c.id = p.content_id WHERE c.status = 'PUBLISHED'`,
    )
    .all() as (PubTime & { contentId: string })[]) {
    const list = pubs.get(p.contentId)
    if (list) list.push(p)
    else pubs.set(p.contentId, [p])
  }

  const verdicts = new Map<string, PruneVerdict>()
  const assets: PrunableAsset[] = []
  let skippedShared = 0
  let skippedYoung = 0
  for (const r of rows) {
    let v = verdicts.get(r.contentId)
    if (!v) {
      v = itemVerdict(r.status, pubs.get(r.contentId) ?? [], cutoff)
      verdicts.set(r.contentId, v)
    }
    if (!v.ok) continue
    if (r.shared) {
      skippedShared++
      continue
    }
    const attached = strictTime(r.createdAt)
    if (attached === null || !(attached < cutoff.getTime())) {
      skippedYoung++
      continue
    }
    assets.push({
      id: r.id,
      contentId: r.contentId,
      code: r.code,
      originalName: r.originalName,
      size: r.size,
      filePath: r.filePath,
      newestPublicationAt: v.newestAt,
    })
  }
  const skippedUnreadable = [...verdicts.values()].filter((v) => !v.ok && v.reason === 'unreadable_time').length
  return { days, cutoff: cutoff.toISOString(), assets, skippedUnreadable, skippedShared, skippedYoung }
}

/** How far ahead a recorded time may be before the clock is not trusted. */
export const CLOCK_AHEAD_MS = DAY_MS
/** An asset written a few minutes "after" now is a normal skew between processes; more is a clock problem. */
export const CLOCK_BEHIND_MS = 5 * 60_000

/**
 * A reason not to prune at all, or null: the server clock looks wrong.
 * - Behind: the newest publication the server recorded (created_at;
 *   published_at may be a scheduled future slot) is more than 24 hours ahead
 *   of the clock, or the clock is before the newest asset's created_at.
 * - Ahead: the newest row the server wrote (created_at of contents, assets,
 *   publications) is more than `days` days before the clock. A clock that
 *   jumped forward would otherwise make every file look old. A server where
 *   nothing was created for that long is refused too, visibly, until the
 *   owner runs the script once with --trust-clock (`trustClock`, which skips
 *   only this check; the scheduled run never sets it).
 */
export function clockProblem(conn: Database.Database, now = new Date(), opts: { days?: number; trustClock?: boolean } = {}) {
  const pub = conn.prepare('SELECT max(created_at) AS t FROM publications').get() as { t: string | null }
  const asset = conn.prepare('SELECT max(created_at) AS t FROM assets').get() as { t: string | null }
  const pubT = strictTime(pub.t)
  const assetT = strictTime(asset.t)
  if (pubT !== null && pubT > now.getTime() + CLOCK_AHEAD_MS) {
    return `the newest publication was recorded at ${pub.t}, more than 24 hours after this server's clock (${now.toISOString()})`
  }
  if (assetT !== null && now.getTime() < assetT - CLOCK_BEHIND_MS) {
    return `this server's clock (${now.toISOString()}) is before the newest file's upload time (${asset.t})`
  }
  if (opts.days && !opts.trustClock) {
    let newest: { t: number; text: string } | null = null
    for (const table of ['contents', 'assets', 'publications']) {
      const row = conn.prepare(`SELECT max(created_at) AS t FROM ${table}`).get() as { t: string | null }
      const t = strictTime(row.t)
      if (t !== null && (!newest || t > newest.t)) newest = { t, text: row.t! }
    }
    if (newest && now.getTime() - newest.t > opts.days * DAY_MS) {
      return (
        `the newest row this server wrote (${newest.text}) is more than ${opts.days} day(s) before this server's clock ` +
        `(${now.toISOString()}): either the clock jumped forward, or nothing was created for ${opts.days} day(s). ` +
        `Check the clock; if it is right, run once by hand: node server/dist/scripts/prune.js --days ${opts.days} --dry-run --trust-clock, ` +
        `then --yes --trust-clock`
      )
    }
  }
  return null
}

/**
 * Files a real run would also delete as leftovers: rows already marked pruned
 * (by a run that died between mark and delete), item still PUBLISHED, file
 * still on disk, and no unpruned row naming the same file. Bytes are on disk.
 */
export function listLeftovers(conn: Database.Database, uploadsDir: string) {
  const rows = conn
    .prepare(
      `SELECT DISTINCT a.file_path AS filePath FROM assets a JOIN contents c ON c.id = a.content_id
        WHERE a.pruned_at IS NOT NULL AND c.status = 'PUBLISHED'
          AND NOT EXISTS (SELECT 1 FROM assets b WHERE b.file_path = a.file_path AND b.pruned_at IS NULL)`,
    )
    .all() as { filePath: string }[]
  const found: { filePath: string; abs: string; bytes: number }[] = []
  for (const r of rows) {
    const abs = uploadFilePath(uploadsDir, r.filePath)
    if (!abs) continue
    try {
      const st = statSync(abs)
      if (st.isFile()) found.push({ filePath: r.filePath, abs, bytes: st.size })
    } catch {
      // gone already
    }
  }
  return found
}

/** The columns the prune reads; a database without them has not been migrated. */
export function missingPruneColumns(conn: Database.Database) {
  const need: [string, string][] = [
    ['assets', 'pruned_at'],
    ['assets', 'created_at'],
    ['assets', 'file_path'],
    ['publications', 'published_at'],
    ['publications', 'created_at'],
  ]
  const missing: string[] = []
  for (const [table, column] of need) {
    const cols = conn.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]
    if (!cols.some((c) => c.name === column)) missing.push(`${table}.${column}`)
  }
  return missing
}

export type PruneReport = {
  dryRun: boolean
  days: number
  cutoff: string
  /** Set when the run refused to do anything (a clock problem). */
  refused?: string
  /** Selected by selectPrunable(). */
  files: number
  bytes: number
  items: number
  skippedUnreadable: number
  skippedShared: number
  skippedYoung: number
  largest: { code: string; name: string; size: number; newestPublicationAt: string }[]
  /** Leftovers of earlier runs: the dry run says what would go, the real run what went (bytes on disk). */
  leftovers: { files: number; bytes: number }
  /** Real run only. */
  marked?: number
  deleted?: number
  /** Sizes as recorded in the database, of the files deleted. */
  bytesFreed?: number
  /** Sizes on disk, measured just before each delete. */
  diskBytesFreed?: number
  alreadyMissing?: number
  failed?: number
  /** Marked, but another unpruned row named the same file by the time of the delete: kept. */
  keptShared?: number
  /** Selected, but the item changed before it could be marked (re-opened, a new publication…). */
  changed?: number
}

export function reportOf(sel: PruneSelection, dryRun: boolean, leftovers: { files: number; bytes: number }): PruneReport {
  return {
    dryRun,
    days: sel.days,
    cutoff: sel.cutoff,
    files: sel.assets.length,
    bytes: sel.assets.reduce((n, a) => n + a.size, 0),
    items: new Set(sel.assets.map((a) => a.contentId)).size,
    skippedUnreadable: sel.skippedUnreadable,
    skippedShared: sel.skippedShared,
    skippedYoung: sel.skippedYoung,
    largest: [...sel.assets]
      .sort((a, b) => b.size - a.size)
      .slice(0, 10)
      .map((a) => ({ code: a.code, name: a.originalName, size: a.size, newestPublicationAt: a.newestPublicationAt })),
    leftovers,
  }
}

export function refusedReport(days: number, now: Date, reason: string, dryRun: boolean): PruneReport {
  return {
    dryRun,
    days,
    cutoff: pruneCutoff(days, now).toISOString(),
    refused: reason,
    files: 0,
    bytes: 0,
    items: 0,
    skippedUnreadable: 0,
    skippedShared: 0,
    skippedYoung: 0,
    largest: [],
    leftovers: { files: 0, bytes: 0 },
  }
}

/** The dry run, on any connection (read-only in the script). Writes and deletes nothing. */
export function dryRunReport(
  conn: Database.Database,
  uploadsDir: string,
  days: number,
  now = new Date(),
  opts: { trustClock?: boolean } = {},
): PruneReport {
  const problem = clockProblem(conn, now, { days, trustClock: opts.trustClock })
  if (problem) return refusedReport(days, now, problem, true)
  const left = listLeftovers(conn, uploadsDir)
  return reportOf(selectPrunable(conn, days, now), true, { files: left.length, bytes: left.reduce((n, l) => n + l.bytes, 0) })
}
