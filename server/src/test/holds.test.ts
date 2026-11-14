/**
 * Contract section 10: who holds a claim (token or session), taking an item
 * back (withdraw, delete), and the `file` asset type.
 */
import './env.js'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db, sqlite } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { assets, contents } from '../db/schema.js'
import { createApiToken } from '../lib/auth.js'
import { config } from '../lib/config.js'
import { call, makeContent, makeUser, multipartFile, sessionFor, upload } from './helpers.js'

let app: FastifyInstance
let yt: ReturnType<typeof makeUser>
let agent: string // poster token acting as yt
let agent2: string // a second poster token of the same user
let cookie: string // yt's browser session
let adminCookie: string

before(async () => {
  migrate()
  app = await buildApp({ logger: false })
  yt = makeUser('yt-pte')
  agent = createApiToken('air-pte', 'kol', { scope: 'poster', userId: yt.id })
  agent2 = createApiToken('air-pte-2', 'kol', { scope: 'poster', userId: yt.id })
  cookie = await sessionFor(yt.id)
  adminCookie = await sessionFor(makeUser('boss', 'admin').id)
})

after(async () => {
  await app.close()
  sqlite.close()
})

const link = (contentId: string, who: { token?: string; cookie?: string }, platform = 'youtube') =>
  call(app, 'POST', '/api/publications', who, { contentId, platform, publishedUrl: `https://example.test/${platform}/${contentId}` })

describe('claims held by a token', () => {
  it('responses say who holds the claim', async () => {
    const id = makeContent({ assignedUserId: yt.id })
    const claim = await call(app, 'POST', `/api/contents/${id}/claim`, { token: agent })
    assert.equal(claim.statusCode, 200)
    const c = claim.json().content
    assert.equal(c.claimedVia, 'token')
    assert.equal(c.claimedByTokenName, 'air-pte')
    assert.equal(c.claimedByThisToken, true)
    assert.equal(c.claimedByToken, undefined, 'the raw token id is not returned')

    const other = (await call(app, 'GET', `/api/contents/${id}`, { token: agent2 })).json().content
    assert.equal(other.claimedByThisToken, false)
    const viaSession = (await call(app, 'GET', `/api/contents/${id}`, { cookie })).json().content
    assert.equal(viaSession.claimedVia, 'token')
    assert.equal(viaSession.claimedByTokenName, 'air-pte')
    assert.equal('claimedByThisToken' in viaSession, false)
    const admin = (await call(app, 'GET', '/api/admin/contents', { cookie: adminCookie })).json().contents
    assert.equal(admin.find((x: { id: string }) => x.id === id).claimedVia, 'token')

    const open = (await call(app, 'GET', '/api/contents', { cookie })).json().contents
    const fresh = open.find((x: { id: string }) => x.id !== id && x.status === 'READY')
    if (fresh) assert.equal(fresh.claimedVia, null)
  })

  it('a session cannot link, unlink or complete an agent-held item, but can release and then claim it', async () => {
    const id = makeContent({ assignedUserId: yt.id })
    assert.equal((await call(app, 'POST', `/api/contents/${id}/claim`, { token: agent })).statusCode, 200)
    const pub = await link(id, { token: agent })
    assert.equal(pub.statusCode, 200)

    const add = await link(id, { cookie }, 'facebook')
    assert.equal(add.statusCode, 409)
    assert.equal(add.json().reason, 'held_by_agent')
    const del = await call(app, 'DELETE', `/api/publications/${pub.json().publication.id}`, { cookie })
    assert.equal(del.statusCode, 409)
    assert.equal(del.json().reason, 'held_by_agent')
    const done = await call(app, 'POST', `/api/contents/${id}/complete`, { cookie })
    assert.equal(done.statusCode, 409)
    assert.equal(done.json().reason, 'held_by_agent')

    // Another token of the same user is another agent.
    const other = await call(app, 'POST', `/api/contents/${id}/complete`, { token: agent2 })
    assert.equal(other.json().reason, 'held_by_other_agent')
    assert.equal((await call(app, 'POST', `/api/contents/${id}/release`, { token: agent2 })).json().reason, 'held_by_other_agent')

    // Take over: release, then claim in the session.
    assert.equal((await call(app, 'POST', `/api/contents/${id}/release`, { cookie })).statusCode, 200)
    const row = db.select().from(contents).where(eq(contents.id, id)).get()!
    assert.equal(row.status, 'READY')
    assert.equal(row.claimedByToken, null)
    const mine = await call(app, 'POST', `/api/contents/${id}/claim`, { cookie })
    assert.equal(mine.statusCode, 200)
    assert.equal(mine.json().content.claimedVia, 'session')
    assert.equal((await call(app, 'POST', `/api/contents/${id}/complete`, { cookie })).statusCode, 200)
  })

  it('a token cannot finish or release a person’s claim', async () => {
    const id = makeContent({ assignedUserId: yt.id })
    assert.equal((await call(app, 'POST', `/api/contents/${id}/claim`, { cookie })).statusCode, 200)
    const pub = await link(id, { cookie })
    assert.equal(pub.statusCode, 200)
    for (const [method, url, body] of [
      ['POST', '/api/publications', { contentId: id, platform: 'facebook', publishedUrl: 'https://example.test/f' }],
      ['DELETE', `/api/publications/${pub.json().publication.id}`, undefined],
      ['POST', `/api/contents/${id}/complete`, undefined],
      ['POST', `/api/contents/${id}/release`, undefined],
    ] as const) {
      const res = await call(app, method, url, { token: agent }, body)
      assert.equal(res.statusCode, 409, `${method} ${url}`)
      assert.equal(res.json().reason, 'held_by_person')
    }
    assert.equal(db.select().from(contents).where(eq(contents.id, id)).get()!.status, 'CLAIMED')
    // An admin session is not restricted.
    assert.equal((await call(app, 'POST', `/api/contents/${id}/complete`, { cookie: adminCookie })).statusCode, 200)
  })

  it('the holding token finishes its own claim normally; claim-next records the token too', async () => {
    db.update(contents).set({ status: 'FAILED' }).where(eq(contents.status, 'READY')).run()
    const id = makeContent({ assignedUserId: yt.id })
    const next = await call(app, 'POST', '/api/contents/claim-next', { token: agent })
    assert.equal(next.json().content.id, id)
    assert.equal(next.json().content.claimedByThisToken, true)
    assert.equal((await link(id, { token: agent })).statusCode, 200)
    assert.equal((await call(app, 'POST', `/api/contents/${id}/complete`, { token: agent })).statusCode, 200)
  })
})

