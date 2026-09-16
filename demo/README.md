# The side-by-side demo

One question, two arms, both bars filling while they run.

| arm | lane | what it is |
| --- | --- | --- |
| Sonnet + grep | `stock-explore` | the stock file tools plus the caller's own Explore subagent — what a developer has today |
| Sonnet + infino | `hosted-full-remote` | the same stock tools plus four code-context tools, `search` on the hosted index, `ask` on our loop — the caller fans out over parallel asks rather than handing one question to a long loop |

Each bar is coloured by where the arm's time went:

- **model** — the caller thinking. Not measured directly: wall clock minus everything below.
- **retrieval** — how the arm finds code. Grep, Glob, LS, Bash and Read on one side; `find`, `search` and `sql` on the other. Hunting the working tree *is* the grep arm's retrieval, which is the whole reason the two are comparable.
- **subagent** — work handed to another loop: the caller's own Explore (`Agent`) on one side, `ask` on ours.

## Running it

Needs Node ≥ 20 (this box's system node is 18 — use a 22), `ANTHROPIC_API_KEY`,
`OPENROUTER_API_KEY` (for the non-Anthropic caller models in the selector), and
the bench deps.

```bash
cd bench && npm install && cd ..
```

```bash
# Keys live in ~/.zshrc (OPENROUTER_API_KEY, optional ANTHROPIC_API_KEY)
source ~/.zshrc
export CX_BENCH_DB_URL=...
export CX_BENCH_KEY_FILE=...
node demo/server.mjs
```

When **`ANTHROPIC_API_KEY` is unset** but **`OPENROUTER_API_KEY` is set**, Haiku/Sonnet/Opus use the Claude Agent SDK with OpenRouter env when configured; **`deepseek-flash`**, **`kimi-k3`**, **`glm-5`**, and **`gpt-5-sol`** use a direct OpenRouter chat runner (same HTTP path as the platform inner loop), not Claude Code.

```bash
export PATH=/home/ubuntu/.local/node/bin:$PATH
export ANTHROPIC_API_KEY=...
export OPENROUTER_API_KEY=...
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

### Where the corpora come from

The demo **provisions nothing**. It expects, already in place:

- the **checkout** on disk (what the grep arm greps), under `DEMO_BENCH_ROOT`;
- the **index dir** beside it, for the manifest the page reads and the ledger
  the charge is measured from;
- the **platform table** the Infino arms query, named by each corpus's `table`.

Creating those is a separate, deliberate act — and the platform tables in
particular are shared state that outlives any one demo run.

**Never point `bench/load-hosted.mjs hosted` (or a bare `cx index --db`) at the
demo's database to "fix" a missing index dir.** Its platform load is a full
rebuild: it drops the table and recreates it from the checkout, which throws
away a table that was provisioned some other way. If what you are missing is
the local index dir, build that alone:

```bash
node bench/load-hosted.mjs /path/to/checkout local
```

The server refuses to boot when the platform, a corpus's lean table card or the
embedder is unreachable (`platform-health.mjs`), so a half-provisioned demo
fails at startup rather than serving degraded arms that still look green.

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
| `DEMO_BENCH_ROOT` | `$HOME/bench-repos` | parent directory for default corpus checkout folder names |
| `DEMO_CORPUS_<ID>_REPO` | under `DEMO_BENCH_ROOT` | override checkout path for corpus `infino`, `opensearch`, or `jobs` |
| `DEMO_CORPUS_<ID>_INDEX` | `<repo>/.infino-hosted` or `.infino` | override index dir; otherwise `.infino-hosted` / `.infino` with fallback |
| `CX_BENCH_REPO` | first corpus default | legacy default repo for boot logs only |
| `CX_INDEX_DIR` | `<repo>/.infino-hosted` | the index dir, and the ledger read for our charge |
| `CX_BENCH_DB_URL`, `CX_BENCH_KEY_FILE` | — | the platform database and its key file |
| `DEMO_FIXTURE` | off | scripted run, no spend |
| `DEMO_PRICING_FILE` | `~/.infino/demo-pricing.json` | the durable source of the three rates below, as JSON keys `readTokenUsdPerMillion`, `modelTokenUsdPerMillion`, `markup`; outside the repo so no sell price is committed, and a variable set in the environment overrides its key |
| `DEMO_READ_TOKEN_USD_PER_M` | from the file | price of a read token |
| `DEMO_MODEL_TOKEN_USD_PER_M` | from the file | blended inference cost |
| `DEMO_INFERENCE_MARKUP` | from the file, else `0` | fraction added to inference, e.g. `0.3` |
| `OPENROUTER_API_KEY` | — | required for OpenRouter caller models (`deepseek-flash`, `kimi-k3`, `glm-5`, `gpt-5-sol`) |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter Anthropic-compatible API base |
| `DEMO_CALLER_OPENROUTER` | auto | `1` forces all caller models through OpenRouter; `0` forces direct Anthropic for Haiku/Sonnet/Opus when `ANTHROPIC_API_KEY` is set |
| `DEMO_MODEL_<FAMILY>` | see `bench/caller-models.mjs` | override the provider model id for one family (e.g. `DEMO_MODEL_GLM_5=z-ai/glm-4.6`) |

Caller model families and default OpenRouter slugs live in **`bench/caller-models.mjs`**
(single source for the demo selector and `bench/lanes.mjs`).

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
