/**
 * The migration must run cleanly on a database created by the code before
 * scoped tokens, with data in it, and leave old tokens and sessions working.
 *
 * The database is built from the exact DDL of main at 0c7a5bd
 * (fixtures/schema-0c7a5bd.sql), plus `bio_link`, which production has but the
 * old migrate.ts never created. Then the current migrate() runs on that file.
 */
import './env.js'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, it } from 'node:test'
import Database from 'better-sqlite3'

const here = dirname(fileURLToPath(import.meta.url))
const dbPath = join(process.env.DATA_DIR!, 'publishfast.db')
// Fixture values: obviously fake, never a real token.
const LEGACY_TOKEN = 'pf_test_only_legacy_admin_token'
const LEGACY_KOL_TOKEN = 'pf_test_only_legacy_kol_token'
const adminId = randomUUID()
const kolId = randomUUID()
const contentIds = [randomUUID(), randomUUID(), randomUUID()]

before(() => {
  const old = new Database(dbPath)
  old.pragma('journal_mode = WAL')
  old.exec(readFileSync(join(here, 'fixtures', 'schema-0c7a5bd.sql'), 'utf8'))
  old.exec('ALTER TABLE users ADD COLUMN bio_link TEXT')
  const sha = (t: string) => createHash('sha256').update(t).digest('hex')

  const user = old.prepare(
    `INSERT INTO users (id, username, email, password_hash, display_name, role, notes, bio_link)
     VALUES (?, ?, ?, 'x', ?, ?, ?, ?)`,
  )
  user.run(adminId, 'oldadmin', 'oldadmin@example.test', 'Old Admin', 'admin', null, null)
  user.run(kolId, 'oldkol', null, 'Old Kol', 'kol', 'a note', 'https://example.test/?ref=oldkol')

  const content = old.prepare(
    `INSERT INTO contents (id, code, title, caption, status, claimed_by, hook_id) VALUES (?, ?, 'old', 'cap', ?, ?, 'h_x')`,
  )
  content.run(contentIds[0], 'OLD-1', 'PUBLISHED', kolId)
  content.run(contentIds[1], 'OLD-2', 'READY', null)
  content.run(contentIds[2], 'OLD-3', 'DRAFT', null)
  old.prepare(
    `INSERT INTO assets (id, content_id, file_path, original_name, mime, size, type)
     VALUES (?, ?, 'stored.mp4', 'clip.mp4', 'video/mp4', 10, 'video')`,
  ).run(randomUUID(), contentIds[0])
  old.prepare(
    `INSERT INTO publications (id, content_id, user_id, platform, published_url, views)
     VALUES ('old-pub', ?, ?, 'tiktok', 'https://example.test/v/1', 77)`,
  ).run(contentIds[0], kolId)
  old.prepare(`INSERT INTO api_tokens (id, name, token_hash, role) VALUES (?, ?, ?, ?)`).run(
    randomUUID(),
    'old-pipeline',
    sha(LEGACY_TOKEN),
    'admin',
  )
  old.prepare(`INSERT INTO api_tokens (id, name, token_hash, role) VALUES (?, ?, ?, ?)`).run(
    randomUUID(),
    'old-kol',
    sha(LEGACY_KOL_TOKEN),
    'kol',
  )
  old.close()
})

// Imported only after the old database exists, because db/index.ts opens it.
const { sqlite } = await import('../db/index.js')
const { migrate } = await import('../db/migrate.js')

after(() => sqlite.close())

function columns(table: string) {
  return (sqlite.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name)
}

