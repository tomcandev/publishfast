# Data model

Fourteen tables in one SQLite file. The schema is applied as idempotent DDL at
startup ([`server/src/db/migrate.ts`](../server/src/db/migrate.ts)) — there is no
migration CLI to install or codegen step to run.

```
users ──< contents ──< assets
              │
              └──< publications >── users
              publications ──< metric_snapshots
api_tokens (machine access) ──< token_events (audit; no FK, outlives the token)
files (drop box; standalone)
sounds ──< sound_sightings        publications.sound_id ─ ─ sounds.id (no FK)
```

Columns added after a table first shipped are listed in `addedColumns` in `migrate.ts` and added
with `ALTER TABLE` only when missing; all are nullable or defaulted, so the migration is additive and
safe on an existing database.

## users

| column | notes |
|---|---|
| `id` | uuid |
| `username` | unique, lowercase, **never contains `@`** |
| `email` | unique, **nullable** — a KOL can exist with a username only |
| `password_hash` | argon2id |
| `display_name` | shown in the UI |
| `role` | `admin` or `kol` |
| `active` | inactive users cannot sign in (and their poster tokens stop working) |
| `notes`, `bio_link` | admin notes; affiliate link |
| `assigned_only` | default `0`. When `1` the user only ever sees content assigned to them, never the open queue |

Login accepts a username *or* an email in the same field. Because usernames are
forbidden from containing `@`, the two namespaces can never collide, so one
lookup resolves both (`findUserByIdentifier` in
[`server/src/lib/auth.ts`](../server/src/lib/auth.ts)).

## contents

One row per piece of content to be posted.

| column | notes |
|---|---|
| `code` | unique human-facing id, e.g. `PTE-RS-001` |
| `title`, `caption` | caption is what the KOL copies |
| `content_type` | `video` or `carousel` |
| `status` | see the flow below |
| `assigned_user_id` | optional pre-assignment — only this user may claim it |
| `assign_expires_at` | ISO UTC, nullable. When it has passed, the scheduler clears the assignment of a `READY`, unclaimed item (and this field), returning it to the open queue. `NULL` = assigned for ever |
| `claimed_by`, `claimed_at` | set atomically on claim |
| `claimed_by_token` | the poster token that made the claim; `NULL` for a session claim; cleared on release |
| `hook_id` | marketing hook id |
| `release_at` | ISO UTC. A `DRAFT` with `release_at` is flipped to `READY` by the server when the time comes |
| `publish_at` | ISO UTC. When the post should go public on its platform (shown to the poster) |
| `meta` | JSON object ≤ 64 KB, free-form per platform (`meta.youtube.title`, …) |
| `source` | ≤ 200 chars, where it came from (`nhi#12`) |
| `created_by_token` | the token that created it; an `ingest`-scope token only sees its own items |

## assets

Media attached to a content item, ordered by `sort_order`. `type` is `video`, `image`, or `file`
(anything else, e.g. subtitles). `file_path` is
relative to the uploads directory and is **never** sent to the client — media is
served through `/api/assets/:id`, which re-checks permissions on every request.

`pruned_at` (nullable) is set by the media prune (`lib/prune.ts`, off unless
`PRUNE_PUBLISHED_AFTER_DAYS` is set) when it deleted the file of a `PUBLISHED` item a few days after its
newest publication. The row, its `size` and the item's publications and snapshots stay; downloads and
the zip answer `410 {reason: "pruned", prunedAt}`; the web pages say "Media removed <date>". The row is
marked (compare-and-swap) before the file is removed, so a row without `pruned_at` whose file was
deleted by the prune cannot exist.

## publications

One row per platform a content item was posted to. A unique index on
`(content_id, platform)` means re-submitting a link for the same platform
updates the existing row rather than creating a duplicate.

This is what supports the core requirement: one KOL takes one content item and
posts it to several platforms, pasting a separate link back for each.

`sound_id`, `sound_title`, `sound_author`, `sound_original` (all nullable): the TikTok sound of the
post, filled by the public-count sync from the video page it reads (a page without a sound leaves them
as they were).

## metric_snapshots

One row per metric reading of a publication: `publication_id` (cascade), `taken_at`, `label`
(`24h`, `7d`, `28d`, `daily`, `auto`), nullable `views`, `likes`, `comments`, `shares`, `extra`
(JSON ≤ 16 KB), `created_at`, `token_id` (the token that wrote it, no FK). A reading at least as new
as the publication's `last_checked_at` also becomes its latest counts.

## api_tokens

Bearer tokens for machines. Only a SHA-256 hash is stored; the plaintext is shown once at creation
and is not recoverable.

| column | notes |
|---|---|
| `role` | `admin` or `kol`; decides what an old (unscoped) token may do |
| `scope` | `NULL` (old token, behaves by `role` exactly as before), `admin`, `ingest`, `poster`, `read`, `files`, `sounds` |
| `user_id` | `poster` tokens act as this user (no FK; a missing or inactive user makes the token fail) |
| `assignees` | JSON array of user ids; `ingest` tokens must assign every item to one of them |
| `file_prefix` | drop-box key prefix (`files`, `ingest`); `NULL` = no file at all |
| `expires_at`, `revoked_at` | checked on every request; a refused token looks unknown |
| `created_by` | `cli` or the id of the admin who made it in the web page |
| `last_used_at` | updated on each accepted use |

## token_events

