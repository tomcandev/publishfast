/**
 * The media prune (contract section 14): only PUBLISHED items whose newest
 * publication is older than the cutoff lose their files; rows, publications
 * and snapshots stay; pruned downloads answer 410; the dry run deletes
 * nothing and selects exactly what the real run deletes; a run is idempotent;
 * a concurrent change between selection and marking wins. Plus the review's
 * findings: shared files, re-opening a pruned item, the zip beside fresh
 * media, strict times and the server-written time, freshly attached files,
 * the dry run's leftovers and read-only database, and a wrong clock.
 */
import './env.js'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { after, before, describe, it } from 'node:test'
import Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { eq, isNotNull } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db, sqlite } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { assets, contents, files, metricSnapshots, publications } from '../db/schema.js'
import { createApiToken } from '../lib/auth.js'
import { config, parsePruneDays } from '../lib/config.js'
import { PRUNE_FIRST_DELAY_MS, PRUNE_INTERVAL_MS, pruneIfDue, pruneMedia, selectPrunable, strictTime } from '../lib/prune.js'
import { releaseDueDrafts } from '../lib/releaseScheduler.js'
import { call, makeContent, makeUser, sessionFor } from './helpers.js'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const serverDir = join(here, '..', '..')

// The real clock, not a fixed date: rows the helpers write without a time get the real "now", and a fixed
// NOW that falls behind it reads as a clock that went backwards (the tests broke the day after they were written).
const NOW = new Date()
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
const PLATFORMS = ['tiktok', 'instagram', 'facebook', 'youtube'] as const
/** Rows are written by the server long before NOW, unless a test says otherwise. */
const OLD = daysAgo(20)

let app: FastifyInstance
let kol: ReturnType<typeof makeUser>

type Pub = { publishedAt?: string | null; createdAt?: string }

/** An item with real files on disk under uploads/ and the given publications. */
function item(
  status: (typeof contents.status.enumValues)[number],
  pubs: Pub[],
  nFiles = 1,
  size = 1000,
  opts: { assetCreatedAt?: string; diskSize?: number } = {},
) {
  const contentId = makeContent({ status, claimedBy: kol.id })
  const stored: string[] = []
  for (let i = 0; i < nFiles; i++) {
    const filePath = `${randomUUID()}.mp4`
    writeFileSync(join(config.uploadsDir, filePath), Buffer.alloc(opts.diskSize ?? size, 1))
    db.insert(assets)
      .values({
        id: randomUUID(),
        contentId,
        filePath,
        originalName: `clip-${i}.mp4`,
        mime: 'video/mp4',
        size,
        type: 'video',
        sortOrder: i,
        createdAt: opts.assetCreatedAt ?? OLD,
      })
      .run()
    stored.push(filePath)
  }
  pubs.forEach((p, i) => {
    const id = randomUUID()
    db.insert(publications)
      .values({
        id,
        contentId,
        userId: kol.id,
        platform: PLATFORMS[i]!,
        publishedUrl: `https://example.test/p/${id}`,
        publishedAt: p.publishedAt === undefined ? daysAgo(10) : p.publishedAt,
        createdAt: p.createdAt ?? OLD,
      })
      .run()
    db.insert(metricSnapshots).values({ id: randomUUID(), publicationId: id, takenAt: daysAgo(9), label: '24h', views: 10 }).run()
  })
  return { contentId, stored }
}

const onDisk = () => readdirSync(config.uploadsDir).sort()
const isPruned = (contentId: string) => db.select().from(assets).where(eq(assets.contentId, contentId)).all().every((a) => a.prunedAt)

before(async () => {
  migrate()
  app = await buildApp({ logger: false })
  kol = makeUser('pruner')
})

after(async () => {
  await app.close()
  sqlite.close()
})

describe('PRUNE_PUBLISHED_AFTER_DAYS', () => {
  it('is a whole number of days; anything else means never', () => {
    assert.equal(parsePruneDays('3'), 3)
    assert.equal(parsePruneDays('1'), 1, '1 is one day, not "on"')
    assert.equal(parsePruneDays(' 7 '), 7)
    for (const off of [undefined, '', '0', '-1', '1.5', '3d', 'three', 'true', '99999']) assert.equal(parsePruneDays(off), 0, String(off))
    assert.equal(config.prunePublishedAfterDays, 0, 'off by default')
  })
})

