/**
 * Second security review pass (2026-11-14): uploads in parts (N1-N4) and
 * three small items (S1-S3). Each test here failed before its fix.
 */
import './env.js'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db, sqlite } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { assets, uploads } from '../db/schema.js'
import { createApiToken } from '../lib/auth.js'
import { config } from '../lib/config.js'
import { partsFolder, sweepUploads } from '../lib/uploads.js'
import { call, makeContent, makeUser, multipartFile, sessionFor } from './helpers.js'

let app: FastifyInstance
let maker: string
const MB = 1024 * 1024

before(async () => {
  migrate()
  app = await buildApp({ logger: false })
  maker = createApiToken('r2-maker', 'kol', { scope: 'ingest' })
})

after(async () => {
  await app.close()
  sqlite.close()
})

const base = (id: string) => `/api/ingest/contents/${id}/uploads`
const tick = (n: number) => new Promise<void>((r) => (n <= 0 ? r() : setImmediate(() => tick(n - 1).then(r))))

async function draft(token = maker) {
  const code = `R2-${randomBytes(4).toString('hex')}`
  return (await call(app, 'POST', '/api/ingest/contents', { token }, { code })).json().content.id as string
}
function init(id: string, body: Record<string, unknown>, token = maker) {
  return app.inject({
    method: 'POST',
    url: base(id),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify(body),
  })
}
function part(id: string, up: string, n: number, data: Buffer, token = maker, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'PUT',
    url: `${base(id)}/${up}/parts/${n}`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', ...headers },
    payload: data,
  })
}
const complete = (id: string, up: string, token = maker) =>
  app.inject({ method: 'POST', url: `${base(id)}/${up}/complete`, headers: { authorization: `Bearer ${token}` } })
const abort = (id: string, up: string, token = maker) =>
  app.inject({ method: 'DELETE', url: `${base(id)}/${up}`, headers: { authorization: `Bearer ${token}` } })

/** Files in uploads/ that no assets row names. */
function orphanUploads() {
  const rows = new Set(db.select({ f: assets.filePath }).from(assets).all().map((r) => r.f))
  return readdirSync(config.uploadsDir).filter((f) => !rows.has(f))
}

describe('N1: abort during complete', () => {
  it('never answers 201 with a null asset and never leaves a joined file without a row', async () => {
    const outcomes = new Set<string>()
    for (let i = 0; i < 20; i++) {
      const id = await draft()
      const body = randomBytes(2 * MB)
      const up = (await init(id, { name: 'c.mp4', size: body.length })).json().uploadId
      await part(id, up, 1, body)
      const pc = complete(id, up)
      await tick(i % 6)
      const pa = abort(id, up)
      const [c, a] = await Promise.all([pc, pa])
      outcomes.add(`${c.statusCode}/${a.statusCode}`)
      if (c.statusCode === 201) {
        assert.ok(c.json().asset, 'a 201 always names its asset')
        assert.equal(a.statusCode, 409, 'abort refused once complete won')
      } else {
        assert.equal(c.statusCode, 409)
      }
      assert.deepEqual(orphanUploads(), [], 'no joined file without a row')
    }
    assert.ok(outcomes.size >= 1)
  })

  it('a second complete during the first answers 409 (completing), not a second asset', async () => {
    const id = await draft()
    const body = randomBytes(2 * MB)
    const up = (await init(id, { name: 'd.mp4', size: body.length })).json().uploadId
    await part(id, up, 1, body)
    const [a, b] = await Promise.all([complete(id, up), complete(id, up)])
    const codes = [a.statusCode, b.statusCode].sort()
    assert.ok(codes.join() === '201,409' || codes.join() === '201,201', codes.join())
    const ids = [a, b].filter((r) => r.statusCode === 201).map((r) => r.json().asset.id)
    assert.equal(new Set(ids).size, 1)
    assert.equal(db.select().from(assets).where(eq(assets.contentId, id)).all().length, 1)
    assert.deepEqual(orphanUploads(), [])
  })

  it('a completing mark older than 10 minutes does not strand the upload', async () => {
    const id = await draft()
    const up = (await init(id, { name: 'e.mp4', size: 4 })).json().uploadId
    await part(id, up, 1, Buffer.from('abcd'))
    db.update(uploads).set({ completingAt: new Date(Date.now() - 11 * 60_000).toISOString() }).where(eq(uploads.id, up)).run()
    assert.equal((await complete(id, up)).statusCode, 201)
    const id2 = await draft()
    const up2 = (await init(id2, { name: 'f.mp4', size: 4 })).json().uploadId
    db.update(uploads).set({ completingAt: new Date().toISOString() }).where(eq(uploads.id, up2)).run()
    assert.equal((await abort(id2, up2)).statusCode, 409, 'fresh mark: abort refused')
    assert.equal((await part(id2, up2, 1, Buffer.from('abcd'))).statusCode, 409, 'fresh mark: parts refused')
    db.update(uploads).set({ completingAt: new Date(Date.now() - 11 * 60_000).toISOString() }).where(eq(uploads.id, up2)).run()
    assert.equal((await abort(id2, up2)).statusCode, 200, 'stale mark: abort allowed')
  })
})

