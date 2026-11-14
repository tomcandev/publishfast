/**
 * Fixes from the independent security review (2026-11-14). Each describe
 * block reproduces one finding; every test here failed before its fix.
 */
import './env.js'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'
import { after, before, beforeEach, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db, sqlite } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { apiTokens, assets, contents, files, metricSnapshots, publications } from '../db/schema.js'
import { createApiToken } from '../lib/auth.js'
import { config } from '../lib/config.js'
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

describe('finding 6: untyped uploads from the old pipeline keep showing up', () => {
  it('no Content-Type, application/octet-stream and binary/octet-stream are typed by extension', async () => {
    const id = makeContent({ status: 'DRAFT' })
    const cases: [string, string | null, string, string][] = [
      ['s1.jpg', null, 'image', 'image/jpeg'],
      ['s2.png', 'application/octet-stream', 'image', 'image/png'],
      ['s3.jpeg', 'binary/octet-stream', 'image', 'image/jpeg'],
      ['v1.mp4', null, 'video', 'video/mp4'],
      ['v2.mov', 'binary/octet-stream', 'video', 'video/quicktime'],
      ['c1.srt', null, 'file', 'text/plain'],
      ['c2.vtt', 'binary/octet-stream', 'file', 'binary/octet-stream'],
      ['u1.dat', null, 'image', 'text/plain'], // unknown: the old behaviour
      ['u2', 'binary/octet-stream', 'image', 'binary/octet-stream'],
    ]
    for (const [name, mime, type, stored] of cases) {
      assert.equal((await uploadPart(id, legacyAdmin, name, mime)).statusCode, 201, name)
      const row = assetByName(name)
      assert.equal(row.type, type, name)
      assert.equal(row.mime, stored, name)
    }
    // And the image previews inline with the right type.
    const res = await call(app, 'GET', `/api/assets/${assetByName('s1.jpg').id}`, { cookie: adminCookie })
    assert.equal(res.headers['content-type'], 'image/jpeg')
  })
})

describe('finding 5: disk', () => {
  const uploadsOnDisk = () => readdirSync(config.uploadsDir).length
  const filesOnDisk = () => readdirSync(config.filesDir).length

  it('(a) an oversize upload leaves no bytes and no rows behind', async () => {
    const saved = config.maxUploadBytes
    config.maxUploadBytes = 1000
    const small = await buildApp({ logger: false })
    config.maxUploadBytes = saved
    try {
      const id = makeContent({ status: 'DRAFT' })
      const before = uploadsOnDisk()
      const { payload, headers } = multipartFile('big.mp4', 'video/mp4', Buffer.alloc(5000, 1))
      const res = await small.inject({
        method: 'POST',
        url: `/api/ingest/contents/${id}/assets`,
        headers: { ...headers, authorization: `Bearer ${legacyAdmin}` },
        payload,
      })
      assert.equal(res.statusCode, 413)
      assert.equal(uploadsOnDisk(), before)
      assert.equal(db.select().from(assets).where(eq(assets.contentId, id)).all().length, 0)
    } finally {
      await small.close()
    }
  })

  it('(a) a refused second part removes the first part’s bytes too', async () => {
    const maker = createApiToken('review-maker-parts', 'kol', { scope: 'ingest' })
    const id = (await call(app, 'POST', '/api/ingest/contents', { token: maker }, { code: 'REVIEW-PARTS' })).json().content.id
    const before = uploadsOnDisk()
    const a = multipartFile('ok.mp4', 'video/mp4', Buffer.from('video'))
    const b = multipartFile('evil.svg', 'image/svg+xml', Buffer.from('<svg/>'))
    const boundaryA = a.headers['content-type'].split('boundary=')[1]!
    const boundaryB = b.headers['content-type'].split('boundary=')[1]!
    const second = b.payload.toString('latin1').split(boundaryB).join(boundaryA)
    const payload = Buffer.concat([
      Buffer.from(a.payload.toString('latin1').replace(`--${boundaryA}--\r\n`, ''), 'latin1'),
      Buffer.from(second.slice(0), 'latin1'),
    ])
    const res = await app.inject({
      method: 'POST',
      url: `/api/ingest/contents/${id}/assets`,
      headers: { 'content-type': a.headers['content-type'], authorization: `Bearer ${maker}` },
      payload,
    })
    assert.equal(res.statusCode, 400)
    assert.equal(uploadsOnDisk(), before)
    assert.equal(db.select().from(assets).where(eq(assets.contentId, id)).all().length, 0)
  })

  it('(b) the drop box caps the total bytes under one prefix (admin tokens exempt)', async () => {
    const saved = config.maxFilesPrefixBytes
    config.maxFilesPrefixBytes = 1000
    try {
      const worker = createApiToken('review-cap-files', 'kol', { scope: 'files', filePrefix: 'cap/' })
      const put = (key: string, n: number, token = worker) =>
        app.inject({ method: 'PUT', url: `/api/files/${key}`, headers: { authorization: `Bearer ${token}` }, payload: Buffer.alloc(n, 1) })
      assert.equal((await put('cap/a', 600)).statusCode, 201)
      const before = filesOnDisk()
      assert.equal((await put('cap/b', 600)).statusCode, 413)
      assert.equal(filesOnDisk(), before, 'nothing kept')
      assert.equal((await put('cap/a', 900)).statusCode, 200, 'replacing counts the new size only')
      assert.equal((await put('cap/c', 600, legacyAdmin)).statusCode, 201, 'old admin token exempt')
    } finally {
      config.maxFilesPrefixBytes = saved
    }
  })

  it('(b) an ingest token’s DRAFT+READY assets are capped in total', async () => {
    const saved = config.maxIngestBytes
    config.maxIngestBytes = 1000
    try {
      const maker = createApiToken('review-cap-ingest', 'kol', { scope: 'ingest' })
      const id = (await call(app, 'POST', '/api/ingest/contents', { token: maker }, { code: 'REVIEW-CAP' })).json().content.id
      assert.equal((await uploadPart(id, maker, 'a.mp4', 'video/mp4', Buffer.alloc(600, 1))).statusCode, 201)
      const before = uploadsOnDisk()
      assert.equal((await uploadPart(id, maker, 'b.mp4', 'video/mp4', Buffer.alloc(600, 1))).statusCode, 413)
      assert.equal(uploadsOnDisk(), before)
      assert.equal((await uploadPart(id, legacyAdmin, 'c.mp4', 'video/mp4', Buffer.alloc(600, 1))).statusCode, 201, 'old admin token exempt')
    } finally {
      config.maxIngestBytes = saved
    }
  })

  it('(c) both upload routes refuse with 507 below the free-space floor, old tokens included', async () => {
    const saved = config.minFreeBytes
    config.minFreeBytes = Number.MAX_SAFE_INTEGER
    try {
      const id = makeContent({ status: 'DRAFT' })
      assert.equal((await uploadPart(id, legacyAdmin, 'x.mp4', 'video/mp4')).statusCode, 507)
      const put = await app.inject({ method: 'PUT', url: '/api/files/any/x', headers: { authorization: `Bearer ${legacyAdmin}` }, payload: 'x' })
      assert.equal(put.statusCode, 507)
    } finally {
      config.minFreeBytes = saved
    }
  })
})

