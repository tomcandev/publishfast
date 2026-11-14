/**
 * An assignment can expire (contents.assign_expires_at): when the time has
 * come, the scheduler puts a READY, unclaimed item back in the open queue.
 * Items without an expiry stay assigned for ever; claimed and published
 * items are never touched; a claim that lands in the same tick wins.
 */
import './env.js'
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db, sqlite } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { contents, tokenEvents } from '../db/schema.js'
import { createApiToken } from '../lib/auth.js'
import { expireAssignments } from '../lib/releaseScheduler.js'
import { call, makeContent, makeUser, sessionFor } from './helpers.js'

let app: FastifyInstance
let admin: ReturnType<typeof makeUser>
let carousel: ReturnType<typeof makeUser> // an assigned-only posting account
let other: ReturnType<typeof makeUser> // a person on the open queue
let adminCookie: string

const past = () => new Date(Date.now() - 60_000).toISOString()
const future = () => new Date(Date.now() + 3_600_000).toISOString()
const row = (id: string) => db.select().from(contents).where(eq(contents.id, id)).get()!

before(async () => {
  migrate()
  app = await buildApp({ logger: false })
  admin = makeUser('ae-admin', 'admin')
  carousel = makeUser('ae-carousel', 'kol', { assignedOnly: true })
  other = makeUser('ae-other')
  adminCookie = await sessionFor(admin.id)
})

after(async () => {
  await app.close()
  sqlite.close()
})

describe('setting an expiring assignment', () => {
  it('admin PATCH takes assignExpiresAt with an assignee; responses carry it; clearing the assignee clears it', async () => {
    const id = makeContent({ status: 'READY' })
    const until = future()
    const res = await call(app, 'PATCH', `/api/admin/contents/${id}`, { cookie: adminCookie }, { assignedUserId: carousel.id, assignExpiresAt: until })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().content.assignExpiresAt, until)
    const seen = await call(app, 'GET', `/api/contents/${id}`, { cookie: await sessionFor(carousel.id) })
    assert.equal(seen.json().content.assignExpiresAt, until)

    assert.equal((await call(app, 'PATCH', `/api/admin/contents/${id}`, { cookie: adminCookie }, { assignExpiresAt: 'tomorrow' })).statusCode, 400)
    const cleared = await call(app, 'PATCH', `/api/admin/contents/${id}`, { cookie: adminCookie }, { assignedUserId: null })
    assert.equal(cleared.statusCode, 200)
    assert.equal(cleared.json().content.assignExpiresAt, null)
    // Without an assignee an expiry means nothing: refused.
    const alone = await call(app, 'PATCH', `/api/admin/contents/${id}`, { cookie: adminCookie }, { assignExpiresAt: until })
    assert.equal(alone.statusCode, 400)
    assert.equal(row(id).assignExpiresAt, null)
  })

  it('ingest create takes it from an old or admin token, with an assignee only', async () => {
    const legacy = createApiToken('ae-legacy')
    const ok = await call(app, 'POST', '/api/ingest/contents', { token: legacy }, {
      code: 'AE-CAROUSEL-1', status: 'READY', contentType: 'carousel', assignedUserId: carousel.username, assignExpiresAt: '2030-01-01T00:00:00+07:00',
    })
    assert.equal(ok.statusCode, 201)
    assert.equal(ok.json().content.assignExpiresAt, '2029-12-31T17:00:00.000Z', 'stored as UTC')
    const noAssignee = await call(app, 'POST', '/api/ingest/contents', { token: legacy }, { code: 'AE-NOBODY', assignExpiresAt: future() })
    assert.equal(noAssignee.statusCode, 400)
  })

  it('an ingest-scope token with an assignee list may not set an expiry (400), on create or patch', async () => {
    const maker = createApiToken('ae-maker', 'kol', { scope: 'ingest', assignees: [carousel.id] })
    const create = await call(app, 'POST', '/api/ingest/contents', { token: maker }, { code: 'AE-MAKER-1', assignedUserId: carousel.id, assignExpiresAt: future() })
    assert.equal(create.statusCode, 400)
    assert.equal(db.select().from(contents).where(eq(contents.code, 'AE-MAKER-1')).get(), undefined)
    const made = await call(app, 'POST', '/api/ingest/contents', { token: maker }, { code: 'AE-MAKER-2', assignedUserId: carousel.id })
    assert.equal(made.statusCode, 201)
    const patch = await call(app, 'PATCH', `/api/ingest/contents/${made.json().content.id}`, { token: maker }, { assignExpiresAt: future() })
    assert.equal(patch.statusCode, 400)
    assert.equal(row(made.json().content.id).assignExpiresAt, null)
  })

  it('a token that sets it leaves an audit row naming the item', async () => {
    const legacy = createApiToken('ae-audit-legacy')
    const created = await call(app, 'POST', '/api/ingest/contents', { token: legacy }, {
      code: 'AE-AUDIT-1', status: 'READY', assignedUserId: carousel.id, assignExpiresAt: future(),
    })
    assert.equal(created.statusCode, 201)
    const id = created.json().content.id
    const scopedAdmin = createApiToken('ae-audit-admin', 'admin', { scope: 'admin' })
    const patched = await call(app, 'PATCH', `/api/admin/contents/${id}`, { token: scopedAdmin }, { assignExpiresAt: future() })
    assert.equal(patched.statusCode, 200)
    const events = db.select().from(tokenEvents).where(eq(tokenEvents.contentId, id)).all()
    assert.deepEqual(events.map((e) => e.action).sort(), ['PATCH /api/admin/contents/:id', 'ingest.create'])
  })
})

