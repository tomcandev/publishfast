import type { FastifyReply, FastifyRequest } from 'fastify'
import { SESSION_COOKIE, findUserById, readSession, resolveApiToken } from './auth.js'
import { isBearerBlocked, recordBearerFailure } from './rateLimit.js'
import { isRouteAllowed } from './scopes.js'
import type { TokenScope, User } from '../db/schema.js'

/** What a request knows about the token it used. Never the plaintext or hash. */
export type RequestToken = {
  id: string
  name: string
  /** NULL for a token created before scopes: it behaves by role, as before. */
  scope: TokenScope | null
  userId: string | null
  assignees: string[]
  /** Drop-box key prefix; null = may touch no file. */
  filePrefix: string | null
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set when the caller is a logged-in human, or a poster token acting as its user. */
    user?: User
    /** Set for admin-power tokens (admin scope or an old token): what requireAdmin/requireIngest check. */
    tokenRole?: 'admin' | 'kol'
    /** Set whenever the caller used a valid API token. */
    apiToken?: RequestToken
    /** Ids a route handler wants recorded in token_events (see lib/audit.ts). */
    audit?: { contentId?: string; publicationId?: string }
  }
}

/**
 * The client address for rate limiting and the audit trail. CF-Connecting-IP
 * is set by Cloudflare itself; without it, the socket address. Never
 * X-Forwarded-For (what req.ip resolves to with trustProxy), which the
 * client can write.
 */
export function clientIp(req: FastifyRequest) {
  const cf = req.headers['cf-connecting-ip']
  if (typeof cf === 'string' && cf.length > 0 && cf.length <= 64) return cf
  return req.raw.socket?.remoteAddress ?? 'unknown'
}

/**
 * Resolves the caller from either a session cookie or a bearer API token.
 *
 * Old tokens (scope NULL) and admin-scope tokens behave exactly as tokens
 * always did. Narrow scopes (ingest, poster, read) are checked here against
 * the one allow-list in lib/scopes.ts: a route not listed for the scope
 * answers 403 before its handler runs. Otherwise this never rejects on its
 * own — the requireX guards decide what is allowed.
 */
export async function attachIdentity(req: FastifyRequest, reply: FastifyReply) {
  const auth = req.headers.authorization
  if (auth?.startsWith('Bearer ')) {
    // The token is resolved first: a valid token is never refused by the limiter,
    // which only counts and refuses failed attempts.
    const row = resolveApiToken(auth.slice(7).trim())
    // A poster token is only as alive as its user.
    const actingUser = row?.scope === 'poster' && row.userId ? findUserById(row.userId) : undefined
    const usable = !!row && (row.scope !== 'poster' || !!actingUser?.active)

    if (row && usable) {
      req.apiToken = {
        id: row.id,
        name: row.name,
        scope: row.scope ?? null,
        userId: row.userId ?? null,
        assignees: Array.isArray(row.assignees) ? row.assignees : [],
        filePrefix: row.filePrefix ?? null,
      }

      if (!row.scope) {
        req.tokenRole = row.role
        return
      }
      if (row.scope === 'admin') {
        req.tokenRole = 'admin'
        return
      }

      if (!isRouteAllowed(row.scope, req.method, req.routeOptions.url)) {
        reply.code(403).send({ error: 'This token is not allowed to call this route' })
        return reply
      }
      if (row.scope === 'poster') {
        // Acts as its user, never with admin power even if that user is an admin.
        req.user = { ...actingUser!, role: 'kol' }
      }
      return
    }

    const ip = clientIp(req)
    if (isBearerBlocked(ip)) {
      reply.code(429).send({ error: 'Too many failed token attempts. Try again later.' })
      return reply
    }
    if (recordBearerFailure(ip)) {
      req.log.warn({ ip }, 'too many failed bearer attempts; blocking failed attempts from this address for 5 minutes')
    }
  }

  const cookie = req.cookies?.[SESSION_COOKIE]
  if (cookie) {
    const userId = await readSession(cookie)
    if (userId) {
      const user = findUserById(userId)
      if (user?.active) req.user = user
    }
  }
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user) {
    reply.code(401).send({ error: 'Not signed in' })
    return reply
  }
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  // An admin API token counts as admin; a KOL session does not.
  if (req.tokenRole === 'admin') return
  if (req.user?.role === 'admin') return
  reply.code(req.user || req.tokenRole ? 403 : 401).send({ error: 'Admin access required' })
  return reply
}

/** Ingestion endpoints accept an API token (old, admin or ingest scope) or an admin session. */
export async function requireIngest(req: FastifyRequest, reply: FastifyReply) {
  if (req.tokenRole) return
  if (req.apiToken?.scope === 'ingest') return
  if (req.user?.role === 'admin') return
  reply.code(401).send({ error: 'A valid API token is required' })
  return reply
}

/** A signed-in user (or poster token), or an admin-power token. Per-item rules stay in the route. */
export async function requireUserOrAdminToken(req: FastifyRequest, reply: FastifyReply) {
  if (req.user) return
  if (req.tokenRole === 'admin') return
  if (req.apiToken) {
    reply.code(403).send({ error: 'Forbidden' })
    return reply
  }
  reply.code(401).send({ error: 'Not signed in' })
  return reply
}

/** Exports: a read-scope token, an admin-power token, or an admin session. */
export async function requireExport(req: FastifyRequest, reply: FastifyReply) {
  if (req.apiToken?.scope === 'read') return
  if (req.tokenRole === 'admin') return
  if (req.user?.role === 'admin') return
  reply.code(req.user || req.apiToken ? 403 : 401).send({ error: 'Read access required' })
  return reply
}

/** Drop box: a files- or ingest-scope token, or an admin-power token. Sessions are not used here. */
export async function requireFileToken(req: FastifyRequest, reply: FastifyReply) {
  if (req.tokenRole === 'admin') return
  if (req.apiToken?.scope === 'files' || req.apiToken?.scope === 'ingest') return
  reply.code(req.user || req.apiToken ? 403 : 401).send({ error: 'A files token is required' })
  return reply
}
