/**
 * Scoped tokens: the allow-list (every registered route, every narrow scope),
 * expiry and revocation, the failed-bearer rate limit, ingest ownership and
 * assignees, poster isolation and the assigned_only queue, and the audit trail.
 */
import './env.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, beforeEach, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db, sqlite } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { apiTokens, assets, contents, tokenEvents, users } from '../db/schema.js'
import { createApiToken } from '../lib/auth.js'
import { MAX_FAILURES, _resetBearerFailures } from '../lib/rateLimit.js'
import { TOKEN_ROUTES, type NarrowScope } from '../lib/scopes.js'
import { call, makeContent, makeUser, sessionFor, upload } from './helpers.js'

const REFUSED = 'This token is not allowed to call this route'

let app: FastifyInstance
const routes: { method: string; url: string }[] = []

before(async () => {
  migrate()
  app = await buildApp({
    logger: false,
    onRoute: (r) => {
      for (const m of [r.method].flat()) routes.push({ method: m, url: r.url })
    },
  })
  await app.ready()
})

after(async () => {
  await app.close()
  sqlite.close()
})

beforeEach(() => _resetBearerFailures())

const tick = () => new Promise((r) => setImmediate(r))

function concrete(url: string) {
  return url.replace(/:id/g, randomUUID()).replace(/\*/g, 'x')
}

