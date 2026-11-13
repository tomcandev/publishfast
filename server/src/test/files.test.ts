/**
 * The drop box (contract section 9): prefix isolation, key validation,
 * expiry and the sweep, the size cap, scope refusals, a 5 MB body streamed
 * intact, and replacing a key.
 */
import './env.js'
import './env-files.js'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { Readable } from 'node:stream'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db, sqlite } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { apiTokens, files, tokenEvents } from '../db/schema.js'
import { createApiToken } from '../lib/auth.js'
import { config } from '../lib/config.js'
import { isValidFileKey, sweepExpiredFiles } from '../lib/files.js'
import { call, makeUser, sessionFor } from './helpers.js'

let app: FastifyInstance
let worker: string // files, prefix nhi/
let otherWorker: string // files, prefix other/
let noPrefix: string // files, no prefix
let maker: string // ingest, prefix nhi/
let makerNoPrefix: string // ingest, no prefix
let admin: string

before(async () => {
  migrate()
  app = await buildApp({ logger: false })
  worker = createApiToken('worker', 'kol', { scope: 'files', filePrefix: 'nhi/' })
  otherWorker = createApiToken('other-worker', 'kol', { scope: 'files', filePrefix: 'other/' })
  noPrefix = createApiToken('no-prefix', 'kol', { scope: 'files' })
  maker = createApiToken('maker', 'kol', { scope: 'ingest', filePrefix: 'nhi/' })
  makerNoPrefix = createApiToken('maker-np', 'kol', { scope: 'ingest' })
  admin = createApiToken('files-admin')
})

after(async () => {
  await app.close()
  sqlite.close()
})

function put(key: string, token: string, body: Buffer | Readable, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'PUT',
    url: `/api/files/${key}`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/zip', ...headers },
    payload: body,
  })
}
const get = (key: string, token: string, method: 'GET' | 'HEAD' | 'DELETE' = 'GET') =>
  app.inject({ method, url: `/api/files/${key}`, headers: { authorization: `Bearer ${token}` } })
const list = (token: string, prefix = '') =>
  app.inject({ method: 'GET', url: `/api/files?prefix=${encodeURIComponent(prefix)}`, headers: { authorization: `Bearer ${token}` } })
const onDisk = () => readdirSync(config.filesDir).length
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

