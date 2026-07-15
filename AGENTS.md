# code-context: notes for AI agents

Read [CONTRIBUTING.md](CONTRIBUTING.md) first for prerequisites, the build,
test commands, and the PR workflow. This file covers what isn't there: what
the project is, the repo map, and the boundaries that aren't obvious from the
code.

## Project overview

**code-context is local code search for AI coding agents: a CLI (`cx`) and an
MCP server over a ranked index that lives in plain files inside the repo.** It
fuses keyword (BM25) and semantic (vector) search into one ranked pass and
exposes read-only SQL over the index, so an agent answers questions about a
codebase without crawling files into the context window. The index is built
and queried in-process with a local embedding model: no accounts, no API
keys, no server. It is built on the [infino](https://github.com/infino-ai/infino)
engine, which runs SQL, full-text, and vector search over one copy of the
data.

The user-facing surface, quick start, and configuration live in
[README.md](README.md); the measured results in [docs/benchmark.md](docs/benchmark.md);
the honest limits in [docs/tradeoffs.md](docs/tradeoffs.md).

## Repo map

- `src/cli.ts`: the `cx` / `code-context` command entry (commander).
- `src/mcp/server.ts`: the MCP server, three tools (`search`, `sql`,
  `reindex`). Each takes an optional `path` (repo root) so one server serves
  multiple repos in a session, defaulting to the startup root.
- `src/mcp/repos.ts`: the per-repo registry - resolves and validates a
  requested root, one engine connection per repo, LRU-capped.
- `src/mcp/ensure.ts`: auto-index on first query - a `search`/`sql` on a
  never-indexed repo builds the index inline, then answers on the same call
  (`CX_AUTO_INDEX=0` restores the strict "index it first" error).
- `src/core/`: the engine-facing core. `chunker` (tree-sitter chunking),
  `indexer` (build + staged readiness + incremental sync), `searcher`
  (hybrid search + SQL), `embedder` (local model), `filestate` (incremental
  sync state), `walker`, `manifest`, `config`, `context`, `output`.
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
- The MCP surface is deliberately three tools: one way to find (`search`),
  one way to count (`sql`), one way to stay fresh (`reindex`). Adding
  near-duplicate retrieval tools worsens an agent's tool selection; resist it.
- Search results carry chunk content plus `path:line` ranges so answers cite
  code; keep that contract when touching `searcher` or the tool descriptions.

## Boundaries

code-context is a ranked **content** retrieval layer, not structural code
intelligence. It does not do call-graph tracing, dead-code detection, or type
resolution, and it should not grow to. Tools that do are complementary and
stack alongside it over MCP. See [docs/tradeoffs.md](docs/tradeoffs.md).
