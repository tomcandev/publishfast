#!/usr/bin/env bash
# One-command upgrade on the server: pull, install when the dependencies changed, build, back up the
# database, migrate, restart, check health. Nobody has to type a password.
#
#   on the VPS:          ~/projects/publishfast/deploy/deploy.sh
#   from another machine: ssh oracle '~/projects/publishfast/deploy/deploy.sh'
#   rebuild and restart without new commits: FORCE=1 deploy/deploy.sh
#
# The restart uses the passwordless sudo rule that exists on the reference VPS for exactly
# `/usr/bin/systemctl restart publishfast.service` (the ".service" matters: `systemctl restart publishfast`
# does not match the rule and asks for a password).
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/projects/publishfast}"
NODE_BIN="${NODE_BIN:-$HOME/.nvm/versions/node/v22.23.4/bin}"   # the Node the service runs (deploy/publishfast.service)
SERVICE=publishfast.service
BACKUPS="${BACKUPS:-$HOME/backups}"
KEEP_BACKUPS=10

export PATH="$NODE_BIN:$PATH"
cd "$APP_DIR"

say() { printf '%s deploy: %s\n' "$(date -u +%H:%M:%S)" "$*"; }
env_value() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- || true; }

# Native modules (better-sqlite3) are built for one Node: install and build with the service's Node only.
case "$(node -v)" in v22.*) ;; *) say "node is $(node -v), expected v22 from $NODE_BIN"; exit 1 ;; esac

# The only local change ever seen here is npm rewriting package-lock.json ("peer" flags) on `npm install`.
# Anything else is someone's work: stop rather than lose it.
dirty=$(git status --porcelain --untracked-files=no)
if [ -n "$dirty" ]; then
  if [ "$dirty" = " M package-lock.json" ]; then
    say "restoring package-lock.json (npm's own rewrite; the repository's lock is the one to install)"
    git checkout -- package-lock.json
  else
    say "tracked files changed on the server; commit or move them first:"; echo "$dirty"; exit 1
  fi
fi

before=$(git rev-parse HEAD)
git pull --ff-only --quiet
after=$(git rev-parse HEAD)
if [ "$before" = "$after" ] && [ "${FORCE:-0}" != 1 ]; then
  say "already at $(git log --oneline -1); nothing to deploy (FORCE=1 rebuilds and restarts)"
  exit 0
fi
[ "$before" != "$after" ] && git log --oneline "$before..$after"

if ! git diff --quiet "$before" "$after" -- package.json package-lock.json server/package.json web/package.json; then
  say "dependencies changed: npm ci"
  npm ci --no-audit --no-fund
fi

say "building"
npm run build >/dev/null

# The database only (WAL-safe online copy); uploads are not touched by a deploy.
data_dir=$(env_value DATA_DIR); data_dir=${data_dir:-$APP_DIR/data}
db="$data_dir/publishfast.db"
mkdir -p "$BACKUPS"
backup="$BACKUPS/publishfast-deploy-$(date -u +%Y%m%d-%H%M%S).db"
sqlite3 "$db" ".backup '$backup'"
chmod 600 "$backup"
ls -1t "$BACKUPS"/publishfast-deploy-*.db 2>/dev/null | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f
say "database backed up to $backup"

node server/dist/db/migrate.js

say "restarting $SERVICE"
sudo -n /usr/bin/systemctl restart "$SERVICE"

port=$(env_value PORT); port=${port:-8055}
code=000
for _ in $(seq 1 30); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/health" || true)
  [ "$code" = 200 ] && break
  sleep 1
done
if [ "$code" != 200 ]; then
  say "health is $code after the restart; the last log lines:"
  journalctl -u "$SERVICE" -n 30 --no-pager || true
  say "to roll back: git checkout $before && npm run build && sudo -n /usr/bin/systemctl restart $SERVICE"
  say "(database before this deploy: $backup)"
  exit 1
fi
say "deployed $(git log --oneline -1), health 200, running since $(systemctl show -p ExecMainStartTimestamp --value "$SERVICE")"
