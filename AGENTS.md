# SuperGrep: notes for AI agents

Read [CONTRIBUTING.md](CONTRIBUTING.md) first for prerequisites, the build,
test commands, and the PR workflow. This file covers what isn't there: what
the project is, the repo map, and the boundaries that aren't obvious from the
code.

## Project overview

**SuperGrep is retrieval subagents for Claude Sonnet: four tools over an
index kept in two places.** `find`, `search` and `sql` run locally - a CLI
(`cx`) and MCP server over a ranked index in plain files inside the repo,
fusing keyword (BM25) and semantic (vector) search into one ranked pass and
exposing read-only SQL over it, so an agent answers questions about a
codebase without crawling files into the context window. `ask`
runs in the cloud, over the same index's platform copy, when a platform
database is configured (`--db`): a bearer key authenticates the connection,
and the platform's own model embeds that copy by default. Without `--db` -
which is what the published npm package and Claude Code plugin ship today -
there are no accounts, no API keys, no server, and the three local tools
alone answer questions. It is built on the
[infino](https://github.com/infino-ai/infino) engine, which runs SQL,
full-text, and vector search over one copy of the data. The package, the CLI
and the MCP server are still named `code-context`; SuperGrep is the product.

The user-facing surface, quick start, measured numbers and configuration
live in [README.md](README.md); the honest limits in
[docs/tradeoffs.md](docs/tradeoffs.md).

## Repo map

- `src/cli.ts`: the `cx` / `code-context` command entry (commander).
- `src/mcp/server.ts`: the MCP server. `find`, `search` and `sql` are always
  registered and each takes an optional `path` (repo root) so one server
  serves multiple local repos in a session, defaulting to the startup root.
  `ask` is registered only when the server has `--db`, reads
  the one platform database it was started with, and refuses a `path` naming
  a different repo. Freshness is not a tool: the first query builds the
  index and every query re-syncs it.
- `src/mcp/repos.ts`: the per-repo registry - resolves and validates a
  requested root, one engine connection per repo, LRU-capped.
- `src/mcp/ensure.ts`: auto-index on first query - a `search`/`sql` on a
  never-indexed repo builds the index inline, then answers on the same call
  (`CX_AUTO_INDEX=0` restores the strict "index it first" error).
- `src/core/`: the engine-facing core. `chunker` (tree-sitter chunking),
  `indexer` (build + staged readiness + incremental sync), `searcher`
  (find, hybrid search, SQL), `embedder`/`embed-worker` (local model),
  `filestate` (incremental sync state), `walker`, `manifest`, `config`,
  `context`, `output`, `usage` (the local ledger and receipts). `hosted.ts`
  (the platform client - auth, sync, metering) and `retrieval-agent.ts`
  (the `ask` loop) are the platform half; both exist only in the
  `--db` path.
- `src/commands/`: CLI command implementations (`index-cmd`, `query-cmds`).
- `test/`: vitest suites. `bench/`: the benchmark harness. `docs/`: docs.

## Build, test, gates

```sh
npm ci
npm run build     # tsc
npm test          # vitest
```

CI runs build + tests on Linux and macOS across Node 20/22. Keep it green
before opening a PR.

## Conventions

- TypeScript, ES modules. Every source file carries an SPDX header.
- The MCP surface is deliberately four tools, one per question: where does
  this exact text occur (`find`, unranked and complete - the grep
  replacement), what is most relevant (`search`, ranked top-k), how much of
  what is where (`sql`), and - when the server has `--db` - a question worth
  delegating rather than exploring yourself (`ask`, which returns the rows
  the platform's loop retrieved). Adding near-duplicate retrieval tools worsens an
  agent's tool selection; resist it. A new tool must answer a question none
  of these four does. An `explore` tool was a second platform tool until it
  was measured: several asks issued together answered the same questions
  faster and for less than its long loop. A `reindex` tool was a fourth local tool until it was
  measured: no Sonnet run called it, Haiku called it where it hurt, and
  auto-sync already does the job.
- Search results carry chunk content plus `path:line` ranges so answers cite
  code; keep that contract when touching `searcher` or the tool descriptions.
- Tool descriptions and server instructions are prompt text on every turn
  and were measured to steer tool selection sentence by sentence. Change
  them with the bench (`bench/`, the four question sets and
  `compare-builds.mjs`), not by taste.

## Boundaries

SuperGrep is a ranked **content** retrieval layer, not structural code
intelligence. It does not do call-graph tracing, dead-code detection, or type
resolution, and it should not grow to. Tools that do are complementary and
stack alongside it over MCP. On a blind judge it holds the exact lookups
(`find`) and loses aggregation, comprehension and by-meaning to a model
reading files itself - see [docs/tradeoffs.md](docs/tradeoffs.md), which
states that plainly.
