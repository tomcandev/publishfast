/**
 * The sound bank routes (contract section 13): sightings read by the server
 * itself, the paste box, the ranking, hiding, the scope rules, and the
 * public-count sync filling a publication's sound. The network is stubbed:
 * every request goes to a fake TikTok, and the test fails if anything else
 * is ever requested.
 */
import './env.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, beforeEach, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db, sqlite } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { apiTokens, metricSnapshots, publications, soundSightings, sounds, tokenEvents } from '../db/schema.js'
import { createApiToken } from '../lib/auth.js'
import { syncAllPublicationMetrics } from '../lib/metrics.js'
import {
  DAILY_PASTES,
  DAILY_SIGHTINGS,
  MIN_REUSERS,
  OURS_RATIO,
  PLAYS_FLOOR,
  _clearRankingCache,
  _resetDailyCaps,
  _useDaily,
  foldName,
  idSeconds,
  isOriginalLike,
  outsideEvidence,
  rankSounds,
  rankSoundsCached,
  sightingHandle,
  soundQuality,
} from '../lib/sounds.js'
import { TIKTOK_HOSTS } from '../lib/tiktok.js'
import { call, makeContent, makeUser, sessionFor } from './helpers.js'

const fixture = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8')

const TRACK_URL = 'https://www.tiktok.com/@example.creator/video/7400000000000000101'
const ORIGINAL_CANONICAL = 'https://www.tiktok.com/@sample.teacher/video/7400000000000000102'
const SHORT_URL = 'https://vt.tiktok.com/ZSinvented/'
const NOJSON_URL = 'https://www.tiktok.com/@nobody/video/7400000000000000103'
const MANUAL_URL = 'https://www.tiktok.com/@manual.user/video/7400000000000000777'
const TRACK_ID = '7300000000000000201'
const ORIGINAL_ID = '7300000000000000202'

