import { sql } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'

export const CONTENT_STATUSES = ['DRAFT', 'READY', 'CLAIMED', 'PUBLISHED', 'FAILED'] as const
export const CONTENT_TYPES = ['video', 'carousel'] as const
export const PLATFORMS = ['tiktok', 'instagram', 'youtube_shorts', 'youtube', 'facebook', 'other'] as const
export const ROLES = ['admin', 'kol'] as const
/**
 * What an API token may do. A row with a NULL scope is a token created before
 * scopes existed and keeps its role-based behaviour (see lib/scopes.ts).
 */
export const TOKEN_SCOPES = ['admin', 'ingest', 'poster', 'read', 'files'] as const
export type TokenScope = (typeof TOKEN_SCOPES)[number]

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    /** Short login handle. Never contains '@' so it can't collide with an email. */
    username: text('username').notNull(),
    /** Optional — a KOL can exist with a username only. */
    email: text('email'),
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name').notNull(),
    role: text('role', { enum: ROLES }).notNull().default('kol'),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    /** Optional admin notes (e.g. channel links, niche, posting schedule) */
    notes: text('notes'),
    /** Affiliate / Bio tracking link for app attribution (e.g. https://pteflow.com/?ref=yoga) */
    bioLink: text('bio_link'),
    /** When true the user only ever sees content assigned to them, never the open queue. */
    assignedOnly: integer('assigned_only', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('users_username_unique').on(t.username),
    uniqueIndex('users_email_unique').on(t.email),
  ],
)

export const contents = sqliteTable(
  'contents',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    title: text('title'),
    caption: text('caption'),
    contentType: text('content_type', { enum: CONTENT_TYPES }).notNull().default('video'),
    status: text('status', { enum: CONTENT_STATUSES }).notNull().default('DRAFT'),
    /** Optional pre-assignment: only this user may claim it. */
    assignedUserId: text('assigned_user_id').references(() => users.id, { onDelete: 'set null' }),
    claimedBy: text('claimed_by').references(() => users.id, { onDelete: 'set null' }),
    claimedAt: text('claimed_at'),
    /** Optional hook identifier from marketing templates (e.g. h_score_01) */
    hookId: text('hook_id'),
    /** ISO time: a DRAFT with release_at is flipped to READY by the release scheduler. */
    releaseAt: text('release_at'),
    /** ISO time the post should go public on its platform. Information for the poster. */
    publishAt: text('publish_at'),
    /** Free-form per-platform JSON object (max 64 KB), e.g. meta.youtube.title. */
    meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>(),
    /** Where the item came from, e.g. "nhi#12". */
    source: text('source'),
    /** api_tokens.id of the token that created it. No FK: deleting a token must not touch content. */
    createdByToken: text('created_by_token'),
    /** api_tokens.id of the poster token holding the claim; NULL for a claim made in a session. */
    claimedByToken: text('claimed_by_token'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('contents_code_unique').on(t.code),
    // The claim query filters on status and orders by created_at.
    index('contents_status_created_idx').on(t.status, t.createdAt),
    index('contents_claimed_by_idx').on(t.claimedBy),
    index('contents_hook_id_idx').on(t.hookId),
    index('contents_release_idx').on(t.status, t.releaseAt),
    index('contents_created_by_token_idx').on(t.createdByToken),
  ],
)

export const assets = sqliteTable(
  'assets',
  {
    id: text('id').primaryKey(),
    contentId: text('content_id')
      .notNull()
      .references(() => contents.id, { onDelete: 'cascade' }),
    /** Path relative to the uploads dir, never an absolute host path. */
    filePath: text('file_path').notNull(),
    originalName: text('original_name').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    /** `file` is anything that is neither video/* nor image/* (e.g. subtitles). */
    type: text('type', { enum: ['video', 'image', 'file'] }).notNull(),
    createdAt: text('created_at').notNull().default(now),
    /**
     * Set when the media prune (lib/prune.ts) deleted this file: the row, its
     * size and its item's history stay; downloads answer 410.
     */
    prunedAt: text('pruned_at'),
  },
  (t) => [index('assets_content_sort_idx').on(t.contentId, t.sortOrder)],
)

