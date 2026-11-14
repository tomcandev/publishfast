/**
 * Metric snapshots, the analysis exports, the release scheduler, and the
 * `auto` snapshot written by the public-count sync.
 */
import './env.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db, sqlite } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { apiTokens, assets, contents, metricSnapshots, publications } from '../db/schema.js'
import { createApiToken } from '../lib/auth.js'
import { syncAllPublicationMetrics } from '../lib/metrics.js'
import { releaseDueDrafts } from '../lib/releaseScheduler.js'
import { call, makeContent, makeUser, sessionFor } from './helpers.js'

let app: FastifyInstance
let owner: ReturnType<typeof makeUser>
let stranger: ReturnType<typeof makeUser>
let ownerToken: string
let strangerToken: string
let pubId: string
let contentId: string

before(async () => {
  migrate()
  app = await buildApp({ logger: false })
  owner = makeUser('owner')
  stranger = makeUser('stranger')
  ownerToken = createApiToken('owner-poster', 'kol', { scope: 'poster', userId: owner.id })
  strangerToken = createApiToken('stranger-poster', 'kol', { scope: 'poster', userId: stranger.id })
  contentId = makeContent({
    code: 'NHI-PTE-N14',
    title: 'Fourteen',
    status: 'PUBLISHED',
    claimedBy: owner.id,
    assignedUserId: owner.id,
    source: 'nhi#12',
    publishAt: '2026-11-28T13:00:00.000Z',
    meta: { secretish: 'meta is never exported' },
  })
  db.insert(assets)
    .values({ id: randomUUID(), contentId, filePath: 'stored-on-disk-abc.mp4', originalName: 'n14.mp4', mime: 'video/mp4', size: 1, type: 'video' })
    .run()
  pubId = randomUUID()
  db.insert(publications)
    .values({
      id: pubId,
      contentId,
      userId: owner.id,
      platform: 'youtube',
      publishedUrl: 'https://youtube.com/watch?v=n14',
      publishedAt: '2026-11-28T13:00:00.000Z',
    })
    .run()
})

after(async () => {
  await app.close()
  sqlite.close()
})

describe('POST/GET /api/publications/:id/metrics', () => {
  it('a snapshot is stored and becomes the publication’s latest counts', async () => {
    const res = await call(app, 'POST', `/api/publications/${pubId}/metrics`, { token: ownerToken }, {
      label: '24h',
      views: 120,
      likes: 9,
      comments: 2,
      extra: { avgViewDurationSec: 31.5, ctr: 0.062, trafficSources: { browse: 0.4 } },
    })
    assert.equal(res.statusCode, 201)
    assert.equal(res.json().snapshot.label, '24h')
    assert.equal(res.json().snapshot.tokenId, undefined)
    const pub = db.select().from(publications).where(eq(publications.id, pubId)).get()!
    assert.equal(pub.views, 120)
    assert.equal(pub.likes, 9)
    assert.equal(pub.comments, 2)
    assert.equal(pub.shares, 0, 'a count not sent is left alone')
    assert.ok(pub.lastCheckedAt)
    const row = db.select().from(metricSnapshots).where(eq(metricSnapshots.publicationId, pubId)).get()!
    assert.ok(row.tokenId, 'the token is recorded in the table')
  })

  it('a back-dated snapshot is kept but does not overwrite newer counts', async () => {
    const res = await call(app, 'POST', `/api/publications/${pubId}/metrics`, { token: ownerToken }, {
      label: 'late',
      takenAt: '2026-01-01T00:00:00Z',
      views: 5,
    })
    assert.equal(res.statusCode, 201)
    assert.equal(db.select().from(publications).where(eq(publications.id, pubId)).get()!.views, 120)

    const list = await call(app, 'GET', `/api/publications/${pubId}/metrics`, { token: ownerToken })
    assert.equal(list.statusCode, 200)
    const labels = list.json().snapshots.map((s: { label: string }) => s.label)
    assert.deepEqual(labels, ['late', '24h'], 'ordered by takenAt')
    assert.ok(list.json().snapshots.every((s: Record<string, unknown>) => !('tokenId' in s)))
  })

  it('validates input', async () => {
    for (const body of [
      { label: 'x'.repeat(21) },
      { views: -1 },
      { views: 1.5 },
      { extra: [1, 2] },
      { extra: { big: 'x'.repeat(17 * 1024) } },
      { takenAt: 'yesterday' },
      { takenAt: new Date(Date.now() + 86_400_000).toISOString() },
    ]) {
      const res = await call(app, 'POST', `/api/publications/${pubId}/metrics`, { token: ownerToken }, body)
      assert.equal(res.statusCode, 400, JSON.stringify(body).slice(0, 50))
    }
  })

  it('access: owner (token or cookie) and admin yes; another poster 404; ingest/read 403; nobody 401', async () => {
    const ownerCookie = await sessionFor(owner.id)
    const admin = makeUser('m-admin', 'admin')
    const adminCookie = await sessionFor(admin.id)
    const legacyAdmin = createApiToken('m-legacy-admin')
    const legacyKol = createApiToken('m-legacy-kol', 'kol')
    const ingest = createApiToken('m-ingest', 'kol', { scope: 'ingest' })
    const read = createApiToken('m-read', 'kol', { scope: 'read' })
    const url = `/api/publications/${pubId}/metrics`

    for (const who of [{ cookie: ownerCookie }, { cookie: adminCookie }, { token: legacyAdmin }]) {
      assert.equal((await call(app, 'GET', url, who)).statusCode, 200)
      assert.equal((await call(app, 'POST', url, who, { views: 130 })).statusCode, 201)
    }
    assert.equal((await call(app, 'GET', url, { token: strangerToken })).statusCode, 404)
    assert.equal((await call(app, 'POST', url, { token: strangerToken }, { views: 1 })).statusCode, 404)
    assert.equal((await call(app, 'GET', url, { cookie: await sessionFor(stranger.id) })).statusCode, 404)
    assert.equal((await call(app, 'GET', `/api/publications/${randomUUID()}/metrics`, { token: ownerToken })).statusCode, 404)
    assert.equal((await call(app, 'GET', url, { token: legacyKol })).statusCode, 403)
    assert.equal((await call(app, 'GET', url, { token: ingest })).statusCode, 403)
    assert.equal((await call(app, 'POST', url, { token: read }, { views: 1 })).statusCode, 403)
    assert.equal((await call(app, 'GET', url)).statusCode, 401)
  })
})

