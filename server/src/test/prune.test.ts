/**
 * The media prune (contract section 14): only PUBLISHED items whose newest
 * publication is older than the cutoff lose their files; rows, publications
 * and snapshots stay; pruned downloads answer 410; the dry run deletes
 * nothing and selects exactly what the real run deletes; a run is idempotent;
 * a concurrent change between selection and marking wins.
 */
import './env.js'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { eq, isNotNull } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db, sqlite } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { assets, contents, files, metricSnapshots, publications } from '../db/schema.js'
import { createApiToken } from '../lib/auth.js'
import { config, parsePruneDays } from '../lib/config.js'
import { PRUNE_FIRST_DELAY_MS, PRUNE_INTERVAL_MS, pruneIfDue, pruneMedia, selectPrunable } from '../lib/prune.js'
import { call, makeContent, makeUser, sessionFor } from './helpers.js'

const run = promisify(execFile)
const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

const NOW = new Date('2026-11-14T00:00:00.000Z')
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
const PLATFORMS = ['tiktok', 'instagram', 'facebook', 'youtube'] as const

let app: FastifyInstance
let kol: ReturnType<typeof makeUser>

type Pub = { publishedAt?: string | null; createdAt?: string }

/** An item with real files on disk under uploads/ and the given publications. */
function item(status: (typeof contents.status.enumValues)[number], pubs: Pub[], nFiles = 1, size = 1000) {
  const contentId = makeContent({ status, claimedBy: kol.id })
  const stored: string[] = []
  for (let i = 0; i < nFiles; i++) {
    const filePath = `${randomUUID()}.mp4`
    writeFileSync(join(config.uploadsDir, filePath), Buffer.alloc(size, 1))
    db.insert(assets)
      .values({ id: randomUUID(), contentId, filePath, originalName: `clip-${i}.mp4`, mime: 'video/mp4', size, type: 'video', sortOrder: i })
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
        ...(p.createdAt ? { createdAt: p.createdAt } : {}),
      })
      .run()
    db.insert(metricSnapshots).values({ id: randomUUID(), publicationId: id, takenAt: daysAgo(9), label: '24h', views: 10 }).run()
  })
  return { contentId, stored }
}

