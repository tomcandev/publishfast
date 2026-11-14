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
| `sounds` | nobody | `POST /api/sounds/sightings`, `GET /api/sounds` | everything else (also `from-link`, which is for people) |

`read` tokens may also call `GET /api/sounds` (the ranking).

- The allow-list for the narrow scopes (`ingest`, `poster`, `read`, `files`, `sounds`) lives in one place,
  [`server/src/lib/scopes.ts`](../server/src/lib/scopes.ts), and is enforced for every request in the
  auth hook before the route runs. A route that is not listed answers **403** to these scopes, so a new
  route is closed to them until someone adds it there on purpose.
- An `ingest` token with assignees must give every item it creates or patches an `assignedUserId` from
  that list (`400` otherwise). With no assignees it may create unassigned items.
- A `poster` token acts as its user with kol power, and only ever sees and claims items **assigned to
  that user**, never the open queue, whatever the account's `assignedOnly` says. The CLI only makes
  poster tokens for kol users that are `assignedOnly`.
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
`assignExpiresAt`, `meta`, `source`, and who holds the claim: `claimedVia` (`"token"`, `"session"` or `null`),
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
`publishedUrl`: a token must send an `http://` or `https://` link. A signed-in person may also save
other absolute links (e.g. an app link `snssdk1233://…`), as before, except those whose scheme — as the
URL parser reads it, so hidden tabs, newlines or control characters do not count — is `javascript:`,
`data:`, `vbscript:` or `file:`.
Optional `publishedAt` (ISO 8601; an offset is converted to UTC) — e.g. a scheduled video's public time.

Submitting the same `(contentId, platform)` again updates the existing row.
Returns `403` if the caller is not holding that content item.

### `DELETE /api/publications/:id`

### `POST /api/publications/:id/metrics`

The publication's owner (session or poster token), an admin session or an admin token.

```json
{ "takenAt": "2026-11-29T13:00:00Z", "label": "24h", "views": 812, "likes": 40, "comments": 3,
  "saves": 25, "extra": { "avgViewDurationSec": 31.5, "ctr": 0.062 } }
```

All fields optional; counts (`views`, `likes`, `comments`, `shares`, `saves`) are whole numbers ≥ 0. `label` ≤ 20 chars (`24h`, `7d`, `28d`, `daily`); `extra` a JSON object ≤ 16 KB;
`takenAt` defaults to now and may not be in the future. Stores a row in `metric_snapshots` and, when the
reading is at least as new as the publication's `lastCheckedAt`, makes its counts the publication's
latest. Returns `201 { snapshot, publication }`. Anyone else gets `404`.

### `GET /api/publications/:id/metrics`
Same access. `{ publication, snapshots }`, oldest first. The automatic public-count sync adds a
snapshot labelled `auto` each time it reads fresh counts, with TikTok's save count (`collectCount`) as
`saves`. Publications in content responses carry their latest `saves` (`null` until one was read or sent).

---

## Media (session or poster token)

| route | purpose |
|---|---|
| `GET /api/assets/:id` | inline — video player, image preview |
| `GET /api/assets/:id/download` | attachment download |
| `GET /api/contents/:id/assets.zip` | whole carousel as one zip |

Each request re-checks that the caller may see the parent content item, so media
is exactly as protected as the item itself.

