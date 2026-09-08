<div align="center">

[![CI](https://github.com/infino-ai/code-context/actions/workflows/ci.yml/badge.svg)](https://github.com/infino-ai/code-context/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@infino-ai/code-context?label=%40infino-ai%2Fcode-context&logo=npm)](https://www.npmjs.com/package/@infino-ai/code-context)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

</div>

# SuperGrep

**Retrieval subagents for Claude Sonnet. Up to 10x faster and 50% lower Anthropic bill.**

Much of what Claude spends time on during agent sessions is reading files rather than reasoning about them. SuperGrep routes file operations to fast subagents running small language models (SLMs): the lookup, the fan-out, the fifty "go look at this" jobs a hard task spawns. No config needed. Sonnet keeps the reasoning and decides when to use them.

![SuperGrep: find, search and sql locally, ask and explore in the cloud, one index in both places](docs/subagent/architecture.svg)

**Five tools. Three run on your machine, two run in the cloud, over one
index kept in both places.**

| | tool | what it does |
|---|---|---|
| local | **`find`** | Every line containing an exact string, like `grep -n`, complete and unranked, with the repo-wide total and per-file counts. Tens of milliseconds from the index instead of a grep-and-read loop that pulls source into Sonnet's context one file at a time. |
| local | **`search`** | One ranked pass fusing exact keyword matching with semantic similarity, so it works whether or not you know the words. Hits carry the code, cited `path:line`. |
| local | **`sql`** | Read-only SQL over the index. The ranked searches are table-valued relations, so "which files have the most code about X" is one query that ranks and tallies in a single pass. |
| cloud | **`explore`** | A question that spans the repository. Small language models run the investigation in parallel against the same index, with deep context from it, and one grounded answer comes back with the facts it rests on, cited `path:line`. |
| cloud | **`ask`** | One retrieval, returned as the rows it found rather than as prose, for when you want the facts and not a write-up. |

The models are small on purpose. Deciding where to look next in a 256,000-line repository is retrieval work, and a small model with deep
context from the index can do it at a fraction of the cost and fifty at a time. What it is not is a reasoning model: it is meant to execute search tasks, and it is where Sonnet's exploration, retrieval and fan-out go.

### Sonnet chooses it on its own

When offered SuperGrep tools alongside its own file tools, **Sonnet chooses to use SuperGrep 76% of the time**, and
its first choice is always SuperGrep in every category of question:

![What Sonnet reaches for first, by question type](docs/subagent/first-choice.svg)

It uses the whole surface rather than settling on one tool. Every call it made across the thirty-six questions, in order of how often:

| tool | calls | | tool | calls |
|---|---|---|---|---|
| **`find`** | 17 | | `Read` | 12 |
| **`ask`** | 14 | | `Glob` | 4 |
| **`sql`** | 11 | | `Grep` | 3 |
| **`search`** | 11 | | `Bash` | 1 |
| **`explore`** | 9 | | | |

All five are load-bearing, and the twenty calls that are not SuperGrep are mostly `Read`: it reads a file *after* the index has told it which one, rather than
instead of asking. That is the shape you want - the index does the finding, and the model still opens what it needs to quote.

## Go beyond code - index your entire laptop or any corpus

SuperGrep looks across all the files a question needs, not just the source. Logs, test output, stack traces, CI output, configuration and docs go in beside the code,
and the same five tools run over all of it: `find` for an exact stack frame, `search` for a failure you can only describe, `sql` to count and rank across a
run, `explore` for the question that spans several of them at once.

That matters most where a frontier model is weakest. A log is the pathological case for a context window - large, repetitive, mostly irrelevant, and paid for
again on every turn it stays in the transcript. An index collapses it to the spans that matter before Sonnet sees any of it. It is the same trade the cost
table below measures on source code, on a corpus where the ratio is worse.

So "why did this integration test start failing?" is one question over source, recent logs, test output, stack traces and config - and the retrieval, the
fan-out and the fifty parallel investigations are the part that is farmed out.

For files that don't fit on your laptop - write them out to Parquet files in object storage and point SuperGrep at them without ever loading them onto your laptop ([how](#indexing-from-object-storage)). You can search them together with your code or laptop files using the same subagents.

## The numbers

Real agent runs through the Claude Agent SDK: `claude-sonnet-4-6`, the same minimal prompt in every arm, on the [infino](https://github.com/infino-ai/infino)
engine repository (about 256,000 lines of Rust the model has not memorized - which is what makes it a retrieval test at all: on a repository already in the
model's weights there is nothing for retrieval to do). Thirty-six questions in five
categories, one pass per arm, all three arms on one build, measured 2026-09-07 - so the cost below and the judging further down score the same
answers. The harness, the questions, the judge and the chart script are in
[`bench/`](bench/).

| arm | what Sonnet has |
|---|---|
| Sonnet, file tools | Glob, Grep, Read, LS, Bash - stock Claude Code |
| Sonnet + its Explore subagents | the same, plus the Agent tool with Claude Code's built-in Explore subagent |
| Sonnet + SuperGrep | the same, plus all five tools |

### Cost

| arm | your Sonnet bill per pass (subagents included) | Infino charge | all-in | main-agent tokens | tool calls (inside subagents included) |
|---|---|---|---|---|---|
| Sonnet, file tools | $5.22 | - | $5.22 | 4,549k | 249 |
| Sonnet + its Explore subagents | $7.35 | - | $7.35 | 1,918k | 355 |
| Sonnet + SuperGrep | **$2.18** | $0.89 | **$3.07** | **1,086k** | **82** |

![Cost per pass](docs/subagent/cost-per-pass.svg)

![Main-agent tokens per pass](docs/subagent/tokens-per-pass.svg)

![Tool calls per pass](docs/subagent/calls-per-pass.svg)

Against Sonnet's own Explore subagents, **your Sonnet bill falls 70%** - 3.4x lower - with 43% less main-agent context and under a quarter of the tool
calls. With what the cloud tools cost you counted in, the **all-in bill falls 58%**, so better than half. Against plain file tools it is 2.4x on the Sonnet
bill and 1.7x all-in.

**It earns its keep on fan-out.** The saving is not spread evenly across everything you ask: where it really pays is the hard task that spawns a fleet of "go
look at this" jobs - that is where a fanning-out agent's bill actually goes, and it is the case SuperGrep is built for.

### Quality

A blind judge - `claude-opus-5` with the repository checked out, both answers in random order - picks a winner per pair and counts the claims in
each answer that the code does not support. It judges the answers from the runs in the cost table above, against each baseline in turn.

**Against Sonnet with file tools**, 36 pairs:

| category | pairs | SuperGrep wins | ties | file-tools wins | unsupported claims, file tools / SuperGrep |
|---|---|---|---|---|---|
| aggregation - which files have the most X | 10 | 3 | 1 | **6** | 39 / 73 |
| comprehension - how does X work | 6 | 1 | 0 | **5** | 9 / 16 |
| pinpoint - where is this symbol | 8 | **4** | 3 | 1 | 6 / 5 |
| known file - what does this file do | 6 | 1 | 4 | 1 | 3 / 3 |
| by meaning - where is X handled | 6 | 0 | 1 | **5** | 7 / 10 |
| all | 36 | 9 | 9 | **18** | 64 / 107 |

![Blind judge per category, against file tools](docs/subagent/judge-vs-file-tools.svg)

**Against Sonnet's own Explore subagents**, 35 pairs (one pair's judging hit
its turn limit and is left out rather than counted):

| category | pairs | SuperGrep wins | ties | Explore-subagent wins | unsupported claims, Explore / SuperGrep |
|---|---|---|---|---|---|
| aggregation - which files have the most X | 10 | 2 | 1 | **7** | 55 / 70 |
| comprehension - how does X work | 5 | 0 | 0 | **5** | 6 / 11 |
| pinpoint - where is this symbol | 8 | 3 | 2 | 3 | 5 / 5 |
| known file - what does this file do | 6 | **2** | 4 | 0 | 3 / 2 |
| by meaning - where is X handled | 6 | 0 | 0 | **6** | 6 / 12 |
| all | 35 | 7 | 7 | **21** | 75 / 100 |

![Blind judge per category, against Explore subagents](docs/subagent/judge-vs-explore.svg)


### Fanout

When a questions spawns several agents at once, with one exploration each. Of course, this always depends on workload so YMMV.

**Ten at once: 10 of 10 in 31 s**, against Sonnet's ten Explore subagents at
316 s. Ten times faster.

**Fifty at once: 31 s**, against **1,218 s** for fifty Sonnet Explore
subagents.[^fifty]

![Parallel exploration](docs/subagent/fanout.svg)

[^fifty]: From the measured time and token cost of one exploration.

## Install

You need node 20 or newer, on macOS or Linux. Then clone this repo:

```bash
git clone -b feat/platform-backend https://github.com/infino-ai/code-context
cd code-context && npm ci && npm run build
```

Now, in the repository you want to search, one command:

```bash
node /path/to/code-context/dist/cli.js install --platform https://host
```

That is the whole setup. It indexes the repository, gets you a free account, registers this repository's database, and writes the MCP entry. Open Claude Code there and ask a question - all five tools are live.

**No signup.** There is no form, no email, no password and no card. SuperGrep asks you once - it tells you that the contents of the files are uploaded - and on yes it creates the account in the background and stores the key at `~/.infino/key`, mode 600, readable only by you. No config file ever holds a key or a path to one.

**Every repository after that is the same command with no arguments at all:**

```bash
cd ../another-repo && node /path/to/code-context/dist/cli.js install
```

The stored key is found automatically. When the free credit runs out, `ask` and `explore` say so and tell you how to add billing details and a card to the same account; `find`, `search` and `sql` keep working throughout.

### Local tools only

On a machine with no account, `install` with no flags at all gives you `find`, `search` and `sql` - no account, no key, nothing uploaded:

```bash
node /path/to/code-context/dist/cli.js install
```

Add `--local-only` to get that same local-only entry on a machine that does have an account.

### If you already have an Infino account

Sign in once per machine instead. The key comes from a file or standard input, never from an argument - argv is readable by every process on the machine:

```bash
node /path/to/code-context/dist/cli.js login --db https://host < keyfile
```

Or name the database and key explicitly, per repository:

```bash
node /path/to/code-context/dist/cli.js install \
  --db https://host/<database> --api-key-file ~/.infino/key
```

Please login and rotate your keys before you run SuperGrep in prod.

## Indexing it yourself

`install` indexes the repository for you and the MCP server keeps it current, so most of the time you never run an index by hand. When you want to - a first pass over a huge tree, a CI step, a corpus that is not a git repository - `index` is the command. (`cx` below is `node /path/to/code-context/dist/cli.js`.)

```bash
cx index                      # bring the index up to date; incremental, full on first run
cx index ~/notes              # index some other directory
cx index --full               # force a full rebuild
cx index --watch              # keep watching the tree and sync on every change
cx index --no-embed           # keyword index only, skip the vector stage
cx index --max-files 1000000  # raise the cap past the 500,000 default; over it, the index is
                              # partial and says so, with the value to pass to get all of it
```

The index is plain files under `.infino/` in the directory you indexed. Keyword search is live within seconds of the first `cx index`; semantic and hybrid search light up as the vectors finish backfilling behind it. `cx status` says what the index holds and how fresh it is.

To load the platform copy in the same pass - so `ask` and `explore` see the same content as `find` - name the database. The stored key from `install` or `login` is used automatically:

```bash
cx index --db https://host/<database>
```

`--embed-provider platform` (the default) has the platform fill that table's vectors with its own model, server-side; `local` embeds on this machine and ships the vectors instead.

## Indexing from object storage

For a corpus too big for your laptop - years of logs, a document dump, anything you already keep in S3 - write it out as Parquet, leave it there, and have the platform build the index next to it. Nothing is downloaded to your machine and no row passes through your laptop or through the API.

**1. Stage the Parquet shards** under the database's own `_source/` prefix:

```bash
aws s3 cp ./shards/ s3://<your-bucket>/<database-root>/_source/logs/ \
  --recursive --exclude '*' --include '*.parquet'
```

**2. Submit the job.** One `POST`, and it returns straight away - the build runs on the platform, not in the request:

```bash
curl -sS -X POST https://host/v1/hydrate/<database> \
  -H "authorization: Bearer $(cat ~/.infino/key)" \
  -H 'content-type: application/json' \
  -d '{
        "table": "logs",
        "source": { "kind": "prefix", "prefix": "_source/logs/" },
        "fts":    [ { "column": "message" } ],
        "embed":  { "column": "embedding", "source": ["message"] }
      }'
```

```json
{ "job": "hydrate/<customer>/<database>/logs", "state": "pending" }
```

Leave `fts` and `embed` out and the job reads a sample and picks the roles itself. `columns` narrows which source columns are carried; `no_embed: true` builds no vector column at all.

**3. Follow it.** The reply carries the state, how far it has got, the schema it settled on, and what it has cost so far:

```bash
curl -sS "https://host/v1/hydrate/<database>?table=logs" \
  -H "authorization: Bearer $(cat ~/.infino/key)"
```

States are `pending`, `running`, `cancelling`, `stopped`, `succeeded`, `failed`. A job that stopped - a cancel, or an outage that outlasted its budget - resumes from its own checkpoint rather than starting over:

```bash
# resume where it left off
curl -sS -X POST https://host/v1/hydrate/<database> -H "authorization: Bearer $(cat ~/.infino/key)" \
  -H 'content-type: application/json' \
  -d '{"table":"logs","source":{"kind":"prefix","prefix":"_source/logs/"},"resume":true}'

# stop a running job at its next commit boundary
curl -sS -X DELETE "https://host/v1/hydrate/<database>?table=logs" \
  -H "authorization: Bearer $(cat ~/.infino/key)"
```

By default a job that fails for good drops its half-built table, so a partial table is never served; `"on_failure": "keep"` keeps what was committed.

The table is then searchable like any other. `ask` and `explore` run over it, and one question can span it and your code at once.

## Learn more

- [Reference](docs/reference.md) - tools, flags, configuration, CLI, architecture.
- [FAQ](docs/faq.md), [Tradeoffs](docs/tradeoffs.md) - the honest limits.
- [`bench/`](bench/) - the harness, the questions and the judge behind the numbers above.

## License

Apache-2.0