const onDisk = () => readdirSync(config.uploadsDir).sort()

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
    assert.equal(parsePruneDays(' 7 '), 7)
    for (const off of [undefined, '', '0', '-1', '1.5', '3d', 'three', '99999']) assert.equal(parsePruneDays(off), 0, String(off))
    assert.equal(config.prunePublishedAfterDays, 0, 'off by default')
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
    k.publishedWins = item('PUBLISHED', [{ publishedAt: daysAgo(10), createdAt: daysAgo(1) }]) // goes (published_at wins)
    k.scheduled = item('PUBLISHED', [{ publishedAt: daysAgo(-5), createdAt: daysAgo(10) }]) // public in 5 days
    k.unreadable = item('PUBLISHED', [{ publishedAt: 'sometime last week' }])
    k.boundary = item('PUBLISHED', [{ publishedAt: daysAgo(3) }]) // exactly 3 days: not older
    // A drop-box file: has its own expiry, never the prune's.
    dropBoxFile = join(config.filesDir, `${randomUUID()}.bin`)
    writeFileSync(dropBoxFile, 'drop box')
    db.insert(files)
      .values({ id: randomUUID(), key: 'nhi/voice/x.zip', storedPath: dropBoxFile.split('/').pop()!, size: 8, sha256: 'x', mime: 'application/zip', expiresAt: daysAgo(-1) })
      .run()
    initial = onDisk()
  })

  const goes = () => [...k.oldPublished!.stored, ...k.createdOnly!.stored, ...k.publishedWins!.stored]

  it('the dry run selects exactly the expected files and deletes nothing', async () => {
    const report = await pruneMedia({ days: 3, now: NOW, dryRun: true })
    assert.equal(report.dryRun, true)
    assert.equal(report.files, 4)
    assert.equal(report.bytes, 4000)
    assert.equal(report.items, 3)
    assert.equal(report.skippedUnreadable, 1)
    assert.equal(report.marked, undefined)
    assert.deepEqual(onDisk(), initial, 'no file was deleted')
    assert.equal(db.select().from(assets).where(isNotNull(assets.prunedAt)).all().length, 0, 'no row was marked')
    const selected = selectPrunable(3, NOW).assets.map((a) => a.filePath).sort()
    assert.deepEqual(selected, goes().sort())
  })

  it('the real run deletes exactly those files; every other file survives', async () => {
    const report = await pruneMedia({ days: 3, now: NOW })
    assert.equal(report.marked, 4)
    assert.equal(report.deleted, 4)
    assert.equal(report.bytesFreed, 4000)
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
    const untouched = db.select().from(assets).where(eq(assets.contentId, k.reopenedReady!.contentId)).get()!
    assert.equal(untouched.prunedAt, null)
  })

  it('is idempotent', async () => {
    const again = await pruneMedia({ days: 3, now: NOW })
    assert.deepEqual([again.files, again.marked, again.deleted, again.leftoversDeleted], [0, 0, 0, 0])
    assert.deepEqual(onDisk(), initial.filter((f) => !goes().includes(f)).sort())
  })

  it('downloads and the zip of a pruned asset answer 410; the item still shows its media rows', async () => {
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
    // Someone who may not see the item still gets 404, not 410.
    const stranger = await sessionFor(makeUser('prune-stranger').id)
    assert.equal((await call(app, 'GET', `/api/assets/${prunedAsset.id}`, { cookie: stranger })).statusCode, 404)
    // A file that was not pruned still downloads.
    const live = db.select().from(assets).where(eq(assets.contentId, k.recent!.contentId)).get()!
    assert.equal((await call(app, 'GET', `/api/assets/${live.id}/download`, { cookie })).statusCode, 200)
    const item = await call(app, 'GET', `/api/contents/${k.oldPublished!.contentId}`, { cookie: admin })
    assert.equal(item.json().content.assets.length, 2)
    assert.equal(item.json().content.assets[0].prunedAt, NOW.toISOString())
    assert.equal(item.json().content.assets[0].filePath, undefined)
  })

  it('an item re-opened after its files were pruned: still 410, and a later run selects nothing of it', async () => {
    db.update(contents).set({ status: 'READY' }).where(eq(contents.id, k.oldPublished!.contentId)).run()
    const r = await pruneMedia({ days: 3, now: NOW })
    assert.deepEqual([r.files, r.marked, r.failed], [0, 0, 0])
    const asset = db.select().from(assets).where(eq(assets.contentId, k.oldPublished!.contentId)).get()!
    const admin = await sessionFor(makeUser('reopen-admin', 'admin').id)
    assert.equal((await call(app, 'GET', `/api/assets/${asset.id}`, { cookie: admin })).statusCode, 410)
    // The re-opened item's untouched sibling files (k.reopenedReady) are still there.
    assert.ok(existsSync(join(config.uploadsDir, k.reopenedReady!.stored[0]!)))
    db.update(contents).set({ status: 'PUBLISHED' }).where(eq(contents.id, k.oldPublished!.contentId)).run()
  })
})

describe('a change between selection and marking wins', () => {
  it('an item re-opened, or given a new publication, after selection keeps its files', async () => {
    const reopened = item('PUBLISHED', [{}])
    const repost = item('PUBLISHED', [{}])
    const later = new Date(NOW.getTime() + 60 * 86_400_000)
    const report = await pruneMedia({
      days: 3,
      now: later,
      _afterSelect: () => {
        db.update(contents).set({ status: 'READY' }).where(eq(contents.id, reopened.contentId)).run()
        db.insert(publications)
          .values({ id: randomUUID(), contentId: repost.contentId, userId: kol.id, platform: 'instagram', publishedUrl: 'https://example.test/new', publishedAt: later.toISOString() })
          .run()
      },
    })
    assert.equal(report.changed, 2)
    for (const f of [...reopened.stored, ...repost.stored]) assert.ok(existsSync(join(config.uploadsDir, f)), f)
    for (const id of [reopened.contentId, repost.contentId]) {
      assert.ok(db.select().from(assets).where(eq(assets.contentId, id)).all().every((a) => a.prunedAt === null))
    }
  })
})