let app: FastifyInstance
let requested: string[] = []
let realFetch: typeof fetch
let hold: Promise<void> | null = null
/** What the fake tikwm answers, by the TikTok link it is asked about; anything else is `{code: -1}`. */
const tikwmAnswers = new Map<string, unknown>()
/** The ~1.5 KB JS shell TikTok serves the VPS for every video page: no video data. */
const SHELL = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>TikTok</title><script>${'/*shell*/'.repeat(150)}</script></head><body></body></html>`
const SHELL_PREFIX = 'https://www.tiktok.com/@shell'

/** A fake TikTok. Anything that is not on a TikTok host (or tikwm) fails the test. */
function fakeTikTok(input: string | URL | Request, init?: RequestInit) {
  const url = String(input)
  requested.push(url)
  const host = new URL(url).hostname
  assert.equal(init?.redirect, 'manual')
  if (host === 'www.tikwm.com') {
    const asked = new URL(url).searchParams.get('url') ?? ''
    return new Response(JSON.stringify(tikwmAnswers.get(asked) ?? { code: -1 }))
  }
  assert.ok(TIKTOK_HOSTS.has(host), `requested a non-TikTok host: ${url}`)
  if (url.startsWith(SHELL_PREFIX)) return new Response(SHELL)
  if (url === SHORT_URL) return new Response(null, { status: 301, headers: { location: `${ORIGINAL_CANONICAL}?_r=1&_t=x` } })
  if (url.startsWith(ORIGINAL_CANONICAL)) return new Response(fixture('tiktok-original.html'))
  if (url.startsWith(TRACK_URL)) return new Response(fixture('tiktok-track.html'))
  if (url === NOJSON_URL) return new Response(fixture('tiktok-nojson.html'))
  if (url.includes('/redirect-out')) return new Response(null, { status: 302, headers: { location: 'https://evil.example/' } })
  if (url.startsWith(MANUAL_URL)) {
    return new Response(fixture('tiktok-track.html').replace('7400000000000000101', '7400000000000000777').replace('example.creator', 'manual.user'))
  }
  if (url.includes('/slow')) return (hold ?? Promise.resolve()).then(() => new Response(fixture('tiktok-track.html')))
  if (url.includes('/upstream-error')) throw new TypeError('getaddrinfo ENOTFOUND upstream-secret-detail')
  return new Response('not found', { status: 404 })
}

let admin: ReturnType<typeof makeUser>
let kol: ReturnType<typeof makeUser>
let soundsToken: string
let readToken: string
let adminToken: string

before(async () => {
  migrate()
  app = await buildApp({ logger: false })
  admin = makeUser('s-admin', 'admin')
  kol = makeUser('s-kol')
  soundsToken = createApiToken('scout', 'kol', { scope: 'sounds' })
  readToken = createApiToken('s-read', 'kol', { scope: 'read' })
  adminToken = createApiToken('s-legacy-admin')
  realFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => fakeTikTok(input, init)) as typeof fetch
})

after(async () => {
  globalThis.fetch = realFetch
  await app.close()
  sqlite.close()
})

beforeEach(() => {
  requested = []
})

describe('POST /api/sounds/sightings', () => {
  it('reads each page itself and answers per item: recorded, unreadable (refused, no sound, not found, upstream error)', async () => {
    const res = await call(app, 'POST', '/api/sounds/sightings', { token: soundsToken }, {
      items: [
        { videoUrl: TRACK_URL, source: 'trend', region: 'au', rank: 3 },
        { videoUrl: SHORT_URL, source: 'viral' },
        { videoUrl: 'https://evil.example/@x/video/1', source: 'viral' },
        { videoUrl: 'https://127.0.0.1/@x/video/1', source: 'viral' },
        { videoUrl: NOJSON_URL, source: 'viral' },
        { videoUrl: 'https://www.tiktok.com/@gone/video/1', source: 'viral' },
        { videoUrl: 'https://www.tiktok.com/upstream-error', source: 'viral' },
        { videoUrl: 'https://vt.tiktok.com/redirect-out', source: 'viral' },
      ],
    })
    assert.equal(res.statusCode, 200)
    const r = res.json().results
    assert.deepEqual(
      r.map((x: { status: string; reason?: string }) => [x.status, x.reason ?? null]),
      [
        ['recorded', null],
        ['recorded', null],
        ['unreadable', 'refused'],
        ['unreadable', 'refused'],
        ['unreadable', 'no_sound'],
        ['unreadable', 'not_found'],
        ['unreadable', 'unreachable'],
        ['unreadable', 'redirect_refused'],
      ],
    )
    assert.equal(r[0].soundId, TRACK_ID)
    assert.equal(r[1].soundId, ORIGINAL_ID)
    // Never the fetched body or upstream error text.
    for (const leak of ['Invented', 'upstream-secret-detail', 'Log in to TikTok', 'ENOTFOUND']) assert.ok(!res.body.includes(leak), leak)
    assert.ok(!requested.some((u) => u.includes('evil.example') || u.includes('127.0.0.1')))

    const s1 = db.select().from(soundSightings).where(eq(soundSightings.soundId, TRACK_ID)).get()!
    assert.equal(s1.videoUrl, TRACK_URL)
    assert.deepEqual([s1.plays, s1.likes, s1.saves, s1.source, s1.region, s1.rank, s1.videoAuthor], [98765, 4321, 210, 'trend', 'AU', 3, 'example.creator'])
    assert.ok(s1.tokenId)
    const s2 = db.select().from(soundSightings).where(eq(soundSightings.soundId, ORIGINAL_ID)).get()!
    assert.equal(s2.videoUrl, ORIGINAL_CANONICAL, 'the short link is stored as the canonical video URL')
    const sound = db.select().from(sounds).where(eq(sounds.id, TRACK_ID)).get()!
    assert.deepEqual([sound.title, sound.author, sound.original, sound.status], ['Lofi Study Loop', 'Example Band', false, 'active'])
    assert.equal(sound.url, `https://www.tiktok.com/music/Lofi-Study-Loop-${TRACK_ID}`)
    // The call is in the token's audit trail.
    assert.ok(db.select().from(tokenEvents).all().some((e) => e.action === 'sounds.sightings'))
  })

  it('the same video again is "known" and refreshed; a caller cannot supply the sound or the counts', async () => {
    const res = await call(app, 'POST', '/api/sounds/sightings', { token: soundsToken }, {
      items: [{ videoUrl: `${TRACK_URL}?is_from_webapp=1`, source: 'trend', rank: 1, soundId: '1', plays: 999_999_999, title: 'fake' }],
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().results[0].status, 'known')
    const rows = db.select().from(soundSightings).where(eq(soundSightings.videoUrl, TRACK_URL)).all()
    assert.equal(rows.length, 1)
    assert.deepEqual([rows[0]!.soundId, rows[0]!.plays, rows[0]!.rank, rows[0]!.region], [TRACK_ID, 98765, 1, 'AU'])
    assert.equal(db.select().from(sounds).where(eq(sounds.id, '1')).get(), undefined)
  })

  it('validates the body: 1 to 50 items, source, region, rank, url length', async () => {
    const item = { videoUrl: TRACK_URL, source: 'trend' }
    for (const body of [
      {},
      { items: [] },
      { items: Array.from({ length: 51 }, () => item) },
      { items: [{ ...item, source: 'radio' }] },
      { items: [{ ...item, region: 'AUS' }] },
      { items: [{ ...item, rank: 0 }] },
      { items: [{ ...item, rank: 1.5 }] },
      { items: [{ ...item, videoUrl: `https://www.tiktok.com/${'a'.repeat(2050)}` }] },
      { items: [{ source: 'trend' }] },
    ]) {
      const res = await call(app, 'POST', '/api/sounds/sightings', { token: soundsToken }, body)
      assert.equal(res.statusCode, 400, JSON.stringify(body).slice(0, 60))
    }
    assert.equal(requested.length, 0)
  })

  it('one of our own posts is not a sighting', async () => {
    db.insert(publications)
      .values({ id: randomUUID(), contentId: makeContent({ status: 'PUBLISHED' }), userId: kol.id, platform: 'tiktok', publishedUrl: 'https://www.tiktok.com/@ours/video/7400000000000000102' })
      .run()
    const before = db.select().from(soundSightings).all().length
    const res = await call(app, 'POST', '/api/sounds/sightings', { token: soundsToken }, { items: [{ videoUrl: 'https://www.tiktok.com/@sample.teacher/video/7400000000000000102?x=1', source: 'viral' }] })
    // Only an admin learns that a video is one of the team's posts; anyone else sees a plain "known".
    assert.deepEqual(res.json().results[0], { videoUrl: 'https://www.tiktok.com/@sample.teacher/video/7400000000000000102?x=1', status: 'known', soundId: ORIGINAL_ID })
    const asAdmin = await call(app, 'POST', '/api/sounds/sightings', { token: adminToken }, { items: [{ videoUrl: 'https://www.tiktok.com/@sample.teacher/video/7400000000000000102', source: 'viral' }] })
    assert.equal(asAdmin.json().results[0].reason, 'our_post')
    const paste = await call(app, 'POST', '/api/sounds/from-link', { cookie: await sessionFor(kol.id) }, { videoUrl: 'https://www.tiktok.com/@sample.teacher/video/7400000000000000102' })
    assert.equal(paste.json().reason, undefined)
    assert.equal(db.select().from(soundSightings).all().length, before)
  })

  it('one call at a time per caller (429 for a second while the first runs)', async () => {
    let release!: () => void
    hold = new Promise<void>((r) => (release = r))
    const first = call(app, 'POST', '/api/sounds/sightings', { token: soundsToken }, { items: [{ videoUrl: 'https://www.tiktok.com/slow', source: 'viral' }] })
    await new Promise((r) => setTimeout(r, 20))
    const second = await call(app, 'POST', '/api/sounds/sightings', { token: soundsToken }, { items: [{ videoUrl: TRACK_URL, source: 'viral' }] })
    assert.equal(second.statusCode, 429)
    assert.equal(second.json().reason, 'busy')
    // Another caller is not blocked by it.
    const other = await call(app, 'POST', '/api/sounds/sightings', { token: adminToken }, { items: [{ videoUrl: TRACK_URL, source: 'trend' }] })
    assert.equal(other.statusCode, 200)
    release()
    assert.equal((await first).statusCode, 200)
    hold = null
  })
})