describe('the scope allow-list covers every registered route', () => {
  it('found the routes', () => {
    assert.ok(routes.length > 40, `only ${routes.length} routes`)
    for (const key of Object.keys(TOKEN_ROUTES)) {
      const [method, url] = key.split(' ')
      assert.ok(
        routes.some((r) => r.method === method && r.url === url),
        `allow-list names ${key}, which is not a registered route`,
      )
    }
  })

  for (const scope of ['ingest', 'poster', 'read', 'files', 'sounds'] as NarrowScope[]) {
    it(`${scope}: 403 on every route outside its allow-list, never refused on its own`, async () => {
      const kol = makeUser(`${scope}-u`)
      const token = createApiToken(`${scope}-all`, 'kol', {
        scope,
        userId: scope === 'poster' ? kol.id : null,
        filePrefix: scope === 'files' || scope === 'ingest' ? 'test/' : null,
      })
      let refused = 0
      for (const r of routes) {
        if (r.method === 'HEAD' || r.method === 'OPTIONS') continue
        const allowed = TOKEN_ROUTES[`${r.method} ${r.url}`]?.scopes.includes(scope) ?? false
        const res = await call(app, r.method as 'GET', concrete(r.url), { token }, r.method === 'GET' || r.method === 'DELETE' ? undefined : {})
        const body = res.headers['content-type']?.toString().includes('json') ? res.json() : {}
        if (allowed) {
          assert.notEqual(body.error, REFUSED, `${scope} must reach ${r.method} ${r.url}`)
          assert.notEqual(res.statusCode, 401, `${scope} must be accepted on ${r.method} ${r.url}`)
        } else {
          assert.equal(res.statusCode, 403, `${scope} must be refused on ${r.method} ${r.url} (got ${res.statusCode})`)
          assert.equal(body.error, REFUSED)
          refused++
        }
      }
      assert.ok(refused > 30)
      // A path no route handles is refused too, not passed through.
      const unknown = await call(app, 'GET', '/api/not-a-route', { token })
      assert.ok([403, 404].includes(unknown.statusCode))
    })
  }

  it('explicitly: admin, auth, me, notifications and the other scopes’ routes are refused', async () => {
    const kol = makeUser('explicit')
    const tokens = {
      ingest: createApiToken('x-ingest', 'kol', { scope: 'ingest' }),
      poster: createApiToken('x-poster', 'kol', { scope: 'poster', userId: kol.id }),
      read: createApiToken('x-read', 'kol', { scope: 'read' }),
      files: createApiToken('x-files', 'kol', { scope: 'files', filePrefix: 'test/' }),
      sounds: createApiToken('x-sounds', 'kol', { scope: 'sounds' }),
    }
    const probes: [string, string][] = [
      ['GET', '/api/admin/users'],
      ['POST', '/api/admin/tokens'],
      ['DELETE', `/api/admin/contents/${randomUUID()}`],
      ['POST', '/api/auth/login'],
      ['POST', '/api/auth/change-password'],
      ['POST', '/api/auth/switch'],
      ['GET', '/api/me'],
      ['PATCH', '/api/me'],
      ['GET', '/api/notifications/settings'],
      ['POST', '/api/notifications/subscribe'],
      ['GET', '/api/contents/stats'],
      ['GET', '/api/history'],
    ]
    const others: Record<NarrowScope, [string, string][]> = {
      ingest: [['GET', '/api/contents'], ['POST', '/api/contents/claim-next'], ['GET', '/api/export/publications'], ['PUT', '/api/files/test/x'], ['DELETE', '/api/files/test/x'], ['GET', '/api/files']],
      poster: [['POST', '/api/ingest/contents'], ['GET', '/api/ingest/contents'], ['GET', '/api/export/metrics'], ['GET', '/api/files/test/x']],
      read: [['GET', '/api/contents'], ['POST', '/api/ingest/contents'], ['POST', `/api/publications/${randomUUID()}/metrics`], ['GET', '/api/files/test/x']],
      files: [['GET', '/api/contents'], ['POST', '/api/ingest/contents'], ['GET', '/api/ingest/contents'], ['GET', '/api/export/metrics'], ['POST', '/api/sounds/sightings'], ['GET', '/api/sounds']],
      sounds: [['GET', '/api/contents'], ['POST', '/api/ingest/contents'], ['GET', '/api/export/publications'], ['GET', '/api/files'], ['POST', '/api/sounds/from-link'], ['PATCH', '/api/admin/sounds/1']],
    }
    // The sound bank is the sounds scope's (and read may only read its ranking).
    others.ingest.push(['POST', '/api/sounds/sightings'], ['GET', '/api/sounds'])
    others.poster.push(['POST', '/api/sounds/sightings'], ['GET', '/api/sounds'], ['POST', '/api/sounds/from-link'])
    others.read.push(['POST', '/api/sounds/sightings'], ['POST', '/api/sounds/from-link'], ['PATCH', '/api/admin/sounds/1'])
    for (const scope of ['ingest', 'poster', 'read', 'files', 'sounds'] as NarrowScope[]) {
      for (const [method, url] of [...probes, ...others[scope]]) {
        const res = await call(app, method as 'GET', url, { token: tokens[scope] }, method === 'GET' ? undefined : {})
        assert.equal(res.statusCode, 403, `${scope} ${method} ${url}`)
      }
    }
  })
})

describe('expired and revoked tokens', () => {
  it('get the same 401 as an unknown token, for every scope', async () => {
    const kol = makeUser('exp')
    const past = new Date(Date.now() - 1000).toISOString()
    const cases: [NarrowScope | 'admin', string, string][] = [
      ['ingest', 'POST', '/api/ingest/contents'],
      ['poster', 'GET', '/api/contents'],
      ['read', 'GET', '/api/export/publications'],
      ['admin', 'GET', '/api/admin/users'],
    ]
    for (const [scope, method, url] of cases) {
      const settings = { scope, userId: scope === 'poster' ? kol.id : null }
      const expired = createApiToken(`exp-${scope}`, scope === 'admin' ? 'admin' : 'kol', { ...settings, expiresAt: past })
      const revoked = createApiToken(`rev-${scope}`, scope === 'admin' ? 'admin' : 'kol', settings)
      db.update(apiTokens).set({ revokedAt: past }).where(eq(apiTokens.name, `rev-${scope}`)).run()
      const unknown = await call(app, method as 'GET', url, { token: 'pf_nope' }, method === 'POST' ? {} : undefined)
      for (const token of [expired, revoked]) {
        const res = await call(app, method as 'GET', url, { token }, method === 'POST' ? {} : undefined)
        assert.equal(res.statusCode, 401, `${scope} ${method} ${url}`)
        assert.deepEqual(res.json(), unknown.json())
      }
    }
    // A future expiry still works.
    const fresh = createApiToken('fresh', 'kol', { scope: 'read', expiresAt: new Date(Date.now() + 86_400_000).toISOString() })
    assert.equal((await call(app, 'GET', '/api/export/publications', { token: fresh })).statusCode, 200)
  })

  it('a poster token whose user is deactivated or gone gets 401', async () => {
    const kol = makeUser('gone')
    const token = createApiToken('gone-poster', 'kol', { scope: 'poster', userId: kol.id })
    assert.equal((await call(app, 'GET', '/api/contents', { token })).statusCode, 200)
    db.update(users).set({ active: false }).where(eq(users.id, kol.id)).run()
    assert.equal((await call(app, 'GET', '/api/contents', { token })).statusCode, 401)
    const ghost = createApiToken('ghost-poster', 'kol', { scope: 'poster', userId: randomUUID() })
    assert.equal((await call(app, 'GET', '/api/contents', { token: ghost })).statusCode, 401)
  })
})

