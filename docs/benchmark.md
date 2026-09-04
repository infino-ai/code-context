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

## The tool surface: names, shapes, and prose

The `find` run above showed an agent choosing tools on nothing but a name, a
description, and a result shape. This run measures how much each of those
steers, one lever at a time, and what the steering costs per turn. Measured
2026-09-04; the design and the decisions are in plan 101.

**Setup.** Same pinned clone (infino @ `ed4e020`, 401 files, 5,527 chunks,
indexed once, auto-sync off), same hermetic lane (stock file tools including
Grep, plus the code-context build under test), `claude-sonnet-4-6`, fresh
conversation per question. Four question sets, 36 questions: the shipped 16
(10 aggregation, 6 comprehension), the 8 pinpoint lookups, 6 *known-file*
questions whose right first call is Read ("what does `Cargo.toml` pin for
arrow"), and 6 *by-meaning* questions that name no identifier ("which code
decides when a superfile is compacted"). Three repeats, so 108 runs per
build; V0 and V3 were run twice over to measure the spread directly. Haiku
4.5 ran V0, V3, V6, V7 and V8, two passes each. Quality: the same blind pairwise
judge as the `find` run (`claude-opus-5` with Read/Grep/Glob on the clone;
winner, confidence, unsupported-claim counts), each variant against V0, and
the mechanical citation check. Selection is the primary metric: the first
tool called, against the tool the question shape is for.

The variants, each one change on the last, with the prose the model pays for
on every turn (chars / 4; JSON schema framing comes on top):

| build | change | tool text | instructions |
|---|---|---|---|
| V0 | the surface after `find` (`byFile`, limit 500) | ~1,280 tok | ~545 tok |
| V1 | descriptions cut to question shape, not-for, result shape; instructions cut to a routing table | ~790 | ~175 |
| V2 | V1 without the "show the usage line" sentence in three descriptions | ~650 | ~160 |
| V3 | V2 with `reindex` off the tool list | ~570 | ~160 |
| V4a | V3 with `search` renamed `context` | ~575 | ~160 |
| V5 | V3 with a tiered `search` result: content on the top 3 hits, a one-line excerpt below | ~590 | ~170 |
| V6 | V3 plus two sentences: answer from a hit without re-reading (in the instructions), and what `lang` holds | ~580 | ~185 |
| V7 | V6 with the answer-from-a-hit sentence in the `search` description as well | ~610 | ~185 |
| V8 | V7 with one sentence per description saying what the `usage` receipt reports, no request to show it | ~680 | ~185 |

### Selection: the prose was not doing the steering

Every build, every pass: `sql` first on 30 of 30 aggregation runs, `search`
first on 18 of 18 comprehension and 18 of 18 by-meaning runs. Cutting the
descriptions to a third and the instructions to a quarter moved none of it.
The known-file tripwire did not move either: Read was the first call on 3
to 5 of 18 runs on every build, `find` on 6 to 13, Glob on the rest.

Pinpoint moved, and how it moved is the finding. `find` was the first call
on 19 and 18 of 24 runs in the two V0 passes and on 14 and 15 of 24 in the
two V3 passes. Two questions account for it: the env-var inventory ("every
`std::env::var` read, with name and file:line") and the per-file test
count. The inventory opened with `find` in 6 of 6 V0 runs and 3 of 3 V1
runs, then with Grep in 9 of 9 runs under V2, V3 and V5 - and back to
`find` in 3 of 3 under V4a, whose only difference from V3 is the *other*
tool's name. A six-pass A/B on the pinpoint set alone pinned it: V1 opened
the inventory with `find` 6 of 6 and the test count with `find` or `sql` 6
of 6; V2, which differs from V1 only by the dropped receipt sentence ("the
result includes a 'usage' field - a one-line receipt (tokens returned,
matches/files, session total); after you answer, show it verbatim"), opened
them with Grep 6 of 6 and 5 of 6. Across everything run, that question is
`find` 12 of 12 with the sentence and Grep 15 of 15 without it. Two
lessons. A borderline question gets a stable choice for a given prompt text
and flips on wording that has nothing to do with it, so a 3-of-3 flip on
one question is not a signal; set totals are. And a sentence written to
make the model show a receipt was steering its tool choice.

The cost of the flip is real where it lands: the Grep runs on that question
took 15 to 24 calls and 135k to 192k tokens against 2 to 5 calls and 32k to
96k for the `find` runs, for the same inventory.

Which half of the sentence steered? V8 keeps a description of the field
("the result includes a 'usage' field, a one-line receipt of tokens
returned, matches and files") and drops the request to show it. Six
pinpoint passes: the inventory back to `find` 5 of 6, the test count to
`sql` 4 of 6, 39 of 48 first calls on a code-context tool against V1's 42
and V2's 31, at the lowest tokens of the three (191k against 232k and
302k). Telling the model what the result reports is what steers; asking it
to relay the receipt was never the active part.

### Cost: ten percent fewer tokens, reproducibly

Sums over questions of the per-question median; two passes each of V0 and V3:

| set | V0 | V0 again | V3 | V3 again |
|---|---|---|---|---|
| aggregation (10) | 138k | 146k | 157k | 146k |
| comprehension (6) | 746k | 774k | 669k | 738k |
| pinpoint (8) | 227k | 205k | 258k | 243k |
| known-file (6) | 131k | 131k | 113k | 107k |
| by-meaning (6) | 524k | 586k | 380k | 383k |
| **blended (36)** | **1,766k** | **1,842k** | **1,576k** | **1,617k** |
| cost per pass | $3.03 | $3.23 | $2.94 | $2.95 |
| tool calls | 103 | 105 | 119 | 124 |

Pass-to-pass spread on one build is 4 to 12% per set, so: by-meaning down
27 to 35% is real, blended down 10 to 12% is real, comprehension down 3 to
10% is at the edge, and aggregation up 6 to 14% is real and has a cause.
On the two aggregation questions that ask for "reasons", every trimmed
build followed the `sql` call with a `search` (9 of 9 runs against 1 of 6
under V0), and the "largest Rust files" question paid a three-call detour
(`lang = 'rust'`, no rows, list the languages, retry with `rs`) that nothing
in the description prevented. The judge rewarded the extra `search` (below);
V6 fixes the detour with eight words.

Single-call questions show the per-turn saving directly: an aggregation
question answered in one `sql` call costs 13k tokens under V0 and 11k under
V3, the 1.5k-token prompt difference, every turn of every conversation.

### Quality: better, not just level

Blind judge, each variant against V0, same question and repeat paired:

| variant | pairs | V0 wins | variant wins | ties | unsupported claims V0 / variant | median confidence |
|---|---|---|---|---|---|---|
| V1 | 107 | 39 | 46 | 22 | 185 / 151 | 0.70 |
| V3 | 108 | 31 | 55 | 22 | 283 / 192 | 0.72 |
| V5 | 107 | 35 | 47 | 25 | 243 / 201 | 0.72 |
| V8 | 107 | 33 | 51 | 23 | 302 / 236 | 0.68 |

V3 wins on every set (aggregation 21 to 8, by-meaning 10 to 7, comprehension
9 to 6, pinpoint 8 to 5 with 11 ties, known-file 7 to 5) and makes a third
fewer claims the code does not support. The aggregation gap is the second
`search` call: a "ranked list with a short reason each" answered from one
`sql` result invents its reasons; answered after a `search` it cites them.
V8, the shipping candidate, holds that: aggregation 18 to 10, by-meaning 11
to 6, pinpoint 9 to 7 with 8 ties, comprehension 7 to 7, and on the
known-file set 6 to 3 with 2 unsupported claims against 7 - the extra
`find`-first runs there did not cost the answers anything. No build cited a
line outside its file except one V4a answer; the trimmed builds' answers
carry more citations than V0's (0.7 to 0.8 against 0.5 per answer).

### The rename and the shape

`context` for `search` (V4a) changed nothing the rename was for: 18 of 18
first calls on both comprehension and by-meaning under either name, and
by-meaning tokens higher than V3 (452k against 380k). The name stays.

The tiered result (V5) trades dollars for round trips. Blended cost $2.61
against V3's $2.94, tokens level (1,640k), but 161 tool calls against 119:
Reads went from 49 to 86 on comprehension and from 10 to 54 on by-meaning,
because the agent reads the hits whose content it no longer has. Cheaper on
the bill because the Reads hit the prompt cache; slower because each is a
round trip. The judge calls it level with V0 on the sets the shape is for
(comprehension 8 to 8, by-meaning 9 to 8) where V3 wins them, and the
excerpt tier lost a little on known-file (3 to 6). A shape that costs a
third more round trips to arrive at the same answers does not ship as the
default; the branch stays for a client that pays per token and not per
round trip.

### The confirmation builds

V6 adds two sentences to V3: the instructions say again that a hit is
answered from without re-reading the file, and the `sql` description says
`lang` is the file extension. V7 puts the first sentence in the `search`
description as well. V8 adds the receipt-field sentence from the A/B above
to each description. Sonnet, tokens per set, alongside both passes of V0
and V3:

| set | V0 | V0 again | V3 | V3 again | V6 | V7 | V8 |
|---|---|---|---|---|---|---|---|
| aggregation | 138k | 146k | 157k | 146k | 142k | 146k | 136k |
| comprehension | 746k | 774k | 669k | 738k | 519k | 572k | 578k |
| pinpoint | 227k | 205k | 258k | 243k | 253k | 203k | 204k |
| known-file | 131k | 131k | 113k | 107k | 121k | 112k | 114k |
| by-meaning | 524k | 586k | 380k | 383k | 539k | 433k | 435k |
| **blended** | **1,766k** | **1,842k** | **1,576k** | **1,617k** | **1,574k** | **1,465k** | **1,468k** |
| cost per pass | $3.03 | $3.23 | $2.94 | $2.95 | $2.93 | $2.87 | $2.77 |
| tool calls | 103 | 105 | 119 | 124 | 118 | 105 | 107 |
| first call on a code-context tool | 94/108 | 94/108 | 88/108 | 87/108 | 90/108 | 94/108 | 97/108 |

The `lang` sentence removed the detour (the largest-Rust-files question is
one `sql` call again). The restored steer brought comprehension to 519k to
578k, under every V0 and V3 pass, with Reads at 33 against 49 to 53. V7 and
V8 are the first trimmed builds to match V0's round trips and first-call
count while spending 17 to 19% fewer tokens; V8 adds the pinpoint steer
(`find` or `sql` first on 18 of 24 against V7's 17 and V3's 14 to 15) and
the highest code-context first-call count of the run. Its one soft spot is
the tripwire set: `find` was the first call on 13 of 18 known-file runs
against V0's 9 and 10, though at 114k tokens against 131k, because a `find`
that lands on a file the agent should have Read costs one cheap call, not a
detour, and the judge preferred V8's known-file answers 6 to 3.

### Haiku 4.5

Two passes of each build, tokens per set:

| set | V0 | V0 again | V3 | V3 again | V6 | V6 again | V7 | V7 again | V8 | V8 again |
|---|---|---|---|---|---|---|---|---|---|---|
| aggregation | 314k | 182k | 190k | 154k | 194k | 262k | 163k | 147k | 183k | 170k |
| comprehension | 889k | 904k | 1,402k | 1,290k | 1,412k | 847k | 864k | 797k | 1,186k | 794k |
| pinpoint | 366k | 323k | 387k | 328k | 287k | 251k | 392k | 411k | 365k | 524k |
| known-file | 126k | 126k | 103k | 111k | 98k | 109k | 109k | 109k | 110k | 110k |
| by-meaning | 866k | 896k | 853k | 896k | 780k | 605k | 622k | 644k | 627k | 726k |
| **blended** | **2,560k** | **2,432k** | **2,935k** | **2,779k** | **2,772k** | **2,074k** | **2,150k** | **2,108k** | **2,471k** | **2,326k** |

Selection on Haiku is the same story as Sonnet: `sql` first on 27 to 29 of
30 aggregation runs and `search` first on 16 to 18 of 18 on every build,
`find` first on 13 to 16 of 24 pinpoint runs, and never a code-context
tool on the known-file set (Bash or Read, then Read). Haiku is where the
fourth tool cost something: on "break down the crate by top-level module"
it called `reindex` in 2 of 3 V0 runs, once as its first call, and the two
V0 aggregation passes swing 314k to 182k largely on that question. With
`reindex` hidden the set sits between 147k and 262k.

Haiku is also where the trimmed text lost something Sonnet did not need.
Comprehension went from about 900k tokens under V0 to 1.3M and 1.4M under
V3, with Reads doubled (82 and 97 against 40 and 45) and Grep up (13 and 17
against 2 and 6): V0's `search` description said to answer from a hit
without re-confirming it by opening the file, the trimmed one said "answer
and cite from the hits", and Haiku went back to reading. Putting the
sentence back in the server instructions (V6) split the passes, 1.4M and
847k; putting it in the `search` description as well (V7), where the model
reads it as the hits arrive, brought both passes to 864k and 797k, under
V0. V8, the same text plus the receipt-field sentence, split again (1,186k
and 794k). Haiku's spread on this six-question set is wide - the same
build lands 65% apart - so the honest reading is: the trimmed text without
the sentence was over V0 in all four passes, and with it in the `search`
description it was at or under V0 in three of four. Haiku also invented a
tool name (`mcp__code_context__search`, underscores for the hyphen) in 9
of 648 runs on the trimmed builds and never in 216 under V0; each such
call fails and the run falls back to Grep and Read.

### What this run decides

- **`search` keeps its name and its shape.** The rename moved nothing it
  was meant to move; the tiered result buys dollars with round trips and
  answers no better.
- **The descriptions and instructions ship trimmed**, at about 680 tokens
  of tool text and 185 of instructions per turn against 1,280 and 545,
  with three sentences the trim had cut and the runs showed were
  load-bearing: answer from a hit without re-opening the file (in the
  `search` description, for Haiku), what the `usage` receipt reports (in
  each description, for the two lookups on Sonnet), and what `lang` holds.
- **The "show the usage line" request goes.** It was paid three times per
  turn, and the part of the sentence that steered was the description of
  the field, which stays.
- **`reindex` leaves the tool list.** Nothing on Sonnet called it in 216
  runs; Haiku called it where it hurt. Auto-sync and auto-index cover the
  job in a session and `cx index --full` on the command line.
- **Prose is measured from now on.** Every sentence in a description costs
  every turn; this run found two that steered selection and one that
  steered how many files got opened, none of them written for that. The
  question sets and the comparison scripts in `bench/` are the harness for
  the next change.

**Caveats.** Sonnet's pass-to-pass spread is 4 to 12% per set; Haiku's is
wider (aggregation 314k against 182k on V0). Per-question first-call counts
are stable per prompt and flip on unrelated wording, so only set totals are
read. The pinned clone and the disabled auto-sync are the same discipline as
the `find` run. Spend: about $50 of agent runs (11 Sonnet passes over the
four sets, three pinpoint-only passes, 10 Haiku passes) and about $107 of
judging, four variants at a quarter of a dollar a pair.

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
the eight-lookup set from the `find` comparison above; `infino-known-file.json`
(questions whose right first call is Read) and `infino-by-meaning.json`
(questions that name no identifier) measure tool selection for the surface
comparison that follows it. Wall-clock is only clean
run sequentially (`CX_BENCH_CONCURRENCY=1`); tool-call count is the
concurrency-independent latency proxy. Expect the aggregation multiple to
grow with repo size, and the whole gap to grow on weaker models.