describe('GET /api/export/*', () => {
  let read: string
  before(() => {
    read = createApiToken('export-read', 'kol', { scope: 'read' })
  })

  function assertClean(text: string) {
    for (const forbidden of [
      '@example.test', // emails
      'private admin note', // user notes
      'stored-on-disk-abc', // asset paths
      'meta is never exported',
      'pf_', // token plaintext
      'not-a-real-hash', // password hashes
    ]) {
      assert.ok(!text.includes(forbidden), `export leaked ${forbidden}`)
    }
    for (const t of db.select().from(apiTokens).all()) {
      assert.ok(!text.includes(t.tokenHash), 'export leaked a token hash')
      assert.ok(!text.includes(t.id), 'export leaked a token id')
    }
  }

  it('publications: one row per publication with the identifying columns and latest counts', async () => {
    const res = await call(app, 'GET', '/api/export/publications', { token: read })
    assert.equal(res.statusCode, 200)
    const rows = res.json().rows
    const row = rows.find((r: { publicationId: string }) => r.publicationId === pubId)
    // Deliberately updated (2026-11-14): captionFirstLine and hookId identify the post's hook.
    assert.deepEqual(Object.keys(row), [
      'publicationId', 'code', 'title', 'captionFirstLine', 'hookId', 'source', 'assignee', 'poster', 'platform', 'url',
      'publishedAt', 'publishAt', 'views', 'likes', 'comments', 'shares', 'lastCheckedAt',
    ])
    assert.equal(row.code, 'NHI-PTE-N14')
    assert.equal(row.assignee, owner.username)
    assert.equal(row.poster, owner.username)
    assert.equal(row.views, 130)
    assertClean(res.body)
  })

  it('metrics: one row per snapshot; csv works; filters by since and assignee', async () => {
    const res = await call(app, 'GET', '/api/export/metrics', { token: read })
    assert.equal(res.statusCode, 200)
    assert.ok(res.json().rows.length >= 5)
    assertClean(res.body)

    const csv = await call(app, 'GET', '/api/export/metrics?format=csv', { token: read })
    assert.equal(csv.statusCode, 200)
    assert.match(String(csv.headers['content-type']), /text\/csv/)
    assert.equal(
      csv.body.split('\r\n')[0],
      'publicationId,code,title,captionFirstLine,hookId,source,assignee,poster,platform,url,takenAt,label,views,likes,comments,shares,extra',
    )
    const pubCsv = await call(app, 'GET', '/api/export/publications?format=csv', { token: read })
    assert.equal(
      pubCsv.body.split('\r\n')[0],
      'publicationId,code,title,captionFirstLine,hookId,source,assignee,poster,platform,url,publishedAt,publishAt,views,likes,comments,shares,lastCheckedAt',
    )
    assertClean(csv.body)

    const since = await call(app, 'GET', '/api/export/metrics?since=2026-06-01T00:00:00Z', { token: read })
    assert.ok(since.json().rows.every((r: { label: string }) => r.label !== 'late'))
    const other = await call(app, 'GET', `/api/export/publications?assignee=${stranger.username}`, { token: read })
    assert.deepEqual(other.json().rows, [])
    assert.equal((await call(app, 'GET', '/api/export/publications?assignee=nobody', { token: read })).statusCode, 400)
    assert.equal((await call(app, 'GET', '/api/export/publications?since=soon', { token: read })).statusCode, 400)
    assert.equal((await call(app, 'GET', '/api/export/publications?format=xml', { token: read })).statusCode, 400)
  })

  it('captionFirstLine is the first non-empty line, cleaned and capped; hookId is the item’s; never the rest of the caption', async () => {
    const caption = '\n  \r\n  =Stop\u0007 practising\u202e full mocks  \nSECOND LINE stays private\nthird'
    db.update(contents).set({ caption, hookId: 'h_mistake_01' }).where(eq(contents.id, contentId)).run()
    for (const url of ['/api/export/publications', '/api/export/metrics']) {
      const res = await call(app, 'GET', url, { token: read })
      const row = res.json().rows.find((r: { publicationId: string }) => r.publicationId === pubId)
      assert.equal(row.captionFirstLine, '=Stop practising full mocks')
      assert.equal(row.hookId, 'h_mistake_01')
      assert.ok(!res.body.includes('SECOND LINE'), `${url} leaked the rest of the caption`)
      const csv = await call(app, 'GET', `${url}?format=csv`, { token: read })
      assert.ok(csv.body.includes(`,'=Stop practising full mocks,h_mistake_01,`), 'the formula guard applies to the new column')
      assert.ok(!csv.body.includes('SECOND LINE'))
    }

    db.update(contents).set({ caption: `${'x'.repeat(250)}\nmore`, hookId: '+cmd' }).where(eq(contents.id, contentId)).run()
    let row = (await call(app, 'GET', '/api/export/publications', { token: read })).json().rows.find((r: { publicationId: string }) => r.publicationId === pubId)
    assert.equal(row.captionFirstLine, 'x'.repeat(200))
    const csv = await call(app, 'GET', '/api/export/publications?format=csv', { token: read })
    assert.ok(csv.body.includes(`,'+cmd,`), 'hookId gets the formula guard too')

    db.update(contents).set({ caption: null, hookId: null }).where(eq(contents.id, contentId)).run()
    row = (await call(app, 'GET', '/api/export/publications', { token: read })).json().rows.find((r: { publicationId: string }) => r.publicationId === pubId)
    assert.deepEqual([row.captionFirstLine, row.hookId], ['', ''])
    db.update(contents).set({ caption: 'caption', hookId: null }).where(eq(contents.id, contentId)).run()
  })

  it('csv neutralises spreadsheet formulas in text', async () => {
    db.update(contents).set({ title: '=HYPERLINK("x")' }).where(eq(contents.id, contentId)).run()
    const csv = await call(app, 'GET', '/api/export/publications?format=csv', { token: read })
    assert.ok(csv.body.includes(`"'=HYPERLINK(""x"")"`))
    db.update(contents).set({ title: 'Fourteen' }).where(eq(contents.id, contentId)).run()
  })

  it('access: read token, admin tokens and admin sessions; nobody else', async () => {
    const admin = makeUser('x-admin', 'admin')
    assert.equal((await call(app, 'GET', '/api/export/publications', { cookie: await sessionFor(admin.id) })).statusCode, 200)
    assert.equal((await call(app, 'GET', '/api/export/publications', { token: createApiToken('x-legacy') })).statusCode, 200)
    const scopedAdmin = createApiToken('x-admin-scope', 'admin', { scope: 'admin' })
    assert.equal((await call(app, 'GET', '/api/export/metrics', { token: scopedAdmin })).statusCode, 200)
    assert.equal((await call(app, 'GET', '/api/export/publications', { cookie: await sessionFor(owner.id) })).statusCode, 403)
    assert.equal((await call(app, 'GET', '/api/export/publications', { token: ownerToken })).statusCode, 403)
    assert.equal((await call(app, 'GET', '/api/export/publications', { token: createApiToken('x-kol', 'kol') })).statusCode, 403)
    assert.equal((await call(app, 'GET', '/api/export/publications')).statusCode, 401)
  })
})

