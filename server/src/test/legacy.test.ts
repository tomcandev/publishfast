/**
 * Pins the behaviour that existed before scoped tokens: an old admin token
 * (a row with no scope), an old kol-role token, unknown tokens and cookie
 * sessions must answer every route exactly as they did. Written before the
 * auth path changed, and kept green through every later commit.
 */
import './env.js'
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db, sqlite } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { apiTokens, contents, publications } from '../db/schema.js'
import { createApiToken } from '../lib/auth.js'
import { call, makeContent, makeUser, sessionFor, upload } from './helpers.js'

let app: FastifyInstance
let adminToken: string
let kolRoleToken: string
let admin: ReturnType<typeof makeUser>
let kol: ReturnType<typeof makeUser>
let adminCookie: string
let kolCookie: string

before(async () => {
  migrate()
  app = await buildApp({ logger: false })
  adminToken = createApiToken('legacy-admin') // role defaults to admin, no scope
  kolRoleToken = createApiToken('legacy-kol', 'kol')
  admin = makeUser('admin', 'admin')
  kol = makeUser('kol')
  adminCookie = await sessionFor(admin.id)
  kolCookie = await sessionFor(kol.id)
})

after(async () => {
  await app.close()
  sqlite.close()
})

describe('old admin token (no scope): ingest routes', () => {
  let id = ''

  it('POST /api/ingest/contents creates (201), refuses a duplicate code (409) and bad input (400)', async () => {
    const res = await call(app, 'POST', '/api/ingest/contents', { token: adminToken }, {
      code: 'LEG-001',
      title: 'Legacy',
      caption: 'c',
      status: 'READY',
    })
    assert.equal(res.statusCode, 201)
    const body = res.json()
    assert.equal(body.content.code, 'LEG-001')
    assert.equal(body.content.status, 'READY')
    assert.equal(body.content.assignedUserId, null)
    id = body.content.id

    const dup = await call(app, 'POST', '/api/ingest/contents', { token: adminToken }, { code: 'LEG-001' })
    assert.equal(dup.statusCode, 409)

    const bad = await call(app, 'POST', '/api/ingest/contents', { token: adminToken }, { title: 'no code' })
    assert.equal(bad.statusCode, 400)
  })

  it('defaults status to DRAFT and accepts an assignedUserId', async () => {
    const res = await call(app, 'POST', '/api/ingest/contents', { token: adminToken }, {
      code: 'LEG-ASSIGNED',
      assignedUserId: kol.id,
    })
    assert.equal(res.statusCode, 201)
    assert.equal(res.json().content.status, 'DRAFT')
    assert.equal(res.json().content.assignedUserId, kol.id)
  })

  it('PATCH /api/ingest/contents/:id updates any item (200) and 404s an unknown id', async () => {
    const res = await call(app, 'PATCH', `/api/ingest/contents/${id}`, { token: adminToken }, { title: 'Renamed' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().content.title, 'Renamed')

    // An item the token did not create (made by a person / directly) is still editable.
    const other = makeContent({ status: 'PUBLISHED' })
    const res2 = await call(app, 'PATCH', `/api/ingest/contents/${other}`, { token: adminToken }, { status: 'READY' })
    assert.equal(res2.statusCode, 200)
    assert.equal(res2.json().content.status, 'READY')

    const missing = await call(app, 'PATCH', '/api/ingest/contents/nope', { token: adminToken }, { title: 'x' })
    assert.equal(missing.statusCode, 404)
  })

  it('POST /api/ingest/contents/:id/assets uploads (201) without exposing file paths', async () => {
    const res = await upload(app, id, { token: adminToken })
    assert.equal(res.statusCode, 201)
    const assets = res.json().assets
    assert.equal(assets.length, 1)
    assert.equal(assets[0].originalName, 'clip.mp4')
    assert.equal(assets[0].filePath, undefined)

    const missing = await upload(app, 'nope', { token: adminToken })
    assert.equal(missing.statusCode, 404)

    const notMultipart = await call(app, 'POST', `/api/ingest/contents/${id}/assets`, { token: adminToken }, {})
    assert.equal(notMultipart.statusCode, 400)
  })
})

describe('old admin token (no scope): admin routes', () => {
  it('POST /api/admin/metrics/sync runs (no published links yet, so no network)', async () => {
    const res = await call(app, 'POST', '/api/admin/metrics/sync', { token: adminToken })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().totalChecked, 0)
  })

  it('users: list, create, patch, notifications, reset', async () => {
    const list = await call(app, 'GET', '/api/admin/users', { token: adminToken })
    assert.equal(list.statusCode, 200)
    assert.ok(list.json().users.length >= 2)
    assert.ok(list.json().users.every((u: Record<string, unknown>) => !('passwordHash' in u)))

    const created = await call(app, 'POST', '/api/admin/users', { token: adminToken }, {
      username: 'newkol',
      password: 'longenough1',
      role: 'kol',
    })
    assert.equal(created.statusCode, 201)
    const newId = created.json().user.id

    const patched = await call(app, 'PATCH', `/api/admin/users/${newId}`, { token: adminToken }, { displayName: 'New' })
    assert.equal(patched.statusCode, 200)
    assert.equal(patched.json().user.displayName, 'New')

    const notif = await call(app, 'GET', `/api/admin/users/${newId}/notifications`, { token: adminToken })
    assert.equal(notif.statusCode, 200)
    assert.equal(notif.json().subscriptionCount, 0)

    const reset = await call(app, 'POST', `/api/admin/users/${newId}/reset-notifications`, { token: adminToken })
    assert.equal(reset.statusCode, 200)
    assert.equal(reset.json().ok, true)
  })

  it('contents: list, patch, bulk-status, bulk-delete, delete, assets delete, release-stale', async () => {
    const list = await call(app, 'GET', '/api/admin/contents', { token: adminToken })
    assert.equal(list.statusCode, 200)
    const withAsset = list.json().contents.find((c: { code: string }) => c.code === 'LEG-001')
    assert.ok(withAsset)
    assert.equal(withAsset.assets[0].filePath, undefined)

    const a = makeContent()
    const b = makeContent()
    const patch = await call(app, 'PATCH', `/api/admin/contents/${a}`, { token: adminToken }, { status: 'DRAFT' })
    assert.equal(patch.statusCode, 200)
    assert.equal(patch.json().content.status, 'DRAFT')

    const bulkStatus = await call(app, 'POST', '/api/admin/contents/bulk-status', { token: adminToken }, {
      ids: [a, b],
      status: 'READY',
    })
    assert.deepEqual(bulkStatus.json(), { updated: 2 })

    const bulkDelete = await call(app, 'POST', '/api/admin/contents/bulk-delete', { token: adminToken }, { ids: [b] })
    assert.deepEqual(bulkDelete.json(), { deleted: 1 })

    const del = await call(app, 'DELETE', `/api/admin/contents/${a}`, { token: adminToken })
    assert.equal(del.statusCode, 200)
    const del404 = await call(app, 'DELETE', `/api/admin/contents/${a}`, { token: adminToken })
    assert.equal(del404.statusCode, 404)

    const assetId = withAsset.assets[0].id
    const assetDel = await call(app, 'DELETE', `/api/admin/assets/${assetId}`, { token: adminToken })
    assert.equal(assetDel.statusCode, 200)

    const stale = await call(app, 'POST', '/api/admin/release-stale', { token: adminToken }, { hours: 24 })
    assert.equal(stale.statusCode, 200)
    assert.equal(typeof stale.json().released, 'number')
  })

  it('tokens: list (no hash), create, delete', async () => {
    const list = await call(app, 'GET', '/api/admin/tokens', { token: adminToken })
    assert.equal(list.statusCode, 200)
    for (const t of list.json().tokens) {
      assert.equal(t.tokenHash, undefined)
      assert.equal(t.token_hash, undefined)
    }

    const created = await call(app, 'POST', '/api/admin/tokens', { token: adminToken }, { name: 'made-by-token' })
    assert.equal(created.statusCode, 201)
    assert.match(created.json().token, /^pf_[0-9a-f]{48}$/)
    const row = db.select().from(apiTokens).where(eq(apiTokens.name, 'made-by-token')).get()!
    assert.equal(row.role, 'admin')

    // The token created through the web page is a full admin token.
    const works = await call(app, 'GET', '/api/admin/users', { token: created.json().token })
    assert.equal(works.statusCode, 200)

    const del = await call(app, 'DELETE', `/api/admin/tokens/${row.id}`, { token: adminToken })
    assert.equal(del.statusCode, 200)
    const gone = await call(app, 'GET', '/api/admin/users', { token: created.json().token })
    assert.equal(gone.statusCode, 401)
  })

  it('publications and metrics: list, summary, manual metric patch', async () => {
    const c = makeContent({ status: 'PUBLISHED', claimedBy: kol.id })
    const pubId = 'pub-legacy-1'
    db.insert(publications)
      .values({ id: pubId, contentId: c, userId: kol.id, platform: 'tiktok', publishedUrl: 'https://example.test/v/1' })
      .run()

    const list = await call(app, 'GET', '/api/admin/publications', { token: adminToken })
    assert.equal(list.statusCode, 200)
    assert.ok(list.json().publications.some((p: { id: string }) => p.id === pubId))

    const summary = await call(app, 'GET', '/api/admin/metrics', { token: adminToken })
    assert.equal(summary.statusCode, 200)
    assert.ok(summary.json().summary.totalPublications >= 1)

    const patch = await call(app, 'PATCH', `/api/admin/publications/${pubId}/metrics`, { token: adminToken }, {
      views: 42,
    })
    assert.equal(patch.statusCode, 200)
    assert.equal(patch.json().publication.views, 42)
  })

  it('the old admin token is not a user: queue, publications and notifications answer 401', async () => {
    for (const [method, url] of [
      ['GET', '/api/contents'],
      ['POST', '/api/contents/claim-next'],
      ['POST', '/api/publications'],
      ['GET', '/api/notifications/settings'],
      ['GET', '/api/me'],
    ] as const) {
      const res = await call(app, method, url, { token: adminToken }, method === 'POST' ? {} : undefined)
      assert.equal(res.statusCode, 401, `${method} ${url}`)
    }
  })

  it('records last_used_at on use', async () => {
    const row = db.select().from(apiTokens).where(eq(apiTokens.name, 'legacy-admin')).get()!
    assert.ok(row.lastUsedAt)
  })
})

