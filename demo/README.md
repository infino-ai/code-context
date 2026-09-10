# The side-by-side demo

One question, two arms, both bars filling while they run.

| arm | lane | what it is |
| --- | --- | --- |
| Sonnet + grep | `stock-explore` | the stock file tools plus the caller's own Explore subagent — what a developer has today |
| Sonnet + infino | `hosted-full-remote` | the same stock tools plus all five code-context tools, `search` on the hosted index, `ask`/`explore` on our loop |

Each bar is coloured by where the arm's time went:

- **model** — the caller thinking. Not measured directly: wall clock minus everything below.
- **retrieval** — how the arm finds code. Grep, Glob, LS, Bash and Read on one side; `find`, `search` and `sql` on the other. Hunting the working tree *is* the grep arm's retrieval, which is the whole reason the two are comparable.
- **subagent** — work handed to another loop: the caller's own Explore (`Agent`) on one side, `ask`/`explore` on ours.

## Running it

Needs Node ≥ 20 (this box's system node is 18 — use a 22), `ANTHROPIC_API_KEY`, and the bench deps.

```bash
cd bench && npm install && cd ..
```

```bash
export PATH=/home/ubuntu/.local/node/bin:$PATH
export ANTHROPIC_API_KEY=...
export CX_BENCH_DB_URL=http://127.0.0.1:9110/cxbench
export CX_BENCH_KEY_FILE=/path/to/cxbench.key
node demo/server.mjs
```

It binds `127.0.0.1:7777` and fails at startup, not on the first click, if the
hosted arm has no database or key.

To develop the page without spending anything:

```bash
DEMO_FIXTURE=1 node demo/server.mjs
```

That replays a scripted run — invented data, a red banner on the page saying so,
no model and no platform call. Its spans go through the real phase arithmetic,
so what it exercises is the actual code over made-up numbers.

### Over the tailnet

`tailscale serve` already proxies `/` to the gateway on this box, so give the
demo its own port rather than a path — additive, and it leaves that entry alone:

```bash
tailscale serve --bg --https 8443 7777
```

Undo with `tailscale serve --https 8443 off`. **Never `tailscale serve reset`** —
it wipes the existing `/` proxy to the shared gateway.

## Configuration

| variable | default | what it does |
| --- | --- | --- |
| `PORT` / `DEMO_HOST` | `7777` / `127.0.0.1` | where it binds |
| `CX_BENCH_REPO` | `bench-repos/infino-ed4e020` | the repo under test |
| `CX_INDEX_DIR` | `<repo>/.infino-hosted` | the index dir, and the ledger read for our charge |
| `CX_BENCH_DB_URL`, `CX_BENCH_KEY_FILE` | — | the platform database and its key file |
| `DEMO_MAX_RUNS` | `25` | runs served before the process refuses more |
| `DEMO_FIXTURE` | off | scripted run, no spend |
| `DEMO_READ_TOKEN_USD_PER_M` | unset | price of a read token |
| `DEMO_MODEL_TOKEN_USD_PER_M` | unset | blended inference cost |
| `DEMO_INFERENCE_MARKUP` | `0` | fraction added to inference, e.g. `0.3` |

**No price is baked in.** With the rate variables unset the demo shows metered
tokens and no dollar sign. A rate is a commercial decision; one guessed here
would go stale silently and be quoted back as if it had been measured.

## Why it behaves the way it does

**Runs are serialized.** Two reasons, both real. The worker admits four
concurrent model calls per database and refuses the fifth outright rather than
queueing it. And the client's usage ledger carries no run id, pid or session
marker, so two overlapping runs against one index dir cannot have their charge
told apart afterwards — attribution here is by ledger byte offset before and
after, which is exact only while one run touches that dir at a time.

**Spans are unioned, never summed.** Several tool calls in one assistant message
run *concurrently* (`batch` in `bench/lanes.mjs`). Adding their durations would
push the segments past the wall clock on exactly the fan-out questions this
demo exists to show. Three greps spanning 1.8–4.2s count as 2.4 seconds, not 7.1.

**A subagent's own calls are inside its span.** They carry `inSubagent` and are
skipped, or the same seconds would be counted twice.

**A call still open when the run ends** is closed at the wall clock, so an
interrupted run still adds up.

## What this is not

One question is an anecdote. The published comparison is 36 questions with a
blind judge, and a single pair will sometimes go the grep arm's way. The saving
concentrates on questions that make an agent fan out — on the recorded set nine
of thirty-six questions carried two thirds of the grep arm's whole bill, and on
the other twenty-seven the two arms cost about the same. The page says so under
the bars; don't remove that line.

Every click is two full agent runs: roughly $0.32 on Sonnet, and the grep arm's
slowest recorded question took 5 minutes 40.

Every lane grants Bash on the real checkout under `bypassPermissions`. The
question box is a prompt to an agent that can run shell commands here, so this
belongs behind the tailnet and nowhere else.

## Tests

```bash
cd demo && node --test demo-tests.mjs
```

Node's built-in runner, matching `bench/harness-tests.mjs` — these import
`../bench/lanes.mjs`, which needs the agent SDK from `bench/node_modules`, and
the root `npm test` (vitest over `src/`) runs without it. No model, no network,
no index: every stream in them is a literal.
