# HTTP API

Two ways to authenticate:

- **Session cookie** — humans, via `POST /api/auth/login`. The cookie is httpOnly and SameSite=Lax.
- **Bearer token** — machines: the AI pipeline and agents. Scoped tokens are made with the
  [token CLI](#token-cli). Admin → API Tokens and `PF_CREATE_TOKEN=name npm run seed` still make
  full-power tokens exactly as before.

```
Authorization: Bearer pf_xxxxxxxxxxxxxxxx
```

### Token scopes

| scope | acts as | may call | may not |
|---|---|---|---|
| none (old token) | nobody | by `role`, exactly as before: `admin` = every ingest and admin route; `kol` = ingest routes | — |
| `admin` | nobody | everything an old admin token can, plus exports and the drop box (any key) | — |
| `ingest` | nobody | `POST /api/ingest/contents`, `GET /api/ingest/contents[?code=]`, `GET`/`PATCH`/`DELETE /api/ingest/contents/:id`, `POST …/:id/assets`, `DELETE …/:id/assets/:assetId`, `POST …/:id/withdraw` — **its own items only**; `GET`/`HEAD /api/files/<key>` inside its `file_prefix` | admin, queue, auth, notification, export routes; other tokens' or people's items; changing an item that left `DRAFT` (except `withdraw`) |
| `poster` | exactly one kol user (`user_id`) | `GET /api/contents`, `GET /api/contents/:id`, `POST /api/contents/claim-next`, `POST …/:id/claim`, `…/release`, `…/complete`, `GET /api/assets/:id[/download]`, `GET /api/contents/:id/assets.zip`, `POST /api/publications`, `DELETE /api/publications/:id`, `GET`/`POST /api/publications/:id/metrics` | admin, ingest, auth, `/api/me`, notification, stats, history, export, file routes; anything of another user |
| `read` | nobody | `GET /api/export/publications`, `GET /api/export/metrics` | everything else |
| `files` | nobody | `PUT`/`GET`/`HEAD`/`DELETE /api/files/<key>` and `GET /api/files` inside its `file_prefix` | everything else |

- The allow-list for the narrow scopes (`ingest`, `poster`, `read`, `files`) lives in one place,
  [`server/src/lib/scopes.ts`](../server/src/lib/scopes.ts), and is enforced for every request in the
  auth hook before the route runs. A route that is not listed answers **403** to these scopes, so a new
  route is closed to them until someone adds it there on purpose.
- An `ingest` token with assignees must give every item it creates or patches an `assignedUserId` from
  that list (`400` otherwise). With no assignees it may create unassigned items.
- A `poster` token acts as its user with kol power, even if that user is an admin.
- Expired and revoked tokens, and poster tokens whose user is inactive, get the same `401` as an unknown
  token.
- 20 failed bearer attempts from one IP within 5 minutes block bearer requests from that IP with `429`
  for 5 minutes (in memory, per process; the IP is `CF-Connecting-IP` when present).
- Every successful state-changing call made with a token writes one `token_events` row
  (`token list --events <name>`).

All responses are JSON. Errors look like `{ "error": "message" }`, sometimes with
a `reason` code.

---

## Auth

### `POST /api/auth/login`

`identifier` accepts **either a username or an email**.

```json
{ "identifier": "yoga", "password": "..." }
```

Returns `{ user }` and sets the session cookie. Wrong credentials return `401`
with the same message whether the account exists or not.

### `POST /api/auth/logout` · `GET /api/me`

---

## Queue (session or poster token)

### `GET /api/contents?status=READY`
Items the caller is allowed to see — already scoped, no client-side filtering needed.

### `GET /api/contents/stats`
```json
{ "available": 3, "claimed": 1, "published": 12 }
```

### `GET /api/contents/:id`
Returns the item with its `assets` and `publications`. `404` if the caller may not see it.

Every content item returned to a session or a poster token also carries `publishAt`, `releaseAt`,
`meta`, `source`, and who holds the claim: `claimedVia` (`"token"`, `"session"` or `null`),
`claimedByTokenName`, and — for a poster-token request — `claimedByThisToken`.

A user with `assignedOnly` never sees the open queue: the list, `stats`, `claim-next` and asset routes
only offer items assigned to them, and claiming an unassigned item answers `404`.

**Agent-held claims.** A claim made with a poster token belongs to that token until it is released:
a session of the same user may only `release` it (the way a person takes over, then claims it again);
linking, unlinking or completing answers `409` with `reason: "held_by_agent"`. A poster token may not
link, unlink, complete or release a claim made in a session (`held_by_person`) or held by another token
(`held_by_other_agent`). Admin sessions are not restricted.

### `POST /api/contents/claim-next`
Atomically claims the oldest available item — the "Claim next post" button.
`404` with `reason: "empty_queue"` when nothing is available.

### `POST /api/contents/:id/claim`
Claims one specific item. `409` with `reason: "already_claimed"` if another KOL won the race.

### `POST /api/contents/:id/release`
Returns a claimed item to the queue. Only the claimant, or an admin.

### `POST /api/contents/:id/complete`
Marks the item `PUBLISHED`. Requires at least one saved link, otherwise `400`.

### `GET /api/history`
Items this KOL has completed.

---

## Publications (session or poster token)

### `POST /api/publications`

```json
{
  "contentId": "…",
  "platform": "tiktok",
  "publishedUrl": "https://www.tiktok.com/@you/video/123"
}
```

Platforms: `tiktok`, `instagram`, `youtube_shorts`, `youtube` (long videos), `facebook`, `other`.
Optional `publishedAt` (ISO 8601; an offset is converted to UTC) — e.g. a scheduled video's public time.

Submitting the same `(contentId, platform)` again updates the existing row.
Returns `403` if the caller is not holding that content item.

### `DELETE /api/publications/:id`

### `POST /api/publications/:id/metrics`

The publication's owner (session or poster token), an admin session or an admin token.

```json
{ "takenAt": "2026-11-29T13:00:00Z", "label": "24h", "views": 812, "likes": 40, "comments": 3,
  "extra": { "avgViewDurationSec": 31.5, "ctr": 0.062 } }
```

All fields optional. `label` ≤ 20 chars (`24h`, `7d`, `28d`, `daily`); `extra` a JSON object ≤ 16 KB;
`takenAt` defaults to now and may not be in the future. Stores a row in `metric_snapshots` and, when the
reading is at least as new as the publication's `lastCheckedAt`, makes its counts the publication's
latest. Returns `201 { snapshot, publication }`. Anyone else gets `404`.

### `GET /api/publications/:id/metrics`
Same access. `{ publication, snapshots }`, oldest first. The automatic public-count sync adds a
snapshot labelled `auto` each time it reads fresh counts.

---

## Media (session or poster token)

| route | purpose |
|---|---|
| `GET /api/assets/:id` | inline — video player, image preview |
| `GET /api/assets/:id/download` | attachment download |
| `GET /api/contents/:id/assets.zip` | whole carousel as one zip |

Each request re-checks that the caller may see the parent content item, so media
is exactly as protected as the item itself.

---

## Ingestion — for the AI pipeline

Bearer token (or an admin session). For comprehensive workflows, Python/Node.js scripts, and carousel guides, see the dedicated [AI Ingestion Guide](file:///home/ubuntu/projects/publishfast/docs/ai-ingestion-guide.md).

### `POST /api/ingest/contents`

```json
{
  "code": "PTE-RS-001",
  "title": "Repeat Sentence Tip",
  "caption": "Most PTE students make this mistake...",
  "contentType": "video",
  "status": "READY",
  "assignedUserId": "user-uuid-here"
}
```

* `status`: defaults to `DRAFT`; use `READY` to put it straight into the queue.
* `assignedUserId`: optional — a user id or a username. When set, only that specific KOL can see and claim the post. When omitted, it goes to the open queue. Unknown → `400`.
* `releaseAt` (ISO 8601): a `DRAFT` with `releaseAt` is put in the queue by the server when the time comes.
* `publishAt` (ISO 8601): when the post should go public on its platform; shown to the poster.
* `meta`: a JSON object ≤ 64 KB, free-form per platform (e.g. `meta.youtube.title`, `description`, `tags`).
* `source`: ≤ 200 chars, where it came from (e.g. `nhi#12`).
* `409` if `code` already exists.

Times are stored as UTC. An `ingest`-scope token may only read, patch, upload to, withdraw or delete
items it created (others answer `404`), and may change nothing on an item that has left `DRAFT` (`409`,
`reason: "not_draft"`).

### `GET /api/ingest/contents?code=<code>` · `GET /api/ingest/contents/:id`
Read items back with their `assets` (name, size, type — never a disk path), e.g. to resume an upload
after a `409` on create. An ingest-scope token sees only its own items (`?code=` then returns `[]`).

### `POST /api/ingest/contents/:id/withdraw`
Takes an item back: `READY` and unclaimed → `DRAFT`, as one compare-and-swap, and cancels a pending
`releaseAt`. Already `DRAFT` → `200`. Claimed or published → `409` with `reason: "not_withdrawable"` and
the current `status`. Once back in `DRAFT` the token may patch, upload and delete assets, then set
`READY` (or `releaseAt`) again.

### `DELETE /api/ingest/contents/:id/assets/:assetId` · `DELETE /api/ingest/contents/:id`
Delete one asset, or the whole item with its files. `DRAFT` only (`409` otherwise).

Asset `type` is `video` for `video/*`, `image` for `image/*`, and `file` for any other declared type
(subtitles). An upload sent as `application/octet-stream` keeps the old fallback (`image`) unless its
name ends in `.srt`, `.vtt`, `.ass`, `.ssa`, `.txt`, `.json`, `.csv`, `.md`, `.pdf` or `.zip`.

### `POST /api/ingest/contents/:id/assets`

`multipart/form-data`, one or more files. Files stream straight to disk, so a
large video never sits in memory. Order of upload becomes `sort_order`.

```bash
curl -X POST https://publishfast.example.com/api/ingest/contents/$ID/assets \
  -H "Authorization: Bearer $TOKEN" \
  -F "file1=@video.mp4;type=video/mp4"
```

### `PATCH /api/ingest/contents/:id`
Update fields — typically flipping `DRAFT` → `READY` after review, or setting `releaseAt`.

### End-to-end example

```bash
TOKEN=pf_...
BASE=https://publishfast.example.com

ID=$(curl -sS -X POST $BASE/api/ingest/contents \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"code":"PTE-001","caption":"...","status":"READY"}' \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["content"]["id"])')

curl -sS -X POST $BASE/api/ingest/contents/$ID/assets \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@video.mp4;type=video/mp4"
```

---

## Admin (admin session or admin token)

| route | purpose |
|---|---|
| `GET/POST /api/admin/users` · `PATCH /api/admin/users/:id` | manage accounts (`PATCH` also takes `assignedOnly`) |
| `GET /api/admin/contents` · `PATCH`/`DELETE /api/admin/contents/:id` | manage content |
| `DELETE /api/admin/assets/:id` | remove a file |
| `GET /api/admin/publications` | all recorded links |
| `GET/POST /api/admin/tokens` · `DELETE /api/admin/tokens/:id` | API tokens (unscoped, as before; the list also shows `scope`, `expiresAt`, `revokedAt`) |
| `POST /api/admin/release-stale` | `{ "hours": 24 }` — requeue abandoned claims |

Setting an item's status to `DRAFT` through `PATCH /api/admin/contents/:id` or `bulk-status` cancels a
pending `releaseAt`, so a soft-archived item is not put straight back in the queue.

## Export — for analysis (read token, admin token or admin session)

### `GET /api/export/publications?since=<ISO>&assignee=<username>&format=<json|csv>`
One row per publication: `publicationId, code, title, source, assignee, poster, platform, url,
publishedAt, publishAt, views, likes, comments, shares, lastCheckedAt`. `since` filters on the
publication's `publishedAt` (or creation time). JSON is `{ rows: [...] }`.

### `GET /api/export/metrics?since=&assignee=&format=`
One row per snapshot: the same identifying columns plus `takenAt, label, views, likes, comments,
shares, extra`. `since` filters on `takenAt`.

No emails, notes, captions, meta, asset paths or token data in either. Unknown `assignee` → `400`. In
CSV, text starting with `= + - @` is prefixed with `'` so a spreadsheet does not run it.

## Drop box — temporary hand-over files (files token, ingest token for reads, admin token)

Keys are slash-separated paths of 1–200 chars; each segment `[A-Za-z0-9._-]+`, not starting with a dot,
no empty segments (`400` otherwise). A token touches only keys starting with its `file_prefix`; a token
without one touches nothing; admin-power tokens see every key. Missing, expired and out-of-prefix keys
all answer `404` (never `403`). Sessions are not used here.

| route | who | what |
|---|---|---|
| `PUT /api/files/<key>` | `files`, admin | raw request body, streamed to disk, max `MAX_FILE_BYTES` (default 200 MB, `413` beyond, nothing kept). Header `X-Expires-Days` 1–30, default 7. Replaces an existing key (old bytes deleted). `201` (new) / `200` (replaced) `{ key, size, sha256, expiresAt }` |
| `GET /api/files/<key>` | `files`, `ingest`, admin | the bytes, with `X-Sha256` and `X-Expires-At` |
| `HEAD /api/files/<key>` | same | the headers only: `Content-Length`, `X-Sha256`, `X-Expires-At` |
| `DELETE /api/files/<key>` | `files`, admin | delete now |
| `GET /api/files?prefix=<p>` | `files`, admin | `{ files: [{ key, size, sha256, expiresAt }] }` under the token's prefix |

```bash
curl -X PUT --data-binary @issue-12.zip -H "Authorization: Bearer $PF_FILES_TOKEN" \
  -H 'X-Expires-Days: 14' https://publishfast.example.com/api/files/nhi/voice/issue-12.zip
```

Expired files (row and bytes) are deleted by the server's scheduler every minute.

## Token CLI

Tokens are made on the server, not in the web page:

```bash
npm run -s token -w server -- create --name <name> --scope <admin|ingest|poster|read|files> \
    [--user <username>] [--assignees <u1,u2>] [--file-prefix <p>] [--expires <days>]
npm run -s token -w server -- list [--events <name>]
npm run -s token -w server -- revoke --name <name>
npm run -s token -w server -- rotate --name <name>
npm run -s token -w server -- user set --username <u> --assigned-only <true|false>

# production, without tsx:
node server/dist/scripts/token.js <command> …
```

- `create` and `rotate` print **only the token and a newline** on stdout; what was made goes to stderr,
  so `… create … > token.txt` stores the token without showing it. Use `npm run -s` (or the `node`
  form): without `-s`, npm itself prints a two-line banner on stdout.
- `--user` (a kol user) is required for `poster`; `--assignees` is only for `ingest`; `--file-prefix` is
  required for `files` and optional for `ingest`. A duplicate active name is refused.
- `list` shows name, scope, user, assignees, file prefix, created, last used, expires, revoked — never a
  token or a hash. `--events <name>` shows that token's last 50 state-changing calls.
- `rotate` revokes the active token of that name and makes a new one with the same settings (an expiry
  keeps its length, counted from now).

## Health

`GET /api/health` → `{ "ok": true }`