describe('drop box', () => {
  it('streams a 5 MB body to disk intact and serves it back with its sha256', async () => {
    const body = randomBytes(5 * 1024 * 1024)
    const res = await put('nhi/voice/issue-12.zip', worker, body, { 'x-expires-days': '14' })
    assert.equal(res.statusCode, 201)
    const out = res.json()
    assert.equal(out.key, 'nhi/voice/issue-12.zip')
    assert.equal(out.size, body.length)
    assert.equal(out.sha256, sha(body))
    const days = (Date.parse(out.expiresAt) - Date.now()) / 86_400_000
    assert.ok(days > 13.9 && days <= 14)

    for (const token of [worker, maker, admin]) {
      const dl = await get('nhi/voice/issue-12.zip', token)
      assert.equal(dl.statusCode, 200)
      assert.equal(sha(dl.rawPayload), sha(body))
      assert.equal(dl.headers['x-sha256'], sha(body))
      assert.equal(dl.headers['content-type'], 'application/zip')
      const head = await get('nhi/voice/issue-12.zip', token, 'HEAD')
      assert.equal(head.statusCode, 200)
      assert.equal(head.headers['content-length'], String(body.length))
      assert.equal(head.headers['x-sha256'], sha(body))
      assert.equal(head.headers['x-expires-at'], out.expiresAt)
      assert.equal(head.rawPayload.length, 0)
    }
    // The key is never a file name on disk.
    assert.ok(readdirSync(config.filesDir).every((n) => !n.includes('issue')))
  })

  it('accepts a chunked body without Content-Length', async () => {
    const parts = [randomBytes(1000), randomBytes(2000)]
    const res = await put('nhi/chunked.bin', worker, Readable.from(parts))
    assert.equal(res.statusCode, 201)
    assert.equal(res.json().sha256, sha(Buffer.concat(parts)))
  })

  it('replacing a key deletes the old bytes', async () => {
    const before = onDisk()
    const first = await put('nhi/replace.txt', worker, Buffer.from('one'))
    assert.equal(first.statusCode, 201)
    assert.equal(onDisk(), before + 1)
    const second = await put('nhi/replace.txt', worker, Buffer.from('two!'))
    assert.equal(second.statusCode, 200)
    assert.equal(onDisk(), before + 1, 'old bytes removed')
    assert.equal((await get('nhi/replace.txt', worker)).payload, 'two!')
    assert.equal(db.select().from(files).where(eq(files.key, 'nhi/replace.txt')).all().length, 1)
  })

  it('prefix isolation: no read, list, replace or delete outside the prefix; no prefix = nothing', async () => {
    assert.equal((await put('other/x.txt', otherWorker, Buffer.from('theirs'))).statusCode, 201)
    const n = onDisk()

    // worker (nhi/) against other/x.txt
    assert.equal((await get('other/x.txt', worker)).statusCode, 404)
    assert.equal((await get('other/x.txt', worker, 'HEAD')).statusCode, 404)
    assert.equal((await put('other/x.txt', worker, Buffer.from('mine'))).statusCode, 404)
    assert.equal((await get('other/x.txt', worker, 'DELETE')).statusCode, 404)
    assert.ok((await list(worker)).json().files.every((f: { key: string }) => f.key.startsWith('nhi/')))
    assert.deepEqual((await list(worker, 'other/')).json().files, [])
    assert.equal((await get('other/x.txt', otherWorker)).payload, 'theirs', 'untouched')

    // the other way round
    assert.equal((await get('nhi/replace.txt', otherWorker)).statusCode, 404)
    assert.deepEqual((await list(otherWorker)).json().files.map((f: { key: string }) => f.key), ['other/x.txt'])

    // a token without a prefix touches nothing
    for (const key of ['nhi/replace.txt', 'other/x.txt']) {
      assert.equal((await get(key, noPrefix)).statusCode, 404)
      assert.equal((await put(key, noPrefix, Buffer.from('x'))).statusCode, 404)
      assert.equal((await get(key, noPrefix, 'DELETE')).statusCode, 404)
      assert.equal((await get(key, makerNoPrefix)).statusCode, 404)
    }
    assert.deepEqual((await list(noPrefix)).json().files, [])
    assert.equal(onDisk(), n, 'nothing was written by refused calls')

    // admin sees every key
    const all = (await list(admin)).json().files.map((f: { key: string }) => f.key)
    assert.ok(all.includes('other/x.txt') && all.includes('nhi/replace.txt'))
    const listed = (await list(worker, 'nhi/voice/')).json().files
    assert.deepEqual(Object.keys(listed[0]).sort(), ['expiresAt', 'key', 'sha256', 'size'])
  })

  it('validates keys: traversal, dot segments, empty segments, over-long, empty', async () => {
    for (const key of [
      'nhi/../other/x.txt',
      'nhi/%2e%2e/other/x.txt',
      'nhi/.hidden',
      'nhi//a',
      'nhi/a/',
      'nhi/a b',
      'nhi/a%00b',
      `nhi/${'a'.repeat(200)}`,
    ]) {
      const res = await put(key, worker, Buffer.from('x'))
      assert.ok([400, 404].includes(res.statusCode), `${key} -> ${res.statusCode}`)
      assert.notEqual(res.statusCode, 201)
    }
    // URL layers may resolve `/./` and `/../` before the route sees them; whatever
    // arrives, no stored key may hold a dot segment or leave the prefix.
    await put('nhi/./a', worker, Buffer.from('x'))
    await put('nhi/x/../../other/y', worker, Buffer.from('x'))
    for (const row of db.select().from(files).all()) {
      assert.ok(isValidFileKey(row.key), row.key)
      assert.ok(row.key.startsWith('nhi/') || row.key.startsWith('other/'), row.key)
    }
    assert.equal(db.select().from(files).where(eq(files.key, 'other/y')).get(), undefined)
    // The validator itself:
    for (const bad of ['', '.', '..', 'a/..', '../a', 'a/./b', 'a/.b', 'a//b', '/a', 'a/', 'a b', 'a\\b', 'x'.repeat(201)]) {
      assert.equal(isValidFileKey(bad), false, JSON.stringify(bad))
    }
    for (const good of ['a', 'nhi/voice/issue-12.zip', 'A-b_c.d/e', 'x'.repeat(200)]) {
      assert.equal(isValidFileKey(good), true, good)
    }
    assert.equal((await put('', worker, Buffer.from('x'))).statusCode, 400)
    assert.equal((await put('nhi/ok', worker, Buffer.from('x'), { 'x-expires-days': '31' })).statusCode, 400)
    assert.equal((await put('nhi/ok', worker, Buffer.from('x'), { 'x-expires-days': '0' })).statusCode, 400)
  })

  it('size cap: 413 and nothing left on disk, with or without Content-Length', async () => {
    const n = onDisk()
    const big = randomBytes(6 * 1024 * 1024 + 1)
    assert.equal((await put('nhi/big.bin', worker, big)).statusCode, 413)
    const chunks = Array.from({ length: 7 }, () => randomBytes(1024 * 1024))
    assert.equal((await put('nhi/big2.bin', worker, Readable.from(chunks))).statusCode, 413)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(onDisk(), n)
    assert.equal(db.select().from(files).where(eq(files.key, 'nhi/big2.bin')).get(), undefined)
  })

  it('expiry: an expired key answers 404 and the sweep deletes row and bytes', async () => {
    assert.equal((await put('nhi/old.txt', worker, Buffer.from('old'))).statusCode, 201)
    const n = onDisk()
    db.update(files).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(files.key, 'nhi/old.txt')).run()
    assert.equal((await get('nhi/old.txt', worker)).statusCode, 404)
    assert.equal((await get('nhi/old.txt', worker, 'HEAD')).statusCode, 404)
    assert.ok(!(await list(worker)).json().files.some((f: { key: string }) => f.key === 'nhi/old.txt'))
    assert.equal(await sweepExpiredFiles(), 1)
    assert.equal(await sweepExpiredFiles(), 0)
    assert.equal(onDisk(), n - 1)
    assert.equal(db.select().from(files).where(eq(files.key, 'nhi/old.txt')).get(), undefined)
  })

  it('delete removes row and bytes now', async () => {
    const n = onDisk()
    assert.equal((await get('nhi/replace.txt', worker, 'DELETE')).statusCode, 200)
    assert.equal(onDisk(), n - 1)
    assert.equal((await get('nhi/replace.txt', worker)).statusCode, 404)
    assert.equal((await get('nhi/replace.txt', worker, 'DELETE')).statusCode, 404)
  })

  it('ingest may only GET and HEAD; poster, read, kol tokens and sessions get nothing', async () => {
    assert.equal((await put('nhi/x', maker, Buffer.from('x'))).statusCode, 403)
    assert.equal((await get('nhi/voice/issue-12.zip', maker, 'DELETE')).statusCode, 403)
    assert.equal((await list(maker)).statusCode, 403)

    const kol = makeUser('files-kol')
    const others = [
      createApiToken('f-poster', 'kol', { scope: 'poster', userId: kol.id }),
      createApiToken('f-read', 'kol', { scope: 'read' }),
    ]
    for (const token of others) {
      assert.equal((await get('nhi/voice/issue-12.zip', token)).statusCode, 403)
      assert.equal((await get('nhi/voice/issue-12.zip', token, 'HEAD')).statusCode, 403)
      assert.equal((await put('nhi/x', token, Buffer.from('x'))).statusCode, 403)
      assert.equal((await list(token)).statusCode, 403)
    }
    // An old kol-role token and a person's session are not drop-box callers either.
    assert.equal((await get('nhi/voice/issue-12.zip', createApiToken('f-legacy-kol', 'kol'))).statusCode, 403)
    const adminUser = makeUser('f-admin', 'admin')
    const viaCookie = await call(app, 'GET', '/api/files/nhi/voice/issue-12.zip', { cookie: await sessionFor(adminUser.id) })
    assert.equal(viaCookie.statusCode, 403)
    assert.equal((await call(app, 'GET', '/api/files/nhi/voice/issue-12.zip')).statusCode, 401)
    // The files scope is refused everywhere else.
    assert.equal((await call(app, 'GET', '/api/contents', { token: worker })).statusCode, 403)
    assert.equal((await call(app, 'POST', '/api/ingest/contents', { token: worker }, {})).statusCode, 403)
  })

  it('records file.put and file.delete events', async () => {
    const row = db.select().from(apiTokens).where(eq(apiTokens.name, 'worker')).get()!
    const actions = db.select().from(tokenEvents).where(eq(tokenEvents.tokenId, row.id)).all().map((e) => e.action)
    assert.ok(actions.includes('file.put'))
    assert.ok(actions.includes('file.delete'))
  })
})
