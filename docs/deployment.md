# Deployment

PublishFast is one Node process and one SQLite file. No database server, no
object storage, no containers.

## Requirements

- **Node.js 22 LTS.** Node 24 is not usable yet: `better-sqlite3` and other
  native modules build against V8 APIs that changed. Use `nvm install 22`.
- systemd (or any process supervisor)
- A way to expose the port — the reference deployment uses a Cloudflare Tunnel;
  a normal reverse proxy works too

## Layout on the server

```
~/projects/publishfast/
  server/  web/           # the app
  web/dist/               # built frontend, served by the API process
  data/                   # gitignored — publishfast.db + uploads/
  .env                    # secrets, chmod 600
```

Everything worth backing up lives in `data/` (database, `uploads/`, and the
temporary drop box `files/`). The rest is reproducible from git.

## Install

```bash
git clone https://github.com/tomcandev/publishfast.git ~/projects/publishfast
cd ~/projects/publishfast

source ~/.nvm/nvm.sh && nvm install 22 && nvm use 22
npm install
npm run build

cp .env.example .env
# set AUTH_SECRET — openssl rand -hex 32
chmod 600 .env

npm run seed     # prints the admin password
```

`AUTH_SECRET` is mandatory when `NODE_ENV=production`; the server refuses to
start without it rather than silently signing sessions with a dev fallback.

## systemd

`deploy/publishfast.service` is in the repo. Note the `ExecStart` path:

```ini
ExecStart=/home/ubuntu/.nvm/versions/node/v22.23.2/bin/node server/dist/index.js
```

It must be the **absolute path to the nvm-installed Node 22 binary**. systemd
does not source `nvm.sh`, so a bare `node` may resolve to the wrong version.

```bash
sudo cp deploy/publishfast.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now publishfast
systemctl status publishfast
```

## Exposing it

The server binds to `127.0.0.1` by default — it is not reachable from the
internet on its own.

### Cloudflare Tunnel (what the reference deployment uses)

A tunnel makes an **outbound** connection to Cloudflare, so no inbound port
needs to be open at all. That matters on hosts where the cloud firewall blocks
everything except SSH by default (Oracle Cloud, for instance) — you never have
to touch the network ACL. Cloudflare also terminates TLS and creates the DNS
record for you.

```bash
sudo cloudflared service install <TOKEN>
```

Then in the tunnel's **Published application routes**, add:
`publishfast.example.com` → `HTTP` → `localhost:8055`. Saving that creates the
DNS record automatically; delete any pre-existing `A` record for the same name
first or the save will conflict.

### Reverse proxy instead

Any proxy works — point it at `127.0.0.1:8055` and terminate TLS there. If you
do, open 80/443 in both the host firewall *and* your provider's network ACL.

## Backups

```bash
tar -czf ~/backups/publishfast-$(date +%F).tar.gz -C ~/projects/publishfast data
```

Daily at 03:00, keeping two weeks:

```cron
0 3 * * * find ~/backups -name 'publishfast-*.tar.gz' -mtime +14 -delete && tar -czf ~/backups/publishfast-$(date +\%F).tar.gz -C ~/projects/publishfast data
```

SQLite runs in WAL mode, so copy the whole `data/` directory (not just the `.db`
file) to be sure the `-wal` and `-shm` sidecars come along.

## Upgrades

```bash
cd ~/projects/publishfast
git pull
npm install
npm run build
sudo systemctl restart publishfast
```

Schema changes apply automatically at boot. `data/` is never touched by a
deploy.

### Upgrading to scoped tokens (agent API)

**Before upgrading**, check:

1. Free disk space is well above `MIN_FREE_BYTES` (default 2 GB): `df -h ~/projects/publishfast/data`.
   Below it, every upload answers `507`.
2. The existing uploader (pteflow pipeline) sends no body keys named `releaseAt`, `publishAt`, `meta`
   or `source` with another meaning: they are now read and validated.
3. `sqlite3 data/publishfast.db "select mime, count(*) from assets group by 1"` — any type outside
   png, jpeg, webp, gif, mp4, quicktime and webm will now download instead of opening inline.
4. After the restart, open one image post and one video post on an iPhone.
5. Files in `data/uploads/` that no asset row names (left by contents deleted long ago and by failed
   uploads) are **not** touched: the sweep that would delete them is **off** unless you set
   `SWEEP_ORPHAN_UPLOADS=1`. To look at them first:
   `comm -23 <(ls data/uploads | sort) <(sqlite3 data/publishfast.db "select file_path from assets" | sort)`.