export const publications = sqliteTable(
  'publications',
  {
    id: text('id').primaryKey(),
    contentId: text('content_id')
      .notNull()
      .references(() => contents.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform', { enum: PLATFORMS }).notNull(),
    status: text('status', { enum: ['PENDING', 'PUBLISHED', 'FAILED'] })
      .notNull()
      .default('PUBLISHED'),
    publishedUrl: text('published_url'),
    publishedAt: text('published_at'),
    views: integer('views').notNull().default(0),
    likes: integer('likes').notNull().default(0),
    comments: integer('comments').notNull().default(0),
    shares: integer('shares').notNull().default(0),
    lastCheckedAt: text('last_checked_at'),
    metricError: text('metric_error'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    index('publications_content_idx').on(t.contentId),
    index('publications_user_idx').on(t.userId),
    // One row per (content, platform) — re-posting the same content to the
    // same platform updates the existing row instead of duplicating it.
    uniqueIndex('publications_content_platform_unique').on(t.contentId, t.platform),
  ],
)

export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** SHA-256 of the token; the plaintext is shown once at creation. */
    tokenHash: text('token_hash').notNull(),
    role: text('role', { enum: ROLES }).notNull().default('admin'),
    createdAt: text('created_at').notNull().default(now),
    lastUsedAt: text('last_used_at'),
    /** NULL = a token from before scopes: behaves by `role`, exactly as before. */
    scope: text('scope', { enum: TOKEN_SCOPES }),
    /** poster tokens act as exactly this user. */
    userId: text('user_id'),
    /** ingest tokens: user ids every item they create must be assigned to (JSON array). */
    assignees: text('assignees', { mode: 'json' }).$type<string[]>(),
    expiresAt: text('expires_at'),
    revokedAt: text('revoked_at'),
    /** "cli" or the id of the admin who created it in the web page. */
    createdBy: text('created_by'),
    /** Drop box: the key prefix this token may touch (files, ingest). NULL = no file at all. */
    filePrefix: text('file_prefix'),
  },
  (t) => [uniqueIndex('api_tokens_hash_unique').on(t.tokenHash), index('api_tokens_name_idx').on(t.name)],
)

/** One row per metric reading of a publication (manual, by agent, or `auto`). */
export const metricSnapshots = sqliteTable(
  'metric_snapshots',
  {
    id: text('id').primaryKey(),
    publicationId: text('publication_id')
      .notNull()
      .references(() => publications.id, { onDelete: 'cascade' }),
    takenAt: text('taken_at').notNull(),
    /** Free text up to 20 chars: 24h, 7d, 28d, daily, auto. */
    label: text('label'),
    views: integer('views'),
    likes: integer('likes'),
    comments: integer('comments'),
    shares: integer('shares'),
    /** JSON object up to 16 KB: watch time, CTR, impressions, traffic sources... */
    extra: text('extra', { mode: 'json' }).$type<Record<string, unknown>>(),
    createdAt: text('created_at').notNull().default(now),
    /** Token that wrote it, if any. No FK so the audit survives token deletion. */
    tokenId: text('token_id'),
  },
  (t) => [index('metric_snapshots_pub_taken_idx').on(t.publicationId, t.takenAt)],
)

/**
 * Drop box for temporary hand-over files (e.g. narration made on the VPS for a
 * cloud session). Bytes live under DATA_DIR/files under a random stored name,
 * never the key. Rows and bytes are deleted when they expire.
 */