describe('N1: crashes and item changes during complete', () => {
  it('a crashed join (stale mark) is swept after 24 hours, joined file included', async () => {
    const id = await draft()
    const up = (await init(id, { name: 'crash.mp4', size: 4 })).json().uploadId
    await part(id, up, 1, Buffer.from('abcd'))
    writeFileSync(join(partsFolder(up), 'joined.00000000-0000-0000-0000-000000000000.tmp'), 'half')
    db.update(uploads)
      .set({
        completingAt: new Date(Date.now() - 25 * 3_600_000).toISOString(),
        createdAt: new Date(Date.now() - 25 * 3_600_000).toISOString(),
      })
      .where(eq(uploads.id, up))
      .run()
    await sweepUploads()
    assert.ok(!existsSync(partsFolder(up)))
    assert.equal(db.select().from(uploads).where(eq(uploads.id, up)).get(), undefined)
  })

  it('releasing or deleting the item while it completes: 201 or 409, never 500, nothing stranded', async () => {
    for (let i = 0; i < 12; i++) {
      const id = await draft()
      const body = randomBytes(2 * MB)
      const up = (await init(id, { name: 'x.mp4', size: body.length })).json().uploadId
      await part(id, up, 1, body)
      const pc = complete(id, up)
      await tick(i % 6)
      const other =
        i % 2
          ? call(app, 'DELETE', `/api/ingest/contents/${id}`, { token: maker })
          : call(app, 'PATCH', `/api/ingest/contents/${id}`, { token: maker }, { status: 'READY' })
      const [c] = await Promise.all([pc, other])
      assert.ok([201, 409].includes(c.statusCode), `complete ${c.statusCode}`)
      if (c.statusCode === 201) assert.ok(c.json().asset)
      assert.deepEqual(orphanUploads(), [])
    }
    await sweepUploads()
    const rows = new Set(db.select({ id: uploads.id }).from(uploads).all().map((r) => r.id))
    assert.ok(readdirSync(config.partsDir).every((d) => rows.has(d)), 'no part folder without its upload')
  })
})

describe('N2: a part is held to its expected length', () => {
  it('declared 1 byte: a 1 MB part is refused (Content-Length and streamed)', async () => {
    const id = await draft()
    const up = (await init(id, { name: 'tiny.mp4', size: 1 })).json().uploadId
    assert.equal((await part(id, up, 1, randomBytes(MB))).statusCode, 413)
    assert.equal((await part(id, up, 1, Buffer.from('xy'))).statusCode, 413)
    assert.equal((await part(id, up, 2, Buffer.from('x'))).statusCode, 400)
    assert.equal((await part(id, up, 1, Buffer.from('x'))).statusCode, 200)
  })

  it('the last part may be at most size - (parts-1) * partSize', async () => {
    const saved = config.uploadPartBytes
    config.uploadPartBytes = 1000
    try {
      const id = await draft()
      const up = (await init(id, { name: 'g.mp4', size: 2100 })).json().uploadId
      assert.equal((await part(id, up, 3, Buffer.alloc(101))).statusCode, 413)
      assert.equal((await part(id, up, 3, Buffer.alloc(100))).statusCode, 200)
      assert.equal((await part(id, up, 1, Buffer.alloc(1001))).statusCode, 413)
    } finally {
      config.uploadPartBytes = saved
    }
  })
})

describe('N3: the ingest cap counts bytes in flight', () => {
  it('8 simultaneous 15 KB uploads under a 30 KB cap: at most 2 succeed', async () => {
    const saved = config.maxIngestBytes
    config.maxIngestBytes = 30_000
    try {
      const token = createApiToken('r2-inflight', 'kol', { scope: 'ingest' })
      const id = await draft(token)
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => {
          const { payload, headers } = multipartFile(`p${i}.mp4`, 'video/mp4', Buffer.alloc(15_000, i))
          return app.inject({
            method: 'POST',
            url: `/api/ingest/contents/${id}/assets`,
            headers: { ...headers, authorization: `Bearer ${token}` },
            payload,
          })
        }),
      )
      const ok = results.filter((r) => r.statusCode === 201).length
      assert.ok(ok <= 1, `${ok} uploads succeeded`) // 15 KB of media + multipart framing per request
      assert.ok(results.every((r) => [201, 413].includes(r.statusCode)))
      const total = db.select().from(assets).where(eq(assets.contentId, id)).all().reduce((s, a) => s + a.size, 0)
      assert.ok(total <= 30_000)
    } finally {
      config.maxIngestBytes = saved
    }
  })
})

