<div align="center">

![code-context: let your coding agent search, not crawl](docs/banner.png)

[![CI](https://github.com/infino-ai/code-context/actions/workflows/ci.yml/badge.svg)](https://github.com/infino-ai/code-context/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@infino-ai/code-context?label=%40infino-ai%2Fcode-context&logo=npm)](https://www.npmjs.com/package/@infino-ai/code-context)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-green.svg)](https://nodejs.org/)

</div>

# Infino Subagent for Claude Code

**Faster code retrieval locally. Parallel AI exploration when you need it.**

Claude Code stays the main agent. Infino Subagent takes the exploration work
off it, in two places:

- **`find` - local.** The repository is indexed on your machine, and exact-text
  lookups ("every use of `commit_manifest`", "where is this error string")
  come back as `path:line` hits from the index instead of a grep-and-read loop
  that pulls source into Claude's context one file at a time. Milliseconds,
  offline, fewer tokens in the main agent.
- **`explore` - cloud.** A question that spans the repository ("how does an
  append become durable?") goes to Infino's platform, where the same index is
  kept, and small fast models run the investigation there: retrieve, read,
  follow, write an answer, and cite it. Around each worker sits what makes a
  small model's answer hold: the retrieval that gives it the right context, a
  check of every citation against the rows it names, retries on a rejected
  answer, and escalation to a stronger model when a worker keeps failing. One
  grounded answer comes back with the facts it rests on.

Claude decides when to call either. Install it and Claude starts spending
less: on the questions measured below it reached for `find` before Grep on
exact lookups and delegated every how-does-it-work question to `explore` on
its own.

> The package, the CLI (`cx`) and the MCP server are still named
> `code-context`. Subagent is the product; the names underneath follow later.

**Claude thinks. Infino explores.**

## Why

Anyone can run a cheaper model and accept cheaper answers. The point here is
the same accuracy at lower cost, and the model is the smallest part of how.
Claude Code's own Explore subagent is another Sonnet loop: it explores, reads,
backtracks and calls tools until it is satisfied, so delegating to it cleans
the parent's context while spending a second frontier-model budget. Infino
Subagent replaces that loop with a bounded job on a retrieval engine: the
index scopes the context, many workers run at once, every answer is checked
against the code it cites and retried when it fails, and only the hard
residue reaches an expensive model. A small model looking at the right five
functions can beat a large one deciding where to look next in a
250,000-line repository.

## What we measured

Real agent runs through the Claude Agent SDK: `claude-sonnet-4-6`, the same
minimal prompt in every arm, on the [infino](https://github.com/infino-ai/infino)
engine repository (about 256,000 lines of Rust the model has not memorized,
which is the realistic case for private code). Thirty-six questions in five
categories, each run three times per arm; per-pass figures are the median of
the three repeats per question, summed. Three arms:

| arm | what Sonnet has |
|---|---|
| Sonnet, file tools | Glob, Grep, Read, LS, Bash - stock Claude Code |
| Sonnet + its Explore subagents | the same, plus the Agent tool with Claude Code's built-in Explore subagent |
| Sonnet + Infino Subagent | the same, plus `find` (local index) and `explore` (platform) |

The harness, the questions and the judge are in [`bench/`](bench/); the
charts below are drawn from its results by
[`bench/readme-charts.mjs`](bench/readme-charts.mjs). All figures are from
2026-09-05.

### Cost, tokens, tool calls

| arm | cost per pass (every Sonnet call, subagents included) | main-agent tokens | tool calls |
|---|---|---|---|
| Sonnet, file tools | $4.62 | 3,344k | 214 |
| Sonnet + its Explore subagents | $8.20 | 1,309k | 357 |
| Sonnet + Infino Subagent | **$2.46** | 1,361k | **122** |

![Cost per pass](docs/subagent/cost-per-pass.svg)

![Main-agent tokens per pass](docs/subagent/tokens-per-pass.svg)

![Tool calls per pass](docs/subagent/calls-per-pass.svg)

Against Sonnet's own Explore subagents, that is **3.3x lower Sonnet cost** at
the same main-agent context and a third of the tool calls; the first build of
the day measured 4.2x ($1.93). On the questions that actually go to
`explore` - how does X work, where is X handled - the gap is wider: $1.16
against $5.33 per pass, **4.6x**. Against plain file tools, 47% lower cost,
59% fewer main-agent tokens, 43% fewer tool calls.

Two things these figures do not include. The platform's own model spend for
`explore` is metered by the platform and billed on its account, not in the
Sonnet cost above. And end-to-end wall time depends on the platform's pool
as much as on the client: the first build of the day finished a pass in
1,106 s against 2,930 s for Sonnet's Explore subagents and 1,674 s for file
tools; the latest build took 2,560 s, the difference being time spent
waiting on the platform's model pool, which is being tuned.

### Quality

A blind judge - `claude-opus-5` with the repository checked out, both
answers in random order, no lane names - picks a winner per pair and counts
the claims in each answer that the code does not support.

| category | pairs | Infino Subagent arm wins | ties | file-tools arm wins | unsupported claims, file tools / Infino |
|---|---|---|---|---|---|
| aggregation - which files have the most X | 30 | 10 | 2 | 18 | 50 / 90 |
| comprehension - how does X work | 18 | **9** | 3 | 6 | 12 / 16 |
| pinpoint - where is this symbol | 24 | **11** | 10 | 3 | 21 / 16 |
| known file - what does this file do | 18 | 4 | 8 | 6 | 9 / 9 |
| by meaning - where is X handled | 18 | 3 | 0 | 15 | 12 / 19 |
| all | 108 | 37 | 23 | 48 | 104 / 150 |

![Blind judge per category](docs/subagent/judge-vs-file-tools.svg)

Where `explore` writes the answer - comprehension - it beats pure Sonnet, and
`find` wins the exact lookups outright. It loses by meaning on coverage (the
judge's reasons say Sonnet's answer covered more of the mechanism) and it
loses aggregation, where the answers rank files by counts taken from
top-k searches; the per-file counts `find` already returns are the right
instrument for that question, and routing it there is the next change. For
reference, Sonnet's own Explore subagents judged 40 / 35 / 33 against pure
Sonnet on the same pairs (wins / ties / losses).

**Same quality as Sonnet Explore is the bar, not yet the measurement.** The
two have not been judged head to head; that judge is running as this is
written and its result replaces this sentence.

What moved quality most on the platform side, measured the same way: the
build that numbers every line of every retrieved row and checks every
citation mechanically before an answer is accepted beat the build before it
11 to 6 on comprehension and 13 to 5 on by-meaning, with unsupported claims
cut by about half in both.

### Claude chooses it on its own

Nothing in the prompt tells Sonnet which tool to use. On exact-lookup
questions it reached for `find` before Grep in 17 of 24 runs; on every
comprehension and by-meaning question, 36 of 36 runs, its first move was
`explore`.

### Parallel exploration

Fifty questions asked at once, one exploration each:

![Parallel exploration](docs/subagent/fanout.svg)

Sonnet fanning out fifty of its own Explore subagents answered 50 of 50 in
1,218 s for $22.62. Infino Subagent answered 38 of 50 in 379 s to the last
answer, the other twelve stopping at the platform's 300 s cap without an
answer. Ten at once, Sonnet's Explore subagents took 316 s and $4.39 for 10
of 10; the platform's ten-wide figure depends on its pool configuration, and
the one that beats that number is the one that will be quoted here.

### The local index on its own

Before the platform tools, the same harness measured the local index alone
(`find`, `search`, `sql` beside stock tools) against stock tools, on the
same repository and model:

| Category | Tokens | Tool calls | Wall time |
|---|---|---|---|
| Aggregation ("most code about X") | **-43%** | **-71%** | **-48%** |
| Comprehension ("how does X work") | **-29%** | **-27%** | **-13%** |
| Blended | **-32%** | **-53%** | **-32%** |

Methodology and per-question tables are in [docs/benchmark.md](docs/benchmark.md).

### How it moved during the day

Every platform change was measured as a fresh pass of the same lane and
judged against pure Sonnet:

| build | change | cost per pass | wins / ties / losses vs pure Sonnet | comprehension | unsupported claims |
|---|---|---|---|---|---|
| FX1 | explore as shipped | $1.93 | 32 / 21 / 55 | 7 - 11 | 155 |
| FX3 | grounding check, retry on the same model, pool of model calls | $2.16 | 34 / 25 / 49 | 7 - 9 | 143 |
| FX4 | answer audit | $2.39 | 38 / 21 / 49 | 8 - 8 | 137 |
| FX5 | numbered lines, mechanical citation check | $2.46 | 37 / 23 / 48 | **9 - 6** | 150 |

Comprehension went from lost to won; the aggregation residue explained
above is where the unsupported count comes from now.

## How it works

```
Claude Code
  ├─ exact text ("every use of X")      → find     local index, milliseconds
  ├─ investigation ("how does X work")  → explore  Infino platform
  │       retrieve over the same index → parallel small-model workers
  │       → every citation checked against the rows → retry on rejection
  │       → escalate the stubborn ones to a stronger model → one grounded answer
  └─ continues with the answer and its facts
```

One index, kept in two places. `cx index --db` builds the local index and
loads the same chunks into a platform database; every sync after it (the
explicit `cx index`, or the server's auto-sync as queries arrive) applies the
same diff to both, so they never drift. `find`, `search` and `sql` read the
local copy; `subagent` and `explore` run on the platform copy.

## Install

Node 20 or newer, macOS or Linux (the engine's prebuilt binding covers
x64 and arm64 on both). The platform tools are on this branch and not yet in
the npm release, so build from the branch:

```bash
git clone -b feat/platform-backend https://github.com/infino-ai/code-context
cd code-context && npm ci && npm run build
```

You need two things from whoever runs your Infino platform instance: a
**database URL** for the repository you want to index, in the form
`https://host/<database>` (one database per repository), and a **bearer
key**, which goes in a file that only you can read (the server takes the
file's path; a key is never passed as an argument).

Register the server with Claude Code, with your paths:

```bash
claude mcp add-json code-context -s user '{"command":"node","args":["/path/to/code-context/dist/cli.js","mcp","--db","https://host/<database>","--api-key-file","/path/to/key"],"alwaysLoad":true}'
```

Then open Claude Code in the repository and ask a question. The first
`find`, `search` or `sql` builds the local index inline and answers on the
same call; the first `explore` or `subagent` loads the platform copy. To
build ahead of time, or to see what the build does:

```bash
node dist/cli.js index --db https://host/<database> --api-key-file /path/to/key
```

A development instance that is not on a public hostname is reachable over
plain `http://` only as a loopback host: tunnel it to your machine and use a
`http://127.0.0.1:<port>/<database>` URL. Any other host must be `https://`.

`alwaysLoad: true` pins the tools into Claude's context. In sessions with many
MCP servers Claude Code defers tool definitions behind a tool-search step, and
without it the agent can miss these tools and fall back to grep.

Other MCP clients (Cursor, Codex CLI, Gemini CLI, Windsurf, Cline) take the
same `command` and `args` in their standard stdio server config; point the
server at a repository with `env: { "CX_ROOT": "/path/to/repo" }` when the
client's working directory is not the repository.

### Without the platform

Without `--db` the server is the local index alone - `find`, `search`,
`sql` - and that is what the npm release ships today:

```bash
claude mcp add-json code-context -s user '{"command":"npx","args":["-y","@infino-ai/code-context","mcp"],"alwaysLoad":true}'
```

or the Claude Code plugin, `/plugin marketplace add infino-ai/code-context`
then `/plugin install code-context@infino-ai`. Nothing leaves the machine in
that configuration: no account, no key, no telemetry; embedding is a small
local model downloaded once.

## The tools

| tool | runs | what it does | when Claude uses it |
|---|---|---|---|
| `find` | local | every line containing an exact string, `path:line` like `grep -n`, with per-file counts like `grep -c`; complete and unranked, and every hit is a real occurrence | where it would grep: every use or definition of an identifier, an error message, a config key |
| `search` | local | one ranked pass fusing exact keyword matching (BM25) with semantic similarity; hits carry the code | how a subsystem works, code by meaning or exact term, similar implementations |
| `sql` | local | read-only SQL over the index, with `bm25_search` and `hybrid_search` as table functions | counts, rankings and aggregates over the whole repository in one query |
| `explore` | platform | a question about a mechanism that spans files; returns a written answer grounded in the facts it lists, with the chain of queries it ran | how does X work, where is X handled, trace this path |
| `subagent` | platform | a question or task in plain language; returns the rows it retrieved - `path`, `start_line`, `end_line` and the code - never a summary | when Claude wants facts to compose from rather than an answer |

`explore` and `subagent` are registered only when the server has `--db`.

### The SQL move

Search-as-a-table composes with aggregation - ranked by relevance, tallied
by SQL, one engine pass:

```sql
SELECT path, SUM(end_line - start_line + 1) AS lines, COUNT(*) AS chunks
FROM bm25_search('chunks', 'content', 'vector index quantization', 300)
GROUP BY path ORDER BY lines DESC LIMIT 15
```

`hybrid_search(...)` and `vector_search(...)` work the same way; the server
embeds `{{name}}` placeholders for them, so agents never handle raw vectors.

### Staged readiness

`cx index` commits the keyword index first - under a second on a
3,000-chunk repository - so search works before any embedding model exists
on the machine. Vectors backfill in the background with a local model
(downloaded once, no key), and hybrid ranking unlocks when they land. If the
vector stage fails, keyword search stays live and the index says so.

### Your index is just files

The local index lives in `.infino/` in the repository root (added to
`.gitignore` on the first build): plain files you can copy or cache in CI, a
live index the engine queries in place.

## Platform flags

Everything about the platform is a command-line flag on the two commands
that touch it, `cx index` and `cx mcp`:

| flag | default | purpose |
|---|---|---|
| `--db <url>` | (local index only) | the platform database, `https://host/<database>` (plain `http://` only for localhost) |
| `--api-key-file <path>` | `INFINO_API_KEY` | file holding the bearer key. The key is never an argument, since a process's arguments are visible to every other process on the machine; the environment variable is the one alternative |
| `--embed-provider <platform\|local>` | `platform` | who fills the platform table's vectors: the platform's own model, or this machine's (vectors shipped with the rows) |
| `--analyzer <ascii_lower\|standard>` | the table's own; `ascii_lower` for a first load | `cx index` only: the full-text analyzer the platform table is created with. `ascii_lower` splits code identifiers on `.`, `_`, and `::`. Without the flag a rebuild keeps the analyzer the table has; naming a different one rebuilds it |
| `--db-timeout-ms <n>` | 60000 | per-request timeout |
| `--cold-start-secs <n>` | 120 | how long to keep retrying while the database is not yet ready, before giving up |
| `--subagent-max-turns`, `--subagent-max-wall-secs`, `--subagent-k` | 4, 120, 10 | `cx mcp` only: turn and wall-clock caps for one `subagent` call, and how many facts a call returns |
| `--explore-max-turns`, `--explore-max-wall-secs` | the platform's budget, 300 | `cx mcp` only: the same caps for one `explore` call |

## Configuration

| variable | default | purpose |
|---|---|---|
| `CX_INDEX_DIR` | `<repo>/.infino` | where the local index lives |
| `CX_SEARCH_K` | 10 | default number of hits `search` returns (also settable per call and via the CLI `-k` flag) |
| `CX_FIND_LIMIT` | 500 | default number of matching lines `find` returns, which is also the hard cap; `total` and `byFile` are complete either way |
| `CX_MAX_FILES` / `CX_MAX_FILE_BYTES` | 20000 / 1MB | indexing caps (files over the cap are left out and the tools flag the index as partial) |
| `CX_ROOT` | current directory | default repository root for the MCP server / CLI when not run from the repository (each tool call can override it with a `path` argument) |
| `CX_AUTO_INDEX` | on | `0` makes a query on an unindexed repository error instead of building the index inline |
| `CX_AUTO_SYNC` | on | `0` disables the MCP server's background staleness sync |
| `CX_SYNC_INTERVAL_SECS` | 30 | auto-sync debounce between staleness checks |
| `CX_NO_EMBED` | off | keyword-only mode (with `--db`, the platform copy is keyword-only too) |
| `CX_NO_RECEIPT` | off | `1` turns off usage accounting - the per-call receipt on results and the `cx usage` ledger |

Every result carries a **usage receipt**: the tokens it returned, the files
it spanned, and a running session total. For the platform tools the receipt
names the platform's metered spend for the call ("N model tokens"), which
the platform bills; the Sonnet side is on your Anthropic bill as usual.

## CLI

```
cx index [path]           sync the index (incremental; --full rebuilds, --watch follows edits)
cx find <text>            every line containing the exact text, path:line  (-i, -c per-file counts, --limit)
cx search <query>         exact terms + meaning, one ranked pass           (-k hits)
cx sql <statement>        read-only SQL; --embed q="text" fills {{q}}
cx status                 what the index holds, how fresh, vector readiness
cx usage                  ledger of queries run and what each returned  (-n, --all, --clear, --json)
cx mcp                    serve the MCP tools over stdio
cx index --db <url>       also keep the index on an infino-platform database  (--api-key-file, --embed-provider, --analyzer)
cx mcp --db <url>         also serve subagent and explore over that copy        (--api-key-file, the subagent/explore caps)
```

`cx usage` reads the local ledger at `.infino/usage.jsonl`: every call, from
the CLI or the MCP server, appends one line with the query and a compact
summary of what came back. With two Claude Code hooks (`cx usage --hook` on
`UserPromptSubmit` and `PostToolUse`) it also shows in how many of your
prompts the tools were used and which tool Claude reached for first.

## What it is, and what it isn't

Infino Subagent's lane is ranked **content** retrieval and grounded
exploration over it: find code by words or meaning, rank files by how much
they are about a topic, answer a question that spans files with citations.
It does not do structural code intelligence (call-graph tracing, dead-code
detection, type resolution); tools that do are complementary, and MCP servers
stack.

## Architecture

![How code-context fits together](docs/architecture.png)

- **Chunking:** tree-sitter (WASM, no native compiles) cuts at definition
  boundaries for TypeScript/JS, Python, Rust, Go, Java, C/C++, Ruby, C#, PHP;
  Markdown splits at headings; everything else falls back to fixed windows.
  Every chunk carries `path, start_line, end_line, lang, content`.
- **Index:** [infino](https://github.com/infino-ai/infino) tables - BM25 and
  IVF vector indexes over a single copy of the data - queried in-process
  through the Node binding locally, and the same table on an infino-platform
  database for `explore` and `subagent`, written by the same builds and syncs.
- **Embeddings:** a small local model for the local copy (chosen by a
  [measured eval](docs/embedder-eval.md)); the platform embeds its copy with
  its own model unless `--embed-provider local`.
- **Freshness:** incremental. A per-file state map (size/mtime prefilter,
  then content hash) means a sync re-chunks and re-embeds only the files that
  changed, in both places; the server auto-syncs as queries arrive.

## Learn more

- [Code search for coding agents](docs/concepts/code-search-for-coding-agents.md) - the crawl-vs-retrieve model and when an index saves tokens.
- [FAQ](docs/faq.md), [Tradeoffs](docs/tradeoffs.md) - the honest limits.
- [Benchmark](docs/benchmark.md) - the local index's measured results, with the harness to reproduce them.
- [`bench/`](bench/) - the lanes, the questions, the judge, and the chart script behind the numbers above.

## License

Apache-2.0