A file removed by the media prune (see [Media prune](#media-prune)) answers **`410`**
`{ "error": "Media removed 2026-11-17", "reason": "pruned", "prunedAt": "…" }` on both routes. The zip
holds only the item's files that still exist and answers `410` when none does. Someone who may not see
the item still gets `404`. Every asset in a content response carries `prunedAt` (`null` while
the file exists).

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
* `assignExpiresAt` (ISO 8601, needs `assignedUserId`, `400` otherwise): the assignment ends then. See
  [Expiring assignments](#expiring-assignments). An `ingest`-scope token with an assignee list may not set it
  (`400`): its items stay with its assignees.
* `publishAt` (ISO 8601): when the post should go public on its platform; shown to the poster.
* `meta`: a JSON object ≤ 64 KB, free-form per platform (e.g. `meta.youtube.title`, `description`, `tags`).
* `source`: ≤ 200 chars, where it came from (e.g. `nhi#12`).
* `409` if `code` already exists.
* Scoped (`ingest`) tokens: `code` may only use `A-Z a-z 0-9 . _ -`. With assignees, `assignedUserId`
  must be one of them; with an empty list, items must be unassigned. Unknown users and users outside the
  list get the same `400`.

Responses never include the internal `createdByToken` / `claimedByToken` ids. Times are stored as UTC. An `ingest`-scope token may only read, patch, upload to, withdraw or delete
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
Delete one asset, or the whole item with its files. `DRAFT` only (`409` otherwise). Withdraw and both
deletes answer `409` with `reason: "has_publications"` when the item has any published link, so links
and metric history are never erased.

### Uploads in parts — for files over 32 MB

Cloudflare (in front of the server) refuses request bodies over 100 MB, so large files go in parts.
Ingest-scope tokens on their own `DRAFT` item, and admin tokens (old ones included); not sessions.

| route | what |
|---|---|
| `POST /api/ingest/contents/:id/uploads` | JSON `{name, size, mime?, sha256?}` → `201 {uploadId, partSize, parts}`. `partSize` is `UPLOAD_PART_BYTES` (32 MB); `parts` = ceil(size / partSize). The declared size is checked against the per-file cap (`413`), the token's total (`413`) and the free-space floor (`507`) before any byte. `name`: 1–255 chars, no `/ \` or control characters; svg/html/xml refused for scoped tokens |
| `PUT …/uploads/:uploadId/parts/:n` | raw body (`Content-Type: application/octet-stream`), `n` from 1 to `parts` (`400` beyond). Part `n` is at most its expected length: `partSize`, and `size - (parts-1) × partSize` for the last (`413`, checked on `Content-Length` and on the bytes received) → `{part, size}`. Sending a part again replaces it; any order. `409` while the upload is being completed |
| `GET …/uploads/:uploadId` | `{uploadId, name, size, partSize, parts, received: [n…], completed}` — to resume |
| `GET /api/ingest/contents/:id/uploads` | the item's unfinished uploads `{uploads: [{uploadId, name, size, partSize, received}]}`, for a client that lost the id. The same list is in `GET /api/ingest/contents/:id` and `?code=` answers as `uploads` |
| `POST …/uploads/:uploadId/complete` | marks the upload as completing (one request at a time: a second `complete` during the join answers `409 reason: completing` — **retry it after a short wait**, it then answers the finished asset; a mark older than 10 minutes counts as a crashed join). Every part there and sizes add up, else `409 {missing, receivedBytes}`; the bytes joined must equal `size`; joins them in order while hashing; a declared `sha256` that does not match → `422` and nothing is kept; creates the asset exactly as the multipart route (type and mime rules, sort order) → `201 {asset}`. Completing again answers the same asset |
| `DELETE …/uploads/:uploadId` | abort: deletes the parts. `409` while it is being completed |

A scoped token may run at most 4 upload requests at once across the three upload routes (multipart
assets, parts, drop-box `PUT`): beyond that `429 reason: too_many_uploads`. Old and admin tokens are not
limited. A request that is closed before its body ends releases everything at once and leaves no file.

Parts live under server-made names (`DATA_DIR/upload-parts/<uploadId>/<n>.part`); nothing the client
sends becomes a path. Unfinished uploads count toward the token's total, are deleted when the item
leaves `DRAFT` or is deleted, and are swept (rows and bytes) after 24 hours. Another token's upload or
item answers `404`; a non-draft `409`.

**Disk limits.** Every upload answers `507` when it would leave less than `MIN_FREE_BYTES` free, counting
the uploads in flight in the server. An ingest-scope token may hold at most `MAX_INGEST_BYTES` of media in
its `DRAFT` and `READY` items, counting open uploads in parts and its other requests in flight (`413`
beyond; a multipart request counts its whole body). A failed, oversize or aborted upload leaves no bytes and no rows behind.

Asset `type`: a declared `video/*` is `video` and `image/*` is `image`. Otherwise the file name decides:
image extensions (`.jpg .jpeg .png .webp .gif .heic .heif`) are `image` and video extensions
(`.mp4 .m4v .mov .webm`) are `video`, stored with their real type; `.srt .vtt .ass .ssa .txt .json .csv
.md .pdf .zip` are `file`; anything else keeps the old behaviour and is an `image`. This covers parts sent
with no type, `application/octet-stream` or `binary/octet-stream`. Scoped tokens may not upload svg,
html or xml. Downloads are inline only for png, jpeg, webp, gif, mp4, quicktime and webm; everything
else is an `application/octet-stream` attachment, always with `nosniff` and a sandbox CSP.

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
| `GET /api/admin/contents` · `PATCH`/`DELETE /api/admin/contents/:id` | manage content (`PATCH` also takes `assignExpiresAt`: an ISO time or `null`; it needs an assignee, `400` otherwise; setting `assignedUserId` to `null` clears it. Optional `ifStatus` (a status) and `ifUnclaimed: true` make the write one compare-and-swap that applies only while the item still has that status and no claimer, else `409 {reason: "changed", status}` and nothing is written; without them the PATCH behaves as before. An assigner sends `ifStatus: "READY", ifUnclaimed: true` so it never overwrites a claim) |
| `DELETE /api/admin/assets/:id` | remove a file |
| `GET /api/admin/publications` | all recorded links |
| `GET/POST /api/admin/tokens` · `DELETE /api/admin/tokens/:id` | API tokens (unscoped, as before; the list also shows `scope`, `expiresAt`, `revokedAt`) |
| `POST /api/admin/release-stale` | `{ "hours": 24 }` — requeue abandoned claims |
| `GET /api/admin/storage` | `{ byStatus: [{status, files, bytes}], pruned: {files, bytes}, dropBox: {files, bytes}, unfinishedUploads: {uploads, bytes}, disk: {freeBytes, totalBytes}, prune: {afterDays} }` — media bytes by item status (files that still exist), what the prune removed so far, the drop box, unfinished uploads in parts, free disk |
| `PATCH /api/admin/sounds/:id` | `{ "status"?: "active" \| "hidden", "note"?: string ≤ 300 \| null }` — hide or note a sound (`404` unknown) |

Setting an item's status to `DRAFT` through `PATCH /api/admin/contents/:id` or `bulk-status` cancels a
pending `releaseAt`, so a soft-archived item is not put straight back in the queue.

### Expiring assignments

An item assigned to a posting account (for a clean experiment) can carry `assignExpiresAt`, so it never gets
stuck on an account that is not posting. Every 60 seconds the scheduler runs one compare-and-swap:

```sql
UPDATE contents SET assigned_user_id = NULL, assign_expires_at = NULL
WHERE status = 'READY' AND assigned_user_id IS NOT NULL AND claimed_by IS NULL
  AND assign_expires_at IS NOT NULL AND assign_expires_at <= now
```

logged as "Release scheduler: N expired assignment(s) returned to the open queue". The item then sits in the
open queue for anyone (an assigned-only account no longer sees it). It never touches an item without
`assignExpiresAt` (assigned for ever, e.g. the YouTube accounts' items), nor a claimed, published, draft or
failed item; a claim that lands first wins. The queue shows the assignee "yours until <time>".

## Export — for analysis (read token, admin token or admin session)

### `GET /api/export/publications?since=<ISO>&assignee=<username>&format=<json|csv>`
One row per publication: `publicationId, code, title, captionFirstLine, hookId, source, assignee, poster,
platform, url, publishedAt, publishAt, views, likes, comments, shares, saves, lastCheckedAt`.
`captionFirstLine` is the first non-empty line of the item's caption (the hook), trimmed, control and
direction characters removed, at most 200 characters, `""` when there is no caption; `hookId` is the
item's `hook_id`, `""` when none. `since` filters on the
publication's `publishedAt` (or creation time). JSON is `{ rows: [...] }`.

### `GET /api/export/metrics?since=&assignee=&format=`
One row per snapshot: the same identifying columns plus `takenAt, label, views, likes, comments,
shares, saves, extra`. `since` filters on `takenAt`.

No emails, notes, full captions (only their first line), meta, asset paths or token data in either. Unknown `assignee` → `400`. In
CSV, text starting with `= + - @` is prefixed with `'` so a spreadsheet does not run it.

## Drop box — temporary hand-over files (files token, ingest token for reads, admin token)

Keys are slash-separated paths of 1–200 chars; each segment `[A-Za-z0-9._-]+`, not starting with a dot,
no empty segments (`400` otherwise). A token touches only keys starting with its `file_prefix`; a token
without one touches nothing; admin-power tokens see every key. Missing, expired and out-of-prefix keys
all answer `404` (never `403`). Sessions are not used here.

| route | who | what |
|---|---|---|
| `PUT /api/files/<key>` | `files`, admin | raw request body, streamed to disk, max `MAX_FILE_BYTES` (default 90 MB, under the tunnel's 100 MB limit; `413` beyond, nothing kept). Header `X-Expires-Days` 1–30, default 7. Replaces an existing key (old bytes deleted). `201` (new) / `200` (replaced) `{ key, size, sha256, expiresAt }` |
| `GET /api/files/<key>` | `files`, `ingest`, admin | the bytes, with `X-Sha256` and `X-Expires-At` |
| `HEAD /api/files/<key>` | same | the headers only: `Content-Length`, `X-Sha256`, `X-Expires-At` |
| `DELETE /api/files/<key>` | `files`, admin | delete now |
| `GET /api/files?prefix=<p>` | `files`, admin | `{ files: [{ key, size, sha256, expiresAt }] }` under the token's prefix |

```bash
curl -X PUT --data-binary @issue-12.zip -H "Authorization: Bearer $PF_FILES_TOKEN" \
  -H 'X-Expires-Days: 14' https://publishfast.example.com/api/files/nhi/voice/issue-12.zip
```

Expired files (row and bytes) are deleted by the server's scheduler every minute. The total under one
token prefix is capped at `MAX_FILES_PREFIX_BYTES` (`413`; admin tokens exempt), and a `PUT` answers
`507` below the free-space floor.

## Sounds — a ranked bank of TikTok sounds

People attach a sound by hand in the TikTok app; the bank tells them which one to look for and learns
which ones worked for us. Sounds enter it **only from what the server itself reads on a TikTok video
page**: callers send video links, never sound names or counts (extra fields are ignored).

**The URL guard** (`guardedFetch` in `server/src/lib/guardedFetch.ts`, used for every server-side read
of a link: TikTok pages, the sync's YouTube pages and tikwm): parsed with the URL parser; `https` only;
host exactly one of the caller's set (TikTok: `www.tiktok.com`, `tiktok.com`, `vt.tiktok.com`,
`vm.tiktok.com`, `m.tiktok.com`); no userinfo, no port (a default
`:443` is dropped by the parser), no IP literal; at most 2048 characters. Redirects are followed by hand,
at most 5, every `Location` re-checked by the same rule. 15 s for the whole read, 3 MB body cap. The
fetched page and any upstream error text are never returned; failures answer a `reason`:
`refused`, `redirect_refused`, `too_many_redirects`, `too_large`, `timeout`, `unreachable`, `not_found`
(a non-2xx page), `no_sound` (no video data on the page).

### `POST /api/sounds/sightings` (`sounds` token, admin token or admin session)

```json
{ "items": [ { "videoUrl": "https://www.tiktok.com/@someone/video/7400000000000000101", "source": "trend", "region": "AU", "rank": 3 } ] }
```

1–50 items; `source` is `trend`, `viral` or `manual`; `region` 2 letters (optional); `rank` 1–1000
(optional, its place in a trending list). The server reads each page (at most 4 reads at once across the
server, one of them kept for people's pastes; a call stops starting new reads after 75 s and answers those
items `unreadable`/`time_budget`; one call at a time per caller, `429 {reason: "busy"}` otherwise; a `sounds`
token may report 600 links a day (UTC, per server process): a call that would go over is refused whole
with `429 {reason: "daily_limit", remaining}`) and answers per item:

```json
{ "results": [ { "videoUrl": "…as sent…", "status": "recorded", "soundId": "7300000000000000201" },
               { "videoUrl": "…", "status": "known", "soundId": "…" },
               { "videoUrl": "…", "status": "unreadable", "reason": "refused" } ] }
```

`known`: the video was already in the bank (its counts, sound and `seen_at` are refreshed, and the
`source`/`region`/`rank` of this call replace the old ones, except that a later `manual` report never
replaces a `trend` or `viral` one), or it is one of our own posts (nothing recorded; only an admin caller
is told `reason: "our_post"`).

### `POST /api/sounds/from-link` (a signed-in person, or an admin token)

`{ "videoUrl": "…" }` — the "paste a viral video you saw" box: the same read for one link, source
`manual`. `200 { status: "recorded" | "known", sound: { id, title, author, original, url, copyText } }`;
`400 {reason: "refused"}` for a link that is not a TikTok video link; `422 {reason}` when no sound could be
read; `429 {reason: "daily_limit"}` after 30 pastes a day per person. Not for tokens other than admin ones.

### `GET /api/sounds?window=<7|14|30>&limit=<1-200>` (any signed-in person; `sounds`, `read` and admin tokens)

Default `window=14`, `limit=50`. Active sounds, best first (admins may add `hidden=1` to include hidden ones;
admins also get `note`). The ranking is computed at most once a minute per window and cleared whenever the
bank changes:

```json
{ "window": 14, "sounds": [ {
  "id": "7300000000000000201", "title": "Lofi Study Loop", "author": "Example Band", "original": false,
  "url": "https://www.tiktok.com/music/Lofi-Study-Loop-7300000000000000201",
  "copyText": "Lofi Study Loop Example Band", "status": "active",
  "ours": { "posts": 4, "medianRatio": 2.3, "enough": true },
  "sightings": { "count": 2, "bestPlays": 98765, "bestRank": 3, "sources": ["trend"],
                 "newestVideoUrl": "…", "bestVideoUrl": "…", "bestVideoPlays": 98765 },
  "score": 9.12, "lastSeenAt": "…" } ] }
```

- `copyText` is what finds the sound in TikTok's "Add sound" search: `<title> <author>` for a named track,
  `original sound <author>` for an original sound.
- `ours`: our publications with this sound whose time (`published_at`, else `created_at`) is inside the
  window; `medianRatio` is the median of each post's views divided by its account's median views (same
  user, same platform, same window); `enough` is false below 3 posts (the web shows "not enough of our own
  posts yet").
- Sightings count whenever they were seen; `staleness` ages them.

**Ranking** (`soundScore` in `server/src/lib/sounds.ts`):

```
score = 3 × clamp(ourMedianRatio, 0, 5) × min(1, ourPosts / 3)
      + 2 × log10(1 + bestPlays) / 6
      + (bestRank ? (51 − min(bestRank, 50)) / 50 : 0)
      − 0.1 × max(0, days since last_seen_at − 7)
```

`last_seen_at` is the newest evidence: a sighting's time, or the publication time of our post with it.

The public-count sync (`POST /api/admin/metrics/sync`, `track-metrics`) fills each TikTok publication's
`soundId`, `soundTitle`, `soundAuthor`, `soundOriginal` from the page it reads, and adds the sound to the bank.

What the sync reads: it parses each saved link. A TikTok link (an `http://` one is read as `https://`)
goes through the guard with the TikTok hosts, and tikwm is asked only about a link that passed it, without
its query string, through the same guard (host `www.tikwm.com`, 15 s, 3 MB). An `https` (or `http`) link on
`www.youtube.com`, `youtube.com`, `m.youtube.com` or `youtu.be` goes through the guard with those hosts;
redirects must stay on them. Any other link is **not fetched**: it keeps its counts. A third-party
shortener (bit.ly …) that points at TikTok or YouTube is no longer followed.

## Media prune

Off unless `PRUNE_PUBLISHED_AFTER_DAYS` is set (whole days: `1` means one day). Once a day (first run one
hour after the server starts) the scheduler deletes the media **files** of items that are `PUBLISHED` and
whose every publication is older than that many days. A publication's time is the **later** of its
`published_at` (sent by the poster) and its `created_at` (written by the server), so back-dating a link
cannot make media go early; only strict ISO times with a zone are read (`2026-11-11T10:00:00Z`,
`…+08:00`), anything else makes the item "unreadable" and it is left alone. Asset rows stay with
`prunedAt` and their size; the item, its links, counts and snapshots stay.

Never touched: `DRAFT`, `READY`, `CLAIMED`, `FAILED` items; items with no publication or an unreadable
time; a file attached less than that many days ago (its own `created_at`); a file another asset row also
names; the drop box; unfinished uploads. Nothing at all when the server clock looks wrong: a publication
recorded (`created_at`) more than 24 hours ahead of the clock, or a clock before the newest file's upload
time; the run logs one line and deletes nothing. A file is deleted only after its row is marked and only
while no unpruned row names it.

Once an item's media is gone (pruned rows and no live file), it cannot go back to a claimable state:
`PATCH /api/admin/contents/:id` and `bulk-status` to `READY`/`CLAIMED`, and an admin-token
`PATCH /api/ingest/contents/:id` to `READY`, answer `409 {reason: "media_pruned"}` (bulk: with `ids`, and
nothing is written), and the queue never lists or hands out such an item.

By hand, with the same selection:

```bash
node server/dist/scripts/prune.js --days 3 --dry-run   # read-only: count, bytes, leftovers, the 10 largest
node server/dist/scripts/prune.js --days 3 --yes       # does it once
```

The dry run opens the database read-only and never migrates it (an older schema: it says to run
`migrate.js` first and stops). It prints what the real run would delete, including files left on disk by
an earlier run that died between marking and deleting (count and bytes on disk). The real run reports
bytes freed both by the database's sizes and as measured on disk.

## Token CLI

Tokens are made on the server, not in the web page:

```bash
npm run -s token -w server -- create --name <name> --scope <admin|ingest|poster|read|files|sounds> \
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
- `--user` (an assigned-only kol user) is required for `poster`; `--assignees` is only for `ingest`; `--file-prefix` is
  required for `files` and optional for `ingest`. `sounds` takes none of them. A duplicate active name is refused.
- `list` shows name, scope, user, assignees, file prefix, created, last used, expires, revoked — never a
  token or a hash. `--events <name>` shows that token's last 50 state-changing calls.
- `rotate` revokes the active token of that name and makes a new one with the same settings (an expiry
  keeps its length, counted from now). In the same transaction the items it created, the claims it holds
  and its drop-box files move to the new token, so a draft or an in-flight claim continues.

## Known limits (documented, not built)

- The TikTok URL guard pins host names, not addresses: it trusts TikTok's DNS for those four names.
- Sound sightings and their sounds are never pruned (small rows).

- `token_events` and `metric_snapshots` are never pruned. Both are small rows; prune by hand (or add a
  job) if they ever matter.
- A person cannot correct a link on an item an agent's token completed (it stays held by that token:
  `409 held_by_agent`). An admin can.
- If the process dies in the instant between moving a joined upload into `uploads/` and committing its
  asset row, that one file stays with no row. Files like that (and older ones from deleted contents) are
  only removed when `SWEEP_ORPHAN_UPLOADS=1` is set; it is off by default.

## Health

`GET /api/health` → `{ "ok": true }`