The schema change is additive (new nullable or defaulted columns, new tables
`metric_snapshots`, `token_events`, `files`); existing tokens and sessions keep
working unchanged. Back up first, then run the migration explicitly so you see
it succeed before the restart:

```bash
cd ~/projects/publishfast
tar -czf ~/backups/publishfast-pre-scopes-$(date +%F-%H%M).tar.gz -C ~/projects/publishfast data
git pull
npm install
npm run build
node server/dist/db/migrate.js            # prints "Schema up to date."
sudo systemctl restart publishfast
curl -s http://127.0.0.1:8055/api/health   # {"ok":true}
```

The server process now also runs the **release scheduler**: every 60 seconds it
moves `DRAFT` items whose `release_at` has passed to `READY` (one
compare-and-swap UPDATE, logged as "Release scheduler: released N draft(s)")
and deletes expired drop-box files and uploads in parts left unfinished for 24
hours (`DATA_DIR/upload-parts/`). It does **not** delete anything in
`DATA_DIR/uploads/` unless `SWEEP_ORPHAN_UPLOADS=1` is set: then, on every tick,
it deletes each file there that no asset row names and that is older than one
hour (it re-checks for a row just before deleting). Turning it on deletes every
such file that already exists, so look at them first with the `comm` line above
and keep a backup. It never touches drafts without
`release_at`.

### Upgrading to sounds and the media prune (2026-11-14)

Additive again: four nullable columns on `publications` (`sound_id`, `sound_title`, `sound_author`,
`sound_original`), one on `assets` (`pruned_at`), two new tables (`sounds`, `sound_sightings`). No
existing row changes; no file is deleted by the upgrade. The steps are the usual ones:

```bash
cd ~/projects/publishfast
tar -czf ~/backups/publishfast-pre-sounds-$(date +%F-%H%M).tar.gz -C ~/projects/publishfast data
git pull
npm install
npm run build
node server/dist/db/migrate.js            # prints "Schema up to date."
sudo systemctl restart publishfast
curl -s http://127.0.0.1:8055/api/health   # {"ok":true}
journalctl -u publishfast -n 20 | grep 'Media prune'   # "Media prune: off (…)" until you set it
```

What changes at once: the Sounds tab appears for everyone; the public-count sync now reads TikTok pages
only through the URL guard (TikTok hosts only) and fills each TikTok post's sound. YouTube and other links
are read exactly as before.

**The media prune is off until you set `PRUNE_PUBLISHED_AFTER_DAYS`.** It deletes people's files, so
before the first run:

1. Take a backup of `data/` (above).
2. Migrate first (`node server/dist/db/migrate.js`, part of the upgrade above): the dry run opens the
   database read-only and stops if the schema is older than the code. Then run the dry run with the number
   of days you mean to set, and read it: how many files, how many bytes, the leftovers of an earlier run,
   the 10 largest, and what was left alone (items with a publication time that cannot be read, files
   another row also names, files attached recently).
   ```bash
   cd ~/projects/publishfast
   node server/dist/scripts/prune.js --days 3 --dry-run
   ```
   Only items that are `PUBLISHED` with a publication older than that are listed. If anything there
   should be kept, move that item back to `READY` (Admin → Content) first: the prune never touches it then.
3. Either run it once by hand (`node server/dist/scripts/prune.js --days 3 --yes`) or set
   `PRUNE_PUBLISHED_AFTER_DAYS=3` in `.env` and restart: the server logs
   `Media prune: on …` at start, runs the first prune one hour later, then once a day, and logs each run
   (`Media prune: deleted N file(s), X MB freed on disk …`). If the server clock looks wrong it logs
   `Media prune: refused to run, nothing deleted: …` instead.
   `PRUNE_PUBLISHED_AFTER_DAYS` is a number of days, not an on/off flag like `SWEEP_ORPHAN_UPLOADS`:
   `1` means files go one day after publishing.

**When the prune refuses because of the clock.** It refuses (deletes nothing, logs one line, at most once a
day) when the server clock looks wrong. One of these checks is about a clock that jumped forward: it
refuses when the newest row the server wrote (`created_at` of contents, files or publications) is more
than that many days old. On a server where nothing was created for that long (a quiet week), it refuses for
the same reason, and keeps refusing until something new is created. The log says so:
`Media prune: refused to run, nothing deleted: the newest row this server wrote (…) is more than 3 day(s)
before this server's clock (…): either the clock jumped forward, or nothing was created for 3 day(s). …`.
Check the clock (`date -u`); if it is right, run the prune once by hand with `--trust-clock`, which skips
only this check (the scheduled run never skips it):

