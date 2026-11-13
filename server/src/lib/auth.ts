import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2'
import { eq, or, sql } from 'drizzle-orm'
import { SignJWT, jwtVerify } from 'jose'
import { db } from '../db/index.js'
import { apiTokens, users, type TokenScope, type User } from '../db/schema.js'
import { config } from './config.js'

const secret = new TextEncoder().encode(config.authSecret)
export const SESSION_COOKIE = 'pf_session'
const SESSION_TTL = '30d'

export async function hashPassword(plain: string) {
  return argonHash(plain)
}

export async function verifyPassword(hash: string, plain: string) {
  try {
    return await argonVerify(hash, plain)
  } catch {
    return false
  }
}

export async function signSession(userId: string) {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(SESSION_TTL)
    .sign(secret)
}

export async function readSession(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret)
    return typeof payload.sub === 'string' ? payload.sub : null
  } catch {
    return null
  }
}

/**
 * Look up a login by username OR email in a single query, so a KOL can type
 * either "yoga" or "yoga@example.com". Usernames are rejected at creation if
 * they contain '@', which keeps the two namespaces from overlapping.
 */
export function findUserByIdentifier(identifier: string): User | undefined {
  const value = identifier.trim().toLowerCase()
  return db
    .select()
    .from(users)
    .where(or(eq(sql`lower(${users.username})`, value), eq(sql`lower(${users.email})`, value)))
    .get()
}

export function findUserById(id: string): User | undefined {
  return db.select().from(users).where(eq(users.id, id)).get()
}

export function isValidUsername(username: string) {
  // No '@' so a username can never look like an email; keep it URL/CLI-friendly.
  return /^[a-z0-9](?:[a-z0-9._-]{1,30})$/.test(username)
}

export async function createUser(input: {
  username: string
  email?: string | null
  password: string
  displayName?: string
  role?: 'admin' | 'kol'
  notes?: string | null
  bioLink?: string | null
}) {
  const username = input.username.trim().toLowerCase()
  if (!isValidUsername(username)) {
    throw new Error(
      'Username must be 2-31 chars, lowercase letters/digits/._- only, and cannot contain @',
    )
  }
  const email = input.email?.trim().toLowerCase() || null
  const defaultBioLink = `https://pteflow.com/?ref=${username}&utm_source=tiktok&utm_medium=bio&utm_campaign=kol_${username}`
  const user = {
    id: randomUUID(),
    username,
    email,
    passwordHash: await hashPassword(input.password),
    displayName: input.displayName?.trim() || username,
    role: input.role ?? 'kol',
    active: true,
    notes: input.notes?.trim() || null,
    bioLink: input.bioLink !== undefined ? (input.bioLink?.trim() || null) : defaultBioLink,
  }
  db.insert(users).values(user).run()
  return findUserById(user.id)!
}

/* ---------- API tokens (for the AI ingestion pipeline and agents) ---------- */

function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export type TokenSettings = {
  scope?: TokenScope | null
  userId?: string | null
  assignees?: string[] | null
  expiresAt?: string | null
  createdBy?: string | null
}

/**
 * Creates a token and returns its plaintext. Called with only a name and a
 * role it writes exactly the row it always did (scope NULL), which is what
 * the web admin page and the seed script still do.
 */
export function createApiToken(name: string, role: 'admin' | 'kol' = 'admin', settings: TokenSettings = {}) {
  const plaintext = `pf_${randomBytes(24).toString('hex')}`
  db.insert(apiTokens)
    .values({
      id: randomUUID(),
      name,
      tokenHash: hashToken(plaintext),
      role,
      scope: settings.scope ?? null,
      userId: settings.userId ?? null,
      assignees: settings.assignees ?? null,
      expiresAt: settings.expiresAt ?? null,
      createdBy: settings.createdBy ?? null,
    })
    .run()
  // Returned once and never recoverable — only the hash is stored.
  return plaintext
}

/**
 * Looks a token up by its SHA-256. A revoked or expired token resolves to
 * null, exactly like an unknown one, so callers cannot tell them apart.
 */
export function resolveApiToken(token: string) {
  const row = db.select().from(apiTokens).where(eq(apiTokens.tokenHash, hashToken(token))).get()
  if (!row) return null
  const now = new Date().toISOString()
  if (row.revokedAt) return null
  if (row.expiresAt && row.expiresAt <= now) return null
  db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.id)).run()
  return row
}

export function publicUser(user: User) {
  const { passwordHash: _omit, ...rest } = user
  return rest
}