describe('POST /api/sounds/from-link', () => {
  it('a signed-in person pastes a video link and gets the sound with its copy text', async () => {
    const cookie = await sessionFor(kol.id)
    const res = await call(app, 'POST', '/api/sounds/from-link', { cookie }, { videoUrl: SHORT_URL })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().status, 'known')
    assert.deepEqual(res.json().sound, {
      id: ORIGINAL_ID,
      title: 'original sound - Sample Teacher',
      author: 'Sample Teacher',
      original: true,
      url: `https://www.tiktok.com/music/original-sound-Sample-Teacher-${ORIGINAL_ID}`,
      copyText: 'original sound Sample Teacher',
    })
  })

  it('refused links are 400, unreadable pages 422, without upstream text', async () => {
    const cookie = await sessionFor(kol.id)
    const refused = await call(app, 'POST', '/api/sounds/from-link', { cookie }, { videoUrl: 'https://www.tiktok.com.evil.example/x' })
    assert.equal(refused.statusCode, 400)
    assert.equal(refused.json().reason, 'refused')
    const nojson = await call(app, 'POST', '/api/sounds/from-link', { cookie }, { videoUrl: NOJSON_URL })
    assert.equal(nojson.statusCode, 422)
    assert.equal(nojson.json().reason, 'no_sound')
    const upstream = await call(app, 'POST', '/api/sounds/from-link', { cookie }, { videoUrl: 'https://www.tiktok.com/upstream-error' })
    assert.equal(upstream.statusCode, 422)
    assert.ok(!upstream.body.includes('upstream-secret-detail'))
    assert.ok(!requested.some((u) => u.includes('evil.example')))
  })

  it('records a manual sighting for a new video', async () => {
    const cookie = await sessionFor(admin.id)
    const res = await call(app, 'POST', '/api/sounds/from-link', { cookie }, { videoUrl: `${MANUAL_URL}?is_copy_url=1` })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().status, 'recorded')
    assert.equal(res.json().sound.copyText, 'Lofi Study Loop Example Band')
    const row = db.select().from(soundSightings).where(eq(soundSightings.videoUrl, MANUAL_URL)).get()!
    assert.deepEqual([row.source, row.tokenId, row.soundId], ['manual', null, TRACK_ID])
  })
})

describe('who may call the sound routes', () => {
  it('scopes: sounds may sight and read; read may only read; poster, ingest and files reach none; from-link is for people', async () => {
    const poster = createApiToken('s-poster', 'kol', { scope: 'poster', userId: kol.id })
    const ingest = createApiToken('s-ingest', 'kol', { scope: 'ingest' })
    const files = createApiToken('s-files', 'kol', { scope: 'files', filePrefix: 'x/' })
    const legacyKol = createApiToken('s-legacy-kol', 'kol')
    const kolCookie = await sessionFor(kol.id)
    const adminCookie = await sessionFor(admin.id)
    const sighting = { items: [{ videoUrl: 'https://evil.example/', source: 'viral' }] } // refused before any fetch
    const link = { videoUrl: 'https://evil.example/' }
    const cases: [string, Record<string, string>, [number, number, number, number]][] = [
      // who, caller, [sightings, from-link, list, admin patch]
      ['sounds token', { token: soundsToken }, [200, 403, 200, 403]],
      ['read token', { token: readToken }, [403, 403, 200, 403]],
      ['poster token', { token: poster }, [403, 403, 403, 403]],
      ['ingest token', { token: ingest }, [403, 403, 403, 403]],
      ['files token', { token: files }, [403, 403, 403, 403]],
      ['old kol token', { token: legacyKol }, [403, 403, 403, 403]],
      ['old admin token', { token: adminToken }, [200, 400, 200, 404]],
      ['kol session', { cookie: kolCookie }, [403, 400, 200, 403]],
      ['admin session', { cookie: adminCookie }, [200, 400, 200, 404]],
      ['nobody', {}, [401, 401, 401, 401]],
    ]
    for (const [who, caller, [s, f, l, p]] of cases) {
      assert.equal((await call(app, 'POST', '/api/sounds/sightings', caller, sighting)).statusCode, s, `${who} sightings`)
      assert.equal((await call(app, 'POST', '/api/sounds/from-link', caller, link)).statusCode, f, `${who} from-link`)
      assert.equal((await call(app, 'GET', '/api/sounds', caller)).statusCode, l, `${who} list`)
      assert.equal((await call(app, 'PATCH', '/api/admin/sounds/123', caller, { status: 'hidden' })).statusCode, p, `${who} patch`)
    }
    assert.ok(!requested.some((u) => u.includes('evil.example')))
  })

  it('a sounds token reaches nothing else: admin, queue, ingest, export, files, auth', async () => {
    for (const [method, url] of [
      ['GET', '/api/admin/users'],
      ['GET', '/api/admin/storage'],
      ['GET', '/api/contents'],
      ['POST', '/api/ingest/contents'],
      ['GET', '/api/export/publications'],
      ['GET', '/api/files'],
      ['POST', '/api/auth/login'],
      ['GET', '/api/me'],
    ] as const) {
      const res = await call(app, method, url, { token: soundsToken }, method === 'POST' ? {} : undefined)
      assert.equal(res.statusCode, 403, `${method} ${url}`)
    }
  })
})