Audit trail: one row per successful state-changing call made with a token (`id, token_id, at,
action, content_id, publication_id, ip`). Actions: `ingest.create`, `ingest.patch`, `ingest.upload`,
`ingest.withdraw`, `ingest.delete`, `ingest.asset.delete`, `claim`, `release`, `complete`,
`publication.create`, `publication.delete`, `metrics`, `file.put`, `file.delete`, `sounds.sightings`; any other route as
`METHOD /pattern`. Written by one hook in `app.ts`.

## uploads · upload_parts

Uploads in parts (large files through the tunnel): `uploads (id, content_id → contents cascade,
token_id, name, size, part_size, parts, mime, sha256, created_at, asset_id)` and `upload_parts
(upload_id → uploads cascade, n, size)`. Part bytes are in `DATA_DIR/upload-parts/<id>/<n>.part`.
`asset_id` is set once on complete. Unfinished uploads (and completed rows) older than 24 hours, and
unfinished uploads of items that left `DRAFT`, are swept by the scheduler.

## files

The drop box: `id, key` (unique), `stored_path` (random name under `DATA_DIR/files`, never the key, never
sent to clients), `size, sha256, mime, created_at, expires_at, created_by_token`. Expired rows and their
bytes are deleted by the scheduler.

## sounds · sound_sightings

The sound bank (`routes/sounds.ts`, `lib/sounds.ts`). Rows are made only from what the server itself read
on a TikTok video page (through the guard in `lib/tiktok.ts`), never from data a caller sent.

`sounds`: `id` (TikTok's music id, digits; primary key), `title`, `author`, `original` (0/1), `url` (the
sound's TikTok page, formed from the id), `first_seen_at` / `last_seen_at` (oldest and newest evidence: a
sighting's time, or our post's publication time), `status` (`active` | `hidden`), `note` (the admin's, ≤ 300).

`sound_sightings`: one row per video outside our own posts: `id`, `sound_id` (→ sounds, cascade),
`video_url` (unique; the canonical `https://www.tiktok.com/@user/video/<id>` the server read), `video_author`,
`plays`, `likes`, `posted_at`, `source` (`trend` | `viral` | `manual`), `region` (2 letters), `rank` (its place
in a trending list), `seen_at`, `token_id` (no FK; `NULL` for a person's paste). Reporting the same video again
refreshes its counts, sound and `seen_at`, and the `source`/`region`/`rank` the new call gave.

## Status flow

```
DRAFT ──▶ READY ──▶ CLAIMED ──▶ PUBLISHED
                        │
                        └──▶ (released) ──▶ READY
```

- `DRAFT` — created but not visible to KOLs yet. With `release_at`, the release scheduler (every
  60 s, one compare-and-swap `UPDATE … WHERE status='DRAFT' AND release_at <= now`) moves it to `READY`.
  An ingest token's `withdraw` moves a `READY`, unclaimed item back to `DRAFT`.
- `READY` — in the queue, claimable
- `CLAIMED` — a KOL is holding it; only they can see and act on it
- `PUBLISHED` — completed, with at least one published link recorded. When `PRUNE_PUBLISHED_AFTER_DAYS` is
  set, its media files are deleted that many days after its newest publication (rows stay; see assets)
- `FAILED` — reserved for problem items

## The claim lock

The single most important guarantee: **two KOLs must never hold the same item.**

It is one statement, in [`server/src/lib/claim.ts`](../server/src/lib/claim.ts):

```sql
UPDATE contents SET status='CLAIMED', claimed_by=?, claimed_at=?
WHERE id=? AND status='READY'
```

The `status='READY'` predicate lives *inside* the UPDATE, so this is a
compare-and-swap, not a read-then-write. SQLite serializes writers, so when two
requests race for the same row exactly one of them matches a `READY` row. A
result of `changes === 0` therefore means "someone else won" — definitively, not
probably.

`claimNext` picks the oldest available candidate and CAS-es it, retrying with
the next candidate if it loses a race. Items assigned to the caller are offered
before unassigned ones.

The database is opened with `journal_mode=WAL` and `busy_timeout=5000` so
concurrent writers queue instead of failing with `SQLITE_BUSY`.

### Why this is application code

An earlier version of PublishFast ran on a headless CMS, where this rule was
expressed as a permission filter (`status = READY`) rather than code. That CMS's
free tier rejects filtered permission rules outright, which silently removed
both the claim lock *and* KOL isolation — every KOL could read and edit every
row. Moving the rule into a plain `WHERE` clause makes it something no licence
tier or config screen can switch off.

Covered by [`claim.test.ts`](../server/src/lib/claim.test.ts), including 20
workers racing for one item and 30 workers against 12 items.

## Access rules

Enforced in route handlers, not configuration:

- A **KOL** can read items that are `READY` and unassigned (or assigned to them), plus anything they claimed. Nothing else. An `assigned_only` KOL never sees unassigned items.
- A **poster token** is its user, with these rules on top: it may not finish or release a claim its user made in a session, and a session may only release (take over) a claim a token holds.
- A KOL can only record links against an item they currently hold.
- Media inherits the same rule — an asset is only downloadable by someone allowed to see its content item.
- Unknown or forbidden items return `404`, not `403`, so ids can't be probed.
- An **admin** sees everything.

## Stale claims

If a KOL claims an item and disappears, `releaseStaleClaims(hours)` returns it to
the queue. It is exposed at `POST /api/admin/release-stale` rather than running
on a timer, so it stays an explicit action (or a cron call) instead of hidden
behaviour.
