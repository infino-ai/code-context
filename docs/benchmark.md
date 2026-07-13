# Benchmark

How code-context changes what a coding agent spends, measured end-to-end on
real agent runs - same model, same turn budget, only the toolset differs.
Run 2026-07-12 on the frozen v0.1 surface.

## Setup

- **Model:** claude-opus-4-8 on every lane (via the Claude Agent SDK, each
  run a real multi-turn agent conversation).
- **Lanes** (hermetic - user-level config, plugins, and MCP servers
  excluded):
  - *stock file tools* - Glob, Grep, Read, LS: how coding agents explore a
    repo without an index.
  - *code-context* - the MCP tools (`search`, `sql`, `reindex`) plus Read
    for following citations.
- **Unsteered:** a minimal identical system prompt ("answer questions about
  this repository; be efficient"); no lane is taught which tool to prefer;
  steering comes only from tool names and descriptions, the way a fresh
  install behaves.
- **Tokens** = input + cache writes + cache reads + output, as reported by
  the API for the full run - everything the run made the API process.
  **Cost** uses the API's own per-run accounting (which prices cache reads
  correctly).

Three question classes, because they stress retrieval differently.

## 1. Relevance aggregation - "which files have the most code about X"

Ten questions against a public ~180k-line Rust codebase (3,042 indexed
chunks); questions 1-6 are aggregation-shaped: rank files by how much
they're about a topic, tally the codebase by language, find the largest
files. File tools must read source into context to tally; `sql` composes
ranked search with GROUP BY in one engine pass. Two independent runs per
question per lane.

| # | Question shape | code-context (2 runs) | file tools (2 runs) | mean ratio |
|---|---|---|---|---|
| 1 | files with the most code | 6k / 6k | 27k / 33k | 4.7x |
| 2 | codebase by language | 6k / 6k | 169k / 113k | **22.4x** |
| 3 | chunk counts per language | 5k / 5k | 53k / 47k | 8.6x |
| 4 | 10 largest source files | 6k / 6k | 20k / 27k | 3.9x |
| 5 | most code about topic A | 11k / 19k | 27k / 26k | 1.7x |
| 6 | most code about topic B | 6k / 6k | 23k / 41k | 5.0x |

**Class total: 85% fewer tokens (6.5x).** Note the stability: the
code-context side answers in 5-6k tokens *every* run (one SQL query,
deterministic); the file-tools side swings 20k-169k depending on how much
source the model decides to read.

## 2. Comprehension - "how does X work"

Questions 7-10 of the same set: explain a write path, a scoring algorithm,
a fusion implementation, crash recovery. Both lanes can answer these; the
difference is what it costs to assemble the context.

| # | Question shape | code-context (2 runs) | file tools (2 runs) | mean ratio |
|---|---|---|---|---|
| 7 | how records are appended | 89k / 54k | 118k / 118k | 1.6x |
| 8 | how scoring works | 54k / 39k | 98k / 68k | 1.8x |
| 9 | where fusion is implemented | 27k / 25k | 18k / 24k | 0.8x |
| 10 | crash recovery behavior | 94k / 86k | 142k / 59k | 1.1x |

**Class total: 28% fewer tokens (1.4x)**, with every answer carrying
`path:start-end` citations (the hits arrive as ranked chunks with content,
so answers quote the code they cite). Question 9 is an honest tie-to-loss:
when one precise grep hits immediately, an index can't beat it.

**Across the whole suite: 55% fewer tokens, 71% fewer tool calls, 41%
lower cost** (28.3k vs 63.2k tokens, 2.2 vs 7.5 calls, $0.102 vs $0.174
per question).

## 3. Localization study - SWE-bench_Verified

A harder secondary test: 29 instances from
[SWE-bench_Verified](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified)
(filtered to 15-60-minute difficulty with exactly two modified Python
files, spanning django, sympy, astropy, scikit-learn, matplotlib, sphinx,
xarray, pytest, pylint, seaborn). The agent reads the real GitHub issue and
must name the files the merged fix actually touched.

Isolated lanes measure the substrate; the third lane is the real
deployment. An MCP server adds tools and never removes the native ones,
so an installed agent has both and picks per query.

| | code-context only | file tools only | both installed |
|---|---|---|---|
| F1 vs gold patch files | **0.691** | 0.654 | 0.654 |
| Tool calls per instance | **2.7** | 3.6 | 3.4 |
| Tokens per instance | 39.4k | **21.4k** | 35.2k |

Reading it honestly: literal known-symbol lookup is native grep's home
turf. Lean grep output beats content-rich search hits on tokens for this
question class, while code-context alone localizes slightly more
accurately in fewer calls. With both installed the agent mixes freely
(roughly half its retrieval calls each way) and accuracy stays at
baseline: installing code-context does not degrade localization, it adds
the question classes above.

## Reading the results

- **Aggregation is the structural win**: ranked search composed with SQL
  aggregation has no file-tools equivalent at any budget, and its cost
  doesn't grow with repo size.
- **Comprehension leans code-context**, with citations for free.
- **Localization stays native-grep territory**, and adding code-context
  costs nothing there because native tools remain available.
- Where file tools win, we say so. Single-run numbers per cell are
  indicative, not gospel - model tool choice varies run to run (the
  aggregation table shows the baseline varying 8x between identical runs).

## Indexing at scale

Keyword-index timings on an Apple Silicon laptop (the stage that gates
"search works"; the vector stage backfills in the background afterwards).
Sizes are after the automatic post-build compaction.

| Repo | Files → chunks | Keyword index | Unchanged-tree check | One-file sync | Index on disk |
|---|---|---|---|---|---|
| ~180k-LOC Rust engine | 311 → 3,042 | 0.9s | ~10ms | ~250ms (vectors kept current) | 30M |
| django | 3,597 → 15,824 | 6.7s | 149ms | 370ms | 37M |
| TypeScript (whole repo, incl. its 45k-file test suite) | 51,826 → 117,344 | 83s | 1.8s | 2.9s | 126M |

The TypeScript row is a deliberately hostile corpus: its test suite
contains parser stress fixtures that abort or stall parsers. Every parse
carries a cancellation deadline, so pathological files fall back to
fixed-window chunking and the run stays linear.

## Reproducing

The harness (lane runner, SWE-bench instance prep, question sets) lives in
[`bench/`](../bench/). It needs an Anthropic API key and produces the
JSONL these tables aggregate. The aggregation/comprehension corpus is any
repo you point it at - the numbers above used a public Rust codebase;
expect the aggregation multiple to grow with repo size.
