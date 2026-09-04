# FAQ

### What is code-context?

Local code search for AI coding agents: a CLI (`cx`) and an MCP server over a
ranked index that lives in plain files inside your repo. It fuses keyword
(BM25) and semantic search in one pass and exposes read-only SQL over the
index, so an agent answers questions about the codebase without reading it
file by file.

### When should an agent use it instead of grep?

The rule of thumb: the more a question spans the repo, the more the index
saves. Use it for understanding how a subsystem works, finding code by
meaning when you do not know the identifier, and ranking or aggregating
across the whole repo. For the grep case itself - every occurrence of a known
symbol or literal string - `find` answers from the same index: every matching
line, cited `path:line`, complete and unranked, with no file scanned.

### Does my code leave the machine?

Not unless you ask it to. By default there are no accounts, no API keys, and
no server: the embedding model is a small local model downloaded once from
the public model hub, and after that everything runs offline. The one opt-in
is a hosted index (next question), where the chunks are loaded into a
database you own on infino-platform and queries go there over HTTPS.

### Can the index live on infino-platform instead of my machine?

Yes. `cx index --db https://host/<database> --api-key-file <path>` walks and
chunks the repo here and loads the chunks table into that database; by
default the platform embeds it, so no model runs on your machine and there is
no vector backfill. `cx mcp --db ...` (or any of `find`, `search`, `sql`,
`status` with `--db`) then serves the same three tools over that table, with
the same results. Every hosted setting is a command-line flag (`--db`,
`--api-key-file`, `--embed-provider`, `--analyzer`, the two timeouts); the key
comes from a file or from `INFINO_API_KEY`, never from the command line, and
`.infino/` in the repo stays as a small sidecar for the manifest and the
usage ledger. Because a hosted table is shared, nothing builds or re-syncs
it as a side effect of a query: `cx index --db` is the explicit load, re-run
to sync. With `cx mcp --db ... --retrieval-agent` a fourth tool joins,
`retrieval_agent`, which hands one question to the platform and returns the
answer with cited `path:line` places. The README's hosted section has the
flag table.

### How fast is it usable after indexing starts?

Keyword (BM25) search is live within seconds on a typical repo, before the
embedding model even finishes downloading. Vectors backfill in the
background and semantic and hybrid ranking unlock automatically when they
land. If the vector stage fails, keyword search stays live and the index
reports that honestly rather than failing.

### Do I have to index before I can search?

No. The first `find`, `search`, or `sql` on a repo that has never been indexed
builds the index inline and answers on that same call - keyword search is live in
seconds, vectors backfill behind it. Run `cx index` first if you'd rather
kick the build off explicitly, or set `CX_AUTO_INDEX=0` to make an unindexed
query return a "index it first" error instead of building. (A hosted index
is the exception: it is shared, so a query never builds or re-syncs it, and
`cx index --db` is the explicit load.)

### Can one server handle more than one repo?

Yes. Each tool takes an optional `path` (an absolute repo root); omit it to
use the server's startup root, or pass it to target a specific repo when a
session spans several. One server instance serves them all, each with its own
index in its own `.infino/`.

### Where does the index live, and can I share it?

In `.infino/` in your repo root, as plain files (added to your `.gitignore`
automatically the first time you index). You can copy it, cache it in CI, or
put it on object storage. It is a live index the engine queries in place, not
a snapshot you export.

### Does it stay fresh as I edit?

Yes. Sync is incremental: a per-file state map (size/mtime prefilter, then
content hash) re-chunks and re-embeds only the files that changed, so a
one-file edit syncs in a fraction of a second and an unchanged tree is a fast
no-op. The MCP server also auto-syncs in the background as queries arrive.

### What happens on a repo too big to index fully?

Indexing caps how many files it takes (`CX_MAX_FILES`, default 20,000); files
past the cap are left out. When that happens the index is marked partial:
every `find`, `search`, and `sql` result carries a `partial` note with how many files
were skipped and the cap in effect, so an agent treats a missing match as
"maybe not indexed" rather than "not in the repo." `cx status` shows the same,
and `cx search` prints a warning. Raise `CX_MAX_FILES` (CLI: `--max-files`)
and re-index for full coverage.

### What tools does the MCP server expose?

Three, by design, one per question: `find` (every line containing an exact
string, cited `path:line` like `grep -n`; complete and unranked, the grep
replacement), `search` (hybrid keyword + semantic retrieval, one ranked pass,
hits carry chunk content with `path:line` ranges), and `sql` (read-only
`SELECT`/`WITH` over the index, with the ranked search functions usable as
table-valued relations so search composes with `GROUP BY`). Every additional
near-duplicate retrieval tool worsens an agent's tool selection, so the
surface is kept deliberately small: `find` and `search` are not duplicates,
one is complete and unranked, the other ranked and top-k. There used to be a
fourth, `reindex`; measured, no Sonnet run ever called it, Haiku called it
where it hurt, and every tool in the list is prompt text on every turn. The
first query builds the index, every query re-syncs it, and `cx index --full`
rebuilds from a shell.

### How is SQL over code useful?

The engine's search functions are SQL table functions, so one query can rank
and aggregate at once. "Which files have the most code about X" becomes a
single `SELECT ... FROM bm25_search(...) GROUP BY path ORDER BY ...`, instead
of a grep-read-tally loop that reads source into the context window.

### Which languages are supported?

Chunking cuts at definition boundaries with tree-sitter for TypeScript/JS,
Python, Rust, Go, Java, C/C++, Ruby, C#, and PHP; Markdown splits at
headings; everything else falls back to fixed-window chunking, so any file is
indexable.

### Which MCP clients work?

Any MCP client, over stdio. In Claude Code (recommended form, since `alwaysLoad`
keeps the tools in view when many MCP servers are configured):
`claude mcp add-json code-context -s user '{"command":"npx","args":["-y","@infino-ai/code-context","mcp"],"alwaysLoad":true}'`
(or install the plugin; see the README). Codex, Gemini CLI, Windsurf, Cline,
and others use the standard stdio config in the README.

### What is it built on?

The [infino](https://github.com/infino-ai/infino) engine, which runs SQL,
full-text (BM25), and vector search over one copy of the data in-process. The
same engine and index format also serve logs, docs, and agent memory.
