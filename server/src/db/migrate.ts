/**
 * Schema is applied with plain idempotent DDL rather than a migration-file
 * generator. The schema is small and this keeps `npm run dev` a single step
 * with no extra CLI or codegen to install.
 */
import { sqlite } from './index.js'

const statements = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    email TEXT,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'kol',
    active INTEGER NOT NULL DEFAULT 1,
    notes TEXT,
    bio_link TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users (username)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email)`,

  `CREATE TABLE IF NOT EXISTS contents (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    title TEXT,
    caption TEXT,
    content_type TEXT NOT NULL DEFAULT 'video',
    status TEXT NOT NULL DEFAULT 'DRAFT',
    assigned_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    claimed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
    claimed_at TEXT,
    hook_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS contents_code_unique ON contents (code)`,
  `CREATE INDEX IF NOT EXISTS contents_status_created_idx ON contents (status, created_at)`,
  `CREATE INDEX IF NOT EXISTS contents_claimed_by_idx ON contents (claimed_by)`,
  `CREATE INDEX IF NOT EXISTS contents_hook_id_idx ON contents (hook_id)`,

  `CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS assets_content_sort_idx ON assets (content_id, sort_order)`,

  `CREATE TABLE IF NOT EXISTS publications (
    id TEXT PRIMARY KEY,
    content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PUBLISHED',
    published_url TEXT,
    published_at TEXT,
    views INTEGER NOT NULL DEFAULT 0,
    likes INTEGER NOT NULL DEFAULT 0,
    comments INTEGER NOT NULL DEFAULT 0,
    shares INTEGER NOT NULL DEFAULT 0,
    last_checked_at TEXT,
    metric_error TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE INDEX IF NOT EXISTS publications_content_idx ON publications (content_id)`,
  `CREATE INDEX IF NOT EXISTS publications_user_idx ON publications (user_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS publications_content_platform_unique ON publications (content_id, platform)`,

  `CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_used_at TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS api_tokens_hash_unique ON api_tokens (token_hash)`,

  `CREATE TABLE IF NOT EXISTS reminder_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 1,
    reminder_times TEXT NOT NULL DEFAULT '18:00',
    timezone TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    last_notified_date TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,

  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_unique ON push_subscriptions (endpoint)`,
  `CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id)`,
]

export function migrate() {
  sqlite.exec('BEGIN')
  try {
    // 1. Create tables first
    for (const stmt of statements) {
      if (!stmt.startsWith('CREATE INDEX') && !stmt.startsWith('CREATE UNIQUE INDEX')) {
        sqlite.exec(stmt)
      }
    }

    // 2. Ensure columns added in updates exist on legacy databases
    const userCols = sqlite.pragma('table_info(users)') as { name: string }[]
    if (!userCols.some((c) => c.name === 'notes')) {
      sqlite.exec('ALTER TABLE users ADD COLUMN notes TEXT')
    }
    // bio_link was added to schema.ts without a migration step; a fresh
    // database could not create or sign in users until it existed.
    if (!userCols.some((c) => c.name === 'bio_link')) {
      sqlite.exec('ALTER TABLE users ADD COLUMN bio_link TEXT')
    }

    const contentCols = sqlite.pragma('table_info(contents)') as { name: string }[]
    if (!contentCols.some((c) => c.name === 'hook_id')) {
      sqlite.exec('ALTER TABLE contents ADD COLUMN hook_id TEXT')
    }

    const pubCols = sqlite.pragma('table_info(publications)') as { name: string }[]
    if (!pubCols.some((c) => c.name === 'views')) {
      sqlite.exec('ALTER TABLE publications ADD COLUMN views INTEGER NOT NULL DEFAULT 0')
    }
    if (!pubCols.some((c) => c.name === 'likes')) {
      sqlite.exec('ALTER TABLE publications ADD COLUMN likes INTEGER NOT NULL DEFAULT 0')
    }
    if (!pubCols.some((c) => c.name === 'comments')) {
      sqlite.exec('ALTER TABLE publications ADD COLUMN comments INTEGER NOT NULL DEFAULT 0')
    }
    if (!pubCols.some((c) => c.name === 'shares')) {
      sqlite.exec('ALTER TABLE publications ADD COLUMN shares INTEGER NOT NULL DEFAULT 0')
    }
    if (!pubCols.some((c) => c.name === 'last_checked_at')) {
      sqlite.exec('ALTER TABLE publications ADD COLUMN last_checked_at TEXT')
    }
    if (!pubCols.some((c) => c.name === 'metric_error')) {
      sqlite.exec('ALTER TABLE publications ADD COLUMN metric_error TEXT')
    }

    // 3. Create indexes now that all columns are guaranteed to exist
    for (const stmt of statements) {
      if (stmt.startsWith('CREATE INDEX') || stmt.startsWith('CREATE UNIQUE INDEX')) {
        sqlite.exec(stmt)
      }
    }

    sqlite.exec('COMMIT')
  } catch (err) {
    sqlite.exec('ROLLBACK')
    throw err
  }
}

// Allow running directly: `npm run migrate`
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
  console.log('Schema up to date.')
}
