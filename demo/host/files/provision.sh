#!/usr/bin/env bash
#
# Everything the demo host runs, installed into the image at bake time.
#
# Run BY packer, as root, on the temporary build VM — never on a live host.
# That distinction is the point of this file: a host is replaced, not edited.
#
# It ends with both units installed and enabled and neither started, so a host
# launched from the image comes up serving. It fetches nothing at boot, because
# the finished host is launched with no service account and could not read the
# corpus bucket if it wanted to.
set -euo pipefail

STAGING_DIR=/tmp/infino-demo-host
APP_USER=infino-demo
APP_HOME=/opt/infino/demo
BENCH_ROOT=/opt/infino/bench-repos
CX_DIR="$APP_HOME/code-context"
DUCKDB=/usr/local/bin/duckdb
# The recorded layout of the job-postings corpus. The grep arm's cost is a
# function of how many files it walks, so this is part of the measurement.
JOBS_ROWS_PER_FILE=250

say() { echo "[provision] $*"; }

: "${CX_REPO:?the repository holding the demo}"
: "${CX_REF:?the ref of that repository to bake}"
: "${JOBS_SHARDS:?the gs:// prefix holding the job-postings shards}"
INFINO_REF="${INFINO_REF:-ed4e020}"
OPENSEARCH_REF="${OPENSEARCH_REF:-c72faae5}"

# --- Packages ---------------------------------------------------------------

say "installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# socat puts the fleet's gateway on loopback where the demo expects it; caddy
# terminates TLS when the host is public; unzip because a stock image has none
# and duckdb ships zipped; git for the two corpus checkouts.
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl git socat unzip jq

# Node from NodeSource: the demo needs ≥ 20 and the distribution's is older.
say "installing node"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
apt-get install -y -qq nodejs
say "node $(node --version)"

say "installing caddy"
apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  > /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq
apt-get install -y -qq caddy
# Off until a host is actually made public; launch-host.sh enables it.
systemctl disable caddy >/dev/null 2>&1 || true
systemctl stop caddy >/dev/null 2>&1 || true

say "installing duckdb (the corpus conversion's parquet reader)"
curl -sSL -o /tmp/duckdb.zip \
  https://github.com/duckdb/duckdb/releases/latest/download/duckdb_cli-linux-amd64.zip
unzip -oq /tmp/duckdb.zip -d /tmp
install -m 0755 /tmp/duckdb "$DUCKDB"
rm -f /tmp/duckdb.zip /tmp/duckdb

# --- The user the demo runs as ----------------------------------------------

# Its own account, not the login user: every lane grants the agent file tools
# over a corpus, so what that agent can read should be a decision rather than
# whatever the operator's home directory happens to hold.
say "creating $APP_USER"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/$APP_USER --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_HOME" "$BENCH_ROOT" /etc/infino

# --- The demo itself --------------------------------------------------------

say "cloning $CX_REPO at $CX_REF"
git clone -q "$CX_REPO" "$CX_DIR"
git -C "$CX_DIR" checkout -q "$CX_REF" || {
  say "FATAL: $CX_REF is not a ref of $CX_REPO"
  exit 1
}
say "demo at $(git -C "$CX_DIR" rev-parse --short HEAD)"

say "installing the demo's dependencies"
( cd "$CX_DIR" && npm ci --omit=dev --silent 2>/dev/null || npm install --omit=dev --silent )
( cd "$CX_DIR" && npm run build --silent 2>/dev/null || true )
# The lanes need the agent SDK, which lives in bench/.
( cd "$CX_DIR/bench" && npm install --silent )

# --- The corpora ------------------------------------------------------------

# A checkout at a commit. Shallow when the server serves one by sha, deepening
# when it does not; a fallback to the tip is reported rather than fatal, because
# a few days of commits do not change which files hold a subsystem.
fetch_checkout() {
  local dir="$1" remote="$2" ref="$3" name="$4"
  say "$name: fetching $ref"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" remote add origin "$remote"
  if git -C "$dir" fetch -q --depth 1 origin "$ref" 2>/dev/null; then
    git -C "$dir" checkout -q FETCH_HEAD
  else
    say "$name: the server will not serve $ref directly; deepening"
    git -C "$dir" fetch -q --depth 500 origin
    if git -C "$dir" cat-file -e "$ref^{commit}" 2>/dev/null; then
      git -C "$dir" checkout -q "$ref"
    else
      git -C "$dir" checkout -q FETCH_HEAD
      say "$name: NOT at $ref, at $(git -C "$dir" rev-parse --short HEAD)"
    fi
  fi
  say "$name: $(git -C "$dir" rev-parse --short HEAD), $(du -sh "$dir" | cut -f1)"
}