describe('the times the prune trusts', () => {
  it('strict ISO with a zone only; no lenient parsing', () => {
    assert.equal(strictTime('2026-11-11T10:00:00Z'), Date.parse('2026-11-11T10:00:00Z'))
    assert.equal(strictTime('2026-11-11T10:00:00.123+08:00'), Date.parse('2026-11-11T10:00:00.123+08:00'))
    for (const bad of [
      '2026-11-11T10:00:00', // no zone: would be read in the server's zone
      '2026-11-11', '2026-11-11 10:00:00', '1', '2026', '12345', '1794398400', 'Thu, 12 Nov 2026 10:00:00 GMT',
      '2026-11-12t10:00:00z', '2026-02-30T10:00:00Z', '2026-11-01T24:00:00Z', '+275761-01-01T00:00:00Z', '', ' ', null, 42,
    ]) {
      assert.equal(strictTime(bad), null, JSON.stringify(bad))
    }
  })
})

describe('the prune on a mix of statuses and ages', () => {
  const k: Record<string, { contentId: string; stored: string[] }> = {}
  let initial: string[] = []
  let dropBoxFile = ''

  before(() => {
    k.oldPublished = item('PUBLISHED', [{}], 2) // goes
    k.recent = item('PUBLISHED', [{ publishedAt: daysAgo(2) }])
    k.newestRecent = item('PUBLISHED', [{}, { publishedAt: daysAgo(1) }]) // the newest publication counts
    k.reopenedReady = item('READY', [{}]) // an admin moved it back
    k.claimed = item('CLAIMED', [{}])
    k.draft = item('DRAFT', [])
    k.failed = item('FAILED', [{}])
    k.noPublication = item('PUBLISHED', [])
    k.createdOnly = item('PUBLISHED', [{ publishedAt: null, createdAt: daysAgo(10) }]) // goes (created_at)
    k.recordedLater = item('PUBLISHED', [{ publishedAt: daysAgo(10), createdAt: daysAgo(1) }]) // the later time counts: stays
    k.yearOne = item('PUBLISHED', [{ publishedAt: '0001-01-01T00:00:00Z', createdAt: daysAgo(1) }]) // a poster's back-dating: stays
    k.scheduled = item('PUBLISHED', [{ publishedAt: daysAgo(-5), createdAt: daysAgo(10) }]) // public in 5 days
    k.unreadable = item('PUBLISHED', [{ publishedAt: 'sometime last week' }])
    k.noZone = item('PUBLISHED', [{ publishedAt: '2026-11-01T10:00:00' }])
    k.dateOnly = item('PUBLISHED', [{ publishedAt: '2026-11-01' }])
    k.boundary = item('PUBLISHED', [{ publishedAt: daysAgo(3) }]) // exactly 3 days: not older
    k.freshFile = item('PUBLISHED', [{}], 1, 1000, { assetCreatedAt: daysAgo(1) }) // a file attached yesterday
    // A drop-box file: has its own expiry, never the prune's.
    dropBoxFile = join(config.filesDir, `${randomUUID()}.bin`)
    writeFileSync(dropBoxFile, 'drop box')
    db.insert(files)
      .values({ id: randomUUID(), key: 'nhi/voice/x.zip', storedPath: dropBoxFile.split('/').pop()!, size: 8, sha256: 'x', mime: 'application/zip', expiresAt: daysAgo(-1) })
      .run()
    initial = onDisk()
  })

  const goes = () => [...k.oldPublished!.stored, ...k.createdOnly!.stored]

  it('the dry run selects exactly the expected files and deletes nothing', async () => {
    const report = await pruneMedia({ days: 3, now: NOW, dryRun: true })
    assert.equal(report.dryRun, true)
    assert.equal(report.files, 3)
    assert.equal(report.bytes, 3000)
    assert.equal(report.items, 2)
    assert.equal(report.skippedUnreadable, 3, 'free text, no zone, date only')
    assert.equal(report.skippedYoung, 1)
    assert.deepEqual(report.leftovers, { files: 0, bytes: 0 })
    assert.equal(report.marked, undefined)
    assert.deepEqual(onDisk(), initial, 'no file was deleted')
    assert.equal(db.select().from(assets).where(isNotNull(assets.prunedAt)).all().length, 0, 'no row was marked')
    const selected = selectPrunable(3, NOW).assets.map((a) => a.filePath).sort()
    assert.deepEqual(selected, goes().sort())
  })

  it('the real run deletes exactly those files; every other file survives', async () => {
    const report = await pruneMedia({ days: 3, now: NOW })
    assert.equal(report.marked, 3)
    assert.equal(report.deleted, 3)
    assert.equal(report.bytesFreed, 3000)
    assert.equal(report.diskBytesFreed, 3000)
    assert.equal(report.alreadyMissing, 0)
    assert.equal(report.failed, 0)
    assert.equal(report.changed, 0)
    const expected = initial.filter((f) => !goes().includes(f)).sort()
    assert.deepEqual(onDisk(), expected)
    assert.ok(existsSync(dropBoxFile), 'the drop box is never touched')
  })

  it('rows, sizes, publications and snapshots survive; pruned rows carry pruned_at', () => {
    const rows = db.select().from(assets).where(eq(assets.contentId, k.oldPublished!.contentId)).all()
    assert.equal(rows.length, 2)
    assert.ok(rows.every((r) => r.prunedAt === NOW.toISOString() && r.size === 1000))
    const pubs = db.select().from(publications).where(eq(publications.contentId, k.oldPublished!.contentId)).all()
    assert.equal(pubs.length, 1)
    assert.equal(db.select().from(metricSnapshots).where(eq(metricSnapshots.publicationId, pubs[0]!.id)).all().length, 1)
    assert.equal(db.select().from(contents).where(eq(contents.id, k.oldPublished!.contentId)).get()!.status, 'PUBLISHED')
    assert.equal(db.select().from(assets).where(eq(assets.contentId, k.reopenedReady!.contentId)).get()!.prunedAt, null)
  })

  it('is idempotent', async () => {
    const again = await pruneMedia({ days: 3, now: NOW })
    assert.deepEqual([again.files, again.marked, again.deleted, again.leftovers.files], [0, 0, 0, 0])
    assert.deepEqual(onDisk(), initial.filter((f) => !goes().includes(f)).sort())
  })

  it('downloads and the zip of a pruned item answer 410; the item still shows its media rows', async () => {
    const cookie = await sessionFor(kol.id)
    const admin = await sessionFor(makeUser('prune-admin', 'admin').id)
    const prunedAsset = db.select().from(assets).where(eq(assets.contentId, k.oldPublished!.contentId)).get()!
    for (const who of [{ cookie }, { cookie: admin }]) {
      for (const url of [`/api/assets/${prunedAsset.id}`, `/api/assets/${prunedAsset.id}/download`, `/api/contents/${k.oldPublished!.contentId}/assets.zip`]) {
        const res = await call(app, 'GET', url, who)
        assert.equal(res.statusCode, 410, url)
        assert.equal(res.json().reason, 'pruned')
        assert.equal(res.json().prunedAt, NOW.toISOString())
      }
    }
    const stranger = await sessionFor(makeUser('prune-stranger').id)
    assert.equal((await call(app, 'GET', `/api/assets/${prunedAsset.id}`, { cookie: stranger })).statusCode, 404)
    const live = db.select().from(assets).where(eq(assets.contentId, k.recent!.contentId)).get()!
    assert.equal((await call(app, 'GET', `/api/assets/${live.id}/download`, { cookie })).statusCode, 200)
    const res = await call(app, 'GET', `/api/contents/${k.oldPublished!.contentId}`, { cookie: admin })
    assert.equal(res.json().content.assets.length, 2)
    assert.equal(res.json().content.assets[0].prunedAt, NOW.toISOString())
    assert.equal(res.json().content.assets[0].filePath, undefined)
  })
})