describe('the scheduler expires assignments', () => {
  it('returns the item to the open queue; another account can then claim it; the assigned-only account no longer sees it', async () => {
    const id = makeContent({ status: 'READY', assignedUserId: carousel.id, assignExpiresAt: past() })
    const carouselCookie = await sessionFor(carousel.id)
    const ids = async (cookie: string) => (await call(app, 'GET', '/api/contents', { cookie })).json().contents.map((c: { id: string }) => c.id)
    assert.ok((await ids(carouselCookie)).includes(id))
    const otherCookie = await sessionFor(other.id)
    assert.equal((await call(app, 'POST', `/api/contents/${id}/claim`, { cookie: otherCookie })).statusCode, 409, 'still assigned to the carousel account')
    assert.ok(!(await ids(otherCookie)).includes(id), 'not in the open queue yet')

    assert.equal(expireAssignments(), 1)
    assert.equal(expireAssignments(), 0, 'idempotent')
    assert.deepEqual([row(id).assignedUserId, row(id).assignExpiresAt, row(id).status], [null, null, 'READY'])
    assert.ok(!(await ids(carouselCookie)).includes(id), 'an assigned-only account loses sight of it')
    assert.ok((await ids(otherCookie)).includes(id))
    const claim = await call(app, 'POST', `/api/contents/${id}/claim`, { cookie: otherCookie })
    assert.equal(claim.statusCode, 200)
    assert.equal(row(id).claimedBy, other.id)
  })

  it('never touches an item without an expiry, a future expiry, or a claimed, published, draft or failed item', () => {
    const forever = makeContent({ status: 'READY', assignedUserId: carousel.id })
    const later = makeContent({ status: 'READY', assignedUserId: carousel.id, assignExpiresAt: future() })
    const claimed = makeContent({ status: 'CLAIMED', assignedUserId: carousel.id, claimedBy: carousel.id, assignExpiresAt: past() })
    const published = makeContent({ status: 'PUBLISHED', assignedUserId: carousel.id, claimedBy: carousel.id, assignExpiresAt: past() })
    const draft = makeContent({ status: 'DRAFT', assignedUserId: carousel.id, assignExpiresAt: past() })
    const failed = makeContent({ status: 'FAILED', assignedUserId: carousel.id, assignExpiresAt: past() })
    // A READY row that still names a claimer (an admin status edit) is left alone too.
    const oddReady = makeContent({ status: 'READY', assignedUserId: carousel.id, claimedBy: carousel.id, assignExpiresAt: past() })
    expireAssignments(new Date(Date.now() + 10 * 365 * 86_400_000))
    for (const id of [forever, claimed, published, draft, failed, oddReady]) assert.equal(row(id).assignedUserId, carousel.id, id)
    assert.equal(row(later).assignedUserId, null, 'ten years on, a set expiry has passed')
    assert.equal(row(forever).assignExpiresAt, null)
  })

  it('a claim that lands in the same tick wins: exactly one of them happens, every time', async () => {
    let claims = 0
    let expiries = 0
    const cookie = await sessionFor(carousel.id)
    for (let i = 0; i < 40; i++) {
      const id = makeContent({ status: 'READY', assignedUserId: carousel.id, assignExpiresAt: past() })
      // Vary when the tick lands relative to the claim request: before it reaches
      // the handler, around it, or after it. Each side is one compare-and-swap.
      const tick = new Promise<number>((resolve) => {
        const run = () => resolve(expireAssignments())
        if (i % 4 === 0) queueMicrotask(run)
        else if (i % 4 === 1) setImmediate(run)
        else setTimeout(run, i % 4 === 2 ? 0 : 5)
      })
      const [claim] = await Promise.all([call(app, 'POST', `/api/contents/${id}/claim`, { cookie }), tick])
      const r = row(id)
      if (claim.statusCode === 200) {
        claims++
        assert.deepEqual([r.status, r.claimedBy, r.assignedUserId], ['CLAIMED', carousel.id, carousel.id], 'the claim kept its assignment')
      } else {
        expiries++
        assert.equal(claim.statusCode, 404)
        assert.deepEqual([r.status, r.claimedBy, r.assignedUserId], ['READY', null, null])
      }
    }
    assert.equal(claims + expiries, 40)
    assert.ok(claims > 0 && expiries > 0, `both orders were exercised (claims ${claims}, expiries ${expiries})`)
    // Claimed first, then the tick: the tick changes nothing.
    const first = makeContent({ status: 'READY', assignedUserId: carousel.id, assignExpiresAt: past() })
    assert.equal((await call(app, 'POST', `/api/contents/${first}/claim`, { cookie })).statusCode, 200)
    expireAssignments()
    assert.deepEqual([row(first).status, row(first).assignedUserId], ['CLAIMED', carousel.id])
    assert.equal(
      db.select().from(contents).where(and(eq(contents.status, 'CLAIMED'), eq(contents.claimedBy, carousel.id))).all().every((c) => c.assignedUserId === carousel.id),
      true,
    )
  })
})