describe('failed bearer attempts are rate-limited per IP', () => {
  it(`after ${MAX_FAILURES} failures the IP's bad attempts get 429, a good token still works; other IPs are unaffected`, async () => {
    const good = createApiToken('rl-good')
    const bad = { token: 'pf_guess', ip: '203.0.113.9' }
    for (let i = 0; i < MAX_FAILURES; i++) {
      assert.equal((await call(app, 'GET', '/api/admin/users', bad)).statusCode, 401)
    }
    assert.equal((await call(app, 'GET', '/api/admin/users', bad)).statusCode, 429)
    assert.equal((await call(app, 'GET', '/api/admin/users', { token: good, ip: '203.0.113.9' })).statusCode, 200)
    assert.equal((await call(app, 'GET', '/api/admin/users', { token: good, ip: '203.0.113.10' })).statusCode, 200)
    // A request without a bearer header (a person with a cookie) is not blocked.
    const admin = makeUser('rl-admin', 'admin')
    const cookie = await sessionFor(admin.id)
    assert.equal((await call(app, 'GET', '/api/admin/users', { cookie, ip: '203.0.113.9' })).statusCode, 200)
  })
})

describe('ingest scope', () => {
  let ytPte: ReturnType<typeof makeUser>
  let ytVichat: ReturnType<typeof makeUser>
  let outsider: ReturnType<typeof makeUser>
  let maker: string
  let otherMaker: string
  let openMaker: string

  before(() => {
    ytPte = makeUser('yt-pte')
    ytVichat = makeUser('yt-vichat')
    outsider = makeUser('outsider')
    maker = createApiToken('maker', 'kol', { scope: 'ingest', assignees: [ytPte.id, ytVichat.id] })
    otherMaker = createApiToken('other-maker', 'kol', { scope: 'ingest', assignees: [ytPte.id] })
    openMaker = createApiToken('open-maker', 'kol', { scope: 'ingest', assignees: [] })
  })

  it('with assignees: refuses a create without an assignee or with one outside the list (400)', async () => {
    const none = await call(app, 'POST', '/api/ingest/contents', { token: maker }, { code: 'NHI-NONE' })
    assert.equal(none.statusCode, 400)
    const out = await call(app, 'POST', '/api/ingest/contents', { token: maker }, {
      code: 'NHI-OUT',
      assignedUserId: outsider.id,
    })
    assert.equal(out.statusCode, 400)
    const unknown = await call(app, 'POST', '/api/ingest/contents', { token: maker }, {
      code: 'NHI-UNKNOWN',
      assignedUserId: 'nobody-here',
    })
    assert.equal(unknown.statusCode, 400)
    assert.equal(db.select().from(contents).where(eq(contents.code, 'NHI-NONE')).get(), undefined)
  })

  it('creates an assigned DRAFT with the new fields, by user id or by username', async () => {
    const res = await call(app, 'POST', '/api/ingest/contents', { token: maker }, {
      code: 'NHI-PTE-N14',
      title: 'Short',
      assignedUserId: ytPte.username,
      publishAt: '2026-11-28T20:00:00+07:00',
      meta: { line: 'pte', youtube: { title: 'T', description: 'D', tags: ['a', 'b'] } },
      source: 'nhi#12',
    })
    assert.equal(res.statusCode, 201)
    const c = res.json().content
    assert.equal(c.status, 'DRAFT')
    assert.equal(c.assignedUserId, ytPte.id)
    assert.equal(c.publishAt, '2026-11-28T13:00:00.000Z')
    assert.deepEqual(c.meta.youtube.tags, ['a', 'b'])
    assert.equal(c.source, 'nhi#12')

    const byId = await call(app, 'POST', '/api/ingest/contents', { token: maker }, {
      code: 'NHI-VICHAT-1',
      assignedUserId: ytVichat.id,
    })
    assert.equal(byId.statusCode, 201)
  })

  it('validates the new fields', async () => {
    const base = { assignedUserId: ytPte.id }
    const bad = [
      { code: 'B1', releaseAt: 'tomorrow' },
      { code: 'B2', meta: ['not', 'an', 'object'] },
      { code: 'B3', meta: 'text' },
      { code: 'B4', meta: { big: 'x'.repeat(65 * 1024) } },
      { code: 'B5', source: 's'.repeat(201) },
      { code: 'B6', status: 'PUBLISHED' },
    ]
    for (const body of bad) {
      const res = await call(app, 'POST', '/api/ingest/contents', { token: maker }, { ...base, ...body })
      assert.equal(res.statusCode, 400, JSON.stringify(body).slice(0, 60))
    }
  })

  it('without assignees: may create unassigned content (the pipeline’s behaviour)', async () => {
    const res = await call(app, 'POST', '/api/ingest/contents', { token: openMaker }, { code: 'OPEN-1', status: 'READY' })
    assert.equal(res.statusCode, 201)
    assert.equal(res.json().content.assignedUserId, null)
  })

  it('reads its own items by id and by code, nobody else’s', async () => {
    const mine = db.select().from(contents).where(eq(contents.code, 'NHI-PTE-N14')).get()!
    const byId = await call(app, 'GET', `/api/ingest/contents/${mine.id}`, { token: maker })
    assert.equal(byId.statusCode, 200)
    assert.deepEqual(byId.json().content.assets, [])

    const byCode = await call(app, 'GET', '/api/ingest/contents?code=NHI-PTE-N14', { token: maker })
    assert.equal(byCode.json().contents.length, 1)

    // Another token, a person (admin session) and old content are all invisible.
    const admin = makeUser('ingest-admin', 'admin')
    const cookie = await sessionFor(admin.id)
    const byPerson = (await call(app, 'POST', '/api/ingest/contents', { cookie }, { code: 'BY-PERSON' })).json().content
    const legacy = makeContent({ status: 'DRAFT', assignedUserId: ytPte.id })
    for (const id of [byPerson.id, legacy]) {
      assert.equal((await call(app, 'GET', `/api/ingest/contents/${id}`, { token: maker })).statusCode, 404)
      assert.equal((await call(app, 'PATCH', `/api/ingest/contents/${id}`, { token: maker }, { title: 'x' })).statusCode, 404)
      assert.equal((await upload(app, id, { token: maker })).statusCode, 404)
    }
    assert.equal((await call(app, 'GET', `/api/ingest/contents/${mine.id}`, { token: otherMaker })).statusCode, 404)
    assert.equal((await call(app, 'PATCH', `/api/ingest/contents/${mine.id}`, { token: otherMaker }, { title: 'x' })).statusCode, 404)
    assert.equal((await upload(app, mine.id, { token: otherMaker })).statusCode, 404)
    assert.deepEqual((await call(app, 'GET', '/api/ingest/contents?code=NHI-PTE-N14', { token: otherMaker })).json().contents, [])
    assert.deepEqual((await call(app, 'GET', '/api/ingest/contents?code=BY-PERSON', { token: maker })).json().contents, [])
    const all = (await call(app, 'GET', '/api/ingest/contents', { token: maker })).json().contents
    assert.ok(all.every((c: { createdByToken: string }) => c.createdByToken === all[0].createdByToken))
  })

  it('uploads to and patches its own DRAFT, then cannot change it after it left DRAFT', async () => {
    const mine = db.select().from(contents).where(eq(contents.code, 'NHI-PTE-N14')).get()!
    const up = await upload(app, mine.id, { token: maker }, 'n14.mp4')
    assert.equal(up.statusCode, 201)
    const read = (await call(app, 'GET', `/api/ingest/contents/${mine.id}`, { token: maker })).json().content
    assert.equal(read.assets[0].originalName, 'n14.mp4')
    assert.equal(read.assets[0].size, Buffer.byteLength('fake video bytes'))
    assert.equal(read.assets[0].filePath, undefined)

    const outside = await call(app, 'PATCH', `/api/ingest/contents/${mine.id}`, { token: maker }, {
      assignedUserId: outsider.id,
    })
    assert.equal(outside.statusCode, 400)
    const claimy = await call(app, 'PATCH', `/api/ingest/contents/${mine.id}`, { token: maker }, { status: 'CLAIMED' })
    assert.equal(claimy.statusCode, 400)

    const ready = await call(app, 'PATCH', `/api/ingest/contents/${mine.id}`, { token: maker }, { status: 'READY' })
    assert.equal(ready.statusCode, 200)
    assert.equal(ready.json().content.status, 'READY')

    for (const body of [{ title: 'late' }, { status: 'DRAFT' }]) {
      const res = await call(app, 'PATCH', `/api/ingest/contents/${mine.id}`, { token: maker }, body)
      assert.equal(res.statusCode, 409)
    }
    assert.equal((await upload(app, mine.id, { token: maker })).statusCode, 409)
    assert.equal(db.select().from(assets).where(eq(assets.contentId, mine.id)).all().length, 1)
    // Still readable, so a resuming client can see it is done.
    assert.equal((await call(app, 'GET', `/api/ingest/contents/${mine.id}`, { token: maker })).statusCode, 200)
  })

  it('may set releaseAt on its draft instead of READY', async () => {
    const res = await call(app, 'POST', '/api/ingest/contents', { token: maker }, {
      code: 'NHI-TIMED',
      assignedUserId: ytVichat.id,
    })
    const id = res.json().content.id
    const patched = await call(app, 'PATCH', `/api/ingest/contents/${id}`, { token: maker }, {
      releaseAt: '2030-01-01T00:00:00Z',
    })
    assert.equal(patched.statusCode, 200)
    assert.equal(patched.json().content.releaseAt, '2030-01-01T00:00:00.000Z')
    assert.equal(patched.json().content.status, 'DRAFT')
  })

  it('records token events for create, upload and patch', async () => {
    await tick()
    const row = db.select().from(apiTokens).where(eq(apiTokens.name, 'maker')).get()!
    const actions = db.select().from(tokenEvents).where(eq(tokenEvents.tokenId, row.id)).all().map((e) => e.action)
    for (const a of ['ingest.create', 'ingest.upload', 'ingest.patch']) assert.ok(actions.includes(a), a)
    // Reads and refusals are not recorded.
    assert.ok(!actions.some((a) => a.startsWith('GET')))
  })
})