describe('ingest: withdraw, delete, file assets', () => {
  let maker: string
  let otherMaker: string
  before(() => {
    maker = createApiToken('maker', 'kol', { scope: 'ingest', assignees: [yt.id] })
    otherMaker = createApiToken('other-maker', 'kol', { scope: 'ingest', assignees: [yt.id] })
  })

  async function readyItem(code: string) {
    const res = await call(app, 'POST', '/api/ingest/contents', { token: maker }, { code, assignedUserId: yt.id })
    const id = res.json().content.id as string
    assert.equal((await upload(app, id, { token: maker }, 'v1.mp4')).statusCode, 201)
    assert.equal((await call(app, 'PATCH', `/api/ingest/contents/${id}`, { token: maker }, { status: 'READY' })).statusCode, 200)
    return id
  }

  it('withdraw: READY and unclaimed goes back to DRAFT; then the token may replace assets and release again', async () => {
    const id = await readyItem('NHI-REMADE')
    assert.equal((await call(app, 'POST', `/api/ingest/contents/${id}/withdraw`, { token: otherMaker })).statusCode, 404)

    db.update(contents).set({ releaseAt: new Date(Date.now() - 1000).toISOString() }).where(eq(contents.id, id)).run()
    const w = await call(app, 'POST', `/api/ingest/contents/${id}/withdraw`, { token: maker })
    assert.equal(w.statusCode, 200)
    assert.equal(w.json().content.status, 'DRAFT')
    assert.equal(w.json().content.releaseAt, null, 'a pending release is cancelled')
    assert.equal((await call(app, 'POST', `/api/ingest/contents/${id}/withdraw`, { token: maker })).statusCode, 200, 'idempotent')

    const old = w.json().content.assets[0]
    const oldPath = db.select().from(assets).where(eq(assets.id, old.id)).get()!.filePath
    assert.ok(existsSync(join(config.uploadsDir, oldPath)))
    assert.equal((await call(app, 'DELETE', `/api/ingest/contents/${id}/assets/${old.id}`, { token: otherMaker })).statusCode, 404)
    assert.equal((await call(app, 'DELETE', `/api/ingest/contents/${id}/assets/${old.id}`, { token: maker })).statusCode, 200)
    assert.ok(!existsSync(join(config.uploadsDir, oldPath)), 'bytes deleted')
    assert.equal((await call(app, 'DELETE', `/api/ingest/contents/${id}/assets/${old.id}`, { token: maker })).statusCode, 404)

    assert.equal((await upload(app, id, { token: maker }, 'v2.mp4')).statusCode, 201)
    const again = await call(app, 'PATCH', `/api/ingest/contents/${id}`, { token: maker }, { status: 'READY' })
    assert.equal(again.json().content.status, 'READY')
  })

  it('withdraw answers 409 with the status once the item is claimed or published', async () => {
    const id = await readyItem('NHI-TAKEN')
    assert.equal((await call(app, 'POST', `/api/contents/${id}/claim`, { token: agent })).statusCode, 200)
    const w = await call(app, 'POST', `/api/ingest/contents/${id}/withdraw`, { token: maker })
    assert.equal(w.statusCode, 409)
    assert.equal(w.json().status, 'CLAIMED')
    db.update(contents).set({ status: 'PUBLISHED' }).where(eq(contents.id, id)).run()
    assert.equal((await call(app, 'POST', `/api/ingest/contents/${id}/withdraw`, { token: maker })).json().status, 'PUBLISHED')
    // and its assets cannot be deleted
    const a = db.select().from(assets).where(eq(assets.contentId, id)).get()!
    assert.equal((await call(app, 'DELETE', `/api/ingest/contents/${id}/assets/${a.id}`, { token: maker })).statusCode, 409)
  })

  it('withdraw racing a claim: exactly one wins', async () => {
    for (let round = 0; round < 10; round++) {
      const id = await readyItem(`NHI-RACE-${round}`)
      const [w, c] = await Promise.all([
        call(app, 'POST', `/api/ingest/contents/${id}/withdraw`, { token: maker }),
        call(app, 'POST', `/api/contents/${id}/claim`, { token: agent }),
      ])
      const wins = [w.statusCode === 200, c.statusCode === 200].filter(Boolean).length
      assert.equal(wins, 1, `round ${round}: withdraw ${w.statusCode}, claim ${c.statusCode}`)
      const status = db.select().from(contents).where(eq(contents.id, id)).get()!.status
      assert.equal(status, w.statusCode === 200 ? 'DRAFT' : 'CLAIMED')
    }
  })

  it('DELETE an own DRAFT removes it and its files; not another’s, not a non-draft', async () => {
    const created = await call(app, 'POST', '/api/ingest/contents', { token: maker }, { code: 'NHI-GONE', assignedUserId: yt.id })
    const id = created.json().content.id
    await upload(app, id, { token: maker })
    const path = db.select().from(assets).where(eq(assets.contentId, id)).get()!.filePath
    assert.equal((await call(app, 'DELETE', `/api/ingest/contents/${id}`, { token: otherMaker })).statusCode, 404)
    assert.equal((await call(app, 'DELETE', `/api/ingest/contents/${id}`, { token: maker })).statusCode, 200)
    assert.equal(db.select().from(contents).where(eq(contents.id, id)).get(), undefined)
    assert.equal(db.select().from(assets).where(eq(assets.contentId, id)).all().length, 0)
    assert.ok(!existsSync(join(config.uploadsDir, path)))

    const ready = await readyItem('NHI-STAYS')
    const res = await call(app, 'DELETE', `/api/ingest/contents/${ready}`, { token: maker })
    assert.equal(res.statusCode, 409)
    assert.ok(db.select().from(contents).where(eq(contents.id, ready)).get())
    // A person's item is invisible to the token.
    const theirs = makeContent({ status: 'DRAFT' })
    assert.equal((await call(app, 'DELETE', `/api/ingest/contents/${theirs}`, { token: maker })).statusCode, 404)
  })

  it('asset type: video/*, image/*, `file` for subtitle-like names; untyped parts go by extension', async () => {
    const created = await call(app, 'POST', '/api/ingest/contents', { token: maker }, { code: 'NHI-TYPES', assignedUserId: yt.id })
    const id = created.json().content.id
    const cases: [string, string, string][] = [
      ['v.mp4', 'video/mp4', 'video'],
      ['t.jpg', 'image/jpeg', 'image'],
      ['n14.srt', 'application/x-subrip', 'file'],
      ['n14.vtt', 'text/vtt', 'file'],
      ['n14b.srt', 'application/octet-stream', 'file'],
      ['legacy.mp4', 'application/octet-stream', 'video'], // untyped: decided by extension (review finding 6)
      ['legacy.bin', 'application/octet-stream', 'image'], // unknown name: the old fallback
    ]
    for (const [name, mime, type] of cases) {
      const { payload, headers } = multipartFile(name, mime, Buffer.from('x'))
      const res = await app.inject({
        method: 'POST',
        url: `/api/ingest/contents/${id}/assets`,
        headers: { ...headers, authorization: `Bearer ${maker}` },
        payload,
      })
      assert.equal(res.statusCode, 201)
      const row = db.select().from(assets).where(eq(assets.originalName, name)).get()!
      assert.equal(row.type, type, name)
    }
    // Downloads of a file asset work like any other (as the item's assignee).
    const srt = db.select().from(assets).where(eq(assets.originalName, 'n14.srt')).get()!
    db.update(contents).set({ status: 'READY' }).where(eq(contents.id, id)).run()
    const dl = await call(app, 'GET', `/api/assets/${srt.id}/download`, { token: agent })
    assert.equal(dl.statusCode, 200)
    assert.equal((await call(app, 'GET', `/api/contents/${id}/assets.zip`, { token: agent })).statusCode, 200)
  })
})
