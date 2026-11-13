/**
 * The token CLI, run as a real subprocess against this file's temporary
 * database: stdout carries only the token, list never shows a token or hash,
 * revoke and rotate work, and a duplicate active name is refused.
 */
import './env.js'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { after, before, describe, it } from 'node:test'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'
import { buildApp } from '../app.js'
import { db, sqlite } from '../db/index.js'
import { migrate } from '../db/migrate.js'
import { apiTokens, users } from '../db/schema.js'
import { call, makeUser } from './helpers.js'

const run = promisify(execFile)
const serverDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

async function cli(...args: string[]) {
  try {
    const { stdout, stderr } = await run(process.execPath, ['--import', 'tsx', 'src/scripts/token.ts', ...args], {
      cwd: serverDir,
      env: { ...process.env },
    })
    return { code: 0, stdout, stderr }
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string }
    return { code: x.code, stdout: x.stdout, stderr: x.stderr }
  }
}

let app: FastifyInstance
let poster: ReturnType<typeof makeUser>
let ytPte: ReturnType<typeof makeUser>
let ytVichat: ReturnType<typeof makeUser>

before(async () => {
  migrate()
  app = await buildApp({ logger: false })
  poster = makeUser('poster')
  ytPte = makeUser('yt-pte')
  ytVichat = makeUser('yt-vichat')
})

after(async () => {
  await app.close()
  sqlite.close()
})