fetch_checkout "$BENCH_ROOT/infino-ed4e020" \
  "https://github.com/infino-ai/infino.git" "$INFINO_REF" "infino"
fetch_checkout "$BENCH_ROOT/opensearch-shallow" \
  "https://github.com/opensearch-project/OpenSearch.git" "$OPENSEARCH_REF" "opensearch"

# The job postings, converted here from the Parquet already staged under the
# database's own root — the same bytes the hosted table was hydrated from. This
# happens at BAKE time because the finished host has no identity to read them
# with.
say "job postings: downloading the shards from $JOBS_SHARDS"
JOBS_DIR="$BENCH_ROOT/jobs-ndjson"
stage=/tmp/jobs-parquet
mkdir -p "$stage" "$JOBS_DIR"
gcloud storage cp "$JOBS_SHARDS/*.parquet" "$stage/" >/dev/null 2>&1 \
  || { say "FATAL: could not read $JOBS_SHARDS — the build VM needs an identity that can"; exit 1; }

total=0
for shard in "$stage"/*.parquet; do
  base=$(basename "$shard" .parquet)
  board=${base%%-*}
  date=$(echo "$base" | cut -d- -f2-4)
  mkdir -p "$JOBS_DIR/$board"
  flat="$stage/$base.ndjson"
  "$DUCKDB" -c "COPY (SELECT * FROM read_parquet('$shard')) TO '$flat' (FORMAT JSON);" >/dev/null
  rows=$(wc -l < "$flat")
  total=$((total + rows))
  split -l "$JOBS_ROWS_PER_FILE" -d -a 4 --additional-suffix=.ndjson "$flat" "$JOBS_DIR/$board/$date-"
  rm -f "$flat"
  say "  $board $date: $rows rows"
done
rm -rf "$stage"
say "job postings: $total rows in $(find "$JOBS_DIR" -name '*.ndjson' | wc -l) files"

# The index directories are metadata only: a codecontext.json naming the hosted
# table, which is what lets ask/explore skip a build. A build here would be
# actively harmful — with a platform database configured it DROPS and recreates
# the table, which is how the demo's `chunks` lost its 768-dim vectors once.
say "installing the corpora's index metadata"
cp "$STAGING_DIR/corpora/jobs-codecontext.json"       "$JOBS_DIR/.infino-hosted/codecontext.json" 2>/dev/null \
  || { mkdir -p "$JOBS_DIR/.infino-hosted"; cp "$STAGING_DIR/corpora/jobs-codecontext.json" "$JOBS_DIR/.infino-hosted/codecontext.json"; }
cp "$STAGING_DIR/corpora/jobs-CLAUDE.md" "$JOBS_DIR/CLAUDE.md"
mkdir -p "$BENCH_ROOT/opensearch-shallow/.infino" "$BENCH_ROOT/infino-ed4e020/.infino-hosted"
cp "$STAGING_DIR/corpora/opensearch-codecontext.json" "$BENCH_ROOT/opensearch-shallow/.infino/codecontext.json"
cp "$STAGING_DIR/corpora/infino-codecontext.json"     "$BENCH_ROOT/infino-ed4e020/.infino-hosted/codecontext.json"

# --- The units --------------------------------------------------------------

say "installing the units and the launcher"
install -m 0755 "$STAGING_DIR/start-demo.sh"          /usr/local/bin/infino-demo-start
install -m 0644 "$STAGING_DIR/infino-demo.service"    /etc/systemd/system/
install -m 0644 "$STAGING_DIR/infino-gateway-proxy.service" /etc/systemd/system/
install -m 0644 "$STAGING_DIR/Caddyfile"              /etc/caddy/Caddyfile

# The secrets file the units read. Created empty and root-only: launch-host.sh
# writes the real one at launch, and an image that carried keys would be a
# credential anyone it is shared with inherits.
touch /etc/infino/demo.env
chmod 0600 /etc/infino/demo.env

chown -R "$APP_USER:$APP_USER" /opt/infino

systemctl daemon-reload
systemctl enable infino-gateway-proxy.service >/dev/null
systemctl enable infino-demo.service >/dev/null
say "units enabled, neither started"

# --- Leave nothing behind ---------------------------------------------------

say "clearing the staged payload and the apt lists"
rm -rf "$STAGING_DIR"
apt-get clean
rm -rf /var/lib/apt/lists/*

say "removing the build instance's ssh host keys (regenerated on first boot)"
rm -f /etc/ssh/ssh_host_*

say "clearing machine-id"
truncate -s 0 /etc/machine-id

say "done: the demo, its three corpora and both units are installed and enabled"
