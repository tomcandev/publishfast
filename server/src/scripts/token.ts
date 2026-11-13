/**
 * API token and account CLI. Tokens are made here, not in the web page.
 *
 *   npm run -s token -w server -- create --name <n> --scope <admin|ingest|poster|read>
 *       [--user <username>] [--assignees <u1,u2>] [--expires <days>]
 *   npm run -s token -w server -- list [--events <name>]
 *   npm run -s token -w server -- revoke --name <n>
 *   npm run -s token -w server -- rotate --name <n>
 *   npm run -s token -w server -- user set --username <u> --assigned-only <true|false>
 *
 * In production, without tsx: node server/dist/scripts/token.js <command> …
 *
 * `create` and `rotate` print ONLY the token and a newline on stdout, so
 * stdout can be piped straight into a file or the clipboard; everything else
 * goes to stderr. Nothing here ever prints a token hash.
 */
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { and, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { TOKEN_SCOPES, apiTokens, contents, tokenEvents, users, type ApiToken, type TokenScope } from '../db/schema.js'
import { createApiToken, type TokenSettings } from '../lib/auth.js'

class CliError extends Error {}

const out = (line: string) => process.stdout.write(line + '\n')
const err = (line: string) => process.stderr.write(line + '\n')

function findUser(username: string) {
  const user = db
    .select()
    .from(users)
    .where(eq(sql`lower(${users.username})`, username.trim().toLowerCase()))
    .get()
  if (!user) throw new CliError(`No user named "${username}"`)
  return user
}

/** Tokens with this name that still work (not revoked, not expired). Old tokens count. */
function activeByName(name: string) {
  const now = new Date().toISOString()
  return db
    .select()
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.name, name),
        isNull(apiTokens.revokedAt),
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, now)),
      ),
    )
    .orderBy(desc(apiTokens.createdAt))
    .all()
}

function describe(name: string, s: TokenSettings & { role: string }) {
  const parts = [`scope ${s.scope ?? `legacy ${s.role}`}`]
  if (s.userId) parts.push(`user ${db.select().from(users).where(eq(users.id, s.userId)).get()?.username}`)
  if (s.assignees?.length) parts.push(`assignees ${usernames(s.assignees)}`)
  parts.push(s.expiresAt ? `expires ${s.expiresAt}` : 'no expiry')
  return `"${name}" (${parts.join(', ')})`
}

function usernames(ids: string[]) {
  if (ids.length === 0) return ''
  const rows = db.select({ id: users.id, username: users.username }).from(users).where(inArray(users.id, ids)).all()
  return ids.map((id) => rows.find((r) => r.id === id)?.username ?? `<deleted ${id.slice(0, 8)}>`).join(',')
}

export function createToken(opts: {
  name?: string
  scope?: string
  user?: string
  assignees?: string
  expires?: string
}) {
  const name = opts.name?.trim()
  if (!name || name.length > 120) throw new CliError('--name is required (1-120 characters)')
  if (!opts.scope || !(TOKEN_SCOPES as readonly string[]).includes(opts.scope)) {
    throw new CliError(`--scope must be one of ${TOKEN_SCOPES.join(', ')}`)
  }
  const scope = opts.scope as TokenScope
  if (opts.user !== undefined && scope !== 'poster') throw new CliError('--user is only for --scope poster')
  if (opts.assignees !== undefined && scope !== 'ingest') throw new CliError('--assignees is only for --scope ingest')

  let userId: string | null = null
  if (scope === 'poster') {
    if (!opts.user) throw new CliError('--user is required for --scope poster')
    const user = findUser(opts.user)
    if (!user.active) throw new CliError(`User "${user.username}" is inactive`)
    if (user.role !== 'kol') throw new CliError('A poster token must act as a kol user, not an admin')
    userId = user.id
  }

  let assignees: string[] | null = null
  if (scope === 'ingest' && opts.assignees !== undefined) {
    const names = opts.assignees.split(',').map((s) => s.trim()).filter(Boolean)
    if (names.length === 0) throw new CliError('--assignees needs at least one username')
    assignees = [...new Set(names.map((n) => findUser(n).id))]
  }

  let expiresAt: string | null = null
  if (opts.expires !== undefined) {
    const days = Number(opts.expires)
    if (!Number.isFinite(days) || days <= 0 || days > 3650) throw new CliError('--expires must be a number of days (0-3650]')
    expiresAt = new Date(Date.now() + days * 86_400_000).toISOString()
  }

  if (activeByName(name).length > 0) throw new CliError(`An active token named "${name}" already exists`)

  const settings = { scope, userId, assignees, expiresAt, createdBy: 'cli' }
  const role = scope === 'admin' ? 'admin' : 'kol'
  const token = createApiToken(name, role, settings)
  err(`Created token ${describe(name, { ...settings, role })}.`)
  return token
}

export function revokeToken(name: string | undefined) {
  if (!name) throw new CliError('--name is required')
  const active = activeByName(name)
  if (active.length === 0) throw new CliError(`No active token named "${name}"`)
  const now = new Date().toISOString()
  db.update(apiTokens)
    .set({ revokedAt: now })
    .where(inArray(apiTokens.id, active.map((t) => t.id)))
    .run()
  return active.length
}

