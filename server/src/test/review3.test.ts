/**
 * Third security review pass (2026-11-14): aborted and silent uploads (C1,
 * C2), the CSP (S1), link schemes as a browser parses them (S2), and files
 * left in uploads/ by a crash (orphan sweep). Each test failed before its fix.
 * These tests use a real listening socket: inject() cannot abort a request.
 */
import './env.js'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app.js'
import { db, sqlite } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { assets } from '../db/schema.js'
import { createApiToken } from '../lib/auth.js'
import { config } from '../lib/config.js'
import { _setFreeSpaceProbe, bytesInFlight, uploadsInProgress } from '../lib/disk.js'
import { SANDBOX_CSP } from '../lib/download.js'
import { partsFolder, sweepUploads } from '../lib/uploads.js'
import { call, makeContent, makeUser, multipartFile, sessionFor } from './helpers.js'

let app: FastifyInstance
let port = 0
let maker: string
let worker: string
let legacyAdmin: string

before(async () => {
  migrate()
  app = await buildApp({ logger: false })
  await app.listen({ port: 0, host: '127.0.0.1' })
  port = (app.server.address() as net.AddressInfo).port
  maker = createApiToken('r3-maker', 'kol', { scope: 'ingest' })
  worker = createApiToken('r3-files', 'kol', { scope: 'files', filePrefix: 'r3/' })
  legacyAdmin = createApiToken('r3-legacy')
})

after(async () => {
  await app.close()
  sqlite.close()
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(check: () => boolean, ms = 15_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await sleep(20)
  }
  return check()
}

function head(method: string, path: string, token: string, type: string, length: number) {
  return `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${token}\r\nContent-Type: ${type}\r\nContent-Length: ${length}\r\n\r\n`
}

/** Writes the request headers and destroys the socket in the same tick. */
function headersThenDie(text: string) {
  return new Promise<void>((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(text)
      s.destroy()
      resolve()
    })
    s.on('error', () => resolve())
  })
}

/** Sends the headers and then nothing, keeping the connection open. Resolves with the status line if one comes. */
function silent(text: string) {
  const s = net.connect(port, '127.0.0.1', () => s.write(text))
  let answer = ''
  s.on('data', (d) => (answer += d))
  s.on('error', () => {})
  return { socket: s, status: () => answer.split('\r\n')[0] ?? '' }
}

async function draft(token = maker) {
  const code = `R3-${randomBytes(4).toString('hex')}`
  return (await call(app, 'POST', '/api/ingest/contents', { token }, { code })).json().content.id as string
}

async function initUpload(id: string, size: number, token = maker) {
  const res = await app.inject({
    method: 'POST',
    url: `/api/ingest/contents/${id}/uploads`,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: JSON.stringify({ name: 'x.mp4', size }),
  })
  return res.json().uploadId as string
}

const count = (dir: string) => (existsSync(dir) ? readdirSync(dir).length : 0)

