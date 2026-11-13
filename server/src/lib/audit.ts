import { randomUUID } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { tokenEvents } from '../db/schema.js'
import { clientIp } from './guards.js'
import { auditAction } from './scopes.js'

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Writes one token_events row for every successful state-changing call made
 * with an API token (any scope, old tokens included). Registered once as an
 * onSend hook in app.ts, so no route can forget it. Handlers may set
 * `req.audit` to name the content or publication they created; otherwise the
 * `:id` route parameter is used where it names one.
 */
export function recordTokenEvent(req: FastifyRequest, reply: FastifyReply) {
  const token = req.apiToken
  if (!token || READ_METHODS.has(req.method) || reply.statusCode >= 400) return

  const route = req.routeOptions.url ?? ''
  const id = (req.params as { id?: unknown } | undefined)?.id
  const paramId = typeof id === 'string' ? id : undefined
  const namesContent =
    route.startsWith('/api/contents/:id') ||
    route.startsWith('/api/ingest/contents/:id') ||
    route.startsWith('/api/admin/contents/:id')

  try {
    db.insert(tokenEvents)
      .values({
        id: randomUUID(),
        tokenId: token.id,
        at: new Date().toISOString(),
        action: auditAction(req.method, req.routeOptions.url),
        contentId: req.audit?.contentId ?? (namesContent ? paramId : undefined) ?? null,
        publicationId:
          req.audit?.publicationId ?? (route.startsWith('/api/publications/:id') ? paramId : undefined) ?? null,
        ip: clientIp(req),
      })
      .run()
  } catch (err) {
    // The audit must never break the call it records.
    req.log.warn({ err: (err as Error).message }, 'could not record token event')
  }
}
