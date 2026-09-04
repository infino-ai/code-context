# Benchmark harness

Real agent runs (Claude Agent SDK) comparing **stock file tools** against the
same agent with the **code-context MCP added** - same model, same turn budget,
hermetic lanes. The only variable is whether the agent has the index, and,
for the hosted lanes, where that index lives.

Needs: Node ≥ 20 and `ANTHROPIC_API_KEY` in the environment. Everything writes
under `bench/.work/` (gitignored).

```bash
cd bench && npm install    # installs @anthropic-ai/claude-agent-sdk

# Index the repo under test once, then run the two lanes over the suite:
cx index /path/to/repo
node run-questions.mjs /path/to/repo                        # default questions
node run-questions.mjs /path/to/repo files,combo questions/mine.json
```

Nothing is hardcoded - the repo, lanes, and question set are all arguments.
Question sets live in [`questions/`](questions/) as a JSON array of
`{ "cat": "aggregation"|"comprehension", "q": "..." }`; `cat` splits the summary
into **aggregation** (ranking/counting across the repo) vs **comprehension**
(how/where something works). Add your own file there and pass its path (or set
`CX_BENCH_QUESTIONS`). Shipped sets:

- `questions/infino.json` (default) - targets the
  [infino](https://github.com/infino-ai/infino) engine repo.
- `questions/swe-qa-django.json` - the comprehension slice from the
  [SWE-QA](https://github.com/peng-weihan/SWE-QA-Bench) dataset; run it against
  Django checked out at commit `14fc2e9`:
  ```
  git clone https://github.com/django/django && git -C django checkout 14fc2e9
  cx index django && node run-questions.mjs django files,combo questions/swe-qa-django.json
  ```

The win is largest on a codebase the model does not already know from training
(a private repo), where the file-tools baseline has to explore rather than
recall; on a well-known open-source repo the baseline can shortcut from memory.

## Lanes

The lane table lives in `lanes.mjs` (`LANES`); an unknown lane name is an
error, not a silent fall-through to the files lane. Every lane shares the same
hermetic base and differs only in the toolset and, for the hosted pair, in
where the server's index lives.

| lane           | kind   | built-in tools            | MCP server | server command line, after `cx mcp` (every MCP lane also gets `CX_ROOT`, `CX_INDEX_DIR`, `CX_AUTO_SYNC=0` in its env) | needs in your env                        |
| -------------- | ------ | ------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `files`        | local  | Glob, Grep, Read, LS, Bash | no         | -                                                                                                                      | -                                        |
| `cx`           | local  | Read                      | yes        | -                                                                                                                      | -                                        |
| `combo`        | local  | Glob, Grep, Read, LS, Bash | yes        | -                                                                                                                      | -                                        |
| `hosted`       | hosted | Glob, Grep, Read, LS, Bash | yes        | `--db $CX_BENCH_DB_URL --api-key-file $CX_BENCH_KEY_FILE --embed-provider platform` (`CX_BENCH_EMBED_PROVIDER` overrides the provider) | `CX_BENCH_DB_URL`, `CX_BENCH_KEY_FILE`  |
| `hosted-agent` | hosted | Glob, Grep, Read, LS, Bash | yes        | as `hosted` plus `--retrieval-agent`                                                                                   | `CX_BENCH_DB_URL`, `CX_BENCH_KEY_FILE`  |
| `agent-only`   | hosted | Read                      | yes        | as `hosted-agent`, with `find`, `search` and `sql` removed from the model's context (the SDK's `disallowedTools`)      | `CX_BENCH_DB_URL`, `CX_BENCH_KEY_FILE`  |

`combo` is what installing the MCP server actually produces in a real client;
`hosted` is the same agent and the same three tools with the index in a
platform database (`CX_BENCH_DB_URL` is `https://host/<database>`, the shape
the engine's own URI parser accepts); `hosted-agent` adds the `retrieval_agent`
tool, one question answered by the platform's own agent loop, and measures
whether the model picks it; `agent-only` leaves it as the only retrieval tool
and measures its answers and cost in isolation.
A hosted lane fails before the first paid model call when `CX_BENCH_DB_URL` or
`CX_BENCH_KEY_FILE` is missing. The server is configured by its command line
alone (the `CX_BENCH_*` names are the harness's, never read by `cx`), and the
key reaches it as the path of the file holding it: no script here reads or
prints the key, and results record `dbHost` (the host) and nothing else of the
URL. Auto-index is off in hosted mode by the server's own rule: loading a repo
into the database is a separate, metered step (below), never something a
question triggers.

Getting a hosted database ready:

```bash
export CX_BENCH_DB_URL=https://<host>/<database> CX_BENCH_KEY_FILE=~/.infino/key
node load-hosted.mjs /path/to/repo              # cx index --json --db ... --api-key-file ... --embed-provider platform <repo>, timed -> .work/results/index-build.jsonl
node load-hosted.mjs /path/to/repo local        # the same CLI against .infino/, for the comparison row
node warm-hosted.mjs                            # POST /v1/list_tables until 200; prints rtt and whether a cold start was seen
node run-questions.mjs /path/to/repo combo,hosted
```

`load-hosted.mjs` runs the server build's own CLI (`dist/cli.js`, or
`CX_BENCH_CLI`) with the `--db` flag hosted mode adds to `cx index`. A CLI
that does not have the flag yet fails with commander's "unknown option" line,
which the record keeps verbatim (`error`) rather than pretending a build
happened. `warm-hosted.mjs` exists because a cold database answers `503`
(worker spawning, `Retry-After: 5`) or `529` (no capacity, `Retry-After: 600`)
until a worker is live, and a question landing on that would bill the spawn to
the model's clock; it honours `Retry-After`, gives up after 120 s, and reports
the round trip of the first `200` and every status it saw on the way.

Lane design notes (they matter for fairness):

- `settingSources: []` + `strictMcpConfig: true` keep your user-level plugins,
  MCP servers, and CLAUDE.md out of every lane.
- `tools: [...]` pins the built-in set exactly (every lane but `cx` includes
  Bash, since real Claude Code has it); the MCP server is registered with
  `alwaysLoad: true` so its tools are present in the turn-1 prompt, not
  deferred behind tool search.
- All lanes get the same minimal system prompt; none is taught which tool to
  prefer.
- Token totals count input + cache writes + cache reads + output; cost uses the
  API's per-run accounting.
- Model is set in `lanes.mjs` (`BENCH_MODEL`, default `claude-sonnet-4-6`).
- The MCP lanes run this checkout's `dist/cli.js`. To compare two builds of
  the server (a tool-surface variant against main), point a run at another
  build with `CX_BENCH_CLI=/path/to/other/dist/cli.js` and label it with
  `CX_BENCH_BUILD=<name>`; both land on every result row, so one
  `questions.jsonl` can hold every variant.
- The run summary compares every other lane against the first lane given, so
  the default `files,combo` reads "combo vs files" and `combo,hosted` reads
  the hosted server against the local one.

## What a result row carries

Every row in `.work/results/questions.jsonl` has the question (`q`, `cat`,
`repo`), the lane (`lane`, `laneKind` = `local`|`hosted`, `dbHost` = the
platform host for a hosted lane, else `null`), the build (`build`, `cli`,
`model`), the run totals (`tokens`, `usage`, `costUsd`, `wallMs`, `calls`,
`answer`, `error`, `ts`) and the tool trace:

- `toolCalls` - the tool names in call order, code-context tools as
  `cx:find` / `cx:search` / `cx:sql` (unchanged; every reader keys on it).
- `toolDetails` - one object per call, same order: `{ name, tookMs, usage }`
  plus `isError: true` when the tool returned an error. `tookMs` is the
  server-side `took_ms` the code-context result carries (engine work plus
  query embedding, no transport) and `usage` is its one-line receipt
  (`returned ~1.2k tokens | 8 chunks / 5 files | invoked 3x this session
  (...)`); both are `null` for built-in tools and for a result that was not
  JSON.
- `cxTookMs` - the sum of `tookMs` over the code-context calls of the run:
  the engine's share of the wall clock, comparable between local and hosted
  since the tool result has the same shape in both. Hosted-only telemetry
  (round trip, platform tokens) is not in the tool result the model sees - it
  goes to the server's usage ledger - so it is not on the row either.

The harness reads the SDK's user-role messages for this: a `tool_result`
block answers each `tool_use` by id, and for an MCP tool the message also
carries the server's structured output as `tool_use_result`
(`{content:[{type:"text",text}]}`), which is preferred over the block text.

Build records (`.work/results/index-build.jsonl`, from `load-hosted.mjs`):
`{ side: "hosted"|"local", repo, dbHost, cli, build, wallMs, exitCode, error, ts }`
plus every field of the CLI's `--json` output (`files`, `chunks`, `vectors`,
`indexMs`, `embedMs`, ... for a full build; the sync outcome for an
incremental one).

## Reading a multi-build results file

All default to `.work/results/questions.jsonl`; a build is its `CX_BENCH_BUILD`
label, or `since..until` ISO timestamps for rows recorded before the label
existed. Every reader filters to one lane: `compare-builds.mjs` takes it as
the third positional (default `combo`), `judge.mjs` as the sixth (default
`combo`; pass `""` for the cats slot to keep the default there). Run a reader
once per lane to put a hosted run next to the local one.

```bash
node compare-builds.mjs "" V0,V3          # per set: tokens, cost, calls, cx ms, first tool; CX_MD=1 for markdown, CX_DETAIL=1 per question
node compare-builds.mjs "" V3 hosted      # the same table for the hosted lane's rows
node cite-check.mjs /path/to/repo "" V0,V3  # every cited path:line exists, is in bounds, and names an identifier found nearby
node judge.mjs /path/to/repo V0 V3          # blind pairwise judge (claude-opus-5, Read/Grep/Glob on the repo) -> .work/results/judge.jsonl
node judge.mjs /path/to/repo V3 V3 "" "" hosted   # judge the hosted lane's rows (verdicts record `lane`)
node judge-report.mjs                       # wins, ties, unsupported claims and confidence per set for each judged pair
```

The `cx ms` column is the sum over questions of the median `cxTookMs`; rows
from before it was recorded count as 0. The judge sees both answers in random
order and returns a winner, a confidence, and how many claims each answer
makes that the code does not support; `JUDGE_LIMIT=n` caps the pairs for a
smoke run. Judging costs about a quarter of a dollar per pair.

## Caveats to state in any local-vs-hosted report

1. **The engine version is a lane attribute.** The local lanes run the
   `@infino-ai/infino` Node binding this checkout links (engine 0.5.5 at the
   time of writing), while the platform worker links engine 0.5.12. A gap in
   `cxTookMs` or in hit ranking between `combo` and `hosted` can be the engine
   version, not the transport; say which versions the run used.
2. **The platform's read-token header is not engine work.** The
   `x-infino-read-tokens` figure the platform meters folds in RAM rent for the
   database's idle time, so it moves with how long the worker sat between
   calls, not only with what a query did. Report it as cost, never as a
   latency or work proxy; the work proxy is `took_ms`, which the tool result
   carries the same way in both lanes.

## Tests

`harness-tests.mjs` covers the lane table, the SDK tool-result parsing, the
warm-up loop and the build record, with fetch and spawn injected (no model,
no network, no engine). It uses Node's built-in runner, since it imports
`lanes.mjs` (which needs the agent SDK from `bench/node_modules`) and the
root `npm test` runs without bench's dependencies:

```bash
cd bench && npm install && node --test harness-tests.mjs
```