/** Revokes the active token and creates a new one with the same settings (expiry: same length, from now). */
export function rotateToken(name: string | undefined) {
  if (!name) throw new CliError('--name is required')
  const [old] = activeByName(name)
  if (!old) throw new CliError(`No active token named "${name}"`)
  let expiresAt: string | null = null
  if (old.expiresAt) {
    const length = Date.parse(old.expiresAt) - Date.parse(old.createdAt)
    expiresAt = new Date(Date.now() + Math.max(length, 86_400_000)).toISOString()
  }
  const settings = {
    scope: old.scope ?? null,
    userId: old.userId ?? null,
    assignees: old.assignees ?? null,
    expiresAt,
    createdBy: 'cli',
  }
  let token = ''
  db.transaction(() => {
    revokeToken(name)
    token = createApiToken(name, old.role, settings)
  })
  err(`Rotated token ${describe(name, { ...settings, role: old.role })}; the old one is revoked.`)
  return token
}

function table(rows: Record<string, string>[]) {
  if (rows.length === 0) return
  const cols = Object.keys(rows[0]!)
  const width = cols.map((c) => Math.max(c.length, ...rows.map((r) => r[c]!.length)))
  const line = (r: Record<string, string>) => cols.map((c, i) => r[c]!.padEnd(width[i]!)).join('  ').trimEnd()
  out(line(Object.fromEntries(cols.map((c) => [c, c]))))
  for (const r of rows) out(line(r))
}

export function listTokens() {
  // Explicit columns: the hash is never even read.
  const rows = db
    .select({
      name: apiTokens.name,
      role: apiTokens.role,
      scope: apiTokens.scope,
      userId: apiTokens.userId,
      assignees: apiTokens.assignees,
      createdAt: apiTokens.createdAt,
      lastUsedAt: apiTokens.lastUsedAt,
      expiresAt: apiTokens.expiresAt,
      revokedAt: apiTokens.revokedAt,
    })
    .from(apiTokens)
    .orderBy(apiTokens.name, apiTokens.createdAt)
    .all()
  table(
    rows.map((t) => ({
      name: t.name,
      scope: t.scope ?? `legacy-${t.role}`,
      user: t.userId ? usernames([t.userId]) : '-',
      assignees: t.assignees?.length ? usernames(t.assignees) : '-',
      created: t.createdAt.slice(0, 16),
      last_used: t.lastUsedAt?.slice(0, 16) ?? '-',
      expires: t.expiresAt?.slice(0, 16) ?? '-',
      revoked: t.revokedAt?.slice(0, 16) ?? '-',
    })),
  )
  if (rows.length === 0) err('No tokens.')
}

export function listEvents(name: string) {
  const ids = db.select({ id: apiTokens.id }).from(apiTokens).where(eq(apiTokens.name, name)).all().map((r) => r.id)
  if (ids.length === 0) throw new CliError(`No token named "${name}"`)
  const rows = db
    .select({
      at: tokenEvents.at,
      action: tokenEvents.action,
      code: contents.code,
      contentId: tokenEvents.contentId,
      publicationId: tokenEvents.publicationId,
      ip: tokenEvents.ip,
    })
    .from(tokenEvents)
    .leftJoin(contents, eq(contents.id, tokenEvents.contentId))
    .where(inArray(tokenEvents.tokenId, ids))
    .orderBy(desc(tokenEvents.at))
    .limit(50)
    .all()
  table(
    rows.map((e) => ({
      at: e.at.slice(0, 19),
      action: e.action,
      content: e.code ?? e.contentId ?? '-',
      publication: e.publicationId ?? '-',
      ip: e.ip ?? '-',
    })),
  )
  if (rows.length === 0) err(`No events for "${name}".`)
}

export function setUser(opts: { username?: string; 'assigned-only'?: string }) {
  if (!opts.username) throw new CliError('--username is required')
  const flag = opts['assigned-only']
  if (flag !== 'true' && flag !== 'false') throw new CliError('--assigned-only must be true or false')
  const user = findUser(opts.username)
  db.update(users).set({ assignedOnly: flag === 'true' }).where(eq(users.id, user.id)).run()
  out(`User "${user.username}": assigned-only ${flag}.`)
}

const USAGE = `Usage:
  token create --name <name> --scope <${TOKEN_SCOPES.join('|')}> [--user <username>] [--assignees <u1,u2>] [--expires <days>]
  token list [--events <name>]
  token revoke --name <name>
  token rotate --name <name>
  token user set --username <username> --assigned-only <true|false>`

export function main(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      scope: { type: 'string' },
      user: { type: 'string' },
      assignees: { type: 'string' },
      expires: { type: 'string' },
      events: { type: 'string' },
      username: { type: 'string' },
      'assigned-only': { type: 'string' },
    },
  })
  migrate()
  const [command, sub] = positionals
  switch (command) {
    case 'create':
      out(createToken(values))
      return
    case 'rotate':
      out(rotateToken(values.name))
      return
    case 'revoke': {
      const n = revokeToken(values.name)
      err(`Revoked ${n} token(s) named "${values.name}".`)
      return
    }
    case 'list':
      if (values.events) listEvents(values.events)
      else listTokens()
      return
    case 'user':
      if (sub === 'set') return setUser(values)
      throw new CliError(USAGE)
    default:
      throw new CliError(USAGE)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2))
    process.exit(0)
  } catch (e) {
    err(e instanceof CliError || (e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS') ? (e as Error).message : `Error: ${(e as Error).message}`)
    process.exit(1)
  }
}
