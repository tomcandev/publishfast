/**
 * Fixes from the independent security review (2026-11-14). Each describe
 * block reproduces one finding; every test here failed before its fix.
 */
import './env.js'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db, sqlite } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { assets, contents, metricSnapshots, publications } from '../db/schema.js'
import { createApiToken } from '../lib/auth.js'
import { _resetBearerFailures } from '../lib/rateLimit.js'
import { call, makeContent, makeUser, multipartFile, sessionFor } from './helpers.js'

let app: FastifyInstance
let legacyAdmin: string
let adminCookie: string

before(async () => {
  migrate()
  app = await buildApp({ logger: false })
  legacyAdmin = createApiToken('review-legacy-admin')
  adminCookie = await sessionFor(makeUser('review-admin', 'admin').id)
})

after(async () => {
  await app.close()
  sqlite.close()
})

beforeEach(() => _resetBearerFailures())

/** Upload one part with an exact Content-Type (or none at all). */
export function uploadPart(
  contentId: string,
  token: string,
  name: string,
  mime: string | null,
  data = Buffer.from('bytes'),
) {
  const { payload, headers } = multipartFile(name, mime ?? 'x/x', data)
  const body = mime === null ? Buffer.from(payload.toString('latin1').replace('Content-Type: x/x\r\n', ''), 'latin1') : payload
  return app.inject({
    method: 'POST',
    url: `/api/ingest/contents/${contentId}/assets`,
    headers: { ...headers, authorization: `Bearer ${token}` },
    payload: body,
  })
}

function assetByName(name: string) {
  return db.select().from(assets).where(eq(assets.originalName, name)).get()!
}

describe('finding 1: uploaded files cannot run script in the app origin', () => {
  it('an svg or html asset (old admin token) is served as an inert attachment', async () => {
    const id = makeContent({ status: 'READY' })
    for (const [name, mime] of [
      ['evil.svg', 'image/svg+xml'],
      ['evil.html', 'text/html'],
      ['evil.xml', 'application/xml'],
    ] as const) {
      const up = await uploadPart(id, legacyAdmin, name, mime, Buffer.from('<svg onload="alert(1)"/>'))
      assert.equal(up.statusCode, 201, 'old admin tokens keep working')
      const a = assetByName(name)
      for (const suffix of ['', '/download']) {
        const res = await call(app, 'GET', `/api/assets/${a.id}${suffix}`, { cookie: adminCookie })
        assert.equal(res.statusCode, 200)
        assert.equal(res.headers['content-type'], 'application/octet-stream', name)
        assert.match(String(res.headers['content-disposition']), /^attachment;/, name)
        assert.equal(res.headers['x-content-type-options'], 'nosniff')
        assert.equal(res.headers['content-security-policy'], "sandbox; default-src 'none'")
      }
    }
  })

  it('png, jpeg and mp4 from an old token still preview inline with their type', async () => {
    const id = makeContent({ status: 'READY' })
    for (const [name, mime] of [
      ['ok.png', 'image/png'],
      ['ok.jpg', 'image/jpeg'],
      ['ok.mp4', 'video/mp4'],
    ] as const) {
      assert.equal((await uploadPart(id, legacyAdmin, name, mime)).statusCode, 201)
      const res = await call(app, 'GET', `/api/assets/${assetByName(name).id}`, { cookie: adminCookie })
      assert.equal(res.headers['content-type'], mime)
      assert.match(String(res.headers['content-disposition']), /^inline;/)
      assert.equal(res.headers['x-content-type-options'], 'nosniff')
      assert.equal(res.headers['content-security-policy'], "sandbox; default-src 'none'")
    }
  })

  it('scoped tokens may not upload svg, html or xml at all', async () => {
    const maker = createApiToken('review-maker', 'kol', { scope: 'ingest' })
    const created = await call(app, 'POST', '/api/ingest/contents', { token: maker }, { code: 'REVIEW-SVG' })
    const id = created.json().content.id
    for (const [name, mime] of [
      ['a.svg', 'image/svg+xml'],
      ['b.png', 'image/svg+xml'],
      ['c.svg', 'image/png'],
      ['d.html', 'text/html'],
      ['e.htm', 'application/octet-stream'],
      ['f.xhtml', 'application/xhtml+xml'],
      ['g.xml', 'text/xml'],
    ] as const) {
      const res = await uploadPart(id, maker, name, mime)
      assert.equal(res.statusCode, 400, `${name} ${mime}`)
    }
    assert.equal(db.select().from(assets).where(eq(assets.contentId, id)).all().length, 0)
  })

  it('the zip and drop-box downloads carry nosniff and the sandbox CSP', async () => {
    const id = makeContent({ status: 'READY' })
    await uploadPart(id, legacyAdmin, 'z.png', 'image/png')
    const zip = await call(app, 'GET', `/api/contents/${id}/assets.zip`, { cookie: adminCookie })
    assert.equal(zip.headers['x-content-type-options'], 'nosniff')
    assert.equal(zip.headers['content-security-policy'], "sandbox; default-src 'none'")

    const worker = createApiToken('review-files', 'kol', { scope: 'files', filePrefix: 'r/' })
    await app.inject({
      method: 'PUT',
      url: '/api/files/r/page.html',
      headers: { authorization: `Bearer ${worker}`, 'content-type': 'text/html' },
      payload: '<script>alert(1)</script>',
    })
    const dl = await app.inject({ method: 'GET', url: '/api/files/r/page.html', headers: { authorization: `Bearer ${worker}` } })
    assert.equal(dl.headers['content-type'], 'application/octet-stream')
    assert.match(String(dl.headers['content-disposition']), /^attachment;/)
    assert.equal(dl.headers['x-content-type-options'], 'nosniff')
    assert.equal(dl.headers['content-security-policy'], "sandbox; default-src 'none'")
  })
})

