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

## Where ranked search does not help

Pinpoint symbol lookup - "jump to this one known identifier" - is a single
grep's home turf, and ranked search does not beat it there: it returns
chunks that carry their content, which is dead weight when all you need is one
path. That same content is exactly what lets the comprehension answers quote
code without opening the file. Same mechanism, opposite sign, depending on
whether the question is "where is this exact name" or "how does this work".
The `find` tool exists for that first question; the next section measures it.

## `find`, the grep replacement

Does adding `find` - every line containing an exact string, cited
`path:line` - change what an agent answers, or what it costs? Measured
2026-09-04 against the three-tool build, on the same repo, questions, model
and judge.

**Setup.** Two hermetic lanes from `bench/run-questions.mjs`, differing only
in the server build: *main* (`search`, `sql`, `reindex`, from `main @ eec2fe7`)
and *find* (the same plus `find`, from `feat/find-tool @ dc713da`). Both
lanes keep the stock file tools including Grep; nothing is restricted. Repo
under test: [infino](https://github.com/infino-ai/infino) pinned at
`ed4e020` (402 files, 5,528 chunks), indexed once from that clone with
auto-sync off, so every run sees the same index. Agent `claude-sonnet-4-6`,
50-turn cap, fresh conversation per question. Two question sets: the shipped
16 (10 aggregation, 6 comprehension; 3 repeats), and 8 pinpoint lookups
written to be grep's home ground and phrased without naming a tool
(`bench/questions/infino-pinpoint.json`; 2 repeats). 128 agent runs, 64
judged pairs. Quality was measured two ways: a mechanical citation check
(every cited file exists, every line range is in bounds, the identifier named
beside a citation appears within five lines of it), and a blind pairwise
judge (`claude-opus-5`, a different model from the agent) that sees both
answers in random order with Read/Grep/Glob on the clone and returns a
winner, a confidence, and unsupported-claim counts. Tokens are input + cache
writes + cache reads + output; cost is the API's accounting; per-question
figures are medians over repeats and totals sum the medians.

### Answer quality: level

| Blind judge | Pairs | main wins | find wins | Ties | Unsupported claims main / find | Median confidence |
|---|---|---|---|---|---|---|
| shipped, aggregation | 30 | 15 | 9 | 6 | 109 / 97 | 0.62 |
| shipped, comprehension | 18 | 7 | 8 | 3 | 37 / 29 | 0.68 |
| pinpoint | 16 | 7 | 5 | 4 | 13 / 17 | 0.84 |
| **all** | 64 | 29 | 22 | 13 | 159 / 143 | 0.70 |

The signals point both ways, which is what no effect looks like: main takes
more wins, `find` has fewer unsupported claims on the shipped set and a few
more on the pinpoint set, and where the judge is confident (pinpoint, 0.84)
the split is 7 to 5 with 4 ties. No answer in either lane cited a line
outside its file. The one change is in the form of the answers: on the
pinpoint set, `find` answers carried 111 line-ranged citations across 16
answers against main's 22, all 105 identifier-anchored ones anchored
correctly. Same correctness, more of it shown.

### Cost: exact lookups a third cheaper, everything else flat

Pinpoint set, medians over repeats:

| Q | Question | main tokens | find tokens | Tokens | Calls main → find | How find answered |
|---|---|---|---|---|---|---|
| 1 | Where `RRF_K` is defined and its value | 49k | 17k | -66% | 2.5 → 1 | one find |
| 2 | Every call site of `reconcile_tombstone_seqs` | 20k | 17k | -14% | 1.5 → 1 | one find |
| 3 | File defining `InfinoError` and its variant count | 108k | 45k | -58% | 5.5 → 2.5 | find, then Read |
| 4 | Every `std::env::var` read, with name and file:line | 203k | 92k | -55% | 13.5 → 3 | two or three finds |
| 5 | Where `pointer_refresh_due` is defined and called | 24k | 17k | -30% | 2 → 1 | one find |
| 6 | Crate, arrow, datafusion versions in Cargo.toml | 22k | 49k | +121% | 1 → 3.5 | three finds, then Read; main did one Read |
| 7 | `#[tokio::test]` counts per file under src/supertable/ | 16k | 17k | +6% | 1 → 1 | Grep, same as main |
| 8 | tracing call sites in src/compaction/ with messages | 135k | 121k | -11% | 8.5 → 9 | mixed find, Grep, Read |
| | **pinpoint (8), tokens** | 578k | 374k | **-35%** | 35.5 → 22 (**-38%**) | |
| | **pinpoint (8), cost per pass** | $0.68 | $0.56 | **-17%** | | |

Where it fits, it collapses the search: definitions, call sites and
repo-wide inventories (Q1 to Q5) go from a grep-then-read sequence to one to
three `find` calls. The env-var inventory is the clearest case - main's worst
run was 23 calls and 380k tokens, `find`'s best was 2 calls and 57k, with
every cited line verified by the judge. Where it does not fit, the agent
sometimes uses it anyway: Q6 asks for a few lines of one known file, main did
one Read, and the `find` lane ran three finds and then read the file (this is
what the tool description's "a known file is a Read" sentence is for). The
agent opened with `find` in 12 of 16 lookup runs; on main the first call was
Grep in 8 of 16.

Shipped set, by category:

| Category | main tokens | find tokens | Tokens | Cost main → find | Calls main → find |
|---|---|---|---|---|---|
| aggregation (10) | 186k | 244k | +31% | $0.28 → $0.33 (+20%) | 11 → 16 |
| comprehension (6) | 719k | 635k | -12% | $1.27 → $1.24 (-3%) | 30 → 27 |
| **blended (16)** | 904k | 879k | **-3%** | $1.55 → $1.57 (**+1%**) | 41 → 43 |

Flat overall, with the two categories moving in opposite directions by
amounts inside the repeat-to-repeat spread. Two small effects are real. Seven
of the ten aggregation questions are one `sql` call in both lanes, and each
moved from 17k to 18k tokens uniformly: that is the fourth tool's schema and
description in every turn's prompt, roughly a thousand tokens. And on two
aggregation questions the agent tried `find` before falling back to `sql`.
The agent used `find` in 5 of 48 shipped-set runs; these are not the
questions it exists for.

### What the run found, and what changed after it

- Quality unchanged; cost down by a third in tokens and a sixth in dollars
  where the tool applies; a standing cost of about a thousand prompt tokens
  per turn plus occasional mis-selection.
- One grep-shaped question was not covered: per-file counts (Q7). `find`
  returned lines with a total, capped at 100 by default in that build, where
  the true answer was about 300 lines across 27 files, so the agent used Grep
  instead. Both lanes answered that question identically, and identically
  wrong (13 files where the tree has 27). The build measured here was
  `dc713da`; the commits after it added `byFile` - matching lines per file
  over every match, never cut - the "known file is a Read" steer, and a
  default limit of 500 (the cap), none of which is measured above.
- Steering is by description only and mostly works: nothing restricts Grep,
  and the agent still preferred `find` on lookups.

**Caveats.** Sonnet 4.6 is the bench default, and tool-selection behaviour -
which drives both the gains and the mis-selection cost - is model-dependent.
Repeats are 3 on the shipped set and 2 on pinpoint; per-question deltas under
about ±50% are noise, so read the totals (main's own pinpoint total varied by
50% between this run and one two days earlier on the same commit). A first
run was discarded because the working tree under test had moved two versions
ahead of its index, so `find` returned line numbers right for the indexed tree
and wrong for the live one: exact-looking, no signal. The MCP server's
auto-sync exists for exactly that; the bench disables it to keep the index
identical across runs, so it must pin the tree instead. Spend for the two
lanes: about $14 of agent runs and $14 of judging.

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
your own repo and questions with no code changes. `infino-pinpoint.json` is
the eight-lookup set from the `find` comparison above. Wall-clock is only clean
run sequentially (`CX_BENCH_CONCURRENCY=1`); tool-call count is the
concurrency-independent latency proxy. Expect the aggregation multiple to
grow with repo size, and the whole gap to grow on weaker models.