```bash
node server/dist/scripts/prune.js --days 3 --dry-run --trust-clock   # read it first
node server/dist/scripts/prune.js --days 3 --yes --trust-clock
```

The dry run and `--yes` exit 1 whenever they refuse.
4. Admin → Storage shows what is stored by item status, what was removed so far and the free disk.

To turn it off again, remove the line (or set `0`) and restart. Files already removed stay removed (restore
them from the backup if needed); their rows say when.

## Tokens

Create **no scoped token until the upgrade's smoke check has passed** (the old
pipeline token ingests, a person can open and claim from the queue).

Scoped tokens are made on the server with the CLI (see `docs/api.md`). Use the
compiled entry so no dev tooling is needed, and send stdout straight to where
the token belongs; it is printed nowhere else. Set `umask 077` first so the
token files are readable by you alone.

A poster account must be assigned-only before it gets a token (the CLI refuses
otherwise), so an agent can never take from the people's open queue:

```bash
cd ~/projects/publishfast
umask 077
node server/dist/scripts/token.js user set --username yt-pte --assigned-only true
node server/dist/scripts/token.js user set --username yt-vichat --assigned-only true
node server/dist/scripts/token.js create --name maker-nhi --scope ingest \
    --assignees yt-pte,yt-vichat --file-prefix nhi/ > ~/maker-nhi.token
node server/dist/scripts/token.js create --name air-pte --scope poster --user yt-pte > ~/air-pte.token
node server/dist/scripts/token.js create --name air-vichat --scope poster --user yt-vichat > ~/air-vichat.token
node server/dist/scripts/token.js create --name weekly-read --scope read --expires 90 > ~/weekly.token
node server/dist/scripts/token.js create --name vps-voice --scope files --file-prefix nhi/ > ~/vps-voice.token
node server/dist/scripts/token.js create --name air-sounds --scope sounds > ~/air-sounds.token
node server/dist/scripts/token.js list
node server/dist/scripts/token.js list --events air-pte
node server/dist/scripts/token.js rotate --name air-pte > ~/air-pte.token
node server/dist/scripts/token.js revoke --name weekly-read
```

`DATA_DIR` is read from `.env`, as for the server. Move each token file to its
machine over a secure channel and delete it here.

## Configuration

| variable | default | notes |
|---|---|---|
| `AUTH_SECRET` | — | **required in production**, `openssl rand -hex 32` |
| `PORT` | `8055` | |
| `HOST` | `127.0.0.1` | keep it on loopback behind a proxy or tunnel |
| `DATA_DIR` | `./data` | database and uploads |
| `PUBLIC_URL` | `http://localhost:8055` | used for absolute links |
| `MAX_UPLOAD_BYTES` | `536870912` (512 MB) | per file |
| `MAX_FILE_BYTES` | `94371840` (90 MB) | per drop-box file (`PUT /api/files/<key>`); keep under Cloudflare's 100 MB request limit |
| `UPLOAD_PART_BYTES` | `33554432` (32 MB) | part size for uploads in parts |
| `SWEEP_ORPHAN_UPLOADS` | off | `1`/`true`: the scheduler deletes files in `uploads/` with no asset row older than one hour |
| `PRUNE_PUBLISHED_AFTER_DAYS` | off | whole days (1–3650); **a number of days, not a flag: `1` means one day**. Once a day the media files of `PUBLISHED` items whose newest publication is older than that are deleted (rows stay, downloads answer `410`). Unset, `0` or anything else = never. Run `node server/dist/scripts/prune.js --days N --dry-run` and read it before setting it |
| `REQUEST_TIMEOUT_MS` | `1800000` (30 min) | longest one request may take, body included; keep above the slowest real upload |
| `MAX_FILES_PREFIX_BYTES` | `2147483648` (2 GB) | drop box: total under one token prefix; admin tokens exempt |
| `MAX_INGEST_BYTES` | `5368709120` (5 GB) | total DRAFT+READY media one ingest-scope token may hold; admin tokens exempt |
| `MIN_FREE_BYTES` | `2147483648` (2 GB) | uploads (all callers) answer `507` when they would leave less free disk |

## Troubleshooting

**`better-sqlite3` fails to build** — you are on Node 24. Switch to 22 and
`rm -rf node_modules && npm install`.

**Service starts then exits** — check `journalctl -u publishfast -n 50`. The
usual cause is a missing `AUTH_SECRET` with `NODE_ENV=production`.

**Uploads fail on large videos** — raise `MAX_UPLOAD_BYTES`, and if you use
Cloudflare's proxy note that the free plan caps request bodies at 100 MB.