describe('two asset rows naming one file (finding 1)', () => {
  it('a file another row names is never selected, marked or deleted', async () => {
    const old = item('PUBLISHED', [{}])
    const ready = makeContent({ status: 'READY' })
    db.insert(assets)
      .values({ id: randomUUID(), contentId: ready, filePath: old.stored[0]!, originalName: 'same.mp4', mime: 'video/mp4', size: 1000, type: 'video', createdAt: OLD })
      .run()
    const dry = await pruneMedia({ days: 3, now: NOW, dryRun: true })
    assert.ok(dry.skippedShared >= 1)
    assert.ok(!selectPrunable(3, NOW).assets.some((a) => a.contentId === old.contentId))
    await pruneMedia({ days: 3, now: NOW })
    assert.ok(existsSync(join(config.uploadsDir, old.stored[0]!)), 'the READY item keeps its file')
    assert.ok(!isPruned(old.contentId))
  })

  it('the delete never runs while an unpruned row names the path (a row added after the mark)', async () => {
    const old = item('PUBLISHED', [{}])
    const other = makeContent({ status: 'READY' })
    const report = await pruneMedia({
      days: 3,
      now: NOW,
      _afterMark: () => {
        db.insert(assets)
          .values({ id: randomUUID(), contentId: other, filePath: old.stored[0]!, originalName: 'late.mp4', mime: 'video/mp4', size: 1000, type: 'video', createdAt: OLD })
          .run()
      },
    })
    assert.equal(report.keptShared, 1)
    assert.ok(existsSync(join(config.uploadsDir, old.stored[0]!)))
    assert.ok(isPruned(old.contentId), 'its own row is marked')
  })
})