describe('GET /api/sounds and hiding', () => {
  it('lists active sounds by score with copyText, sightings and the not-enough flag', async () => {
    const res = await call(app, 'GET', '/api/sounds?window=14', { cookie: await sessionFor(kol.id) })
    assert.equal(res.statusCode, 200)
    const list = res.json().sounds
    const track = list.find((s: { id: string }) => s.id === TRACK_ID)
    assert.equal(track.copyText, 'Lofi Study Loop Example Band')
    // Two videos use it: the trend one (last reported as viral by the slow call above) and the pasted one.
    assert.equal(track.sightings.count, 2)
    assert.deepEqual(track.sightings.sources, ['manual', 'viral'])
    assert.equal(track.sightings.bestRank, 1)
    assert.equal(track.sightings.bestPlays, 98765)
    // Both pages carry the same plays: the newer sighting is the example.
    assert.equal(track.sightings.bestVideoUrl, MANUAL_URL)
    assert.equal(track.sightings.newestVideoUrl, MANUAL_URL)
    assert.equal(track.ours.enough, false)
    assert.equal(track.note, undefined, 'notes are for admins')
    for (const bad of ['?window=5', '?limit=0', '?limit=201', '?window=abc']) {
      assert.equal((await call(app, 'GET', `/api/sounds${bad}`, { cookie: await sessionFor(kol.id) })).statusCode, 400, bad)
    }
  })

  it('an admin hides a sound and writes a note; hidden sounds are left out (admins can ask for them)', async () => {
    const adminCookie = await sessionFor(admin.id)
    const kolCookie = await sessionFor(kol.id)
    assert.equal((await call(app, 'PATCH', `/api/admin/sounds/${TRACK_ID}`, { cookie: adminCookie }, { note: 'x'.repeat(301) })).statusCode, 400)
    assert.equal((await call(app, 'PATCH', `/api/admin/sounds/${TRACK_ID}`, { cookie: adminCookie }, {})).statusCode, 400)
    assert.equal((await call(app, 'PATCH', `/api/admin/sounds/${TRACK_ID}`, { cookie: adminCookie }, { status: 'gone' })).statusCode, 400)
    const res = await call(app, 'PATCH', `/api/admin/sounds/${TRACK_ID}`, { cookie: adminCookie }, { status: 'hidden', note: '  too loud  ' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual([res.json().sound.status, res.json().sound.note], ['hidden', 'too loud'])

    const ids = async (who: Record<string, string>, q = '') =>
      (await call(app, 'GET', `/api/sounds${q}`, who)).json().sounds.map((s: { id: string }) => s.id)
    assert.ok(!(await ids({ cookie: kolCookie })).includes(TRACK_ID))
    assert.ok(!(await ids({ cookie: kolCookie }, '?hidden=1')).includes(TRACK_ID), 'only admins see hidden ones')
    assert.ok(!(await ids({ token: soundsToken }, '?hidden=1')).includes(TRACK_ID))
    assert.ok(!(await ids({ cookie: adminCookie })).includes(TRACK_ID))
    const withHidden = (await call(app, 'GET', '/api/sounds?hidden=1', { cookie: adminCookie })).json().sounds
    const hidden = withHidden.find((s: { id: string }) => s.id === TRACK_ID)
    assert.deepEqual([hidden.status, hidden.note], ['hidden', 'too loud'])

    await call(app, 'PATCH', `/api/admin/sounds/${TRACK_ID}`, { cookie: adminCookie }, { status: 'active', note: null })
    assert.ok((await ids({ cookie: kolCookie })).includes(TRACK_ID))
  })
})

describe('the ranking with our own posts', () => {
  it('our posts: views over the posting account’s median in the window; 3 posts make it trusted; ordered by score', () => {
    const now = new Date()
    const at = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString()
    const acct = makeUser('rank-acct')
    const other = makeUser('rank-other')
    db.insert(sounds).values([
      { id: '900001', title: 'Strong', author: 'A', original: false, firstSeenAt: at(1), lastSeenAt: at(1) },
      { id: '900002', title: 'Weak', author: 'B', original: false, firstSeenAt: at(1), lastSeenAt: at(1) },
      { id: '900003', title: 'Old', author: 'C', original: true, firstSeenAt: at(60), lastSeenAt: at(40) },
    ]).run()
    const pub = (user: string, views: number, soundId: string | null, days: number) =>
      db.insert(publications)
        .values({ id: randomUUID(), contentId: makeContent({ status: 'PUBLISHED' }), userId: user, platform: 'tiktok', publishedUrl: `https://www.tiktok.com/@a/video/${randomUUID()}`, publishedAt: at(days), views, soundId })
        .run()
    // The account's posts in the window: views 100, 100, 100, 400, 400, 400, 1000 -> median 400.
    pub(acct.id, 100, null, 2)
    pub(acct.id, 100, null, 2)
    pub(acct.id, 100, '900002', 2)
    pub(acct.id, 400, null, 2)
    pub(acct.id, 400, '900001', 3)
    pub(acct.id, 400, '900001', 4)
    pub(acct.id, 1000, '900001', 5)
    pub(acct.id, 50_000, '900001', 40) // outside a 14-day window
    // Another account's median is its own.
    pub(other.id, 10, '900002', 1)
    pub(other.id, 30, null, 1)

    const ranked = rankSounds({ windowDays: 14, limit: 50, now })
    const get = (id: string) => ranked.find((s) => s.id === id)!
    // 900001: ratios 1, 1, 2.5 -> median 1; 3 posts -> enough. score = 3 × 1 × 1 = 3
    assert.deepEqual(get('900001').ours, { posts: 3, medianRatio: 1, enough: true })
    assert.equal(get('900001').score, 3)
    // 900002: ratios 100/400 = 0.25 and 10/20 = 0.5 -> median 0.375; 2 posts. score = 3 × 0.375 × 2/3 = 0.75
    assert.deepEqual(get('900002').ours, { posts: 2, medianRatio: 0.38, enough: false })
    assert.equal(get('900002').score, 0.75)
    // 900003: nothing but staleness: 40 days -> -3.3
    assert.equal(get('900003').score, -3.3)
    assert.equal(get('900003').copyText, 'original sound C')
    const order = ranked.map((s) => s.id).filter((id) => id.startsWith('9000'))
    assert.deepEqual(order, ['900001', '900002', '900003'])
    // The 30-day window takes the 40-day-old post? No: 40 > 30. A 30-day window is the same here.
    assert.deepEqual(rankSounds({ windowDays: 30, limit: 50, now }).find((s) => s.id === '900001')!.ours.posts, 3)
    assert.equal(rankSounds({ windowDays: 7, limit: 1, now }).length, 1)
  })
})

describe('the quality gate: background audio, not someone talking', () => {
  // TikTok ids carry their creation second in the high 32 bits.
  const idAt = (seconds: number, low = 1) => ((BigInt(seconds) << 32n) + BigInt(low)).toString()
  const T = 1_778_000_000

  it('soundQuality: ours first, then an original needs 2 reusers, then a trend rank or the plays floor', () => {
    assert.deepEqual([MIN_REUSERS, PLAYS_FLOOR, OURS_RATIO], [2, 20_000, 1.25])
    const none = { reusers: 0, bestPlays: 0, bestRank: null }
    const q = (originalLike: boolean, outside = none, ours = { enough: false, medianRatio: null as number | null }) =>
      soundQuality({ originalLike, ours, outside })
    assert.deepEqual(q(false), { pass: false, reason: 'no_evidence' })
    assert.deepEqual(q(true), { pass: false, reason: 'speech' })
    assert.deepEqual(q(false, { reusers: 1, bestPlays: 20_000, bestRank: null }), { pass: true, reason: 'plays' })
    assert.deepEqual(q(false, { reusers: 1, bestPlays: 19_999, bestRank: null }), { pass: false, reason: 'no_evidence' })
    assert.deepEqual(q(false, { reusers: 1, bestPlays: 10, bestRank: 40 }), { pass: true, reason: 'trend' })
    // One person's original sound, however many plays its own video has: probably their voice.
    assert.deepEqual(q(true, { reusers: 1, bestPlays: 5_000_000, bestRank: 1 }), { pass: false, reason: 'speech' })
    assert.deepEqual(q(true, { reusers: 2, bestPlays: 5_000, bestRank: null }), { pass: false, reason: 'no_evidence' })
    assert.deepEqual(q(true, { reusers: 2, bestPlays: 25_000, bestRank: null }), { pass: true, reason: 'plays' })
    // Our own posts, enough of them and clearly above the account's usual, qualify either kind.
    assert.deepEqual(q(true, none, { enough: true, medianRatio: 1.25 }), { pass: true, reason: 'ours' })
    assert.deepEqual(q(true, none, { enough: true, medianRatio: 1.2 }), { pass: false, reason: 'speech' })
    assert.deepEqual(q(false, none, { enough: false, medianRatio: 4 }), { pass: false, reason: 'no_evidence' })
  })

  it('outsideEvidence leaves out the sound’s own author: by name, or by a video made with the sound', () => {
    const sound = { id: idAt(T), title: 'original sound - ivan.r.music', author: '𝐈𝐯𝐚́𝐧 𝐑 Music 🎧' }
    const x = (handle: string, at: number, plays = 0, rank: number | null = null) => ({ handle, videoId: idAt(at, 7), plays, rank })
    // ivanrmusic: the folded title name; ptebydee: its video was made 1 s before the sound.
    const out = outsideEvidence(sound, [x('ivanrmusic', T + 9_000_000, 9_000_000), x('ptebydee', T - 1, 8_000_000, 1), x('ptebydee', T + 50_000, 7_000_000), x('a.fan', T + 100_000, 30_000), x('b.fan', T + 200_000, 1_000, 5)])
    assert.deepEqual(out, { reusers: 2, bestPlays: 30_000, bestRank: 5 })
    // The display name folds too ("𝐈𝐯𝐚́𝐧 𝐑 Music" -> "ivanrmusic").
    assert.equal(foldName(sound.author), 'ivanrmusic')
    assert.equal(outsideEvidence({ ...sound, title: 'original sound' }, [x('ivanrmusic', T + 9_000_000, 9)]).reusers, 0)
    assert.equal(idSeconds(idAt(T)), T)
    assert.equal(idSeconds('123'), null)
    assert.equal(sightingHandle({ videoAuthor: null, videoUrl: 'https://www.tiktok.com/@Some.One/video/1' }), 'some.one')
    assert.equal(sightingHandle({ videoAuthor: ' Other ', videoUrl: 'https://www.tiktok.com/@x/video/1' }), 'other')
    assert.ok(isOriginalLike({ original: false, title: 'original sound - Charmaine | PTE Trainer' }))
    assert.ok(isOriginalLike({ original: false, title: 'âm thanh gốc' }))
    assert.ok(isOriginalLike({ original: true, title: 'Night Trouble' }))
    assert.ok(!isOriginalLike({ original: false, title: 'Beanie - Piano Version' }))
  })

  it('GET /api/sounds serves only sounds that pass; an admin’s "Show hidden" serves all, each with its verdict', async () => {
    const now = new Date().toISOString()
    const seen = (soundId: string, handle: string, videoId: string, plays: number) =>
      db.insert(soundSightings)
        .values({ id: randomUUID(), soundId, videoUrl: `https://www.tiktok.com/@${handle}/video/${videoId}`, videoAuthor: handle, plays, source: 'viral', seenAt: now })
        .run()
    const voice = idAt(T + 10)
    const reused = idAt(T + 20)
    const track = idAt(T + 30)
    const quiet = idAt(T + 40)
    db.insert(sounds).values([
      { id: voice, title: 'original sound', author: 'Gate Teacher', original: true, lastSeenAt: now },
      { id: reused, title: 'original sound - gate.beats', author: 'Gate Beats', original: true, lastSeenAt: now },
      { id: track, title: 'Gate Piano', author: 'Gate Band', original: false, lastSeenAt: now },
      { id: quiet, title: 'Gate Quiet', author: 'Nobody', original: false, lastSeenAt: now },
    ]).run()
    // A teacher's voiceover: 4M plays, but only on her own video (made with the sound).
    seen(voice, 'gate.teacher', idAt(T + 9, 3), 4_000_000)
    // A beat: its maker's video plus two other creators, one of them over the floor.
    seen(reused, 'gate.beats', idAt(T + 100_000, 3), 900)
    seen(reused, 'study.one', idAt(T + 200_000, 3), 45_000)
    seen(reused, 'study.two', idAt(T + 300_000, 3), 3_000)
    // A named track on one other creator's video over the floor; another under it.
    seen(track, 'study.one', idAt(T + 400_000, 3), 120_000)
    seen(quiet, 'study.two', idAt(T + 500_000, 3), 900)
    _clearRankingCache()

    const list = async (who: Record<string, string>, q = '') =>
      (await call(app, 'GET', `/api/sounds?limit=200${q}`, who)).json().sounds as { id: string; quality: { pass: boolean; reason: string }; sightings: { reusers: number } }[]
    for (const who of [{ cookie: await sessionFor(kol.id) }, { token: soundsToken }, { cookie: await sessionFor(admin.id) }]) {
      const ids = (await list(who)).map((s) => s.id)
      assert.ok(!ids.includes(voice), 'a voiceover is left out')
      assert.ok(!ids.includes(quiet), 'a track with no evidence is left out')
      assert.ok(ids.includes(reused) && ids.includes(track))
    }
    const shown = await list({ cookie: await sessionFor(kol.id) })
    assert.ok(shown.every((s) => s.quality.pass))
    assert.deepEqual(shown.find((s) => s.id === reused)!.sightings.reusers, 2)
    assert.deepEqual(shown.find((s) => s.id === reused)!.quality, { pass: true, reason: 'plays' })

    const all = await list({ cookie: await sessionFor(admin.id) }, '&hidden=1')
    const verdict = (id: string) => all.find((s) => s.id === id)?.quality
    assert.deepEqual(verdict(voice), { pass: false, reason: 'speech' })
    assert.deepEqual(verdict(quiet), { pass: false, reason: 'no_evidence' })
    assert.deepEqual(verdict(track), { pass: true, reason: 'plays' })
    assert.equal(all.find((s) => s.id === voice)!.sightings.reusers, 0)
    // A kol asking for hidden=1 still gets the gated list.
    assert.ok(!(await list({ cookie: await sessionFor(kol.id) }, '&hidden=1')).some((s) => s.id === voice))
    // rankSounds itself keeps every row unless asked to drop the failing ones.
    assert.ok(rankSounds({ windowDays: 14, limit: 500 }).some((s) => s.id === voice))
    assert.ok(!rankSounds({ windowDays: 14, limit: 500, onlyQualified: true }).some((s) => s.id === voice))
  })

  it('our own posts clearly above the account’s usual let an unsighted original sound through', () => {
    const now = new Date()
    const at = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString()
    const acct = makeUser('gate-acct')
    const loved = idAt(T + 50)
    const meh = idAt(T + 60)
    db.insert(sounds).values([
      { id: loved, title: 'original sound', author: 'Loop Maker', original: true, lastSeenAt: at(1) },
      { id: meh, title: 'original sound', author: 'Meh Maker', original: true, lastSeenAt: at(1) },
    ]).run()
    const pub = (views: number, soundId: string | null) =>
      db.insert(publications)
        .values({ id: randomUUID(), contentId: makeContent({ status: 'PUBLISHED' }), userId: acct.id, platform: 'tiktok', publishedUrl: `https://www.tiktok.com/@a/video/${randomUUID()}`, publishedAt: at(2), views, soundId })
        .run()
    // Account median 100: `loved` posts run 3×, `meh` posts at 1×.
    for (const v of [100, 100, 100, 100]) pub(v, null)
    for (const v of [300, 300, 300]) pub(v, loved)
    for (const v of [100, 100, 100]) pub(v, meh)
    const rows = rankSounds({ windowDays: 14, limit: 500, now, onlyQualified: true })
    assert.deepEqual(rows.find((s) => s.id === loved)?.quality, { pass: true, reason: 'ours' })
    assert.equal(rows.find((s) => s.id === meh), undefined)
  })
})

describe('the public-count sync fills the publication’s sound', () => {
  it('from the TikTok page it reads, and puts the sound in the bank dated by the post', async () => {
    db.update(publications).set({ publishedUrl: null }).run()
    const id = randomUUID()
    const postedAt = new Date(Date.now() - 2 * 86_400_000).toISOString()
    db.insert(publications)
      .values({ id, contentId: makeContent({ status: 'PUBLISHED' }), userId: kol.id, platform: 'tiktok', publishedUrl: `${TRACK_URL}?lang=en`, publishedAt: postedAt })
      .run()
    db.delete(soundSightings).run()
    db.delete(sounds).where(eq(sounds.id, TRACK_ID)).run()
    const result = await syncAllPublicationMetrics()
    assert.equal(result.updated, 1)
    const p = db.select().from(publications).where(eq(publications.id, id)).get()!
    assert.deepEqual([p.soundId, p.soundTitle, p.soundAuthor, p.soundOriginal], [TRACK_ID, 'Lofi Study Loop', 'Example Band', false])
    assert.equal(p.views, 98765, 'tikwm had nothing; the counts come from the same page')
    // Saves: the experiments are judged on save rate.
    assert.equal(p.saves, 210)
    const snap = db.select().from(metricSnapshots).where(eq(metricSnapshots.publicationId, id)).all()
    assert.equal(snap.length, 1)
    assert.deepEqual([snap[0]!.label, snap[0]!.views, snap[0]!.saves], ['auto', 98765, 210])
    const s = db.select().from(sounds).where(eq(sounds.id, TRACK_ID)).get()!
    assert.equal(s.lastSeenAt, postedAt)
    assert.ok(requested.every((u) => TIKTOK_HOSTS.has(new URL(u).hostname) || u.startsWith('https://www.tikwm.com/')))

    // The ranking now counts it as one of ours (1 post: not enough yet).
    const row = rankSounds({ windowDays: 7, limit: 200 }).find((x) => x.id === TRACK_ID)!
    assert.equal(row.ours.posts, 1)
    assert.equal(row.ours.enough, false)

    // A later page without a sound leaves the known sound alone.
    db.update(publications).set({ publishedUrl: NOJSON_URL }).where(eq(publications.id, id)).run()
    await syncAllPublicationMetrics()
    assert.equal(db.select().from(publications).where(eq(publications.id, id)).get()!.soundId, TRACK_ID)
  })
})

describe('review 2: limits, sources, the ranking cache', () => {
  beforeEach(() => _resetDailyCaps())

  it(`a person may paste ${30} links a day; then 429 daily_limit; another person is not affected`, async () => {
    assert.equal(DAILY_PASTES, 30)
    const person = makeUser('cap-person')
    const cookie = await sessionFor(person.id)
    _useDaily(`user:${person.id}`, DAILY_PASTES - 1)
    assert.equal((await call(app, 'POST', '/api/sounds/from-link', { cookie }, { videoUrl: TRACK_URL })).statusCode, 200)
    const over = await call(app, 'POST', '/api/sounds/from-link', { cookie }, { videoUrl: TRACK_URL })
    assert.equal(over.statusCode, 429)
    assert.equal(over.json().reason, 'daily_limit')
    assert.equal((await call(app, 'POST', '/api/sounds/from-link', { cookie: await sessionFor(kol.id) }, { videoUrl: TRACK_URL })).statusCode, 200)
  })

  it(`a sounds token may report ${600} links a day; a call that would go over is refused whole`, async () => {
    assert.equal(DAILY_SIGHTINGS, 600)
    const scout = createApiToken('cap-scout', 'kol', { scope: 'sounds' })
    const row = db.select().from(apiTokens).where(eq(apiTokens.name, 'cap-scout')).get()!
    _useDaily(`token:${row.id}`, DAILY_SIGHTINGS - 10)
    const items = (n: number) => Array.from({ length: n }, () => ({ videoUrl: TRACK_URL, source: 'viral' }))
    const over = await call(app, 'POST', '/api/sounds/sightings', { token: scout }, { items: items(11) })
    assert.equal(over.statusCode, 429)
    assert.equal(over.json().reason, 'daily_limit')
    assert.equal(over.json().remaining, 10)
    assert.equal((await call(app, 'POST', '/api/sounds/sightings', { token: scout }, { items: items(10) })).statusCode, 200)
    assert.equal((await call(app, 'POST', '/api/sounds/sightings', { token: scout }, { items: items(1) })).statusCode, 429)
  })

  it('a person’s paste does not wait behind a scout call whose links hang (one read slot is kept for people)', async () => {
    let release!: () => void
    hold = new Promise<void>((r) => (release = r))
    const scout = call(app, 'POST', '/api/sounds/sightings', { token: soundsToken }, {
      items: Array.from({ length: 8 }, (_, i) => ({ videoUrl: `https://www.tiktok.com/slow?i=${i}`, source: 'viral' })),
    })
    await new Promise((r) => setTimeout(r, 30))
    const started = Date.now()
    const paste = await call(app, 'POST', '/api/sounds/from-link', { cookie: await sessionFor(kol.id) }, { videoUrl: TRACK_URL })
    assert.equal(paste.statusCode, 200)
    assert.ok(Date.now() - started < 1000, 'the paste was answered while the scout call still hangs')
    release()
    assert.equal((await scout).statusCode, 200)
    hold = null
  })

  it('a later manual report keeps a sighting’s trend source, region and rank', async () => {
    await call(app, 'POST', '/api/sounds/sightings', { token: soundsToken }, { items: [{ videoUrl: TRACK_URL, source: 'trend', region: 'vn', rank: 2 }] })
    const paste = await call(app, 'POST', '/api/sounds/from-link', { cookie: await sessionFor(kol.id) }, { videoUrl: TRACK_URL })
    assert.equal(paste.statusCode, 200)
    const row = db.select().from(soundSightings).where(eq(soundSightings.videoUrl, TRACK_URL)).get()!
    assert.deepEqual([row.source, row.region, row.rank], ['trend', 'VN', 2])
    // A new trend or viral report still replaces them.
    await call(app, 'POST', '/api/sounds/sightings', { token: soundsToken }, { items: [{ videoUrl: TRACK_URL, source: 'viral' }] })
    assert.equal(db.select().from(soundSightings).where(eq(soundSightings.videoUrl, TRACK_URL)).get()!.source, 'viral')
  })

  it('the ranking is cached for 60 seconds per window, and cleared when the bank changes', async () => {
    _clearRankingCache()
    const cookie = await sessionFor(kol.id)
    const first = (await call(app, 'GET', '/api/sounds?window=7', { cookie })).json().sounds.length
    // A row written behind the bank's back (no clearing) is not seen until the cache expires…
    // (with a sighting by another creator over the plays floor, so it passes the quality gate).
    db.insert(sounds).values({ id: '955555', title: 'Behind', author: 'X', original: false }).run()
    db.insert(soundSightings)
      .values({ id: randomUUID(), soundId: '955555', videoUrl: 'https://www.tiktok.com/@behind.user/video/1', videoAuthor: 'behind.user', plays: 50_000, source: 'viral', seenAt: new Date().toISOString() })
      .run()
    assert.equal((await call(app, 'GET', '/api/sounds?window=7', { cookie })).json().sounds.length, first)
    assert.ok(!rankSoundsCached({ windowDays: 7, limit: 200 }).some((x) => x.id === '955555'), 'cached')
    const later = rankSoundsCached({ windowDays: 7, limit: 200 }, Date.now() + 61_000)
    assert.ok(later.some((x) => x.id === '955555'), 'after 60 s it is recomputed')
    assert.ok(rankSounds({ windowDays: 7, limit: 200 }).some((x) => x.id === '955555'), 'rankSounds itself is never cached')
    // …while a change through the bank clears it at once.
    await call(app, 'PATCH', '/api/admin/sounds/955555', { cookie: await sessionFor(admin.id) }, { note: 'n' })
    assert.ok((await call(app, 'GET', '/api/sounds?window=7', { cookie })).json().sounds.some((x: { id: string }) => x.id === '955555'))
  })
})

describe('when TikTok serves the server an empty page, the sighting is read through tikwm', () => {
  const SHELL_URL = `${SHELL_PREFIX}.one/video/7678256298554690836`
  const TIKWM_SOUND = '7600000000000000301'
  const tikwmData = (over: Record<string, unknown> = {}) => ({
    code: 0,
    msg: 'success',
    data: {
      id: '7678256298554690836',
      author: { unique_id: 'moni.pte', nickname: 'Moni' },
      create_time: 1731456000,
      play_count: 12345,
      digg_count: 678,
      comment_count: 9,
      share_count: 10,
      collect_count: 321,
      music_info: { id: TIKWM_SOUND, title: 'Tikwm Track', author: 'Tikwm Band', original: false },
      ...over,
    },
  })
  const tikwmAsked = () => requested.filter((u) => u.startsWith('https://www.tikwm.com/'))

  beforeEach(() => {
    _resetDailyCaps()
    tikwmAnswers.clear()
  })

  it('a shell page and a tikwm answer with a sound: recorded with tikwm’s author, id and counts', async () => {
    tikwmAnswers.set(SHELL_URL, tikwmData())
    const res = await call(app, 'POST', '/api/sounds/sightings', { token: soundsToken }, { items: [{ videoUrl: `${SHELL_URL}?is_from_webapp=1&_r=1`, source: 'trend', region: 'sg', rank: 4 }] })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json().results[0], { videoUrl: `${SHELL_URL}?is_from_webapp=1&_r=1`, status: 'recorded', soundId: TIKWM_SOUND })
    // tikwm was asked about the link without its query string.
    assert.deepEqual(tikwmAsked(), [`https://www.tikwm.com/api/?url=${encodeURIComponent(SHELL_URL)}`])
    const row = db.select().from(soundSightings).where(eq(soundSightings.soundId, TIKWM_SOUND)).get()!
    assert.equal(row.videoUrl, 'https://www.tiktok.com/@moni.pte/video/7678256298554690836', 'the canonical URL from tikwm’s author and id')
    assert.deepEqual(
      [row.videoAuthor, row.plays, row.likes, row.saves, row.postedAt, row.source, row.region, row.rank],
      ['moni.pte', 12345, 678, 321, '2024-11-13T00:00:00.000Z', 'trend', 'SG', 4],
    )
    const sound = db.select().from(sounds).where(eq(sounds.id, TIKWM_SOUND)).get()!
    assert.deepEqual([sound.title, sound.author, sound.original], ['Tikwm Track', 'Tikwm Band', false])
  })

  it('tikwm with nothing (code ≠ 0, or no sound, or no video id): the page path’s reason stands', async () => {
    tikwmAnswers.set(`${SHELL_PREFIX}.nosound/video/7678256298554690837`, tikwmData({ music_info: null }))
    tikwmAnswers.set(`${SHELL_PREFIX}.noid/video/7678256298554690838`, tikwmData({ id: 'abc' }))
    const res = await call(app, 'POST', '/api/sounds/sightings', { token: soundsToken }, {
      items: [
        { videoUrl: `${SHELL_PREFIX}.two/video/7678256298554690839`, source: 'viral' },
        { videoUrl: `${SHELL_PREFIX}.nosound/video/7678256298554690837`, source: 'viral' },
        { videoUrl: `${SHELL_PREFIX}.noid/video/7678256298554690838`, source: 'viral' },
        { videoUrl: 'https://www.tiktok.com/@gone/video/2', source: 'viral' },
        { videoUrl: 'https://www.tiktok.com/upstream-error', source: 'viral' },
      ],
    })
    assert.deepEqual(
      res.json().results.map((x: { status: string; reason?: string }) => [x.status, x.reason ?? null]),
      [
        ['unreadable', 'no_sound'],
        ['unreadable', 'no_sound'],
        ['unreadable', 'no_sound'],
        ['unreadable', 'not_found'],
        ['unreadable', 'unreachable'],
      ],
    )
    assert.equal(tikwmAsked().length, 5, 'every failed page read asked tikwm once')
    const paste = await call(app, 'POST', '/api/sounds/from-link', { cookie: await sessionFor(kol.id) }, { videoUrl: `${SHELL_PREFIX}.two/video/7678256298554690839` })
    assert.equal(paste.statusCode, 422)
    assert.equal(paste.json().reason, 'no_sound')
  })

  it('a page that reads fine never asks tikwm', async () => {
    tikwmAnswers.set(TRACK_URL, tikwmData())
    const res = await call(app, 'POST', '/api/sounds/sightings', { token: soundsToken }, { items: [{ videoUrl: TRACK_URL, source: 'viral' }, { videoUrl: SHORT_URL, source: 'viral' }] })
    assert.deepEqual(res.json().results.map((x: { soundId: string }) => x.soundId), [TRACK_ID, ORIGINAL_ID])
    assert.deepEqual(tikwmAsked(), [])
  })

  it('a pasted link read through tikwm gives the sound with its copy text', async () => {
    const url = `${SHELL_PREFIX}.paste/video/7678256298554690840`
    tikwmAnswers.set(url, tikwmData({ id: '7678256298554690840', music_info: { id: '7600000000000000302', title: 'original sound - Moni', author: 'Moni', original: true } }))
    const res = await call(app, 'POST', '/api/sounds/from-link', { cookie: await sessionFor(kol.id) }, { videoUrl: url })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().status, 'recorded')
    assert.equal(res.json().sound.copyText, 'original sound Moni')
    const row = db.select().from(soundSightings).where(eq(soundSightings.soundId, '7600000000000000302')).get()!
    assert.deepEqual([row.videoUrl, row.source], ['https://www.tiktok.com/@moni.pte/video/7678256298554690840', 'manual'])
  })

  it('one of our own posts read through tikwm is "known", nothing recorded', async () => {
    const ownId = '7678256298554690850'
    db.insert(publications)
      .values({ id: randomUUID(), contentId: makeContent({ status: 'PUBLISHED' }), userId: kol.id, platform: 'tiktok', publishedUrl: `https://www.tiktok.com/@ours/video/${ownId}` })
      .run()
    const url = `${SHELL_PREFIX}.own/video/${ownId}`
    tikwmAnswers.set(url, tikwmData({ id: ownId }))
    const before = db.select().from(soundSightings).all().length
    const res = await call(app, 'POST', '/api/sounds/sightings', { token: soundsToken }, { items: [{ videoUrl: url, source: 'viral' }] })
    assert.deepEqual(res.json().results[0], { videoUrl: url, status: 'known', soundId: TIKWM_SOUND })
    const asAdmin = await call(app, 'POST', '/api/sounds/sightings', { token: adminToken }, { items: [{ videoUrl: url, source: 'viral' }] })
    assert.equal(asAdmin.json().results[0].reason, 'our_post')
    assert.equal(db.select().from(soundSightings).all().length, before)
  })
})
