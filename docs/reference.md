# Reference

The tools, flags, configuration and CLI behind
[SuperGrep](../README.md). The package, the CLI (`cx`) and the MCP
server are still named `code-context`.

## The tools

| tool | runs | what it does | when Claude uses it |
|---|---|---|---|
| `find` | local | every line containing an exact string, `path:line` like `grep -n`, with per-file counts like `grep -c`; complete and unranked, and every hit is a real occurrence | where it would grep: every use or definition of an identifier, an error message, a config key |
| `search` | local | one ranked pass fusing exact keyword matching (BM25) with semantic similarity; hits carry the code | how a subsystem works, code by meaning or exact term, similar implementations |
| `sql` | local | read-only SQL over the index, with `bm25_search` and `hybrid_search` as table functions | counts, rankings and aggregates over the whole repository in one query |
| `explore` | platform | a question about a mechanism that spans files; returns a written answer grounded in the facts it lists, with the chain of queries it ran | how does X work, where is X handled, trace this path |
| `ask` | platform | a question or task in plain language; returns the rows it retrieved - `path`, `start_line`, `end_line` and the code - never a summary | when Claude wants facts to compose from rather than an answer |

`explore` and `ask` are registered only when the server has `--db`.
`find`, `search` and `sql` take an optional `path` (an absolute repository
root) so one server can serve several repositories in a session, each with
its own local index; `explore` and `ask` read one platform database and
refuse a `path` naming a different repository.

### The SQL move

Search-as-a-table composes with aggregation - ranked by relevance, filtered
and tallied by SQL, one engine pass. Lead with `hybrid_search`, which fuses
keyword and meaning so it finds the code whether or not the question's words
are the code's:

```sql
SELECT path, SUM(end_line - start_line + 1) AS ranked_lines, COUNT(*) AS chunks
FROM hybrid_search('chunks', 'content', 'merge small superfiles', 'embedding', {{q}}, 300)
WHERE path LIKE 'src/%'
GROUP BY path ORDER BY ranked_lines DESC LIMIT 15
```
with embed `{"q": "how small superfiles are merged into larger ones"}`. The
total is the lines that ranked in the top 300 for that query, not the file's
length or a repository-wide count. `bm25_search(...)` is the same shape,
keyword-only, for when the topic is a literal string you want counted as
occurrences a reader can check; the server embeds `{{name}}` placeholders
server-side, so agents never handle raw vectors.

### One index in two places