describe('release scheduler', () => {
  it('flips only DRAFTs whose release_at has passed, never drafts without one, and is idempotent', () => {
    // Leave only this test's rows in DRAFT so counts are exact.
    db.update(contents).set({ status: 'FAILED' }).where(eq(contents.status, 'DRAFT')).run()
    const past = new Date(Date.now() - 60_000).toISOString()
    const future = new Date(Date.now() + 3_600_000).toISOString()
    const due = makeContent({ status: 'DRAFT', releaseAt: past })
    const notYet = makeContent({ status: 'DRAFT', releaseAt: future })
    const plain = makeContent({ status: 'DRAFT' })
    const claimed = makeContent({ status: 'CLAIMED', claimedBy: owner.id, releaseAt: past })
    const failed = makeContent({ status: 'FAILED', releaseAt: past })

    assert.equal(releaseDueDrafts(), 1)
    assert.equal(releaseDueDrafts(), 0, 'a second run changes nothing')
    const status = (id: string) => db.select().from(contents).where(eq(contents.id, id)).get()!.status
    assert.equal(status(due), 'READY')
    assert.equal(status(notYet), 'DRAFT')
    assert.equal(status(plain), 'DRAFT')
    assert.equal(status(claimed), 'CLAIMED')
    assert.equal(status(failed), 'FAILED')

    // When its time comes, the later one goes too; the plain draft never does.
    assert.equal(releaseDueDrafts(new Date(Date.now() + 7_200_000)), 1)
    assert.equal(status(notYet), 'READY')
    assert.equal(status(plain), 'DRAFT')
  })

  it('an admin sending an item back to DRAFT cancels its pending release', async () => {
    const admin = makeUser('r-admin', 'admin')
    const cookie = await sessionFor(admin.id)
    const past = new Date(Date.now() - 60_000).toISOString()
    const a = makeContent({ status: 'READY', releaseAt: past })
    const b = makeContent({ status: 'READY', releaseAt: past })
    const keep = makeContent({ status: 'DRAFT', releaseAt: '2031-01-01T00:00:00.000Z' })
    assert.equal((await call(app, 'PATCH', `/api/admin/contents/${a}`, { cookie }, { status: 'DRAFT' })).statusCode, 200)
    const bulk = await call(app, 'POST', '/api/admin/contents/bulk-status', { cookie }, { ids: [b, keep], status: 'DRAFT' })
    assert.deepEqual(bulk.json(), { updated: 2 })
    const row = (id: string) => db.select().from(contents).where(eq(contents.id, id)).get()!
    assert.equal(row(a).releaseAt, null)
    assert.equal(row(b).releaseAt, null)
    assert.equal(row(keep).releaseAt, '2031-01-01T00:00:00.000Z', 'an existing draft keeps its schedule')
    releaseDueDrafts()
    assert.equal(row(a).status, 'DRAFT')
    assert.equal(row(b).status, 'DRAFT')
  })
})