describe('N4: replacing a part during complete', () => {
  it('the asset row always matches the bytes on disk and the declared size', async () => {
    for (let i = 0; i < 10; i++) {
      const id = await draft()
      const body = randomBytes(2 * MB)
      const up = (await init(id, { name: 'r.mp4', size: body.length })).json().uploadId
      await part(id, up, 1, body)
      const pc = complete(id, up)
      await tick(i % 5)
      const pp = part(id, up, 1, randomBytes(10))
      const [c] = await Promise.all([pc, pp])
      if (c.statusCode === 201) {
        const row = db.select().from(assets).where(eq(assets.id, c.json().asset.id)).get()!
        assert.equal(row.size, body.length)
        assert.equal(statSync(join(config.uploadsDir, row.filePath)).size, body.length)
      }
      assert.deepEqual(orphanUploads(), [])
    }
  })
})

describe('S1: inline media can play in a tab; script still cannot run', () => {
  it('the CSP allows same-origin media and images, nothing else', async () => {
    const legacy = createApiToken('r2-legacy')
    const id = makeContent({ status: 'READY' })
    const { payload, headers } = multipartFile('v.mp4', 'video/mp4', Buffer.from('v'))
    await app.inject({ method: 'POST', url: `/api/ingest/contents/${id}/assets`, headers: { ...headers, authorization: `Bearer ${legacy}` }, payload })
    const a = db.select().from(assets).where(eq(assets.contentId, id)).get()!
    const cookie = await sessionFor(makeUser('r2-admin', 'admin').id)
    const res = await call(app, 'GET', `/api/assets/${a.id}`, { cookie })
    const csp = String(res.headers['content-security-policy'])
    // Third review: allow-same-origin added so the video plays in a tab; still no script.
    assert.equal(csp, "sandbox allow-same-origin; default-src 'none'; img-src 'self'; media-src 'self'")
    assert.ok(!/allow-scripts|script-src/.test(csp), 'no script source is allowed')
  })
})

describe('S2: publication links', () => {
  it('a signed-in person may still save an app link (old behaviour); dangerous schemes are refused', async () => {
    const u = makeUser('r2-person')
    const cookie = await sessionFor(u.id)
    const id = makeContent({ status: 'CLAIMED', claimedBy: u.id })
    const ok = await call(app, 'POST', '/api/publications', { cookie }, { contentId: id, platform: 'tiktok', publishedUrl: 'snssdk1233://aweme/detail/123' })
    assert.equal(ok.statusCode, 200)
    for (const url of ['javascript:alert(1)', 'JavaScript:alert(1)', 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd']) {
      const res = await call(app, 'POST', '/api/publications', { cookie }, { contentId: id, platform: 'other', publishedUrl: url })
      assert.equal(res.statusCode, 400, url)
    }
  })

  it('a poster token keeps the strict http(s) rule', async () => {
    const u = makeUser('r2-poster', 'kol', { assignedOnly: true })
    const token = createApiToken('r2-poster', 'kol', { scope: 'poster', userId: u.id })
    const id = makeContent({ status: 'READY', assignedUserId: u.id })
    await call(app, 'POST', `/api/contents/${id}/claim`, { token })
    const res = await call(app, 'POST', '/api/publications', { token }, { contentId: id, platform: 'tiktok', publishedUrl: 'snssdk1233://aweme/detail/1' })
    assert.equal(res.statusCode, 400)
  })
})

describe('S3: request timeout and listing unfinished uploads', () => {
  it('the server has a request timeout (default 30 minutes)', () => {
    assert.equal(config.requestTimeoutMs, 30 * 60_000)
    assert.equal(app.initialConfig.requestTimeout, 30 * 60_000)
  })

  it('GET …/uploads lists the item’s unfinished uploads, for its owner only; the item shows them too', async () => {
    const id = await draft()
    const up = (await init(id, { name: 'resume.mp4', size: 10 })).json().uploadId
    await part(id, up, 1, Buffer.alloc(10))
    const done = (await init(id, { name: 'done.mp4', size: 1 })).json().uploadId
    await part(id, done, 1, Buffer.alloc(1))
    await complete(id, done)

    const list = await call(app, 'GET', base(id), { token: maker })
    assert.equal(list.statusCode, 200)
    assert.deepEqual(list.json().uploads, [
      { uploadId: up, name: 'resume.mp4', size: 10, partSize: config.uploadPartBytes, received: [1] },
    ])
    const other = createApiToken('r2-other', 'kol', { scope: 'ingest' })
    assert.equal((await call(app, 'GET', base(id), { token: other })).statusCode, 404)

    const item = (await call(app, 'GET', `/api/ingest/contents/${id}`, { token: maker })).json().content
    assert.deepEqual(item.uploads.map((u: { uploadId: string }) => u.uploadId), [up])
    const code = item.code
    const byCode = (await call(app, 'GET', `/api/ingest/contents?code=${code}`, { token: maker })).json().contents[0]
    assert.equal(byCode.uploads.length, 1)
  })
})