describe('a pruned item cannot go back to the queue (finding 2)', () => {
  let admin: string
  let adminToken: string
  before(async () => {
    admin = await sessionFor(makeUser('reopen-admin', 'admin').id)
    adminToken = createApiToken('reopen-legacy')
  })

  it('admin PATCH, bulk-status and the admin-token ingest PATCH answer 409 media_pruned; nothing changes', async () => {
    const p = item('PUBLISHED', [{}])
    const other = makeContent({ status: 'PUBLISHED' })
    await pruneMedia({ days: 3, now: NOW })
    assert.ok(isPruned(p.contentId))
    for (const status of ['READY', 'CLAIMED']) {
      const res = await call(app, 'PATCH', `/api/admin/contents/${p.contentId}`, { cookie: admin }, { status })
      assert.equal(res.statusCode, 409, status)
      assert.equal(res.json().reason, 'media_pruned')
    }
    const bulk = await call(app, 'POST', '/api/admin/contents/bulk-status', { cookie: admin }, { ids: [other, p.contentId], status: 'READY' })
    assert.equal(bulk.statusCode, 409)
    assert.deepEqual(bulk.json().ids, [p.contentId])
    assert.equal(db.select().from(contents).where(eq(contents.id, other)).get()!.status, 'PUBLISHED', 'nothing was written')
    const ingest = await call(app, 'PATCH', `/api/ingest/contents/${p.contentId}`, { token: adminToken }, { status: 'READY' })
    assert.equal(ingest.statusCode, 409)
    assert.equal(ingest.json().reason, 'media_pruned')
    assert.equal(db.select().from(contents).where(eq(contents.id, p.contentId)).get()!.status, 'PUBLISHED')
    // Other edits and other statuses still work.
    assert.equal((await call(app, 'PATCH', `/api/admin/contents/${p.contentId}`, { cookie: admin }, { title: 'kept' })).statusCode, 200)
    assert.equal((await call(app, 'PATCH', `/api/admin/contents/${p.contentId}`, { cookie: admin }, { status: 'FAILED' })).statusCode, 200)
    assert.equal((await call(app, 'POST', '/api/admin/contents/bulk-status', { cookie: admin }, { ids: [other], status: 'READY' })).statusCode, 200)
  })

  it('a re-open that lands between the mark and the delete is refused', async () => {
    const p = item('PUBLISHED', [{}])
    let answer = 0
    await pruneMedia({
      days: 3,
      now: NOW,
      _afterMark: async () => {
        answer = (await call(app, 'PATCH', `/api/admin/contents/${p.contentId}`, { cookie: admin }, { status: 'READY' })).statusCode
      },
    })
    assert.equal(answer, 409)
    assert.equal(db.select().from(contents).where(eq(contents.id, p.contentId)).get()!.status, 'PUBLISHED')
    assert.ok(!existsSync(join(config.uploadsDir, p.stored[0]!)))
  })

  it('a scoped ingest token cannot set its own pruned draft to READY (409 media_pruned)', async () => {
    const maker = createApiToken('reopen-maker', 'kol', { scope: 'ingest' })
    const made = await call(app, 'POST', '/api/ingest/contents', { token: maker }, { code: 'PRUNED-DRAFT-1' })
    assert.equal(made.statusCode, 201)
    const id = made.json().content.id
    db.insert(assets)
      .values({ id: randomUUID(), contentId: id, filePath: `${randomUUID()}.mp4`, originalName: 'gone.mp4', mime: 'video/mp4', size: 1, type: 'video', createdAt: OLD, prunedAt: daysAgo(1) })
      .run()
    const res = await call(app, 'PATCH', `/api/ingest/contents/${id}`, { token: maker }, { status: 'READY' })
    assert.equal(res.statusCode, 409)
    assert.equal(res.json().reason, 'media_pruned')
    assert.equal(db.select().from(contents).where(eq(contents.id, id)).get()!.status, 'DRAFT')
    // Other edits to its own draft still work.
    assert.equal((await call(app, 'PATCH', `/api/ingest/contents/${id}`, { token: maker }, { title: 'still a draft' })).statusCode, 200)
  })

  it('second line of defence: a pruned item forced to READY is never listed or handed out', async () => {
    const p = item('PUBLISHED', [{}])
    await pruneMedia({ days: 3, now: NOW })
    db.update(contents).set({ status: 'READY', claimedBy: null, assignedUserId: null }).where(eq(contents.id, p.contentId)).run()
    const person = makeUser('reopen-person')
    const cookie = await sessionFor(person.id)
    const list = await call(app, 'GET', '/api/contents', { cookie })
    assert.ok(!list.json().contents.some((c: { id: string }) => c.id === p.contentId))
    const claim = await call(app, 'POST', `/api/contents/${p.contentId}/claim`, { cookie })
    assert.notEqual(claim.statusCode, 200)
    const next = await call(app, 'POST', '/api/contents/claim-next', { cookie })
    assert.notEqual(next.json().content?.id, p.contentId)
    if (next.statusCode === 200) await call(app, 'POST', `/api/contents/${next.json().content.id}/release`, { cookie })
    // A pruned draft with a due release_at stays a draft.
    db.update(contents).set({ status: 'DRAFT', releaseAt: daysAgo(1) }).where(eq(contents.id, p.contentId)).run()
    releaseDueDrafts()
    assert.equal(db.select().from(contents).where(eq(contents.id, p.contentId)).get()!.status, 'DRAFT')
    db.update(contents).set({ status: 'PUBLISHED', releaseAt: null }).where(eq(contents.id, p.contentId)).run()
  })
})

