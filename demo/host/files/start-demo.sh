#!/usr/bin/env bash
#
# Start the demo. Installed as /usr/local/bin/infino-demo-start and run by
# infino-demo.service, which supplies the environment from /etc/infino/demo.env.
#
# Deliberately thin: everything configurable is a variable in that file, so the
# image is the same wherever it runs and the differences between deployments are
# visible in one place rather than spread through a script.
set -euo pipefail

CX_DIR=/opt/infino/demo/code-context

# The corpora live beside the demo in the image. `DEMO_BENCH_ROOT` lets a host
# point at another tree without a rebuild — for a corpus being trialled, not as
# the ordinary path.
export DEMO_BENCH_ROOT="${DEMO_BENCH_ROOT:-/opt/infino/bench-repos}"

# Bound to loopback unless told otherwise. A host that is reachable from outside
# the tailnet sets both of these together, and the guard is the reason the
# second is safe:
#   DEMO_HOST=0.0.0.0   — bind every interface (or 127.0.0.1 behind caddy)
#   DEMO_PUBLIC=1       — lanes run under bench/public-guard.mjs
export DEMO_HOST="${DEMO_HOST:-127.0.0.1}"

# A build must never happen here: with a platform database configured, the
# client's first find/sql/ask on an index directory without a manifest DROPS and
# recreates the hosted table. Every corpus is indexed before the page is up, so
# auto-index has nothing legitimate to do.
export CX_AUTO_INDEX=0

if [ -z "${DEMO_HOST:-}" ] || [ -z "${CX_BENCH_DB_URL:-}" ]; then
  echo "start-demo: CX_BENCH_DB_URL must be set in /etc/infino/demo.env" >&2
  exit 1
fi

cd "$CX_DIR/demo"
exec node server.mjs
