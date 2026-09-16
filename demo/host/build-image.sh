#!/usr/bin/env bash
#
# Bake the demo host image: the operator entry point for infino-demo.pkr.hcl.
#
# Mirrors the pipeline's deploy/gcp/gpu-host/build-image.sh closely enough to
# read side by side, because the two hosts are the same kind of thing: a machine
# that is baked, launched and replaced, never configured while running.
#
# Usage:
#   ./build-image.sh --project <id> --jobs-shards <gs://…/_source/jobs> \
#                    [--ref <branch|sha>] [--version <v>] [--zone <z>]
#                    [--network <n>] [--subnetwork <s>]
#                    [--build-service-account <sa>]
#
#   --project <id>          GCP project to bake in and store the image in.
#   --jobs-shards <gs://…>  The ten Parquet shards of the job-postings corpus,
#                           as staged under the database's own root. Converted
#                           during the bake because the finished host has no
#                           identity with which to read them.
#   --ref <branch|sha>      Which commit of THIS repository to bake. Default:
#                           the checkout's HEAD, so an image says what it is.
#   --version <v>           Version suffix in the image name and label.
#                           Default: the short sha, `-dirty` when the tree has
#                           uncommitted work.
#   --build-service-account The identity the BUILD VM runs as. It must be able
#                           to read --jobs-shards. The finished host runs with
#                           no service account at all.
#
# Credentials come from Application Default Credentials, which is NOT the same
# as a working `gcloud` — see the check below.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="infino-demo.pkr.hcl"
MANIFEST="${TMPDIR:-/tmp}/infino-demo-manifest.$$.json"

die() { echo "[build-image] $*" >&2; exit 1; }
usage() { echo "usage: $0 --project <id> --jobs-shards <gs://…> [--ref <r>] [--version <v>] [--zone <z>] [--network <n>] [--subnetwork <s>] [--build-service-account <sa>]" >&2; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found on PATH: $1
  $2"
}

project=""; jobs_shards=""; ref=""; version=""; zone=""; network=""; subnetwork=""; build_sa=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project) project="${2:?}"; shift 2 ;;
    --jobs-shards) jobs_shards="${2:?}"; shift 2 ;;
    --ref) ref="${2:?}"; shift 2 ;;
    --version) version="${2:?}"; shift 2 ;;
    --zone) zone="${2:?}"; shift 2 ;;
    --network) network="${2:?}"; shift 2 ;;
    --subnetwork) subnetwork="${2:?}"; shift 2 ;;
    --build-service-account) build_sa="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[build-image] unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

[ -n "$project" ] || { echo "[build-image] --project is required" >&2; usage; exit 2; }
[ -n "$jobs_shards" ] || { echo "[build-image] --jobs-shards is required" >&2; usage; exit 2; }

require_cmd packer "install it from https://developer.hashicorp.com/packer/install"
require_cmd gcloud "install the Google Cloud SDK: https://cloud.google.com/sdk/docs/install"

# Packer authenticates through Application Default Credentials, not through
# gcloud's active configuration. A box where `gcloud compute instances list`
# works perfectly well can have none, and what packer does about it is error two
# milliseconds into the bake — long after the operator has committed to it.
if [ -n "${GOOGLE_APPLICATION_CREDENTIALS:-}" ]; then
  [ -f "$GOOGLE_APPLICATION_CREDENTIALS" ] \
    || die "GOOGLE_APPLICATION_CREDENTIALS points at '$GOOGLE_APPLICATION_CREDENTIALS', which does not exist"
  creds="GOOGLE_APPLICATION_CREDENTIALS"
elif [ -f "${CLOUDSDK_CONFIG:-$HOME/.config/gcloud}/application_default_credentials.json" ]; then
  creds="the gcloud ADC file"
elif curl -s -f -m 2 -H 'Metadata-Flavor: Google' \
  http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email >/dev/null 2>&1; then
  creds="this VM's metadata server"
else
  die "no Application Default Credentials, so packer cannot authenticate — and it
would fail two milliseconds into the bake rather than now. Supply them:

  export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
  # or
  gcloud auth application-default login

A working 'gcloud compute' is NOT evidence of this: gcloud reads its active
configuration, packer reads ADC, and the two are set separately."
fi
echo "[build-image] credentials: $creds"

# --- What is being baked ----------------------------------------------------

if [ -z "$ref" ]; then
  ref="$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null)" \
    || die "not a git checkout, so no ref can be derived; pass --ref"
fi

if [ -z "$version" ]; then
  version="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null)" \
    || die "not a git checkout, so no version can be derived; pass --version"
  # An image built from uncommitted work says so in its own name. Scoped to what
  # actually reaches the image: this directory and the demo it serves.
  if [ -n "$(git -C "$SCRIPT_DIR" status --porcelain -- . ../../demo ../../bench ../../src 2>/dev/null)" ]; then
    version="${version}-dirty"
  fi
fi

# GCE label values take lowercase letters, digits, underscores and dashes. An
# invalid one is refused by the API at the very end of a long bake.
case "$version" in
  *[!a-z0-9_-]*) die "version '$version' is not a valid GCE label value; pass --version with one that is" ;;
esac

git_sha="$(git -C "$SCRIPT_DIR" rev-parse HEAD 2>/dev/null || true)"

# --- Bake -------------------------------------------------------------------

rm -f "$MANIFEST"

vars=(
  -var "project_id=$project"
  -var "jobs_shards=$jobs_shards"
  -var "cx_ref=$ref"
  -var "image_version=$version"
  -var "git_sha=$git_sha"
  -var "manifest_path=$MANIFEST"
)
[ -n "$zone" ] && vars+=(-var "zone=$zone")
[ -n "$network" ] && vars+=(-var "network=$network")
[ -n "$subnetwork" ] && vars+=(-var "subnetwork=$subnetwork")
[ -n "$build_sa" ] && vars+=(-var "build_service_account_email=$build_sa")

echo "[build-image] baking infino-demo-host-$version in $project from $ref"
(
  cd "$SCRIPT_DIR"
  packer init "$TEMPLATE"
  packer build "${vars[@]}" "$TEMPLATE"
)

[ -f "$MANIFEST" ] || die "the bake reported success but wrote no manifest at $MANIFEST"
artifact="$(grep -o '"artifact_id": "[^"]*"' "$MANIFEST" | tail -n 1)"
[ -n "$artifact" ] || die "no artifact id in $MANIFEST"
image="${artifact#*: \"}"; image="${image%\"}"
rm -f "$MANIFEST"

cat <<REPORT

[build-image] done
  image:   $image
  family:  infino-demo-host
  project: $project
  built:   $ref

To put a host on it:

  ./launch-host.sh --project $project --zone <zone> --name <instance> \\
    --gateway <host:port> --db-url <url> --key-file <path> --env-file <path>

That launches with NO service account and writes the secrets in at launch, so
the image itself carries none and can be shared.
REPORT