describe('old kol-role token and unknown tokens', () => {
  it('a kol-role token may ingest but not use admin routes (403)', async () => {
    const res = await call(app, 'POST', '/api/ingest/contents', { token: kolRoleToken }, { code: 'LEG-KOLTOKEN' })
    assert.equal(res.statusCode, 201)
    const admin = await call(app, 'GET', '/api/admin/users', { token: kolRoleToken })
    assert.equal(admin.statusCode, 403)
  })

  it('an unknown token gets 401 on ingest, admin and queue routes', async () => {
    const who = { token: 'pf_unknown', ip: '10.9.9.9' }
    assert.equal((await call(app, 'POST', '/api/ingest/contents', who, { code: 'X' })).statusCode, 401)
    assert.equal((await call(app, 'GET', '/api/admin/users', who)).statusCode, 401)
    assert.equal((await call(app, 'GET', '/api/contents', who)).statusCode, 401)
  })

  it('a bad bearer header falls back to a valid session cookie, as before', async () => {
    const res = await call(app, 'GET', '/api/me', { token: 'pf_unknown', cookie: kolCookie, ip: '10.9.9.8' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().user.id, kol.id)
  })
})

describe('cookie sessions', () => {
  it('a kol sees the open queue, claims, links, completes; is refused admin (403)', async () => {
    const me = await call(app, 'GET', '/api/me', { cookie: kolCookie })
    assert.equal(me.statusCode, 200)
    assert.equal(me.json().user.passwordHash, undefined)

    const open = makeContent({ status: 'READY' })
    const list = await call(app, 'GET', '/api/contents', { cookie: kolCookie })
    assert.equal(list.statusCode, 200)
    assert.ok(list.json().contents.some((c: { id: string }) => c.id === open))

    const stats = await call(app, 'GET', '/api/contents/stats', { cookie: kolCookie })
    assert.equal(stats.statusCode, 200)
    assert.ok(stats.json().available >= 1)

    const claim = await call(app, 'POST', `/api/contents/${open}/claim`, { cookie: kolCookie })
    assert.equal(claim.statusCode, 200)
    assert.equal(claim.json().content.claimedBy, kol.id)

    const early = await call(app, 'POST', `/api/contents/${open}/complete`, { cookie: kolCookie })
    assert.equal(early.statusCode, 400)

    const pub = await call(app, 'POST', '/api/publications', { cookie: kolCookie }, {
      contentId: open,
      platform: 'youtube_shorts',
      publishedUrl: 'https://youtube.com/shorts/abc',
    })
    assert.equal(pub.statusCode, 200)

    const done = await call(app, 'POST', `/api/contents/${open}/complete`, { cookie: kolCookie })
    assert.equal(done.statusCode, 200)
    assert.equal(done.json().content.status, 'PUBLISHED')

    const history = await call(app, 'GET', '/api/history', { cookie: kolCookie })
    assert.ok(history.json().contents.some((c: { id: string }) => c.id === open))

    const del = await call(app, 'DELETE', `/api/publications/${pub.json().publication.id}`, { cookie: kolCookie })
    assert.equal(del.statusCode, 200)

    assert.equal((await call(app, 'GET', '/api/admin/users', { cookie: kolCookie })).statusCode, 403)
    assert.equal((await call(app, 'POST', '/api/ingest/contents', { cookie: kolCookie }, { code: 'K' })).statusCode, 401)
  })

  it('a kol never sees another kol’s claim or another kol’s assigned item (404)', async () => {
    const other = makeUser('other')
    const theirs = makeContent({ status: 'CLAIMED', claimedBy: other.id })
    const assigned = makeContent({ status: 'READY', assignedUserId: other.id })
    for (const id of [theirs, assigned]) {
      assert.equal((await call(app, 'GET', `/api/contents/${id}`, { cookie: kolCookie })).statusCode, 404)
    }
  })

  it('an admin session reaches admin and ingest routes', async () => {
    assert.equal((await call(app, 'GET', '/api/admin/contents', { cookie: adminCookie })).statusCode, 200)
    const res = await call(app, 'POST', '/api/ingest/contents', { cookie: adminCookie }, { code: 'LEG-BYADMIN' })
    assert.equal(res.statusCode, 201)
    const row = db.select().from(contents).where(eq(contents.code, 'LEG-BYADMIN')).get()!
    assert.equal(row.status, 'DRAFT')
  })

  it('no credentials: 401 everywhere that needs them, health is open', async () => {
    assert.equal((await call(app, 'GET', '/api/contents')).statusCode, 401)
    assert.equal((await call(app, 'GET', '/api/admin/users')).statusCode, 401)
    assert.equal((await call(app, 'GET', '/api/health')).statusCode, 200)
  })
})