describe('C1: a client that sends headers and dies at once', () => {
  it('part PUT, multipart and drop-box PUT: no hung handler, nothing reserved, no stray file', async () => {
    const id = await draft()
    const up = await initUpload(id, 1000)
    const uploadsBefore = count(config.uploadsDir)
    const filesBefore = count(config.filesDir)
    const mp = multipartFile('a.mp4', 'video/mp4', Buffer.alloc(500))

    for (let i = 0; i < 50; i++) {
      await headersThenDie(head('PUT', `/api/ingest/contents/${id}/uploads/${up}/parts/1`, maker, 'application/octet-stream', 1000))
      await headersThenDie(head('POST', `/api/ingest/contents/${id}/assets`, maker, mp.headers['content-type'], mp.payload.length))
      await headersThenDie(head('PUT', `/api/files/r3/k${i}`, worker, 'application/octet-stream', 1000))
    }

    // Wait on the conditions, not on time: the in-flight reservation is also released when the
    // client's socket closes (the backstop), which can be a moment before the handler has removed
    // the file it had just opened. A real leak still fails these after the timeout.
    assert.ok(await waitFor(() => bytesInFlight() === 0), `bytes still in flight: ${bytesInFlight()}`)
    assert.ok(await waitFor(() => count(partsFolder(up)) === 0), 'no part file left')
    assert.ok(await waitFor(() => count(config.uploadsDir) === uploadsBefore), 'no file left in uploads/')
    assert.ok(await waitFor(() => count(config.filesDir) === filesBefore), 'no file left in files/')

    // Normal uploads still work.
    const ok = await app.inject({
      method: 'PUT',
      url: `/api/ingest/contents/${id}/uploads/${up}/parts/1`,
      headers: { authorization: `Bearer ${maker}`, 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(1000),
    })
    assert.equal(ok.statusCode, 200)
    const good = multipartFile('b.mp4', 'video/mp4', Buffer.alloc(10))
    const res = await app.inject({
      method: 'POST',
      url: `/api/ingest/contents/${id}/assets`,
      headers: { ...good.headers, authorization: `Bearer ${maker}` },
      payload: good.payload,
    })
    assert.equal(res.statusCode, 201)
  })
})

describe('C1: a client that dies half-way through its body', () => {
  it('releases everything and leaves no file, on all three routes', async () => {
    const id = await draft()
    const up = await initUpload(id, 100_000)
    const uploadsBefore = count(config.uploadsDir)
    const filesBefore = count(config.filesDir)
    const mp = multipartFile('half.mp4', 'video/mp4', Buffer.alloc(100_000, 7))
    const halfThenDie = (text: string, body: Buffer) =>
      new Promise<void>((resolve) => {
        const s = net.connect(port, '127.0.0.1', () => {
          s.write(text)
          s.write(body.subarray(0, Math.floor(body.length / 2)), () => setTimeout(() => {
            s.destroy()
            resolve()
          }, 5))
        })
        s.on('error', () => resolve())
      })
    for (let i = 0; i < 20; i++) {
      await halfThenDie(head('PUT', `/api/ingest/contents/${id}/uploads/${up}/parts/1`, maker, 'application/octet-stream', 100_000), Buffer.alloc(100_000))
      await halfThenDie(head('POST', `/api/ingest/contents/${id}/assets`, maker, mp.headers['content-type'], mp.payload.length), mp.payload)
      await halfThenDie(head('PUT', `/api/files/r3/h${i}`, worker, 'application/octet-stream', 100_000), Buffer.alloc(100_000))
    }
    assert.ok(await waitFor(() => bytesInFlight() === 0), `bytes still in flight: ${bytesInFlight()}`)
    assert.ok(await waitFor(() => uploadsInProgress(maker) === 0 && uploadsInProgress(worker) === 0), 'slots released')
    assert.ok(await waitFor(() => count(partsFolder(up)) === 0), 'no part file left')
    assert.ok(await waitFor(() => count(config.uploadsDir) === uploadsBefore), 'no file left in uploads/')
    assert.ok(await waitFor(() => count(config.filesDir) === filesBefore), 'no file left in files/')
  })
})

describe('C2: silent connections cannot hold the headroom', () => {
  it('at most 4 concurrent uploads per scoped token (429), and the old pipeline is not pushed to 507', async () => {
    const saved = { part: config.uploadPartBytes, floor: config.minFreeBytes }
    config.uploadPartBytes = 4 * 1024 * 1024
    const token = createApiToken('r3-silent', 'kol', { scope: 'ingest' })
    const id = await draft(token)
    const up = await initUpload(id, 30 * config.uploadPartBytes, token)
    // The disk is shared with test files running in parallel (some write 150 MB), so this test
    // sees a fixed free space instead of the real one. Headroom of 50 MB: 30 silent 4 MB parts
    // (120 MB) would exhaust it, 4 (16 MB) do not.
    const free = 10 * 1024 ** 3
    _setFreeSpaceProbe(async () => free)
    config.minFreeBytes = free - 50 * 1024 * 1024
    const conns: ReturnType<typeof silent>[] = []
    try {
      for (let n = 1; n <= 30; n++) {
        conns.push(silent(head('PUT', `/api/ingest/contents/${id}/uploads/${up}/parts/${n}`, token, 'application/octet-stream', config.uploadPartBytes)))
      }
      await waitFor(() => conns.filter((c) => c.status()).length >= 26)
      const refused = conns.filter((c) => c.status().includes('429')).length
      assert.equal(refused, 26, `${refused} refused`)

      const item = makeContent({ status: 'DRAFT' })
      const mp = multipartFile('old.mp4', 'video/mp4', Buffer.alloc(1000))
      const old = await app.inject({
        method: 'POST',
        url: `/api/ingest/contents/${item}/assets`,
        headers: { ...mp.headers, authorization: `Bearer ${legacyAdmin}` },
        payload: mp.payload,
      })
      assert.equal(old.statusCode, 201, 'the old pipeline still uploads')
    } finally {
      for (const c of conns) c.socket.destroy()
      Object.assign(config, { uploadPartBytes: saved.part, minFreeBytes: saved.floor })
      _setFreeSpaceProbe(null)
    }
    assert.ok(await waitFor(() => bytesInFlight() === 0), `bytes still in flight: ${bytesInFlight()}`)
  })
})

describe('S1: CSP', () => {
  it('lets a same-origin video play in a tab, still allows no script', () => {
    assert.equal(SANDBOX_CSP, "sandbox allow-same-origin; default-src 'none'; img-src 'self'; media-src 'self'")
    assert.ok(!/allow-scripts|script-src/.test(SANDBOX_CSP))
  })
})

describe('S2: link schemes as a browser parses them', () => {
  it('a session cannot store javascript:, data:, vbscript: or file: in any spelling; app links still pass', async () => {
    const u = makeUser('r3-links')
    const cookie = await sessionFor(u.id)
    const id = makeContent({ status: 'CLAIMED', claimedBy: u.id })
    const bad = [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      '\tjavascript:alert(1)',
      '\njavascript:alert(1)',
      '\u0001javascript:alert(1)',
      '\u0000javascript:alert(1)',
      '\u001fjavascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'j\ra\tv\nascript:alert(1)',
      'da\tta:text/html,x',
      '\u0002data:text/html,x',
      'vb\tscript:msgbox(1)',
      'fi\nle:///etc/passwd',
      'not a url',
    ]
    for (const url of bad) {
      const res = await call(app, 'POST', '/api/publications', { cookie }, { contentId: id, platform: 'other', publishedUrl: url })
      assert.equal(res.statusCode, 400, JSON.stringify(url))
    }
    for (const url of ['snssdk1233://aweme/detail/1', 'https://example.com/x']) {
      const res = await call(app, 'POST', '/api/publications', { cookie }, { contentId: id, platform: 'tiktok', publishedUrl: url })
      assert.equal(res.statusCode, 200, url)
    }
  })
})

describe('orphan files in uploads/', () => {
  function plant() {
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000)
    const old = join(config.uploadsDir, `orphan-old-${randomBytes(3).toString('hex')}.mp4`)
    const young = join(config.uploadsDir, `orphan-young-${randomBytes(3).toString('hex')}.mp4`)
    writeFileSync(old, 'x')
    writeFileSync(young, 'y')
    utimesSync(old, twoHoursAgo, twoHoursAgo)
    // A file that has its row is kept whatever its age.
    const id = makeContent({ status: 'DRAFT' })
    const keptName = `kept-${randomBytes(3).toString('hex')}.mp4`
    const kept = join(config.uploadsDir, keptName)
    writeFileSync(kept, 'k')
    utimesSync(kept, twoHoursAgo, twoHoursAgo)
    db.insert(assets).values({ id: `a-${id}`, contentId: id, filePath: keptName, originalName: 'k.mp4', mime: 'video/mp4', size: 1, type: 'video' }).run()
    return { old, young, kept }
  }

  it('is off by default: an old orphan survives a scheduler tick', async () => {
    assert.equal(config.sweepOrphanUploads, false)
    const { old, young, kept } = plant()
    await sweepUploads()
    assert.ok(existsSync(old), 'nothing in uploads/ is deleted unless SWEEP_ORPHAN_UPLOADS is on')
    assert.ok(existsSync(young) && existsSync(kept))
  })

  it('when SWEEP_ORPHAN_UPLOADS is on, deletes files with no row older than one hour, never younger ones', async () => {
    const { old, young, kept } = plant()
    config.sweepOrphanUploads = true
    try {
      await sweepUploads()
    } finally {
      config.sweepOrphanUploads = false
    }
    assert.ok(!existsSync(old), 'old orphan removed')
    assert.ok(existsSync(young), 'young file kept (its row may still be on the way)')
    assert.ok(existsSync(kept), 'file with a row kept')
  })
})