describe('migrate() on a database from main@0c7a5bd', () => {
  it('adds every new column and table, twice without error', () => {
    migrate()
    migrate()
    for (const c of ['assigned_only', 'bio_link']) assert.ok(columns('users').includes(c), c)
    for (const c of ['release_at', 'publish_at', 'meta', 'source', 'created_by_token']) {
      assert.ok(columns('contents').includes(c), c)
    }
    for (const c of ['scope', 'user_id', 'assignees', 'expires_at', 'revoked_at', 'created_by', 'file_prefix']) {
      assert.ok(columns('api_tokens').includes(c), c)
    }
    assert.ok(columns('metric_snapshots').includes('extra'))
    assert.ok(columns('token_events').includes('action'))
    assert.ok(columns('files').includes('stored_path'))
    assert.ok(columns('uploads').includes('part_size'))
    assert.ok(columns('upload_parts').includes('n'))
    assert.ok(columns('assets').includes('pruned_at'))
  })

  it('keeps every old row and value; new columns are NULL or their default', () => {
    assert.equal((sqlite.prepare('SELECT count(*) n FROM contents').get() as { n: number }).n, 3)
    const one = sqlite.prepare('SELECT * FROM contents WHERE code = ?').get('OLD-1') as Record<string, unknown>
    assert.equal(one.status, 'PUBLISHED')
    assert.equal(one.claimed_by, kolId)
    assert.equal(one.hook_id, 'h_x')
    assert.equal(one.release_at, null)
    assert.equal(one.meta, null)
    assert.equal(one.created_by_token, null)
    const asset = sqlite.prepare('SELECT * FROM assets WHERE content_id = ?').get(one.id) as Record<string, unknown>
    assert.equal(asset.file_path, 'stored.mp4')
    assert.equal(asset.size, 10)
    assert.equal(asset.pruned_at, null, 'no existing file counts as pruned')
    const kol = sqlite.prepare('SELECT * FROM users WHERE id = ?').get(kolId) as Record<string, unknown>
    assert.equal(kol.assigned_only, 0)
    assert.equal(kol.notes, 'a note')
    const pub = sqlite.prepare("SELECT * FROM publications WHERE id = 'old-pub'").get() as Record<string, unknown>
    assert.equal(pub.views, 77)
    const tokens = sqlite.prepare('SELECT scope, revoked_at, expires_at FROM api_tokens').all() as Record<string, unknown>[]
    assert.equal(tokens.length, 2)
    assert.ok(tokens.every((t) => t.scope === null && t.revoked_at === null && t.expires_at === null))
  })

  it('the old admin token, the old kol token and an old session still work as before', async () => {
    const { buildApp } = await import('../app.js')
    const { SESSION_COOKIE, signSession } = await import('../lib/auth.js')
    const app = await buildApp({ logger: false })
    try {
      const admin = await app.inject({
        method: 'GET',
        url: '/api/admin/contents',
        headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
      })
      assert.equal(admin.statusCode, 200)
      assert.equal(admin.json().contents.length, 3)

      const ingest = await app.inject({
        method: 'POST',
        url: '/api/ingest/contents',
        headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
        payload: { code: 'NEW-AFTER-MIGRATE', status: 'READY' },
      })
      assert.equal(ingest.statusCode, 201)

      const kolToken = await app.inject({
        method: 'GET',
        url: '/api/admin/users',
        headers: { authorization: `Bearer ${LEGACY_KOL_TOKEN}` },
      })
      assert.equal(kolToken.statusCode, 403)

      // A session cookie signed before the upgrade (sessions are stateless JWTs).
      const cookie = `${SESSION_COOKIE}=${await signSession(kolId)}`
      const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })
      assert.equal(me.statusCode, 200)
      assert.equal(me.json().user.username, 'oldkol')
      assert.equal(me.json().user.assignedOnly, false)

      const queue = await app.inject({ method: 'GET', url: '/api/contents', headers: { cookie } })
      assert.equal(queue.statusCode, 200)
      const codes = queue.json().contents.map((c: { code: string }) => c.code).sort()
      assert.deepEqual(codes, ['NEW-AFTER-MIGRATE', 'OLD-1', 'OLD-2'])
    } finally {
      await app.close()
    }
  })
})