describe('token CLI', () => {
  let readToken = ''

  it('create prints exactly one line on stdout, the token, and it authenticates', async () => {
    const res = await cli('create', '--name', 'weekly', '--scope', 'read', '--expires', '30')
    assert.equal(res.code, 0, res.stderr)
    assert.match(res.stdout, /^pf_[0-9a-f]{48}\n$/)
    assert.ok(!res.stderr.includes(res.stdout.trim()), 'the token is not repeated on stderr')
    assert.match(res.stderr, /Created token "weekly"/)
    readToken = res.stdout.trim()

    const ok = await call(app, 'GET', '/api/export/publications', { token: readToken })
    assert.equal(ok.statusCode, 200)
    const row = db.select().from(apiTokens).where(eq(apiTokens.name, 'weekly')).get()!
    assert.equal(row.scope, 'read')
    assert.equal(row.createdBy, 'cli')
    assert.ok(row.expiresAt)
  })

  it('creates poster and ingest tokens with their user and assignees', async () => {
    const p = await cli('create', '--name', 'air-pte', '--scope', 'poster', '--user', poster.username)
    assert.equal(p.code, 0, p.stderr)
    assert.equal((await call(app, 'GET', '/api/contents', { token: p.stdout.trim() })).statusCode, 200)

    const i = await cli('create', '--name', 'maker', '--scope', 'ingest', '--assignees', `${ytPte.username},${ytVichat.username}`)
    assert.equal(i.code, 0, i.stderr)
    const row = db.select().from(apiTokens).where(eq(apiTokens.name, 'maker')).get()!
    assert.deepEqual(row.assignees, [ytPte.id, ytVichat.id])
  })

  it('files tokens need --file-prefix; ingest may have one; list shows it', async () => {
    const f = await cli('create', '--name', 'vps-worker', '--scope', 'files', '--file-prefix', 'nhi/')
    assert.equal(f.code, 0, f.stderr)
    assert.match(f.stdout, /^pf_[0-9a-f]{48}\n$/)
    const i = await cli('create', '--name', 'maker-files', '--scope', 'ingest', '--file-prefix', 'nhi/')
    assert.equal(i.code, 0, i.stderr)
    assert.equal(db.select().from(apiTokens).where(eq(apiTokens.name, 'maker-files')).get()!.filePrefix, 'nhi/')
    for (const args of [
      ['create', '--name', 'f2', '--scope', 'files'],
      ['create', '--name', 'f3', '--scope', 'read', '--file-prefix', 'nhi/'],
      ['create', '--name', 'f4', '--scope', 'files', '--file-prefix', 'nhi/../x/'],
      ['create', '--name', 'f5', '--scope', 'files', '--file-prefix', '.hidden/'],
    ]) {
      const res = await cli(...args)
      assert.equal(res.code, 1, args.join(' '))
      assert.equal(res.stdout, '')
    }
    const list = await cli('list')
    assert.match(list.stdout, /vps-worker\s+files\s+-\s+-\s+nhi\//)
  })

  it('refuses bad combinations and a duplicate active name, printing nothing on stdout', async () => {
    for (const args of [
      ['create', '--name', 'weekly', '--scope', 'read'], // duplicate active name
      ['create', '--name', 'x', '--scope', 'poster'], // poster without --user
      ['create', '--name', 'x', '--scope', 'read', '--user', poster.username],
      ['create', '--name', 'x', '--scope', 'poster', '--user', 'nobody'],
      ['create', '--name', 'x', '--scope', 'admin', '--assignees', ytPte.username],
      ['create', '--name', 'x', '--scope', 'superuser'],
      ['create', '--scope', 'read'],
      ['create', '--name', 'x', '--scope', 'read', '--expires', 'soon'],
    ]) {
      const res = await cli(...args)
      assert.equal(res.code, 1, args.join(' '))
      assert.equal(res.stdout, '', args.join(' '))
      assert.ok(res.stderr.trim().length > 0)
    }
  })

  it('list shows the tokens but never a token or a hash', async () => {
    const res = await cli('list')
    assert.equal(res.code, 0, res.stderr)
    assert.match(res.stdout, /weekly\s+read/)
    assert.match(res.stdout, new RegExp(`air-pte\\s+poster\\s+${poster.username}`))
    assert.ok(res.stdout.includes(`${ytPte.username},${ytVichat.username}`))
    for (const t of db.select().from(apiTokens).all()) {
      assert.ok(!res.stdout.includes(t.tokenHash) && !res.stderr.includes(t.tokenHash))
    }
    assert.ok(!/pf_[0-9a-f]{10}/.test(res.stdout + res.stderr))
  })

  it('rotate revokes the old token and prints a working new one; revoke stops it', async () => {
    const rot = await cli('rotate', '--name', 'weekly')
    assert.equal(rot.code, 0, rot.stderr)
    assert.match(rot.stdout, /^pf_[0-9a-f]{48}\n$/)
    const fresh = rot.stdout.trim()
    assert.notEqual(fresh, readToken)
    assert.equal((await call(app, 'GET', '/api/export/publications', { token: readToken })).statusCode, 401)
    assert.equal((await call(app, 'GET', '/api/export/publications', { token: fresh })).statusCode, 200)
    const rows = db.select().from(apiTokens).where(eq(apiTokens.name, 'weekly')).all()
    assert.equal(rows.length, 2)
    assert.ok(rows.every((r) => r.scope === 'read' && r.expiresAt))

    const rev = await cli('revoke', '--name', 'weekly')
    assert.equal(rev.code, 0, rev.stderr)
    assert.equal(rev.stdout, '')
    assert.equal((await call(app, 'GET', '/api/export/publications', { token: fresh })).statusCode, 401)
    assert.equal((await cli('revoke', '--name', 'weekly')).code, 1)

    // The name is free again once nothing active uses it.
    const again = await cli('create', '--name', 'weekly', '--scope', 'read')
    assert.equal(again.code, 0, again.stderr)
  })

  it('list --events shows a token’s recent state-changing calls', async () => {
    const res = await cli('list', '--events', 'air-pte')
    assert.equal(res.code, 0, res.stderr)
    assert.equal((await cli('list', '--events', 'no-such-token')).code, 1)
  })

  it('user set --assigned-only flips the flag', async () => {
    const res = await cli('user', 'set', '--username', ytPte.username, '--assigned-only', 'true')
    assert.equal(res.code, 0, res.stderr)
    assert.equal(db.select().from(users).where(eq(users.id, ytPte.id)).get()!.assignedOnly, true)
    assert.equal((await cli('user', 'set', '--username', ytPte.username, '--assigned-only', 'maybe')).code, 1)
  })
})