describe('automatic public-count sync', () => {
  it('still updates the publication and now also writes an `auto` snapshot', async () => {
    // Only this publication has a URL the sync will visit; fetch is stubbed (no network).
    db.update(publications).set({ publishedUrl: null }).run()
    const id = randomUUID()
    db.insert(publications)
      .values({ id, contentId: makeContent({ status: 'PUBLISHED' }), userId: owner.id, platform: 'tiktok', publishedUrl: 'https://www.tiktok.com/@x/video/1' })
      .run()
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.startsWith('https://www.tikwm.com/')) {
        return new Response(JSON.stringify({ code: 0, data: { play_count: 777, digg_count: 7, comment_count: 1, share_count: 2 } }))
      }
      return new Response('', { status: 200 })
    }) as typeof fetch
    try {
      const result = await syncAllPublicationMetrics()
      assert.equal(result.updated, 1)
    } finally {
      globalThis.fetch = realFetch
    }
    const pub = db.select().from(publications).where(eq(publications.id, id)).get()!
    assert.equal(pub.views, 777)
    const snaps = db.select().from(metricSnapshots).where(eq(metricSnapshots.publicationId, id)).all()
    assert.equal(snaps.length, 1)
    assert.equal(snaps[0]!.label, 'auto')
    assert.equal(snaps[0]!.views, 777)
    assert.equal(snaps[0]!.takenAt, pub.lastCheckedAt)
  })
})