describe('finding 7: token rotate keeps the token’s work', () => {
  it('a draft and an in-flight claim continue with the new token', async () => {
    const { rotateToken } = await import('../scripts/token.js')
    const yt = makeUser('review-rot', 'kol', { assignedOnly: true })
    const maker = createApiToken('review-rot-maker', 'kol', { scope: 'ingest', assignees: [yt.id] })
    const poster = createApiToken('review-rot-poster', 'kol', { scope: 'poster', userId: yt.id })
    const draft = (await call(app, 'POST', '/api/ingest/contents', { token: maker }, { code: 'REVIEW-ROT', assignedUserId: yt.id })).json().content.id
    const item = makeContent({ status: 'READY', assignedUserId: yt.id })
    assert.equal((await call(app, 'POST', `/api/contents/${item}/claim`, { token: poster })).statusCode, 200)

    const newMaker = rotateToken('review-rot-maker')
    const newPoster = rotateToken('review-rot-poster')

    assert.equal((await call(app, 'GET', `/api/ingest/contents/${draft}`, { token: newMaker })).statusCode, 200)
    assert.equal((await call(app, 'GET', '/api/ingest/contents?code=REVIEW-ROT', { token: newMaker })).json().contents.length, 1)
    assert.equal((await uploadPart(draft, newMaker, 'r.mp4', 'video/mp4')).statusCode, 201)
    assert.equal((await call(app, 'PATCH', `/api/ingest/contents/${draft}`, { token: newMaker }, { status: 'READY' })).statusCode, 200)

    const got = (await call(app, 'GET', `/api/contents/${item}`, { token: newPoster })).json().content
    assert.equal(got.claimedByThisToken, true)
    const link = await call(app, 'POST', '/api/publications', { token: newPoster }, {
      contentId: item,
      platform: 'youtube',
      publishedUrl: 'https://example.test/rot',
    })
    assert.equal(link.statusCode, 200)
    assert.equal((await call(app, 'POST', `/api/contents/${item}/complete`, { token: newPoster })).statusCode, 200)
    // The old ones are dead.
    assert.equal((await call(app, 'GET', `/api/ingest/contents/${draft}`, { token: maker })).statusCode, 401)
  })

  it('drop-box files follow the new token id too', async () => {
    const { rotateToken } = await import('../scripts/token.js')
    const worker = createApiToken('review-rot-files', 'kol', { scope: 'files', filePrefix: 'rot/' })
    await app.inject({ method: 'PUT', url: '/api/files/rot/a', headers: { authorization: `Bearer ${worker}` }, payload: 'a' })
    rotateToken('review-rot-files')
    const fresh = db.select().from(apiTokens).where(eq(apiTokens.name, 'review-rot-files')).all().find((t) => !t.revokedAt)!
    assert.equal(db.select().from(files).where(eq(files.key, 'rot/a')).get()!.createdByToken, fresh.id)
  })
})

