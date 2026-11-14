/**
 * Uploads in parts (contract section 12): large files as several requests of
 * at most 32 MB, so no body reaches Cloudflare's 100 MB limit.
 */
import './env.js'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { Readable } from 'node:stream'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db, sqlite } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { assets, contents, uploads } from '../db/schema.js'
import { createApiToken } from '../lib/auth.js'
import { config } from '../lib/config.js'
import { partsFolder, sweepUploads } from '../lib/uploads.js'
import { call, makeContent, makeUser, sessionFor } from './helpers.js'

const MB = 1024 * 1024
let app: FastifyInstance
let maker: string
let otherMaker: string
let legacyAdmin: string
let adminCookie: string

before(async () => {
  migrate()
  app = await buildApp({ logger: false })
  maker = createApiToken('parts-maker', 'kol', { scope: 'ingest' })
  otherMaker = createApiToken('parts-other', 'kol', { scope: 'ingest' })
  legacyAdmin = createApiToken('parts-legacy')
  adminCookie = await sessionFor(makeUser('parts-admin', 'admin').id)
})

after(async () => {
  await app.close()
  sqlite.close()
})

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const base = (id: string) => `/api/ingest/contents/${id}/uploads`

async function draft(token = maker, code = `PARTS-${Math.random().toString(36).slice(2, 8)}`) {
  const res = await call(app, 'POST', '/api/ingest/contents', { token }, { code })
  assert.equal(res.statusCode, 201)
  return res.json().content.id as string
}

const init = (id: string, body: Record<string, unknown>, token = maker) => initAs(id, body, token)
function initAs(id: string, body: Record<string, unknown>, token: string) {
  return app.inject({
    method: 'POST',
    url: base(id),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  })
}

function part(id: string, uploadId: string, n: number, data: Buffer | Readable, token = maker) {
  return app.inject({
    method: 'PUT',
    url: `${base(id)}/${uploadId}/parts/${n}`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
    payload: data,
  })
}

const complete = (id: string, uploadId: string, token = maker) =>
  app.inject({ method: 'POST', url: `${base(id)}/${uploadId}/complete`, headers: { authorization: `Bearer ${token}` } })

const uploadsOnDisk = () => readdirSync(config.uploadsDir).length

