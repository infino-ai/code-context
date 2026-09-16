#!/usr/bin/env bash
#
# Put a demo host on the newest image in the family.
#
# This is the whole of "cycling the demo": launch a new one, check it, delete the
# old one. Nothing is configured in place, so a host that has drifted is thrown
# away rather than repaired — which is only true while everything it runs comes
# from the image, and that is what this script exists to keep true.
#
# Usage:
#   ./launch-host.sh --project <id> --zone <z> --name <instance> \
#                    --gateway <host:port> --db-url <url> --key-file <path> \
#                    [--env-file <path>] [--machine-type <t>] [--network <n>]
#                    [--subnet <s>] [--address <name|ip>] [--public <dns name>]
#
#   --gateway <host:port>  Where the fleet's gateway is. socat puts it on
#                          127.0.0.1:9110, which is where the demo looks.
#   --db-url <url>         The demo's database, as the demo addresses it —
#                          http://127.0.0.1:9110/<database>.
#   --key-file <path>      A file holding the platform API key. Its CONTENTS are
#                          written to the host; the path is not baked.
#   --env-file <path>      Extra environment for the demo: the model keys and the
#                          three pricing variables. Never baked into the image.
#   --public <dns name>    Also enable caddy for that name. Without it the host
#                          serves on 7777 only and is reachable from the tailnet
#                          or the VPC, which is the default for a reason.
#
# The host is created with NO SERVICE ACCOUNT. Everything it runs is in the
# image, so it needs no identity — and every lane hands an agent file tools over
# a corpus, so an identity on this machine is a credential behind a text box.
set -euo pipefail

die() { echo "[launch-host] $*" >&2; exit 1; }
usage() { echo "usage: $0 --project <id> --zone <z> --name <instance> --gateway <host:port> --db-url <url> --key-file <path> [--env-file <path>] [--address <name|ip>] [--public <dns name>]" >&2; }

project=""; zone=""; name=""; gateway=""; db_url=""; key_file=""; env_file=""
machine_type="e2-standard-8"; network="infino-vpc"; subnet="infino-subnet"
address=""; public_name=""; family="infino-demo-host"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --project) project="${2:?}"; shift 2 ;;
    --zone) zone="${2:?}"; shift 2 ;;
    --name) name="${2:?}"; shift 2 ;;
    --gateway) gateway="${2:?}"; shift 2 ;;
    --db-url) db_url="${2:?}"; shift 2 ;;
    --key-file) key_file="${2:?}"; shift 2 ;;
    --env-file) env_file="${2:?}"; shift 2 ;;
    --machine-type) machine_type="${2:?}"; shift 2 ;;
    --network) network="${2:?}"; shift 2 ;;
    --subnet) subnet="${2:?}"; shift 2 ;;
    --address) address="${2:?}"; shift 2 ;;
    --public) public_name="${2:?}"; shift 2 ;;
    --image-family) family="${2:?}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[launch-host] unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

for required in project zone name gateway db_url key_file; do
  [ -n "${!required}" ] || { echo "[launch-host] --${required//_/-} is required" >&2; usage; exit 2; }
done
[ -f "$key_file" ] || die "no key file at $key_file"
[ -z "$env_file" ] || [ -f "$env_file" ] || die "no env file at $env_file"

gc() { gcloud "$@" --project="$project"; }

image="$(gc compute images describe-from-family "$family" --format='value(name)' 2>/dev/null)" \
  || die "no image in family '$family'; bake one first with ./build-image.sh"
echo "[launch-host] image: $image"

gc compute instances describe "$name" --zone="$zone" >/dev/null 2>&1 \
  && die "$name already exists. Cycling means launching a NEW name and deleting the old one, so both are alive while you check the new one."

# The secrets, assembled here and handed over at creation. They travel in
# instance metadata rather than in the image, so the image can be shared and a
# host can be given a different database without a rebake.
env_payload="$(mktemp)"
trap 'rm -f "$env_payload"' EXIT
{
  echo "# Written by launch-host.sh at creation. Not baked into the image."
  echo "INFINO_GATEWAY=$gateway"
  echo "CX_BENCH_DB_URL=$db_url"
  echo "CX_BENCH_KEY_FILE=/etc/infino/platform.key"
  echo "DEMO_HOST=127.0.0.1"
  [ -n "$public_name" ] && echo "DEMO_NAME=$public_name"
  # The guard is what makes a public text box acceptable; it is set here, with
  # the decision to be public, rather than baked on by default.
  [ -n "$public_name" ] && echo "DEMO_PUBLIC=1"
  [ -n "$env_file" ] && cat "$env_file"
} > "$env_payload"

args=(
  compute instances create "$name"
  --zone="$zone"
  --machine-type="$machine_type"
  --image-family="$family"
  --image-project="$project"
  --network="$network"
  --subnet="$subnet"
  --no-service-account
  --no-scopes
  --labels=infino_role=demo-host
  --metadata-from-file="infino-demo-env=$env_payload,infino-platform-key=$key_file"
  --metadata=startup-script='#!/bin/bash
# Take the secrets out of metadata and put them where the units read them, then
# start. They are fetched once, at boot, and the metadata server is the only
# thing on this host that ever held them.
set -e
mkdir -p /etc/infino
curl -s -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/attributes/infino-demo-env \
  > /etc/infino/demo.env
curl -s -H "Metadata-Flavor: Google" \
  http://metadata.google.internal/computeMetadata/v1/instance/attributes/infino-platform-key \
  > /etc/infino/platform.key
chmod 0600 /etc/infino/demo.env /etc/infino/platform.key
chown infino-demo:infino-demo /etc/infino/demo.env /etc/infino/platform.key
systemctl restart infino-gateway-proxy.service infino-demo.service
if grep -q "^DEMO_NAME=" /etc/infino/demo.env; then
  systemctl enable --now caddy.service
fi
'
)
[ -n "$address" ] && args+=(--address="$address")
[ -z "$address" ] && args+=(--no-address)

echo "[launch-host] creating $name (no service account)"
gc "${args[@]}"

ip=$(gc compute instances describe "$name" --zone="$zone" \
  --format='value(networkInterfaces[0].networkIP)')

cat <<REPORT

[launch-host] done
  instance: $name
  image:    $image
  internal: $ip
  identity: none

It comes up serving; the demo refuses to start until the embedding host answers,
and is retried, so give it a minute. Check it before sending anyone to it:

  curl http://$ip:7777/

To cycle: launch the next one under a new name, check it, then delete this one.
REPORT