describe('poster scope', () => {
  let alice: ReturnType<typeof makeUser>
  let bob: ReturnType<typeof makeUser>
  let aliceToken: string
  let bobToken: string

  before(() => {
    // Clear the queue other suites left behind, so claim-next is predictable.
    db.update(contents).set({ status: 'FAILED' }).where(eq(contents.status, 'READY')).run()
    alice = makeUser('alice', 'kol', { assignedOnly: true })
    bob = makeUser('bob')
    aliceToken = createApiToken('alice-poster', 'kol', { scope: 'poster', userId: alice.id })
    bobToken = createApiToken('bob-poster', 'kol', { scope: 'poster', userId: bob.id })
  })

  it('an assigned_only user never gets the open queue: list, get, claim-next, claim, assets', async () => {
    const t0 = Date.now() - 100_000
    const open = makeContent({ status: 'READY', createdAt: new Date(t0).toISOString() })
    const openAsset = randomUUID()
    db.insert(assets)
      .values({ id: openAsset, contentId: open, filePath: 'x.mp4', originalName: 'x.mp4', mime: 'video/mp4', size: 1, type: 'video' })
      .run()
    const mine = makeContent({ status: 'READY', assignedUserId: alice.id, createdAt: new Date(t0 + 1000).toISOString() })

    const list = (await call(app, 'GET', '/api/contents', { token: aliceToken })).json().contents
    assert.deepEqual(list.map((c: { id: string }) => c.id), [mine])
    assert.equal(list[0].createdByToken, undefined)

    assert.equal((await call(app, 'GET', `/api/contents/${open}`, { token: aliceToken })).statusCode, 404)
    assert.equal((await call(app, 'GET', `/api/assets/${openAsset}`, { token: aliceToken })).statusCode, 404)
    assert.equal((await call(app, 'GET', `/api/contents/${open}/assets.zip`, { token: aliceToken })).statusCode, 404)

    const claimOpen = await call(app, 'POST', `/api/contents/${open}/claim`, { token: aliceToken })
    assert.equal(claimOpen.statusCode, 404)

    const next = await call(app, 'POST', '/api/contents/claim-next', { token: aliceToken })
    assert.equal(next.statusCode, 200)
    assert.equal(next.json().content.id, mine)
    assert.equal(next.json().content.claimedBy, alice.id)

    const empty = await call(app, 'POST', '/api/contents/claim-next', { token: aliceToken })
    assert.equal(empty.statusCode, 404)
    assert.equal(empty.json().reason, 'empty_queue')
    assert.equal(db.select().from(contents).where(eq(contents.id, open)).get()!.status, 'READY')

    // The same rule holds for alice signed in with a cookie.
    const cookie = await sessionFor(alice.id)
    assert.equal((await call(app, 'GET', `/api/contents/${open}`, { cookie })).statusCode, 404)
    assert.equal((await call(app, 'GET', '/api/contents/stats', { cookie })).json().available, 0)

    // A normal user signed in still sees the open queue; their poster token does not (review finding 3).
    const bobCookie = await sessionFor(bob.id)
    const bobs = (await call(app, 'GET', '/api/contents', { cookie: bobCookie })).json().contents
    assert.ok(bobs.some((c: { id: string }) => c.id === open))
    const bobsToken = (await call(app, 'GET', '/api/contents', { token: bobToken })).json().contents
    assert.ok(!bobsToken.some((c: { id: string }) => c.id === open))
    db.update(contents).set({ status: 'FAILED' }).where(eq(contents.id, open)).run()
  })

  it('acts as its user only: cannot see, release, complete or unlink another user’s work', async () => {
    const bobsItem = makeContent({ status: 'READY', assignedUserId: bob.id })
    assert.equal((await call(app, 'POST', `/api/contents/${bobsItem}/claim`, { token: bobToken })).statusCode, 200)
    const pub = await call(app, 'POST', '/api/publications', { token: bobToken }, {
      contentId: bobsItem,
      platform: 'youtube',
      publishedUrl: 'https://youtube.com/watch?v=bob',
      publishedAt: '2026-11-28T20:00:00+07:00',
    })
    assert.equal(pub.statusCode, 200)
    assert.equal(pub.json().publication.userId, bob.id)
    assert.equal(pub.json().publication.publishedAt, '2026-11-28T13:00:00.000Z')
    const pubId = pub.json().publication.id

    assert.equal((await call(app, 'GET', `/api/contents/${bobsItem}`, { token: aliceToken })).statusCode, 404)
    assert.equal((await call(app, 'POST', `/api/contents/${bobsItem}/release`, { token: aliceToken })).statusCode, 409)
    assert.equal((await call(app, 'POST', `/api/contents/${bobsItem}/complete`, { token: aliceToken })).statusCode, 409)
    assert.equal((await call(app, 'DELETE', `/api/publications/${pubId}`, { token: aliceToken })).statusCode, 403)
    const foreignLink = await call(app, 'POST', '/api/publications', { token: aliceToken }, {
      contentId: bobsItem,
      platform: 'facebook',
      publishedUrl: 'https://facebook.com/x',
    })
    assert.equal(foreignLink.statusCode, 403)
    assert.equal((await call(app, 'GET', `/api/publications/${pubId}/metrics`, { token: aliceToken })).statusCode, 404)
    assert.equal((await call(app, 'POST', `/api/publications/${pubId}/metrics`, { token: aliceToken }, { views: 1 })).statusCode, 404)

    const done = await call(app, 'POST', `/api/contents/${bobsItem}/complete`, { token: bobToken })
    assert.equal(done.statusCode, 200)
    assert.equal(done.json().content.status, 'PUBLISHED')
  })

  it('admins set assigned_only with PATCH /api/admin/users/:id', async () => {
    const adminCookie = await sessionFor(makeUser('ao-admin', 'admin').id)
    const carol = makeUser('carol')
    const res = await call(app, 'PATCH', `/api/admin/users/${carol.id}`, { cookie: adminCookie }, { assignedOnly: true })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().user.assignedOnly, true)
    assert.equal((await call(app, 'PATCH', `/api/admin/users/${carol.id}`, { cookie: adminCookie }, { assignedOnly: 'yes' })).statusCode, 400)
  })

  it('a poster token bound to an admin user still acts with kol power only', async () => {
    const boss = makeUser('boss', 'admin')
    const token = createApiToken('boss-poster', 'kol', { scope: 'poster', userId: boss.id })
    const someoneElses = makeContent({ status: 'CLAIMED', claimedBy: bob.id })
    assert.equal((await call(app, 'GET', `/api/contents/${someoneElses}`, { token })).statusCode, 404)
    assert.equal((await call(app, 'GET', '/api/admin/users', { token })).statusCode, 403)
  })

  it('many poster tokens racing for one item: exactly one wins, the rest get 409', async () => {
    // Poster tokens only take items assigned to their user, so the racers are 20 tokens of one user.
    const u = makeUser('racer', 'kol', { assignedOnly: true })
    const item = makeContent({ status: 'READY', assignedUserId: u.id })
    const racers = Array.from({ length: 20 }, (_, i) => ({
      u,
      token: createApiToken(`racer${i}`, 'kol', { scope: 'poster', userId: u.id }),
    }))
    const results = await Promise.all(
      racers.map((r) => call(app, 'POST', `/api/contents/${item}/claim`, { token: r.token })),
    )
    const winners = results.filter((r) => r.statusCode === 200)
    assert.equal(winners.length, 1, 'exactly one poster must win')
    assert.ok(results.filter((r) => r.statusCode !== 200).every((r) => r.statusCode === 409))
    const row = db.select().from(contents).where(eq(contents.id, item)).get()!
    assert.equal(row.claimedBy, u.id)
    assert.equal(winners[0]!.json().content.claimedByThisToken, true)
  })

  it('records claim, publication and complete events with their ids', async () => {
    await tick()
    const row = db.select().from(apiTokens).where(eq(apiTokens.name, 'bob-poster')).get()!
    const events = db.select().from(tokenEvents).where(eq(tokenEvents.tokenId, row.id)).all()
    const actions = events.map((e) => e.action)
    for (const a of ['claim', 'publication.create', 'complete']) assert.ok(actions.includes(a), a)
    const pubEvent = events.find((e) => e.action === 'publication.create')!
    assert.ok(pubEvent.contentId && pubEvent.publicationId && pubEvent.ip)
  })
})
