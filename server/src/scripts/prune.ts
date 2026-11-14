/**
 * The media prune, by hand (contract section 14).
 *
 *   node server/dist/scripts/prune.js --days 3 --dry-run   # what would go; reads only
 *   node server/dist/scripts/prune.js --days 3 --yes       # does it once
 *   (development: npm run -s prune -w server -- --days 3 --dry-run)
 *
 * The dry run opens the database read-only, never migrates it, and uses the
 * same selection as the real run (lib/pruneSelect.ts): files of PUBLISHED
 * items whose newest publication is older than --days, plus the leftovers of
 * an earlier run that the real run would also delete. Exactly one of
 * --dry-run and --yes is required.
 */
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import Database from 'better-sqlite3'
import { config, parsePruneDays } from '../lib/config.js'
import { dryRunReport, missingPruneColumns, type PruneReport } from '../lib/pruneSelect.js'

class CliError extends Error {}

const USAGE = 'Usage: prune --days <whole days> (--dry-run | --yes)'

function mb(bytes: number) {
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

export function formatReport(r: PruneReport) {
  if (r.refused) return `Media prune${r.dryRun ? ' (dry run)' : ''}: refused to run, nothing ${r.dryRun ? 'selected' : 'deleted'}: ${r.refused}.`
  const lines = [
    `Media prune${r.dryRun ? ' (dry run)' : ''}: files of PUBLISHED items whose newest publication is older than ` +
      `${r.days} day(s), i.e. before ${r.cutoff}.`,
    `${r.dryRun ? 'Would delete' : 'Selected'} ${r.files} file(s), ${mb(r.bytes)} by the database's sizes, from ${r.items} item(s).`,
    `${r.dryRun ? 'Would also delete' : 'Also deleted'} ${r.leftovers.files} leftover file(s) of an earlier run, ${mb(r.leftovers.bytes)} on disk.`,
  ]
  const alone = [
    r.skippedUnreadable ? `${r.skippedUnreadable} item(s) with a publication time that cannot be read` : '',
    r.skippedShared ? `${r.skippedShared} file(s) another asset row also names` : '',
    r.skippedYoung ? `${r.skippedYoung} file(s) attached less than ${r.days} day(s) ago` : '',
  ].filter(Boolean)
  if (alone.length) lines.push(`Left alone: ${alone.join('; ')}.`)
  if (r.largest.length > 0) {
    lines.push(`Largest ${r.largest.length}:`)
    for (const a of r.largest) {
      lines.push(`  ${mb(a.size).padStart(10)}  ${a.code}  ${a.name}  (newest publication ${a.newestPublicationAt.slice(0, 10)})`)
    }
  }
  if (r.dryRun) {
    lines.push('Nothing was deleted (dry run). Run again with --yes to delete these files.')
  } else {
    lines.push(
      `Deleted ${r.deleted} file(s): ${mb(r.diskBytesFreed ?? 0)} freed on disk (${mb(r.bytesFreed ?? 0)} by the database's sizes). ` +
        `Marked ${r.marked}; ${r.alreadyMissing} were already missing, ${r.failed} could not be deleted, ` +
        `${r.changed} skipped because the item changed, ${r.keptShared} kept because another row named the file.`,
    )
  }
  return lines.join('\n')
}

export async function main(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      days: { type: 'string' },
      'dry-run': { type: 'boolean' },
      yes: { type: 'boolean' },
    },
  })
  const days = parsePruneDays(values.days)
  if (!days) throw new CliError(`--days must be a whole number of days from 1 to 3650\n${USAGE}`)
  if (!!values['dry-run'] === !!values.yes) throw new CliError(`Give exactly one of --dry-run and --yes\n${USAGE}`)

  if (values['dry-run']) {
    if (!existsSync(config.dbPath)) throw new CliError(`No database at ${config.dbPath}`)
    const conn = new Database(config.dbPath, { readonly: true, fileMustExist: true })
    try {
      const missing = missingPruneColumns(conn)
      if (missing.length) {
        throw new CliError(
          `The database schema is older than this code (missing ${missing.join(', ')}). ` +
            'Run node server/dist/db/migrate.js first (docs/deployment.md); the dry run never migrates.',
        )
      }
      process.stdout.write('Opened the database read-only.\n')
      process.stdout.write(formatReport(dryRunReport(conn, config.uploadsDir, days)) + '\n')
    } finally {
      conn.close()
    }
    return
  }

  // The real run: the server's own database code (migrates, like every other entry point).
  const { migrate } = await import('../db/migrate.js')
  const { pruneMedia } = await import('../lib/prune.js')
  migrate()
  const report = await pruneMedia({ days })
  process.stdout.write(formatReport(report) + '\n')
  if (report.refused) throw new CliError('Refused: nothing was deleted.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2))
    process.exit(0)
  } catch (e) {
    const known = e instanceof CliError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS')
    process.stderr.write((known ? (e as Error).message : `Error: ${(e as Error).message}`) + '\n')
    process.exit(1)
  }
}
