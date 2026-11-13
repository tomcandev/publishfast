/**
 * Shared helpers for the route tests. Import ./env.js before this file.
 */
import { randomUUID } from 'node:crypto'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { db } from '../db/index.js'
import { contents, users } from '../db/schema.js'
import { SESSION_COOKIE, findUserById, signSession } from '../lib/auth.js'

export type Caller = { token?: string; cookie?: string; ip?: string }

/** A user row inserted directly (no argon2 cost); sign in with sessionFor(). */
export function makeUser(prefix: string, role: 'admin' | 'kol' = 'kol', extra: Record<string, unknown> = {}) {
  const id = randomUUID()
  db.insert(users)
    .values({
      id,
      username: `${prefix}-${id.slice(0, 6)}`,
      email: `${prefix}-${id.slice(0, 6)}@example.test`,
      passwordHash: 'not-a-real-hash',
      displayName: prefix,
      role,
      active: true,
      notes: 'private admin note',
      ...extra,
    })
    .run()
  return findUserById(id)!
}

/** Session cookie for a user, exactly what POST /api/auth/login sets. */
export async function sessionFor(userId: string) {
  return `${SESSION_COOKIE}=${await signSession(userId)}`
}

export function makeContent(values: Partial<typeof contents.$inferInsert> = {}) {
  const id = randomUUID()
  db.insert(contents)
    .values({
      id,
      code: `T-${id.slice(0, 8)}`,
      title: 'test',
      caption: 'caption',
      status: 'READY',
      ...values,
    })
    .run()
  return id
}

export function call(
  app: FastifyInstance,
  method: InjectOptions['method'],
  url: string,
  who: Caller = {},
  body?: unknown,
) {
  const headers: Record<string, string> = {}
  if (who.token) headers.authorization = `Bearer ${who.token}`
  if (who.cookie) headers.cookie = who.cookie
  return app.inject({
    method,
    url,
    headers,
    remoteAddress: who.ip ?? '127.0.0.1',
    ...(body === undefined ? {} : { payload: body as InjectOptions['payload'] }),
  })
}

/** A minimal multipart body with one file, for the asset upload route. */
export function multipartFile(name: string, mime: string, data: Buffer) {
  const boundary = `----pf${randomUUID().replace(/-/g, '')}`
  const payload = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`,
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } }
}

export function upload(app: FastifyInstance, contentId: string, who: Caller, name = 'clip.mp4') {
  const { payload, headers: partHeaders } = multipartFile(name, 'video/mp4', Buffer.from('fake video bytes'))
  const headers: Record<string, string> = { ...partHeaders }
  if (who.token) headers.authorization = `Bearer ${who.token}`
  if (who.cookie) headers.cookie = who.cookie
  return app.inject({
    method: 'POST',
    url: `/api/ingest/contents/${contentId}/assets`,
    headers,
    payload,
    remoteAddress: who.ip ?? '127.0.0.1',
  })
}