`cx index --db` builds the local index and loads the same chunks into a
platform database; every sync after it (the explicit `cx index`, or the
server's auto-sync as queries arrive) applies the same diff to both, so they
never drift. `find`, `search` and `sql` read the local copy; `ask` and
`explore` run on the platform copy. Without `--db` the server is the local
index alone, and nothing leaves the machine: no account, no key, no
telemetry; embedding is a small local model downloaded once.

The keyword index commits first - about a second on a 3,000-chunk
repository - so search works before any embedding model exists on the
machine; vectors backfill in the background and hybrid ranking unlocks when
they land. The local index lives in `.infino/` in the repository root (added
to `.gitignore` on the first build): plain files you can copy or cache in CI.

## Platform flags

Everything about the platform is a command-line flag on the two commands
that touch it, `cx index` and `cx mcp`:

| flag | default | purpose |
|---|---|---|
| `--db <url>` | (local index only) | the platform database, `https://host/<database>` (plain `http://` only for localhost) |
| `--api-key-file <path>` | `INFINO_API_KEY` | file holding the bearer key. The key is never an argument, since a process's arguments are visible to every other process on the machine; the environment variable is the one alternative |
| `--embed-provider <platform\|local>` | `platform` | who fills the platform table's vectors: the platform's own model, or this machine's (vectors shipped with the rows) |
| `--analyzer <ascii_lower\|standard>` | the table's own; `ascii_lower` for a first load | `cx index` only: the full-text analyzer the platform table is created with. `ascii_lower` splits code identifiers on `.`, `_`, and `::`. Without the flag a rebuild keeps the analyzer the table has; naming a different one rebuilds it |
| `--db-timeout-ms <n>` | 60000 | per-request timeout |
| `--cold-start-secs <n>` | 120 | how long to keep retrying while the database is not yet ready, before giving up |
| `--subagent-max-turns`, `--subagent-max-wall-secs`, `--subagent-k` | 4, 120, 10 | `cx mcp` only: turn and wall-clock caps for one `ask` call, and how many facts a call returns |
| `--explore-max-turns`, `--explore-max-wall-secs` | the platform's budget, 300 | `cx mcp` only: the same caps for one `explore` call |

Plain `http://` is accepted for a loopback host only
(`http://127.0.0.1:<port>/<database>` or `http://localhost:<port>/<database>`);
any other host must be `https://`, since the bearer key travels in the
request and a non-loopback address is assumed to be reachable over the
network.

## Configuration

| variable | default | purpose |
|---|---|---|
| `CX_INDEX_DIR` | `<repo>/.infino` | where the local index lives |
| `CX_SEARCH_K` | 10 | default number of hits `search` returns (also settable per call and via the CLI `-k` flag) |
| `CX_FIND_LIMIT` | 500 | default number of matching lines `find` returns, which is also the hard cap; `total` and `byFile` are complete either way |
| `CX_MAX_FILES` / `CX_MAX_FILE_BYTES` | 20000 / 1MB | indexing caps (files over the cap are left out and the tools flag the index as partial) |
| `CX_ROOT` | current directory | default repository root for the MCP server / CLI when not run from the repository (each tool call can override it with a `path` argument) |
| `CX_AUTO_INDEX` | on | `0` makes a query on an unindexed repository error instead of building the index inline |
| `CX_AUTO_SYNC` | on | `0` disables the MCP server's background staleness sync |
| `CX_SYNC_INTERVAL_SECS` | 30 | auto-sync debounce between staleness checks |
| `CX_NO_EMBED` | off | keyword-only mode (with `--db`, the platform copy is keyword-only too) |
| `CX_NO_RECEIPT` | off | `1` turns off usage accounting - the per-call receipt on results and the `cx usage` ledger |

Every result carries a **usage receipt**: the tokens it returned, the files
it spanned, and a running session total. For the platform tools the receipt
names the platform's metered spend for the call ("N model tokens"), which
the platform bills; the Sonnet side is on your Anthropic bill as usual.

## CLI

```
cx index [path]           sync the index (incremental; --full rebuilds, --watch follows edits)
cx find <text>            every line containing the exact text, path:line  (-i, -c per-file counts, --limit)
cx search <query>         exact terms + meaning, one ranked pass           (-k hits)
cx sql <statement>        read-only SQL; --embed q="text" fills {{q}}
cx status                 what the index holds, how fresh, vector readiness
cx usage                  ledger of queries run and what each returned  (-n, --all, --clear, --json)
cx mcp                    serve the MCP tools over stdio
cx index --db <url>       also keep the index on an infino-platform database  (--api-key-file, --embed-provider, --analyzer)
cx mcp --db <url>         also serve ask and explore over that copy             (--api-key-file, the ask/explore caps)
```

`cx usage` reads the local ledger at `.infino/usage.jsonl`: every call, from
the CLI or the MCP server, appends one line with the query and a compact
summary of what came back. Two Claude Code hooks (`cx usage --hook` on
`UserPromptSubmit` and `PostToolUse`, matcher `mcp__code-context.*`) add a
per-session tally of how many prompts used the tools and which tool Claude
reached for first.

## Other MCP clients

The server speaks stdio MCP, so Cursor, Codex CLI, Gemini CLI, Windsurf and
Cline take the same `command` and `args` as the Claude Code registration in
their standard server config. Point the server at a repository with
`env: { "CX_ROOT": "/path/to/repo" }` when the client's working directory is
not the repository.

The npm release (`npx -y @infino-ai/code-context mcp`) and the Claude Code
plugin (`/plugin marketplace add infino-ai/code-context`, then
`/plugin install code-context@infino-ai`) ship the local index alone today;
the platform tools are on the `feat/platform-backend` branch.

## What it is, and what it isn't

SuperGrep's lane is ranked **content** retrieval and grounded
exploration over it: find code by words or meaning, rank files by how much
they are about a topic, answer a question that spans files with citations.
It does not do structural code intelligence (call-graph tracing, dead-code
detection, type resolution); tools that do are complementary, and MCP servers
stack.

## Architecture

![SuperGrep: find, search and sql locally, ask and explore in the cloud, one index in both places](subagent/architecture.svg)

- **Chunking:** tree-sitter (WASM, no native compiles) cuts at definition
  boundaries for TypeScript/JS, Python, Rust, Go, Java, C/C++, Ruby, C#, PHP;
  Markdown splits at headings; everything else falls back to fixed windows.
  Every chunk carries `path, start_line, end_line, lang, content`.
- **Index:** [infino](https://github.com/infino-ai/infino) tables - BM25 and
  IVF vector indexes over a single copy of the data - queried in-process
  through the Node binding locally, and the same table on an infino-platform
  database for `explore` and `ask`, written by the same builds and syncs.
- **Embeddings:** a small local model for the local copy (chosen by a
  [measured eval](embedder-eval.md)); the platform embeds its copy with its
  own model unless `--embed-provider local`.
- **Freshness:** incremental. A per-file state map (size/mtime prefilter,
  then content hash) means a sync re-chunks and re-embeds only the files that
  changed, in both places; the server auto-syncs as queries arrive.

## Learn more

- [Code search for coding agents](concepts/code-search-for-coding-agents.md) - the crawl-vs-retrieve model and when an index saves tokens.
- [FAQ](faq.md), [Tradeoffs](tradeoffs.md) - the honest limits.
- [`bench/`](../bench/) - the lanes, the questions, the judge, and the chart script behind the README's numbers.