describe('small: names with control or non-Latin-1 characters', () => {
  it('download and zip do not fail; the name is sent as RFC 5987 filename*', async () => {
    const id = makeContent({ status: 'READY', code: 'PTE-日本-\u0001' })
    const name = 'naïve 日本\u0001"x.mp4'
    assert.equal((await uploadPart(id, legacyAdmin, name, 'video/mp4')).statusCode, 201)
    const a = db.select().from(assets).where(eq(assets.contentId, id)).get()!
    const dl = await call(app, 'GET', `/api/assets/${a.id}/download`, { cookie: adminCookie })
    assert.equal(dl.statusCode, 200)
    const disp = String(dl.headers['content-disposition'])
    assert.match(disp, /filename\*=UTF-8''na%C3%AFve%20%E6%97%A5%E6%9C%AC/)
    assert.ok(/^[\x20-\x7e]*$/.test(disp), 'header is plain ASCII')
    const zip = await call(app, 'GET', `/api/contents/${id}/assets.zip`, { cookie: adminCookie })
    assert.equal(zip.statusCode, 200)
    assert.ok(/^[\x20-\x7e]*$/.test(String(zip.headers['content-disposition'])))
  })
})

void contents

describe('finding 2: the bearer rate limit never refuses a valid token', () => {
  it('after 20 bad attempts a valid token from the same address still works; bad ones get 429', async () => {
    const pipeline = createApiToken('review-pipeline')
    const ip = '198.51.100.7'
    for (let i = 0; i < 20; i++) {
      const res = await call(app, 'GET', '/api/admin/users', { token: `pf_bad${i}`, ip })
      assert.equal(res.statusCode, 401)
    }
    assert.equal((await call(app, 'GET', '/api/admin/users', { token: 'pf_bad', ip })).statusCode, 429)
    assert.equal((await call(app, 'GET', '/api/admin/users', { token: pipeline, ip })).statusCode, 200)
  })

  it('X-Forwarded-For does not move the caller to a fresh bucket', async () => {
    const ip = '198.51.100.8'
    for (let i = 0; i < 20; i++) {
      await app.inject({
        method: 'GET',
        url: '/api/admin/users',
        headers: { authorization: 'Bearer pf_bad', 'x-forwarded-for': `10.0.${i}.1` },
        remoteAddress: ip,
      })
    }
    const res = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { authorization: 'Bearer pf_bad', 'x-forwarded-for': '10.9.9.9' },
      remoteAddress: ip,
    })
    assert.equal(res.statusCode, 429)
  })
})