describe('small fixes', () => {
  it('no response carries created_by_token or claimed_by_token ids', async () => {
    const yt = makeUser('review-ids', 'kol', { assignedOnly: true })
    const maker = createApiToken('review-ids-maker', 'kol', { scope: 'ingest', assignees: [yt.id] })
    const poster = createApiToken('review-ids-poster', 'kol', { scope: 'poster', userId: yt.id })
    const created = await call(app, 'POST', '/api/ingest/contents', { token: maker }, { code: 'REVIEW-IDS', assignedUserId: yt.id })
    const id = created.json().content.id
    await uploadPart(id, maker, 'i.mp4', 'video/mp4')
    const ready = await call(app, 'PATCH', `/api/ingest/contents/${id}`, { token: maker }, { status: 'READY' })
    await call(app, 'POST', `/api/contents/${id}/claim`, { token: poster })
    const ids = db.select({ id: apiTokens.id }).from(apiTokens).all().map((t) => t.id)
    const bodies = [
      created.body,
      ready.body,
      (await call(app, 'GET', `/api/ingest/contents/${id}`, { token: maker })).body,
      (await call(app, 'GET', '/api/ingest/contents?code=REVIEW-IDS', { token: maker })).body,
      (await call(app, 'GET', `/api/contents/${id}`, { token: poster })).body,
      (await call(app, 'GET', '/api/admin/contents', { cookie: adminCookie })).body,
      (await call(app, 'PATCH', `/api/admin/contents/${id}`, { cookie: adminCookie }, { title: 't' })).body,
    ]
    for (const body of bodies) {
      assert.ok(!body.includes('"createdByToken"') && !body.includes('"claimedByToken"'), body.slice(0, 80))
      for (const t of ids) assert.ok(!body.includes(t), 'a token id leaked')
    }
  })

  it('publications accept only http(s) links', async () => {
    const u = makeUser('review-links', 'kol')
    const cookie = await sessionFor(u.id)
    const id = makeContent({ status: 'CLAIMED', claimedBy: u.id })
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'ftp://example.test/x']) {
      const res = await call(app, 'POST', '/api/publications', { cookie }, { contentId: id, platform: 'other', publishedUrl: url })
      assert.equal(res.statusCode, 400, url)
    }
    const ok = await call(app, 'POST', '/api/publications', { cookie }, { contentId: id, platform: 'other', publishedUrl: 'https://example.test/x' })
    assert.equal(ok.statusCode, 200)
  })

  it('scoped tokens may only use codes of [A-Za-z0-9._-]', async () => {
    const maker = createApiToken('review-codes', 'kol', { scope: 'ingest' })
    for (const code of ['A B', 'NHI/1', 'ü', 'x\u0001', '<b>']) {
      assert.equal((await call(app, 'POST', '/api/ingest/contents', { token: maker }, { code })).statusCode, 400, code)
    }
    const ok = await call(app, 'POST', '/api/ingest/contents', { token: maker }, { code: 'NHI-PTE-P04.v2_x' })
    assert.equal(ok.statusCode, 201)
    const patched = await call(app, 'PATCH', `/api/ingest/contents/${ok.json().content.id}`, { token: maker }, { code: 'bad code' })
    assert.equal(patched.statusCode, 400)
    // Old tokens keep their freedom.
    assert.equal((await call(app, 'POST', '/api/ingest/contents', { token: legacyAdmin }, { code: 'OLD CODE ü' })).statusCode, 201)
  })

  it('a scoped token gets the same answer for an unknown user and a user outside its list', async () => {
    const yt = makeUser('review-same')
    const outsider = makeUser('review-outsider')
    const maker = createApiToken('review-same-maker', 'kol', { scope: 'ingest', assignees: [yt.id] })
    const a = await call(app, 'POST', '/api/ingest/contents', { token: maker }, { code: 'REVIEW-S1', assignedUserId: 'no-such-user' })
    const b = await call(app, 'POST', '/api/ingest/contents', { token: maker }, { code: 'REVIEW-S2', assignedUserId: outsider.username })
    assert.equal(a.statusCode, 400)
    assert.deepEqual(a.json(), b.json())
  })

  it('an ingest token with an empty assignee list may only create unassigned items', async () => {
    const open = createApiToken('review-open-maker', 'kol', { scope: 'ingest', assignees: [] })
    const someone = makeUser('review-someone')
    const res = await call(app, 'POST', '/api/ingest/contents', { token: open }, { code: 'REVIEW-E1', assignedUserId: someone.id })
    assert.equal(res.statusCode, 400)
    const unknown = await call(app, 'POST', '/api/ingest/contents', { token: open }, { code: 'REVIEW-E2', assignedUserId: 'nobody' })
    assert.deepEqual(unknown.json(), res.json())
    const okay = await call(app, 'POST', '/api/ingest/contents', { token: open }, { code: 'REVIEW-E3' })
    assert.equal(okay.statusCode, 201)
    const patch = await call(app, 'PATCH', `/api/ingest/contents/${okay.json().content.id}`, { token: open }, { assignedUserId: someone.id })
    assert.equal(patch.statusCode, 400)
  })
})
