<div align="center">

[![CI](https://github.com/infino-ai/code-context/actions/workflows/ci.yml/badge.svg)](https://github.com/infino-ai/code-context/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@infino-ai/code-context?label=%40infino-ai%2Fcode-context&logo=npm)](https://www.npmjs.com/package/@infino-ai/code-context)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

</div>

# SuperGrep

**Retrieval subagents for Claude Sonnet. Up to 10x faster and 50% lower Anthropic bill.**

Sonnet is the model most agent sessions actually run on, and most of what it
spends goes on finding code rather than reasoning about it. SuperGrep farms
that half off to fast subagents running small language models (SLMs): the
retrieval, the fan-out, the fifty "go look at this" jobs a hard task spawns.
No config needed. Sonnet keeps the reasoning and decides when to use them.

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

The models are small on purpose. Deciding where to look next in a
256,000-line repository is retrieval work, and a small model with deep
context from the index can do it at a fraction of the cost and fifty at a
time. What it is not is a reasoning model: it will not out-argue Sonnet
about the code, and the numbers below are honest about where that shows.
It is where Sonnet's exploration, retrieval and fan-out go.

**Sonnet thinks. Infino explores.**

## Code is the first corpus, not the only one

The index takes the files a question needs, not just the source. Logs, test
output, stack traces, CI output, configuration and docs go in beside the code,
and the same five tools run over all of it: `find` for an exact stack frame,
`search` for a failure you can only describe, `sql` to count and rank across a
run, `explore` for the question that spans several of them at once.

That matters most where a frontier model is weakest. A log is the pathological
case for a context window - large, repetitive, mostly irrelevant, and paid for
again on every turn it stays in the transcript. An index collapses it to the
spans that matter before Sonnet sees any of it. It is the same trade the cost
table below measures on source code, on a corpus where the ratio is worse.

So "why did this integration test start failing?" is one question over source,
recent logs, test output, stack traces and config - and the retrieval, the
fan-out and the fifty parallel investigations are the part that is farmed out.

**Not yet measured.** Every number on this page is a source-code corpus. The
log and trace case is indexable today and is what we are measuring next;
nothing here should be read as covering it. Two limits worth knowing now: a
single file above 1 MB is skipped, and today it is skipped without being
reported, so a large log is simply absent from the index rather than flagged -
raise `CX_MAX_FILE_BYTES` if you are pointing this at logs. A multi-gigabyte
trace is not what this handles today.

### Sonnet chooses it on its own

Nothing in the prompt names a tool. Given all five beside its own file tools,
**76% of every call Sonnet makes is to SuperGrep, of its own choosing**, and
its first choice is always SuperGrep in every category of question:

| question | Sonnet's first tool call |
|---|---|
| which files have the most X | `sql`, 10 of 10 |
| how does X work | `explore`, 6 of 6 |
| where is X handled | `explore` 3, `search` 3 of 6 |
| where is this symbol | `find` 7, `Grep` 1 of 8 |
| what does this file do | `find` 4, `Glob` 1, `Read` 1 of 6 |

It uses the whole surface rather than settling on one tool. Every call it made
across the thirty-six questions, in order of how often:

| tool | calls | | tool | calls |
|---|---|---|---|---|
| **`find`** | 17 | | `Read` | 12 |
| **`ask`** | 14 | | `Glob` | 4 |
| **`sql`** | 11 | | `Grep` | 3 |
| **`search`** | 11 | | `Bash` | 1 |
| **`explore`** | 9 | | | |

All five are load-bearing, and the twenty calls that are not SuperGrep are mostly
`Read`: it reads a file *after* the index has told it which one, rather than
instead of asking. That is the shape you want - the index does the finding,
and the model still opens what it needs to quote.

## The numbers

Real agent runs through the Claude Agent SDK: `claude-sonnet-4-6`, the same
minimal prompt in every arm, on the [infino](https://github.com/infino-ai/infino)
engine repository (about 256,000 lines of Rust the model has not memorized,
which is the realistic case for private code). Thirty-six questions in five
categories, one pass per arm, all three arms on one build, measured
2026-09-07 - so the cost below and the judging further down score the same
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

Against Sonnet's own Explore subagents, **your Sonnet bill falls 70%** - 3.4x
lower - with 43% less main-agent context and under a quarter of the tool
calls. With what the cloud tools cost you counted in, the **all-in bill falls
58%**, so better than half. Against plain file tools it is 2.4x on the Sonnet
bill and 1.7x all-in.

A single pass is one measurement, so here is its spread: eight passes over
the same thirty-six questions across this branch's development ranged $1.81
to $2.63 of Sonnet, median $2.15. The cost claim is the stable part of this
page.

**It earns its keep on fan-out.** The saving is not spread evenly across
everything you ask: on a question one agent answers by itself there is little
in it either way. Where it pays is the hard task that spawns a fleet of "go
look at this" jobs - that is where a fanning-out agent's bill actually goes,
and it is the case SuperGrep is built for.

One thing is still not in these figures: the same arms on a frontier model,
where the gap is much smaller, because a stronger model already retrieves
efficiently and there is less waste to remove. These are Sonnet numbers and
they are a claim about Sonnet.

### Quality

A blind judge - `claude-opus-5` with the repository checked out, both
answers in random order - picks a winner per pair and counts the claims in
each answer that the code does not support. It judges the answers from the
runs in the cost table above, against each baseline in turn.

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

**Read that plainly: on this judge, cheap retrieval buys the cost and does
not buy the quality.** It holds the exact lookups - `find` ties or wins
pinpoint and known-file against both baselines, with no more unsupported
claims than the baseline - and it loses aggregation, comprehension and by
meaning, in both comparisons, with more unsupported claims overall. A model
that reads the files writes an answer with more of the code in it, and this
judge rewards that.

Three conditions worth knowing, since they are what we would want to know.
The judge counts a claim unsupported unless the answer's grain matches the
question, so an answer that names five files where the question implies ten
is marked down for the gap rather than for being wrong. **Aggregation** is
scored largely on whether a number reproduces, and a total over a ranked
search is a fact about that query rather than about the repository; the tool
text now says so, these runs used that text, and the row still loses.
**By meaning** was live semantic search in these runs - an earlier version of
this page blamed an absent vector half for that row, and rerunning it with
semantic search working did not change the result.

### Parallel

Questions asked all at once, one exploration each.

**Ten at once: 10 of 10 in 31 s**, against Sonnet's ten Explore subagents at
316 s. Ten times faster.

**Fifty at once: 31 s**, against **1,218 s** for fifty Sonnet Explore
subagents.[^fifty]

![Parallel exploration](docs/subagent/fanout.svg)

[^fifty]: From the measured time and token cost of one exploration.

## Install

Node 20 or newer, macOS or Linux. The cloud tools are on this branch and
not yet in the npm release, so build from the branch:

```bash
git clone -b feat/platform-backend https://github.com/infino-ai/code-context
cd code-context && npm ci && npm run build
```

You need two things from whoever runs your Infino platform instance: a
**database URL** for the repository you want to index, `https://host/<database>`
(one database per repository), and a **bearer key**, which goes in a file
only you can read. Then register the server with Claude Code, with your
paths:

```bash
claude mcp add-json code-context -s user '{"command":"node","args":["/path/to/code-context/dist/cli.js","mcp","--db","https://host/<database>","--api-key-file","/path/to/key"],"alwaysLoad":true}'
```

Open Claude Code in the repository and ask a question. The first local call
builds the index inline and answers on the same call; the first `explore`
loads the platform copy. `alwaysLoad` keeps the tools in Sonnet's view in
sessions with many MCP servers.

Without a database URL the same server runs the three local tools alone,
which is what the npm release ships today and needs no account and no key.

Everything else - the five tools in detail, the platform flags, the
environment variables, the CLI, other MCP clients - is in
[docs/reference.md](docs/reference.md).

> The package, the CLI (`cx`) and the MCP server are still named
> `code-context`. SuperGrep is the product; the names underneath follow.

## Learn more

- [Reference](docs/reference.md) - tools, flags, configuration, CLI, architecture.
- [FAQ](docs/faq.md), [Tradeoffs](docs/tradeoffs.md) - the honest limits.
- [`bench/`](bench/) - the harness, the questions and the judge behind the numbers above.

## License

Apache-2.0