export const files = sqliteTable(
  'files',
  {
    id: text('id').primaryKey(),
    /** Slash-separated path, 1-200 chars, segments [A-Za-z0-9._-]+ not starting with a dot. */
    key: text('key').notNull(),
    /** Relative to the files directory. Never sent to clients. */
    storedPath: text('stored_path').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    mime: text('mime').notNull(),
    createdAt: text('created_at').notNull().default(now),
    expiresAt: text('expires_at').notNull(),
    /** No FK, like contents.created_by_token. */
    createdByToken: text('created_by_token'),
  },
  (t) => [uniqueIndex('files_key_unique').on(t.key), index('files_expires_idx').on(t.expiresAt)],
)

/**
 * An upload in parts (contract section 12): a large file sent as several
 * requests of at most part_size bytes, so no request body reaches the
 * tunnel's 100 MB limit. Parts live in DATA_DIR/upload-parts/<id>/<n>.part,
 * all server-made names. Unfinished uploads are swept after 24 hours.
 */
export const uploads = sqliteTable(
  'uploads',
  {
    id: text('id').primaryKey(),
    contentId: text('content_id')
      .notNull()
      .references(() => contents.id, { onDelete: 'cascade' }),
    /** Token that started it (no FK). */
    tokenId: text('token_id'),
    name: text('name').notNull(),
    size: integer('size').notNull(),
    partSize: integer('part_size').notNull(),
    parts: integer('parts').notNull(),
    mime: text('mime'),
    /** Declared sha256 (hex), checked on complete. */
    sha256: text('sha256'),
    createdAt: text('created_at').notNull().default(now),
    /** Set once: the asset the upload became. Completing again answers it. */
    assetId: text('asset_id'),
    /**
     * Set (compare-and-swap) while one request joins the parts. While it is
     * fresh, parts and abort answer 409; older than 10 minutes it counts as a
     * crashed join and may be taken over.
     */
    completingAt: text('completing_at'),
  },
  (t) => [index('uploads_content_idx').on(t.contentId), index('uploads_created_idx').on(t.createdAt)],
)

export const uploadParts = sqliteTable(
  'upload_parts',
  {
    uploadId: text('upload_id')
      .notNull()
      .references(() => uploads.id, { onDelete: 'cascade' }),
    n: integer('n').notNull(),
    size: integer('size').notNull(),
    /** Server-made file name of this copy of the part (a resend writes a new one). */
    file: text('file'),
  },
  (t) => [uniqueIndex('upload_parts_unique').on(t.uploadId, t.n)],
)

/** Audit trail: one row per state-changing call made with an API token. */
export const tokenEvents = sqliteTable(
  'token_events',
  {
    id: text('id').primaryKey(),
    /** No FK: the trail must outlive a deleted token. */
    tokenId: text('token_id').notNull(),
    at: text('at').notNull().default(now),
    action: text('action').notNull(),
    contentId: text('content_id'),
    publicationId: text('publication_id'),
    ip: text('ip'),
  },
  (t) => [index('token_events_token_at_idx').on(t.tokenId, t.at)],
)

export const reminderSettings = sqliteTable(
  'reminder_settings',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** Comma-separated times: e.g. "18:00" */
    reminderTimes: text('reminder_times').notNull().default('18:00'),
    timezone: text('timezone').notNull().default('Asia/Ho_Chi_Minh'),
    lastNotifiedDate: text('last_notified_date'),
    updatedAt: text('updated_at').notNull().default(now),
  },
)

export const pushSubscriptions = sqliteTable(
  'push_subscriptions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [
    uniqueIndex('push_subscriptions_endpoint_unique').on(t.endpoint),
    index('push_subscriptions_user_idx').on(t.userId),
  ],
)

export type User = typeof users.$inferSelect
export type Content = typeof contents.$inferSelect
export type Asset = typeof assets.$inferSelect
export type Publication = typeof publications.$inferSelect
export type ApiToken = typeof apiTokens.$inferSelect
export type MetricSnapshot = typeof metricSnapshots.$inferSelect
export type TokenEvent = typeof tokenEvents.$inferSelect
export type StoredFile = typeof files.$inferSelect
export type Upload = typeof uploads.$inferSelect
export type ReminderSettings = typeof reminderSettings.$inferSelect
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect

