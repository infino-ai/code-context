# The demo host

Everything the machine serving the side-by-side demo needs, so that it is a
thing this repository can rebuild rather than a machine somebody configured.

That distinction is the whole point of this directory. The host ran for weeks on
hand-started processes — `start-demo.sh` and a `socat` under `nohup`, a git
bundle copied into place, corpora that existed on one laptop — and every one of
those is invisible until it is missing. It cost a morning: the demo answered
"Checkout or index not on this host" for two of three corpora because nobody
could have known they were never put there, and a reboot to change the host's
service account took the demo down with no unit to bring it back.

The GPU host has `deploy/gcp/gpu-host/` in the pipeline repository for the same
reason. This is that, for this machine.

## What the host runs

| | |
| --- | --- |
| `infino-demo.service` | the demo itself (`demo/server.mjs`), on `DEMO_HOST:7777` |
| `infino-gateway-proxy.service` | `socat` putting the fleet's gateway on `127.0.0.1:9110`, which is where the demo expects it |
| `caddy` | TLS at the edge, reverse-proxying to the demo — only when the host is public |

## The corpora

**No corpus is in this repository.** Eight gigabytes of checkouts and postings
are fetched or converted on the build VM; what is checked in is four files
totalling about three kilobytes — one `codecontext.json` per corpus naming its
hosted table, and the job-postings field documentation. `files/corpus-metadata/`
is exactly that and nothing else.

Each corpus is a checkout the File Tools arm greps plus an index directory whose
`codecontext.json` names the hosted table. **The local superfile index is not
needed and is not built**: the file-tools arm reads the checkout and the hosted
arms read the platform table, so nothing opens it.

`provision.sh` fetches all three from sources the host can reach itself:

- **infino** — a git checkout at the pinned commit
- **OpenSearch** — a shallow git checkout
- **job postings** — the ten Parquet shards of `edwarddgao/open-apply-jobs` that
  are already staged under the database's own `_source/jobs/` prefix, converted
  to the NDJSON layout the arm reads (250 rows to a file). The layout is part of
  the measurement: the grep arm's cost is a function of how many files it walks.

Nothing is copied from an operator's machine.

## Being public

The demo is a text box that runs tool calls on this host, so two things must be
true before it is reachable from anywhere but the tailnet, and `provision.sh`
refuses to open the firewall unless both are:

1. **`DEMO_PUBLIC=1`**, which swaps the lanes' `bypassPermissions` for
   `bench/public-guard.mjs` — every call checked against the corpus boundary and
   an allowlist of read-only search commands.
2. **The host holds no cloud credential.** It ran with the project's default
   compute service account, which carries `roles/editor`; a shell on the box
   could mint a project token from the metadata server. A demo host needs no
   service account at all.

Neither is optional and neither is the guard alone: the guard is a filter I
wrote, and a filter is the last line rather than the only one.

## HTTPS

Caddy terminates TLS for one name. Behind a Cloudflare-proxied record the
browser's certificate is Cloudflare's, and this end only has to make the
Cloudflare-to-origin hop encrypted — `tls internal` does that and is accepted by
Cloudflare's **Full** SSL mode. It is *not* accepted by **Full (strict)**, which
wants a publicly trusted certificate; a Cloudflare Origin CA certificate dropped
in place of `tls internal` is how to get there.

Let's Encrypt is deliberately unused: once the record is proxied, Cloudflare
answers the HTTP-01 challenge rather than this host, so it cannot complete.
DNS-01 would work and needs a Cloudflare API token.

## Building and launching

Nothing here runs on a live host. The image is baked, a host is launched from
it, and a host that has drifted is replaced rather than repaired.

```sh
# bake — needs ADC, not just a working gcloud
./build-image.sh \
  --project supergrepdemo \
  --jobs-shards gs://<bucket>/<cust>/<db>/_source/jobs \
  --network infino-vpc --subnetwork infino-subnet

# launch — no service account; secrets arrive at creation, never in the image
./launch-host.sh \
  --project supergrepdemo --zone us-east1-b --name infino-demo-2 \
  --gateway 8.233.255.25:80 \
  --db-url http://127.0.0.1:9110/cxbench \
  --key-file ~/.infino/key \
  --env-file ~/demo-secrets.env
```

**Cycling is launching the next one and deleting the last.** `launch-host.sh`
refuses a name that already exists for that reason: both are alive while the new
one is checked, and the old one goes when it is not needed. That is only honest
while everything the host runs comes from the image, which is what this
directory is for.

## What is deliberately not here

- **No step that configures a running host.** If something is missing from a
  host, it is missing from the image; fix it here and bake.
- **No secret.** `/etc/infino/demo.env` and the platform key arrive in instance
  metadata at creation. An image is a thing you hand to a colleague.
- **No local superfile index.** The file-tools arm reads the checkout and the
  hosted arms read the platform table; nothing opens it, and building one would
  drop and recreate the hosted table.
