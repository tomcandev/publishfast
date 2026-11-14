import type { FastifyRequest } from 'fastify'
import { inArray } from 'drizzle-orm'
import { db } from '../db/index.js'
import { apiTokens, type Content } from '../db/schema.js'

/**
 * Who holds a claim (contract section 10). A poster token and its user's
 * browser session act as the same user, so the claim records the token
 * (contents.claimed_by_token). An item claimed through a token belongs to
 * that token until it is released:
 * - a session of the same user may release it (to take over), nothing else;
 * - a poster token may not finish or release a claim made in a session, or
 *   one held by another token;
 * - admin sessions (and admin tokens, which never reach these routes as a
 *   user) are not restricted.
 */
export type HoldReason = 'held_by_agent' | 'held_by_person' | 'held_by_other_agent'

const MESSAGES: Record<HoldReason, string> = {
  held_by_agent: 'An agent is posting this item. Take it over (release it) first.',
  held_by_person: 'This item was claimed in a browser session; a token cannot finish or release it.',
  held_by_other_agent: 'Another agent token holds this item.',
}

function posterTokenId(req: FastifyRequest) {
  return req.apiToken?.scope === 'poster' ? req.apiToken.id : null
}

/** Why this caller may not finish (link, unlink, complete) or release this item, or null. */
export function holdConflict(
  req: FastifyRequest,
  item: Pick<Content, 'claimedBy' | 'claimedByToken'>,
  action: 'finish' | 'release',
): HoldReason | null {
  const tokenId = posterTokenId(req)
  if (!tokenId && req.user?.role === 'admin') return null
  if (item.claimedByToken) {
    if (!tokenId) return action === 'release' ? null : 'held_by_agent'
    return item.claimedByToken === tokenId ? null : 'held_by_other_agent'
  }
  if (tokenId && item.claimedBy) return 'held_by_person'
  return null
}

export function holdReply(reason: HoldReason) {
  return { error: MESSAGES[reason], reason }
}

/**
 * The claim fields every session/poster response carries: claimedVia,
 * claimedByTokenName, and claimedByThisToken for poster-token requests.
 * The raw token id is not returned.
 */
export function withClaimInfo<T extends Content>(req: FastifyRequest | null, rows: T[]) {
  const ids = [...new Set(rows.map((r) => r.claimedByToken).filter((x): x is string => !!x))]
  const names = new Map(
    ids.length
      ? db
          .select({ id: apiTokens.id, name: apiTokens.name })
          .from(apiTokens)
          .where(inArray(apiTokens.id, ids))
          .all()
          .map((t) => [t.id, t.name] as const)
      : [],
  )
  const tokenId = req ? posterTokenId(req) : null
  return rows.map(({ claimedByToken, ...row }) => ({
    ...row,
    claimedVia: (claimedByToken ? 'token' : row.claimedBy ? 'session' : null) as 'token' | 'session' | null,
    claimedByTokenName: claimedByToken ? (names.get(claimedByToken) ?? null) : null,
    ...(tokenId ? { claimedByThisToken: !!claimedByToken && claimedByToken === tokenId } : {}),
  }))
}

/** A content row without the internal token ids (created_by_token, claimed_by_token). */
export function stripTokenIds<T extends { createdByToken?: string | null; claimedByToken?: string | null }>(row: T) {
  const { createdByToken: _created, claimedByToken: _claimed, ...rest } = row
  return rest
}
