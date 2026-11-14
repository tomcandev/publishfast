/**
 * The media prune, by hand (contract section 14).
 *
 *   node server/dist/scripts/prune.js --days 3 --dry-run   # what would go; deletes nothing
 *   node server/dist/scripts/prune.js --days 3 --yes       # does it once
 *   (development: npm run -s prune -w server -- --days 3 --dry-run)
 *
 * The dry run and the real run use the same selection (lib/prune.ts
 * selectPrunable): files of PUBLISHED items whose newest publication
 * (published_at, else created_at) is older than --days. Exactly one of
 * --dry-run and --yes is required.
 */
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { migrate } from '../db/migrate.js'
import { parsePruneDays } from '../lib/config.js'
import { pruneMedia, type PruneReport } from '../lib/prune.js'

class CliError extends Error {}

const USAGE = 'Usage: prune --days <whole days> (--dry-run | --yes)'

function mb(bytes: number) {
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

export function formatReport(r: PruneReport) {
  const lines = [
    `Media prune${r.dryRun ? ' (dry run)' : ''}: files of PUBLISHED items whose newest publication is older than ` +
      `${r.days} day(s), i.e. before ${r.cutoff}.`,
    `${r.dryRun ? 'Would delete' : 'Selected'} ${r.files} file(s), ${mb(r.bytes)}, from ${r.items} item(s).`,
  ]
  if (r.skippedUnreadable > 0) {
    lines.push(`Left alone: ${r.skippedUnreadable} item(s) with a publication time that cannot be read.`)
  }
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
      `Deleted ${r.deleted} file(s), ${mb(r.bytesFreed ?? 0)} freed. Marked ${r.marked}; ` +
        `${r.alreadyMissing} were already missing, ${r.failed} could not be deleted, ` +
        `${r.changed} skipped because the item changed, ${r.leftoversDeleted} leftover(s) from earlier runs removed.`,
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
  migrate()
  const report = await pruneMedia({ days, dryRun: !!values['dry-run'] })
  process.stdout.write(formatReport(report) + '\n')
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