describe('uploads in parts', () => {
  it('a 70 MB file in 32 MB parts arrives byte for byte, parts out of order and repeated', async () => {
    const file = randomBytes(70 * MB)
    const id = await draft()
    const start = await init(id, { name: 'long.mp4', size: file.length, mime: 'video/mp4', sha256: sha(file) })
    assert.equal(start.statusCode, 201)
    const { uploadId, partSize, parts } = start.json()
    assert.equal(partSize, 32 * MB)
    assert.equal(parts, 3)
    const slice = (n: number) => file.subarray((n - 1) * partSize, n * partSize)

    assert.equal((await part(id, uploadId, 3, slice(3))).json().size, file.length - 2 * partSize)
    assert.equal((await part(id, uploadId, 1, randomBytes(1000))).statusCode, 200) // wrong bytes first…
    assert.deepEqual((await part(id, uploadId, 1, slice(1))).json(), { part: 1, size: partSize }) // …replaced

    const half = await call(app, 'GET', `${base(id)}/${uploadId}`, { token: maker })
    assert.deepEqual(half.json().received, [1, 3])
    const early = await complete(id, uploadId)
    assert.equal(early.statusCode, 409)
    assert.deepEqual(early.json().missing, [2])

    assert.equal((await part(id, uploadId, 2, slice(2))).statusCode, 200)
    const done = await complete(id, uploadId)
    assert.equal(done.statusCode, 201)
    const asset = done.json().asset
    assert.equal(asset.size, file.length)
    assert.equal(asset.type, 'video')
    assert.equal(asset.mime, 'video/mp4')
    assert.equal(asset.originalName, 'long.mp4')
    assert.equal(asset.filePath, undefined)
    assert.ok(!existsSync(partsFolder(uploadId)), 'parts deleted once joined')

    const dl = await call(app, 'GET', `/api/assets/${asset.id}/download`, { cookie: adminCookie })
    assert.equal(sha(dl.rawPayload), sha(file))

    const again = await complete(id, uploadId)
    assert.equal(again.statusCode, 201)
    assert.equal(again.json().asset.id, asset.id, 'completing twice answers the same asset')
    assert.equal(db.select().from(assets).where(eq(assets.contentId, id)).all().length, 1)
  })

  it('a wrong sha256 answers 422 and keeps nothing', async () => {
    const file = randomBytes(1000)
    const id = await draft()
    const before = uploadsOnDisk()
    const { uploadId } = (await init(id, { name: 'x.mp4', size: 1000, sha256: 'a'.repeat(64) })).json()
    await part(id, uploadId, 1, file)
    const res = await complete(id, uploadId)
    assert.equal(res.statusCode, 422)
    assert.equal(uploadsOnDisk(), before)
    assert.ok(!existsSync(partsFolder(uploadId)))
    assert.equal(db.select().from(uploads).where(eq(uploads.id, uploadId)).get(), undefined)
    assert.equal(db.select().from(assets).where(eq(assets.contentId, id)).all().length, 0)
  })

  it('an oversize part answers 413, with or without Content-Length, and leaves no bytes', async () => {
    const saved = config.uploadPartBytes
    config.uploadPartBytes = 1000
    try {
      const id = await draft()
      const { uploadId, partSize } = (await init(id, { name: 'y.mp4', size: 2500 })).json()
      assert.equal(partSize, 1000)
      assert.equal((await part(id, uploadId, 1, Buffer.alloc(1001))).statusCode, 413)
      assert.equal((await part(id, uploadId, 2, Readable.from([Buffer.alloc(600), Buffer.alloc(600)]))).statusCode, 413)
      const left = existsSync(partsFolder(uploadId)) ? readdirSync(partsFolder(uploadId)) : []
      assert.deepEqual(left, [])
      assert.equal((await part(id, uploadId, 4, Buffer.alloc(10))).statusCode, 400, 'no part 4 of 3')
      assert.equal((await part(id, uploadId, 0, Buffer.alloc(10))).statusCode, 400)
      // Sizes must add up.
      for (const n of [1, 2, 3]) await part(id, uploadId, n, Buffer.alloc(n === 3 ? 400 : 1000))
      const bad = await complete(id, uploadId)
      assert.equal(bad.statusCode, 409)
      assert.equal(bad.json().receivedBytes, 2400)
    } finally {
      config.uploadPartBytes = saved
    }
  })

  it('another token gets 404; a non-draft gets 409; releasing the item drops its unfinished upload', async () => {
    const id = await draft()
    const { uploadId } = (await init(id, { name: 'z.mp4', size: 10 })).json()
    assert.equal((await init(id, { name: 'z.mp4', size: 10 }, otherMaker)).statusCode, 404)
    assert.equal((await part(id, uploadId, 1, Buffer.alloc(10), otherMaker)).statusCode, 404)
    assert.equal((await call(app, 'GET', `${base(id)}/${uploadId}`, { token: otherMaker })).statusCode, 404)
    assert.equal((await complete(id, uploadId, otherMaker)).statusCode, 404)
    assert.equal((await call(app, 'DELETE', `${base(id)}/${uploadId}`, { token: otherMaker })).statusCode, 404)

    await part(id, uploadId, 1, Buffer.alloc(10))
    assert.equal((await call(app, 'PATCH', `/api/ingest/contents/${id}`, { token: maker }, { status: 'READY' })).statusCode, 200)
    assert.equal(db.select().from(uploads).where(eq(uploads.id, uploadId)).get(), undefined)
    assert.ok(!existsSync(partsFolder(uploadId)))
    assert.equal((await init(id, { name: 'z.mp4', size: 10 })).statusCode, 409)

    // A part arriving for an item an admin released in between is refused.
    const id2 = await draft()
    const up2 = (await init(id2, { name: 'w.mp4', size: 10 })).json().uploadId
    db.update(contents).set({ status: 'READY' }).where(eq(contents.id, id2)).run()
    assert.equal((await part(id2, up2, 1, Buffer.alloc(10))).statusCode, 409)
    assert.equal((await complete(id2, up2)).statusCode, 409)
  })

  it('abort deletes the parts', async () => {
    const id = await draft()
    const { uploadId } = (await init(id, { name: 'a.mp4', size: 10 })).json()
    await part(id, uploadId, 1, Buffer.alloc(10))
    assert.ok(existsSync(partsFolder(uploadId)))
    assert.equal((await call(app, 'DELETE', `${base(id)}/${uploadId}`, { token: maker })).statusCode, 200)
    assert.ok(!existsSync(partsFolder(uploadId)))
    assert.equal((await call(app, 'GET', `${base(id)}/${uploadId}`, { token: maker })).statusCode, 404)
  })

  it('the scheduler sweeps unfinished uploads older than 24 hours', async () => {
    const id = await draft()
    const old = (await init(id, { name: 'old.mp4', size: 10 })).json().uploadId
    const fresh = (await init(id, { name: 'fresh.mp4', size: 10 })).json().uploadId
    await part(id, old, 1, Buffer.alloc(10))
    await part(id, fresh, 1, Buffer.alloc(10))
    db.update(uploads).set({ createdAt: new Date(Date.now() - 25 * 3_600_000).toISOString() }).where(eq(uploads.id, old)).run()
    assert.ok((await sweepUploads()) >= 1)
    assert.equal(db.select().from(uploads).where(eq(uploads.id, old)).get(), undefined)
    assert.ok(!existsSync(partsFolder(old)))
    assert.ok(db.select().from(uploads).where(eq(uploads.id, fresh)).get())
    assert.ok(existsSync(partsFolder(fresh)))
  })

  it('caps and the free-space floor apply to the declared size before any byte', async () => {
    const fresh = createApiToken('parts-cap', 'kol', { scope: 'ingest' })
    const id = await draft(fresh)
    const init = (item: string, body: Record<string, unknown>, token = fresh) => initAs(item, body, token)
    const saved = { up: config.maxUploadBytes, ingest: config.maxIngestBytes, free: config.minFreeBytes }
    try {
      config.maxUploadBytes = 1000
      assert.equal((await init(id, { name: 'a.mp4', size: 1001 })).statusCode, 413)
      config.maxUploadBytes = saved.up
      config.maxIngestBytes = 1000
      assert.equal((await init(id, { name: 'a.mp4', size: 600 })).statusCode, 201)
      assert.equal((await init(id, { name: 'b.mp4', size: 600 })).statusCode, 413, 'an open upload reserves its size')
      config.maxIngestBytes = saved.ingest
      config.minFreeBytes = Number.MAX_SAFE_INTEGER
      assert.equal((await init(id, { name: 'c.mp4', size: 10 })).statusCode, 507)
      const legacyItem = makeContent({ status: 'DRAFT' })
      assert.equal((await init(legacyItem, { name: 'c.mp4', size: 10 }, legacyAdmin)).statusCode, 507, 'old tokens too')
    } finally {
      Object.assign(config, { maxUploadBytes: saved.up, maxIngestBytes: saved.ingest, minFreeBytes: saved.free })
    }
  })

  it('validates name, size and type; svg and html refused for scoped tokens', async () => {
    const id = await draft()
    for (const body of [
      { name: '../x.mp4', size: 10 },
      { name: 'a/b.mp4', size: 10 },
      { name: 'a\\b.mp4', size: 10 },
      { name: 'a\u0000.mp4', size: 10 },
      { name: '', size: 10 },
      { name: 'x.mp4', size: 0 },
      { name: 'x.mp4', size: 1.5 },
      { name: 'x.mp4', size: 10, sha256: 'xyz' },
      { name: 'e.svg', size: 10 },
      { name: 'e.png', size: 10, mime: 'image/svg+xml' },
      { name: 'e.html', size: 10 },
    ]) {
      assert.equal((await init(id, body)).statusCode, 400, JSON.stringify(body))
    }
    const notJson = await app.inject({ method: 'POST', url: base(id), headers: { authorization: `Bearer ${maker}` }, payload: 'nope' })
    assert.equal(notJson.statusCode, 400)
  })

  it('the type is decided like the multipart route; old admin tokens may use it on any draft', async () => {
    const item = makeContent({ status: 'DRAFT' })
    for (const [name, mime, type] of [
      ['n14.srt', 'application/x-subrip', 'file'],
      ['slide.jpg', undefined, 'image'],
      ['clip.mov', 'binary/octet-stream', 'video'],
    ] as const) {
      const { uploadId } = (await init(item, { name, size: 4, ...(mime ? { mime } : {}) }, legacyAdmin)).json()
      await part(item, uploadId, 1, Buffer.from('abcd'), legacyAdmin)
      const res = await complete(item, uploadId, legacyAdmin)
      assert.equal(res.statusCode, 201)
      assert.equal(res.json().asset.type, type, name)
    }
  })

  it('poster, read, files, old kol tokens and sessions are refused', async () => {
    const id = await draft()
    const yt = makeUser('parts-yt', 'kol', { assignedOnly: true })
    for (const token of [
      createApiToken('parts-poster', 'kol', { scope: 'poster', userId: yt.id }),
      createApiToken('parts-read', 'kol', { scope: 'read' }),
      createApiToken('parts-files', 'kol', { scope: 'files', filePrefix: 'x/' }),
      createApiToken('parts-kol', 'kol'),
    ]) {
      assert.equal((await init(id, { name: 'a.mp4', size: 10 }, token)).statusCode, 403)
    }
    const viaSession = await app.inject({
      method: 'POST',
      url: base(id),
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'a.mp4', size: 10 }),
    })
    assert.equal(viaSession.statusCode, 403)
  })

  it('the drop box default cap is 90 MB, under the tunnel limit', () => {
    assert.equal(config.maxFileBytes, 90 * MB)
  })
})