describe('the zip beside fresh media (finding 3)', () => {
  it('zips only the files that still exist; 410 only when none does', async () => {
    const p = item('PUBLISHED', [{}], 2)
    await pruneMedia({ days: 3, now: NOW })
    const fresh = `${randomUUID()}.jpg`
    writeFileSync(join(config.uploadsDir, fresh), Buffer.alloc(500, 66))
    db.insert(assets)
      .values({ id: randomUUID(), contentId: p.contentId, filePath: fresh, originalName: 'new-1.jpg', mime: 'image/jpeg', size: 500, type: 'image', sortOrder: 5, createdAt: daysAgo(1) })
      .run()
    const admin = await sessionFor(makeUser('zip-admin', 'admin').id)
    const code = db.select().from(contents).where(eq(contents.id, p.contentId)).get()!.code
    const res = await call(app, 'GET', `/api/contents/${p.contentId}/assets.zip`, { cookie: admin })
    assert.equal(res.statusCode, 200)
    assert.ok(res.rawPayload.includes(Buffer.from(`${code}-01.jpg`)))
    assert.ok(!res.rawPayload.includes(Buffer.from(`${code}-02`)), 'only the live file')
  })
})

describe('freshly attached files and the clock (findings 4 and 6)', () => {
  it('a file attached to an old PUBLISHED item less than `days` ago stays', async () => {
    const p = item('PUBLISHED', [{}], 1, 1000, { assetCreatedAt: daysAgo(1) })
    const report = await pruneMedia({ days: 3, now: NOW })
    assert.ok(report.skippedYoung >= 1)
    assert.ok(existsSync(join(config.uploadsDir, p.stored[0]!)))
  })

  it('refuses to run (deletes nothing) when a publication was recorded more than 24 h ahead of the clock', async () => {
    const p = item('PUBLISHED', [{}])
    const ahead = item('PUBLISHED', [{ createdAt: new Date(NOW.getTime() + 2 * 86_400_000).toISOString() }])
    const report = await pruneMedia({ days: 3, now: NOW })
    assert.match(report.refused!, /more than 24 hours after this server's clock/)
    assert.equal(report.marked, undefined)
    assert.ok(existsSync(join(config.uploadsDir, p.stored[0]!)))
    assert.match((await pruneMedia({ days: 3, now: NOW, dryRun: true })).refused!, /24 hours/)
    db.delete(contents).where(eq(contents.id, ahead.contentId)).run()
  })

  it('refuses to run when the clock is before the newest file’s upload time (a reset clock)', async () => {
    const p = item('PUBLISHED', [{}])
    const later = item('PUBLISHED', [{}], 1, 1000, { assetCreatedAt: new Date(NOW.getTime() + 3_600_000).toISOString() })
    const report = await pruneMedia({ days: 3, now: NOW })
    assert.match(report.refused!, /before the newest file/)
    assert.ok(existsSync(join(config.uploadsDir, p.stored[0]!)))
    db.delete(contents).where(eq(contents.id, later.contentId)).run()
    assert.equal((await pruneMedia({ days: 3, now: NOW })).refused, undefined)
  })

  it('reports the bytes really freed on disk beside the database sizes', async () => {
    item('PUBLISHED', [{}], 1, 5000, { diskSize: 1234 })
    const report = await pruneMedia({ days: 3, now: NOW })
    assert.equal(report.bytesFreed, 5000)
    assert.equal(report.diskBytesFreed, 1234)
  })
})

describe('a clock that jumped forward, or a quiet server (review 3)', () => {
  it('+4 days with fresh rows: refused, nothing deleted; the dry run says it too', async () => {
    const realAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString()
    const p = item('PUBLISHED', [{ publishedAt: realAgo(1), createdAt: realAgo(1) }], 1, 1000, { assetCreatedAt: realAgo(1) })
    const jumped = new Date(Date.now() + 4 * 86_400_000)
    const report = await pruneMedia({ days: 3, now: jumped })
    assert.match(report.refused!, /more than 3 day\(s\) before this server's clock/)
    assert.match(report.refused!, /--trust-clock/)
    assert.equal(report.marked, undefined)
    assert.ok(existsSync(join(config.uploadsDir, p.stored[0]!)))
    assert.match((await pruneMedia({ days: 3, now: jumped, dryRun: true })).refused!, /before this server's clock/)
    // Within the limit it runs (and would take that file once it is old enough by its own times).
    assert.equal((await pruneMedia({ days: 3, now: new Date(Date.now() + 2 * 86_400_000), dryRun: true })).refused, undefined)
  })

})

describe('change between selection and marking, crashes', () => {
  it('an item re-opened, or given a new publication, after selection keeps its files', async () => {
    const reopened = item('PUBLISHED', [{}])
    const repost = item('PUBLISHED', [{}])
    const report = await pruneMedia({
      days: 3,
      now: NOW,
      _afterSelect: () => {
        db.update(contents).set({ status: 'READY' }).where(eq(contents.id, reopened.contentId)).run()
        db.insert(publications)
          .values({ id: randomUUID(), contentId: repost.contentId, userId: kol.id, platform: 'instagram', publishedUrl: 'https://example.test/new', publishedAt: NOW.toISOString(), createdAt: NOW.toISOString() })
          .run()
      },
    })
    assert.equal(report.changed, 2)
    for (const f of [...reopened.stored, ...repost.stored]) assert.ok(existsSync(join(config.uploadsDir, f)), f)
    db.update(contents).set({ status: 'FAILED' }).where(eq(contents.id, reopened.contentId)).run()
  })

  it('a leftover of a run that died before deleting: the dry run shows it, the next run deletes it', async () => {
    const it1 = item('PUBLISHED', [{}], 1, 1000, { diskSize: 777 })
    db.update(assets).set({ prunedAt: daysAgo(1) }).where(eq(assets.contentId, it1.contentId)).run()
    const dry = await pruneMedia({ days: 3, now: NOW, dryRun: true })
    assert.deepEqual(dry.leftovers, { files: 1, bytes: 777 })
    assert.ok(existsSync(join(config.uploadsDir, it1.stored[0]!)))
    const report = await pruneMedia({ days: 3, now: NOW })
    assert.deepEqual(report.leftovers, { files: 1, bytes: 777 })
    assert.ok(!existsSync(join(config.uploadsDir, it1.stored[0]!)))
  })

  it('a file already gone is not an error: the row is marked and counted as missing', async () => {
    const it2 = item('PUBLISHED', [{}])
    unlinkSync(join(config.uploadsDir, it2.stored[0]!))
    const report = await pruneMedia({ days: 3, now: NOW })
    assert.equal(report.alreadyMissing, 1)
    assert.equal(report.failed, 0)
    assert.ok(isPruned(it2.contentId))
  })

  it('a stored name that would leave uploads/ is marked but never followed', async () => {
    const outside = join(config.dataDir, 'outside.txt')
    writeFileSync(outside, 'keep me')
    const contentId = makeContent({ status: 'PUBLISHED' })
    db.insert(assets)
      .values({ id: randomUUID(), contentId, filePath: '../outside.txt', originalName: 'x.mp4', mime: 'video/mp4', size: 7, type: 'video', createdAt: OLD })
      .run()
    db.insert(publications)
      .values({ id: randomUUID(), contentId, userId: kol.id, platform: 'tiktok', publishedUrl: 'https://example.test/o', publishedAt: daysAgo(10), createdAt: OLD })
      .run()
    const report = await pruneMedia({ days: 3, now: NOW })
    assert.equal(report.failed, 1)
    assert.ok(existsSync(outside))
  })
})

describe('scheduled runs', () => {
  it('off when the setting is 0; first run one hour after start; then once a day', async () => {
    const start = Date.now()
    assert.equal(await pruneIfDue(start + 2 * PRUNE_FIRST_DELAY_MS, 0), null, 'off')
    assert.equal(await pruneIfDue(start, 3), null, 'not in the first hour')
    const first = await pruneIfDue(start + PRUNE_FIRST_DELAY_MS + 1000, 3)
    assert.ok(first && first.dryRun === false)
    assert.equal(await pruneIfDue(start + PRUNE_FIRST_DELAY_MS + 2000, 3), null, 'not twice a day')
    assert.ok(await pruneIfDue(start + PRUNE_FIRST_DELAY_MS + PRUNE_INTERVAL_MS + 1000, 3))
  })

  it('the scheduled run refuses on a quiet database (newest row 10 days old) and logs it at most once a day', async () => {
    const tenDaysOn = Date.now() + 10 * 86_400_000
    const first = await pruneIfDue(tenDaysOn, 3)
    assert.ok(first?.refused, 'refused')
    assert.match(first!.refused!, /nothing was created/)
    assert.equal(await pruneIfDue(tenDaysOn + 3_600_000, 3), null, 'not again within the day')
  })
})

describe('GET /api/admin/storage', () => {
  it('admins see bytes by status, pruned bytes, drop box, unfinished uploads and free disk; nobody else', async () => {
    const admin = await sessionFor(makeUser('storage-admin', 'admin').id)
    const res = await call(app, 'GET', '/api/admin/storage', { cookie: admin })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.ok(body.byStatus.some((r: { status: string; files: number }) => r.status === 'PUBLISHED' && r.files > 0))
    assert.ok(body.pruned.files >= 3)
    assert.deepEqual(body.dropBox, { files: 1, bytes: 8 })
    assert.deepEqual(body.unfinishedUploads, { uploads: 0, bytes: 0 })
    assert.ok(body.disk.freeBytes >= 0 && body.disk.totalBytes > 0)
    assert.deepEqual(body.prune, { afterDays: null })
    assert.ok(!res.body.includes('.mp4'), 'no file names or paths')
    assert.equal((await call(app, 'GET', '/api/admin/storage', { cookie: await sessionFor(kol.id) })).statusCode, 403)
    assert.equal((await call(app, 'GET', '/api/admin/storage', { token: createApiToken('st-read', 'kol', { scope: 'read' }) })).statusCode, 403)
    assert.equal((await call(app, 'GET', '/api/admin/storage', { token: createApiToken('st-admin') })).statusCode, 200)
    assert.equal((await call(app, 'GET', '/api/admin/storage')).statusCode, 401)
  })
})

describe('the prune script', () => {
  async function prune(args: string[], env: Record<string, string> = {}) {
    try {
      const { stdout, stderr } = await run(process.execPath, ['--import', 'tsx', 'src/scripts/prune.ts', ...args], {
        cwd: serverDir,
        env: { ...process.env, ...env },
      })
      return { code: 0, stdout, stderr }
    } catch (e) {
      const x = e as { code: number; stdout: string; stderr: string }
      return { code: x.code, stdout: x.stdout, stderr: x.stderr }
    }
  }

  it('refuses without --days, or without exactly one of --dry-run and --yes', async () => {
    for (const args of [['--dry-run'], ['--days', '0', '--dry-run'], ['--days', '3'], ['--days', '3', '--dry-run', '--yes']]) {
      const res = await prune(args)
      assert.equal(res.code, 1, args.join(' '))
      assert.equal(res.stdout, '')
    }
  })

  it('--dry-run reads only, prints the count, bytes, leftovers and largest files; --yes deletes them', async () => {
    const realAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString()
    const big = item('PUBLISHED', [{ publishedAt: realAgo(10), createdAt: realAgo(10) }], 1, 3 * 1024 * 1024, { assetCreatedAt: realAgo(10) })
    const path = join(config.uploadsDir, big.stored[0]!)
    const dry = await prune(['--days', '3', '--dry-run'])
    assert.equal(dry.code, 0, dry.stderr)
    assert.match(dry.stdout, /^Opened the database read-only\.\n/)
    assert.match(dry.stdout, /Would delete \d+ file\(s\), [\d.]+ MB by the database's sizes, from \d+ item\(s\)\./)
    assert.match(dry.stdout, /Would also delete \d+ leftover file\(s\) of an earlier run/)
    assert.match(dry.stdout, /Left alone: .*publication time that cannot be read/)
    assert.match(dry.stdout, /3\.0 MB {2}T-\w+ {2}clip-0\.mp4/)
    assert.match(dry.stdout, /Nothing was deleted \(dry run\)/)
    assert.ok(existsSync(path))
    assert.equal(db.select().from(assets).where(eq(assets.contentId, big.contentId)).get()!.prunedAt, null)

    const yes = await prune(['--days', '3', '--yes'])
    assert.equal(yes.code, 0, yes.stderr)
    assert.match(yes.stdout, /Deleted \d+ file\(s\): [\d.]+ MB freed on disk/)
    assert.ok(!existsSync(path))
    assert.ok(db.select().from(assets).where(eq(assets.contentId, big.contentId)).get()!.prunedAt)
  })

  it('a quiet database (newest row 10 days old): refused without --trust-clock (exit 1, the line says why), runs with it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-prune-quiet-'))
    const setup = await prune(['--days', '3', '--yes'], { DATA_DIR: dir }) // creates and migrates an empty database
    assert.equal(setup.code, 0, setup.stderr)
    const q = new Database(join(dir, 'publishfast.db'))
    const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString()
    q.prepare("INSERT INTO users (id, username, password_hash, display_name) VALUES ('u1', 'quiet', 'x', 'q')").run()
    q.prepare("INSERT INTO contents (id, code, status, created_at) VALUES ('c1', 'QUIET-1', 'PUBLISHED', ?)").run(ago(12))
    q.prepare("INSERT INTO assets (id, content_id, file_path, original_name, mime, size, type, created_at) VALUES ('a1', 'c1', 'q.mp4', 'q.mp4', 'video/mp4', 10, 'video', ?)").run(ago(12))
    q.prepare("INSERT INTO publications (id, content_id, user_id, platform, published_url, published_at, created_at) VALUES ('p1', 'c1', 'u1', 'tiktok', 'https://example.test/q', ?, ?)").run(ago(10), ago(10))
    q.close()
    writeFileSync(join(dir, 'uploads', 'q.mp4'), 'quiet file')

    for (const mode of ['--dry-run', '--yes']) {
      const refused = await prune(['--days', '3', mode], { DATA_DIR: dir })
      assert.equal(refused.code, 1, mode)
      assert.match(refused.stdout, /refused to run, nothing (selected|deleted): the newest row this server wrote .* more than 3 day\(s\) before this server's clock/)
      assert.match(refused.stdout, /--trust-clock/)
      assert.ok(existsSync(join(dir, 'uploads', 'q.mp4')))
    }
    const dry = await prune(['--days', '3', '--dry-run', '--trust-clock'], { DATA_DIR: dir })
    assert.equal(dry.code, 0, dry.stderr)
    assert.match(dry.stdout, /Would delete 1 file\(s\)/)
    const yes = await prune(['--days', '3', '--yes', '--trust-clock'], { DATA_DIR: dir })
    assert.equal(yes.code, 0, yes.stderr)
    assert.ok(!existsSync(join(dir, 'uploads', 'q.mp4')))
  })

  it('--dry-run never migrates: on an old schema it says so and leaves the database as it was', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pf-prune-old-'))
    const old = new Database(join(dir, 'publishfast.db'))
    old.exec(readFileSync(join(here, 'fixtures', 'schema-0c7a5bd.sql'), 'utf8'))
    old.close()
    const res = await prune(['--days', '3', '--dry-run'], { DATA_DIR: dir })
    assert.equal(res.code, 1)
    assert.match(res.stderr, /older than this code .*migrate\.js first/)
    const check = new Database(join(dir, 'publishfast.db'), { readonly: true })
    const cols = (check.prepare('SELECT name FROM pragma_table_info(?)').all('assets') as { name: string }[]).map((c) => c.name)
    check.close()
    assert.ok(!cols.includes('pruned_at'), 'not migrated')
  })
})
