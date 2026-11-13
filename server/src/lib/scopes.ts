import type { TokenScope } from '../db/schema.js'

/** The scopes that are limited to an allow-list. `admin` and old (NULL-scope) tokens are not. */
export type NarrowScope = Exclude<TokenScope, 'admin'>

/**
 * THE allow-list for narrow token scopes. This is the only place that decides
 * which routes an `ingest`, `poster` or `read` token may call; attachIdentity
 * (lib/guards.ts) enforces it for every request before any route handler runs.
 *
 * Keys are `METHOD /route/pattern` exactly as the route is registered in
 * Fastify (`req.routeOptions.url`), so a request is matched by the route that
 * will actually handle it, never by its raw path. A route that is not listed
 * here answers 403 to every narrow scope: a route added later is closed to
 * these tokens until someone deliberately adds it.
 *
 * `action` names the row written to token_events for state-changing calls.
 * Route handlers still apply their own per-item checks (ownership, 404 for
 * items the caller may not see); this table only decides who may knock.
 */
export const TOKEN_ROUTES: Record<string, { scopes: readonly NarrowScope[]; action?: string }> = {
  // ingest: create, fill and release its own drafts
  'POST /api/ingest/contents': { scopes: ['ingest'], action: 'ingest.create' },
  'GET /api/ingest/contents': { scopes: ['ingest'] },
  'GET /api/ingest/contents/:id': { scopes: ['ingest'] },
  'PATCH /api/ingest/contents/:id': { scopes: ['ingest'], action: 'ingest.patch' },
  'POST /api/ingest/contents/:id/assets': { scopes: ['ingest'], action: 'ingest.upload' },

  // poster: the queue routes its user could call in a browser
  'GET /api/contents': { scopes: ['poster'] },
  'GET /api/contents/:id': { scopes: ['poster'] },
  'POST /api/contents/claim-next': { scopes: ['poster'], action: 'claim' },
  'POST /api/contents/:id/claim': { scopes: ['poster'], action: 'claim' },
  'POST /api/contents/:id/release': { scopes: ['poster'], action: 'release' },
  'POST /api/contents/:id/complete': { scopes: ['poster'], action: 'complete' },
  'GET /api/assets/:id': { scopes: ['poster'] },
  'GET /api/assets/:id/download': { scopes: ['poster'] },
  'GET /api/contents/:id/assets.zip': { scopes: ['poster'] },
  'POST /api/publications': { scopes: ['poster'], action: 'publication.create' },
  'DELETE /api/publications/:id': { scopes: ['poster'], action: 'publication.delete' },
  'POST /api/publications/:id/metrics': { scopes: ['poster'], action: 'metrics' },
  'GET /api/publications/:id/metrics': { scopes: ['poster'] },

  // read: analysis exports only
  'GET /api/export/publications': { scopes: ['read'] },
  'GET /api/export/metrics': { scopes: ['read'] },
}

function routeKey(method: string, routeUrl: string | undefined) {
  // Fastify answers HEAD for every GET route; treat it as the GET.
  return `${method === 'HEAD' ? 'GET' : method} ${routeUrl}`
}

/** True when a token of this scope may call this route. Unknown routes are refused. */
export function isRouteAllowed(scope: NarrowScope, method: string, routeUrl: string | undefined) {
  if (!routeUrl) return false
  return TOKEN_ROUTES[routeKey(method, routeUrl)]?.scopes.includes(scope) ?? false
}

/** token_events.action for a call: the named action, or `METHOD /pattern` for any other route. */
export function auditAction(method: string, routeUrl: string | undefined) {
  const key = routeKey(method, routeUrl)
  return TOKEN_ROUTES[key]?.action ?? key
}