describe('crash safety', () => {
  it('a row marked by a run that died before deleting its file: the file goes on the next run', async () => {
    const it1 = item('PUBLISHED', [{}])
    // What a crash between the commit of the mark and the unlink leaves behind.
    db.update(assets).set({ prunedAt: daysAgo(1) }).where(eq(assets.contentId, it1.contentId)).run()
    assert.ok(existsSync(join(config.uploadsDir, it1.stored[0]!)))
    const report = await pruneMedia({ days: 3, now: NOW })
    assert.ok(report.leftoversDeleted! >= 1)
    assert.ok(!existsSync(join(config.uploadsDir, it1.stored[0]!)))
  })

  it('a file already gone is not an error: the row is marked and counted as missing', async () => {
    const it2 = item('PUBLISHED', [{}])
    const { unlinkSync } = await import('node:fs')
    unlinkSync(join(config.uploadsDir, it2.stored[0]!))
    const report = await pruneMedia({ days: 3, now: NOW })
    assert.equal(report.alreadyMissing, 1)
    assert.equal(report.failed, 0)
    assert.ok(db.select().from(assets).where(eq(assets.contentId, it2.contentId)).get()!.prunedAt)
  })

  it('a stored name that would leave uploads/ is marked but never followed', async () => {
    const outside = join(config.dataDir, 'outside.txt')
    writeFileSync(outside, 'keep me')
    const contentId = makeContent({ status: 'PUBLISHED' })
    db.insert(assets)
      .values({ id: randomUUID(), contentId, filePath: '../outside.txt', originalName: 'x.mp4', mime: 'video/mp4', size: 7, type: 'video' })
      .run()
    db.insert(publications)
      .values({ id: randomUUID(), contentId, userId: kol.id, platform: 'tiktok', publishedUrl: 'https://example.test/o', publishedAt: daysAgo(10) })
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
})

describe('GET /api/admin/storage', () => {
  it('admins see bytes by status, pruned bytes, drop box, unfinished uploads and free disk; nobody else', async () => {
    const admin = await sessionFor(makeUser('storage-admin', 'admin').id)
    const res = await call(app, 'GET', '/api/admin/storage', { cookie: admin })
    assert.equal(res.statusCode, 200)
    const body = res.json()
    assert.ok(body.byStatus.some((r: { status: string; files: number }) => r.status === 'PUBLISHED' && r.files > 0))
    assert.ok(body.pruned.files >= 4)
    assert.ok(body.pruned.bytes >= 4000)
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
  async function prune(...args: string[]) {
    try {
      const { stdout, stderr } = await run(process.execPath, ['--import', 'tsx', 'src/scripts/prune.ts', ...args], {
        cwd: serverDir,
        env: { ...process.env },
      })
      return { code: 0, stdout, stderr }
    } catch (e) {
      const x = e as { code: number; stdout: string; stderr: string }
      return { code: x.code, stdout: x.stdout, stderr: x.stderr }
    }
  }

  it('refuses without --days, or without exactly one of --dry-run and --yes', async () => {
    for (const args of [['--dry-run'], ['--days', '0', '--dry-run'], ['--days', '3'], ['--days', '3', '--dry-run', '--yes']]) {
      const res = await prune(...args)
      assert.equal(res.code, 1, args.join(' '))
      assert.equal(res.stdout, '')
    }
  })

  it('--dry-run prints the count, bytes and largest files and deletes nothing; --yes deletes them', async () => {
    const big = item('PUBLISHED', [{ publishedAt: new Date(Date.now() - 10 * 86_400_000).toISOString() }], 1, 3 * 1024 * 1024)
    const path = join(config.uploadsDir, big.stored[0]!)
    const dry = await prune('--days', '3', '--dry-run')
    assert.equal(dry.code, 0, dry.stderr)
    assert.match(dry.stdout, /Would delete \d+ file\(s\), [\d.]+ MB, from \d+ item\(s\)\./)
    assert.match(dry.stdout, /Largest \d+:/)
    assert.match(dry.stdout, /3\.0 MB {2}T-\w+ {2}clip-0\.mp4/)
    assert.match(dry.stdout, /Nothing was deleted \(dry run\)/)
    assert.ok(existsSync(path))
    assert.equal(db.select().from(assets).where(eq(assets.contentId, big.contentId)).get()!.prunedAt, null)

    const yes = await prune('--days', '3', '--yes')
    assert.equal(yes.code, 0, yes.stderr)
    assert.match(yes.stdout, /Deleted \d+ file\(s\)/)
    assert.ok(!existsSync(path))
    assert.ok(db.select().from(assets).where(eq(assets.contentId, big.contentId)).get()!.prunedAt)
  })
})
