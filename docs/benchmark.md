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
- **Prompting:** both lanes get the identical minimal system prompt,
  verbatim: *"You answer questions about the repository checked out at
  \<path\>. Use the available tools to find the answer. Cite file paths
  (with line ranges when you have them). Be efficient: prefer few,
  well-chosen tool calls."* Both lanes are equally asked to cite and to be
  efficient; neither is told which tool to prefer, so tool choice comes
  from tool names and descriptions alone.
- **Tokens** = input + cache writes + cache reads + output, as reported by
  the API for the full run - everything the run made the API process.
  **Cost** uses the API's own per-run accounting (which prices cache reads
  correctly).

Three question classes, because they stress retrieval differently.

## 1. Relevance aggregation - "which files have the most code about X"

Ten questions we authored (disclosed mix: 6 aggregation-shaped, 4
comprehension) against [infino](https://github.com/infino-ai/infino), the
public ~180k-line Rust engine this tool is built on (3,042 indexed chunks).
Using our own repo is a limitation worth naming - run the harness on yours.
Questions 1-6 are aggregation-shaped: rank files by how much they're about
a topic, tally the codebase by language, find the largest files. File tools
must read source into context to tally; `sql` composes ranked search with
GROUP BY in one engine pass. Two independent runs per question per lane;
no run errored or hit the turn cap.

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

**Answer quality:** cheaper is only a win if the answers hold up, so all
20 answer pairs went to a blind pairwise judge (claude-opus-4-8, lanes
anonymized and order randomized, judging correctness-consistency,
completeness, and usefulness). Verdicts: 8 for code-context, 12 for file
tools, none decisive - a 12/20 split is well within binomial noise
(p≈0.25), i.e. no measurable quality difference. The judge cannot verify
claims against the repo, so this measures answer completeness and
consistency, not ground truth.

## 3. Localization study - SWE-bench_Verified

A harder secondary test: 30 instances from
[SWE-bench_Verified](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Verified) -
the complete yield of the filter (15-60-minute difficulty, exactly two
modified files), no further selection, spanning django, sympy, astropy,
scikit-learn, matplotlib, sphinx, xarray, pytest, pylint, seaborn. The
agent reads the real GitHub issue and must name the files the merged fix
actually touched. **Three independent runs per instance per lane** (90
runs per lane); a run that exhausts its 12-turn budget without an answer
scores 0 and its spent tokens still count.

Isolated lanes measure the substrate; the third lane is the real
deployment. An MCP server adds tools and never removes the native ones,
so an installed agent has both and picks per query.

| Mean over 90 runs | code-context only | file tools only | both installed |
|---|---|---|---|
| F1 vs gold patch files | **0.696** | 0.663 | 0.678 |
| Recall | **0.583** | 0.539 | 0.567 |
| Precision | **0.931** | 0.911 | 0.906 |
| Tool calls per instance | **3.4** | 4.2 | 3.8 |
| Tokens per instance | 57.3k | **25.9k** | 42.1k |
| Runs completed in budget | 88/90 | 87/90 | **90/90** |

The F1 ordering held in each of the three runs individually (code-context
0.678 / 0.722 / 0.689 vs file tools 0.667 / 0.667 / 0.656), so the
accuracy edge is consistent, if modest. Reading it honestly: literal
known-symbol lookup is native grep's home turf. Lean grep output beats
content-rich search hits on tokens for this question class, while
code-context localizes more accurately in fewer calls. With both installed
the agent mixes freely, lands between the isolated lanes on accuracy and
tokens, and was the only configuration that completed every run within
budget: installing code-context does not degrade localization accuracy,
and it adds the question classes above.

The same both-installed configuration re-run on the question suite
confirms the routing goes the other way where the index wins: the agent
chose `sql` first on every aggregation question unprompted (12.0k tokens
per question vs 51.1k for file tools alone) and answered comprehension
questions through ranked search (59.0k vs 81.3k), so the savings above
survive real deployment.

## Reading the results

- **Aggregation is the structural win**: ranked search composed with SQL
  aggregation has no file-tools equivalent at any budget. Its cost grows
  with the index, not with how much source the model would otherwise read.
- **Comprehension leans code-context**, with citations for free.
- **Localization stays native-grep territory**: adding code-context does
  not reduce accuracy there (native tools remain available and the agent
  uses them), though runs that mix in content-rich hits spend more tokens
  than lean grep output alone.
- Where file tools win, we say so. These are small-n measurements -
  model tool choice varies run to run (the baseline swings more than 2x
  between identical runs on some questions, and 8x across questions).

## Indexing at scale

Keyword-index timings on an Apple Silicon laptop (the stage that gates
"search works"; the vector stage backfills in the background afterwards).
Sizes are after the automatic post-build compaction.

| Repo | Files → chunks | Keyword index | Unchanged-tree check | One-file sync | Index on disk |
|---|---|---|---|---|---|
| ~180k-LOC Rust engine | 311 → 3,042 | 0.9s | 20ms | 0.7s (vectors kept current) | 20M with vectors |
| django | 3,597 → 15,824 | 6.7s | 149ms | 370ms | 37M keyword-only |
| TypeScript (whole repo, incl. its 45k-file test suite) | 51,826 → 117,344 | 83s | 1.8s | 2.9s | 126M keyword-only |

The Rust-engine row is a full index (vector stage: 102s); the django and
TypeScript rows were measured keyword-only, with sync timings that do not
include re-embedding.

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
