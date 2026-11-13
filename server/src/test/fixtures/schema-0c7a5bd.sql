-- Schema exactly as server/src/db/migrate.ts created it at commit 0c7a5bd (main before
-- scoped tokens). Used by migrate.test.ts to prove the new migration runs on an old database.

CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    email TEXT,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'kol',
    active INTEGER NOT NULL DEFAULT 1,
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users (username);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email);

CREATE TABLE IF NOT EXISTS contents (
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
  );

CREATE UNIQUE INDEX IF NOT EXISTS contents_code_unique ON contents (code);

CREATE INDEX IF NOT EXISTS contents_status_created_idx ON contents (status, created_at);

CREATE INDEX IF NOT EXISTS contents_claimed_by_idx ON contents (claimed_by);

CREATE INDEX IF NOT EXISTS contents_hook_id_idx ON contents (hook_id);

CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    content_id TEXT NOT NULL REFERENCES contents(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    type TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

CREATE INDEX IF NOT EXISTS assets_content_sort_idx ON assets (content_id, sort_order);

CREATE TABLE IF NOT EXISTS publications (
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
  );

CREATE INDEX IF NOT EXISTS publications_content_idx ON publications (content_id);

CREATE INDEX IF NOT EXISTS publications_user_idx ON publications (user_id);

CREATE UNIQUE INDEX IF NOT EXISTS publications_content_platform_unique ON publications (content_id, platform);

CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_used_at TEXT
  );

CREATE UNIQUE INDEX IF NOT EXISTS api_tokens_hash_unique ON api_tokens (token_hash);

CREATE TABLE IF NOT EXISTS reminder_settings (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 1,
    reminder_times TEXT NOT NULL DEFAULT '18:00',
    timezone TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
    last_notified_date TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_unique ON push_subscriptions (endpoint);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id);
