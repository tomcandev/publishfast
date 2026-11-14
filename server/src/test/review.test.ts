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
import { assets, contents } from '../db/schema.js'
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
