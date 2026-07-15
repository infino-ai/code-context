# Benchmark

code-context gives a coding agent ranked retrieval over the whole repo
instead of crawling files into context. This measures what that changes in
real agent runs - same model, same prompt, only the toolset differs - on
three axes: **tokens**, **tool calls** (round-trips), and **wall-clock time**.

The short version: on a codebase the model does not already know, adding
code-context cut **~32% of tokens, ~53% of tool calls, and ~32% of end-to-end
time** across the suite, and roughly **halved the time on aggregation
questions** (48% faster). The win is largest where an agent would otherwise
burn context - ranking or aggregating across the repo, understanding a
subsystem - and smallest on pinpoint symbol lookup, where a single grep is
already cheap.

## What repo this runs on, and why it matters

These numbers are on [infino](https://github.com/infino-ai/infino), the
public ~180k-line Rust engine this tool is built on (313 files, 3,133
indexed chunks). We use it because the model has **not** memorized it - which
is the realistic case for *your* private codebase. On a famous open-source
repo (say Django) the file-tools baseline can shortcut from training
knowledge, jumping straight to the right files without exploring, and the gap
narrows or disappears. The honest scope of these results is **your own
code**, where the agent has no memorized shortcuts.

## Setup

- **Model:** `claude-sonnet-4-6` on every lane, via the Claude Agent SDK
  (each run a real multi-turn agent conversation).
- **Lanes** (hermetic - user config, plugins, and MCP servers excluded):
  - *stock file tools* - Glob, Grep, Read, LS, **and Bash** (real Claude
    Code has a shell; a no-Bash baseline would overstate the gap).
  - *code-context* - the same file tools **plus** the MCP tools (`search`,
    `sql`, `reindex`), i.e. exactly what installing the server produces.
- **Prompting:** both lanes get the identical minimal system prompt; neither
  is told which tool to prefer, so tool choice comes from tool names and
  descriptions alone.
- **Questions:** 16, disclosed mix - 10 aggregation-shaped, 6 comprehension
  (`bench/questions/infino.json`). One run per question per lane, sequential
  (so wall-clock is contention-free); no run hit the turn cap.
- **Tokens** = input + cache writes + cache reads + output, as reported by
  the API. **Tool calls** count model round-trips. **Time** is end-to-end
  wall-clock per run.

## A note on model strength (these numbers are conservative)

Sonnet 4.6 is a strong model that already uses file tools fairly efficiently,
so this is close to a worst case for showing a gap. Weaker and cheaper models
(e.g. Haiku) explore less efficiently - they grep loosely and read whole
files to find things - so the file-tools baseline is more wasteful and
retrieval saves *more*; in our runs the aggregation win was larger on Haiku
than on Sonnet. Conversely, the very strongest models close some of the gap
by exploring more efficiently themselves. So read these as a mid-range,
conservative figure: expect **larger** savings on the smaller models many
teams actually run in their agents day to day.

## Results

Combo (code-context added) vs stock file tools, by category:

| Category | Tokens | Tool calls | Wall time |
|---|---|---|---|
| **Aggregation** (10q) | 641k → 368k (**-43%**) | 98 → 28 (**-71%**) | 693s → 357s (**-48%**) |
| **Comprehension** (6q) | 2.16M → 1.53M (**-29%**) | 73 → 53 (**-27%**) | 602s → 525s (**-13%**) |
| **Blended** (16q) | 2.80M → 1.90M (**-32%**) | 171 → 81 (**-53%**) | 1295s → 882s (**-32%**) |

![code-context vs stock file tools: reduction by metric](benchmark-chart.png)

### Aggregation - "which files have the most code about X"

Rank files by how much they're about a topic, tally by language, find the
largest files. File tools must read source into context to tally; `sql`
composes ranked search with `GROUP BY` in one engine pass. This is the
structural win - there is no file-tools equivalent at any budget - and the
sharpest on **time**: the agent reaches the answer in a couple of tool calls
instead of a grep-read-tally loop, so it finishes ~2x faster. It is also the
most consistent: combo answers most of these in one `sql` call (~16k tokens),
while the baseline swings 20k-195k depending on how much source it reads.

### Comprehension - "how does X work"

Explain a write path, how compaction merges, how hybrid search fuses results,
crash-consistent commit. Both lanes can answer; the difference is the cost of
assembling context. Here the win is real but smaller and noisier - the combo
lane still reads files to trace things, so round-trips drop less (27%) and
time follows (13%). The biggest wins land on the questions where the baseline
reads the most (one dropped from 861k tokens to 292k). Every answer carries
`path:start-end` citations, since hits arrive as ranked chunks with content.

## Where it does not help

Pinpoint symbol lookup - "jump to this one known identifier" - is a single
grep's home turf, and an index does not beat it there: ranked search returns
chunks that carry their content, which is dead weight when all you need is one
path. That same content is exactly what lets the comprehension answers quote
code without opening the file. Same mechanism, opposite sign, depending on
whether the question is "where is this exact name" or "how does this work".
The tool descriptions say as much, so the agent still uses a plain grep for
pinpoint lookups.

## Indexing at scale

Keyword-index timings on an Apple Silicon laptop (the stage that gates
"search works"; the vector stage backfills in the background afterwards).
Sizes are after the automatic post-build compaction.

| Repo | Files → chunks | Keyword index | Unchanged-tree check | One-file sync | Index on disk |
|---|---|---|---|---|---|
| ~180k-LOC Rust engine | 313 → 3,133 | 1.0s | 20ms | 0.7s (vectors kept current) | 20M with vectors |
| django | 3,597 → 15,824 | 6.7s | 149ms | 370ms | 37M keyword-only |
| TypeScript (whole repo, incl. its 45k-file test suite) | 51,826 → 117,344 | 83s | 1.8s | 2.9s | 126M keyword-only |

The Rust-engine row is a full index (vector stage: ~2min); the django and
TypeScript rows were measured keyword-only, with sync timings that do not
include re-embedding. The TypeScript row is a deliberately hostile corpus
(parser stress fixtures); every parse carries a cancellation deadline, so
pathological files fall back to fixed-window chunking and the run stays
linear.

## Reproducing

The harness lives in [`bench/`](../bench/): index a repo, then run the two
lanes over a question set. It needs an Anthropic API key and produces the
JSONL these tables aggregate.

```
cx index /path/to/repo
node bench/run-questions.mjs /path/to/repo          # default question set
```

Question sets are `bench/questions/*.json` (`{cat, q}` arrays) - point it at
your own repo and questions with no code changes. Wall-clock is only clean
run sequentially (`CX_BENCH_CONCURRENCY=1`); tool-call count is the
concurrency-independent latency proxy. Expect the aggregation multiple to
grow with repo size, and the whole gap to grow on weaker models.