describe('finding 3: a poster token never takes from the open queue', () => {
  it('even when its user is not assigned_only: list, get, claim and claim-next see only assigned items', async () => {
    db.update(contents).set({ status: 'FAILED' }).where(eq(contents.status, 'READY')).run()
    const human = makeUser('review-open-user') // assigned_only = false
    const token = createApiToken('review-poster-open', 'kol', { scope: 'poster', userId: human.id })
    const open = makeContent({ status: 'READY' })
    const mine = makeContent({ status: 'READY', assignedUserId: human.id })

    const list = (await call(app, 'GET', '/api/contents', { token })).json().contents.map((c: { id: string }) => c.id)
    assert.deepEqual(list, [mine])
    assert.equal((await call(app, 'GET', `/api/contents/${open}`, { token })).statusCode, 404)
    assert.equal((await call(app, 'POST', `/api/contents/${open}/claim`, { token })).statusCode, 404)
    assert.equal((await call(app, 'POST', '/api/contents/claim-next', { token })).json().content.id, mine)
    assert.equal((await call(app, 'POST', '/api/contents/claim-next', { token })).statusCode, 404)
    assert.equal(db.select().from(contents).where(eq(contents.id, open)).get()!.status, 'READY')
    // The person signed in as that user still sees the open queue.
    const cookie = await sessionFor(human.id)
    assert.equal((await call(app, 'GET', `/api/contents/${open}`, { cookie })).statusCode, 200)
  })

  it('the CLI refuses a poster token for a user that is not assigned_only', async () => {
    const { createToken } = await import('../scripts/token.js')
    const human = makeUser('review-cli-open')
    assert.throws(() => createToken({ name: 'p-open', scope: 'poster', user: human.username }), /assigned-only/)
  })
})

describe('finding 4: withdraw and delete never erase publications or metric history', () => {
  it('withdraw, asset delete and item delete refuse with has_publications', async () => {
    const yt = makeUser('review-yt', 'kol', { assignedOnly: true })
    const maker = createApiToken('review-maker-pubs', 'kol', { scope: 'ingest', assignees: [yt.id] })
    const created = await call(app, 'POST', '/api/ingest/contents', { token: maker }, { code: 'REVIEW-PUBS', assignedUserId: yt.id })
    const id = created.json().content.id
    await uploadPart(id, maker, 'v.mp4', 'video/mp4')
    await call(app, 'PATCH', `/api/ingest/contents/${id}`, { token: maker }, { status: 'READY' })
    // A person linked it, then released it: a normal state.
    db.insert(publications)
      .values({ id: `pub-${id}`, contentId: id, userId: yt.id, platform: 'youtube', publishedUrl: 'https://example.test/v' })
      .run()
    db.insert(metricSnapshots).values({ id: `snap-${id}`, publicationId: `pub-${id}`, takenAt: new Date().toISOString(), views: 5 }).run()

    const w = await call(app, 'POST', `/api/ingest/contents/${id}/withdraw`, { token: maker })
    assert.equal(w.statusCode, 409)
    assert.equal(w.json().reason, 'has_publications')
    assert.equal(db.select().from(contents).where(eq(contents.id, id)).get()!.status, 'READY')

    // Even if an admin moved it back to DRAFT, the token cannot delete its files or the item.
    db.update(contents).set({ status: 'DRAFT' }).where(eq(contents.id, id)).run()
    const asset = db.select().from(assets).where(eq(assets.contentId, id)).get()!
    const da = await call(app, 'DELETE', `/api/ingest/contents/${id}/assets/${asset.id}`, { token: maker })
    assert.equal(da.statusCode, 409)
    assert.equal(da.json().reason, 'has_publications')
    const di = await call(app, 'DELETE', `/api/ingest/contents/${id}`, { token: maker })
    assert.equal(di.statusCode, 409)
    assert.equal(di.json().reason, 'has_publications')
    assert.ok(db.select().from(publications).where(eq(publications.id, `pub-${id}`)).get())
    assert.ok(db.select().from(metricSnapshots).where(eq(metricSnapshots.id, `snap-${id}`)).get())
    assert.ok(db.select().from(assets).where(eq(assets.id, asset.id)).get())
  })
})
