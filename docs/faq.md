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
across the whole repo. For jumping to one known symbol or literal string, a
plain grep is already cheap and there is no need for an index.

### Does my code leave the machine?

No. There are no accounts, no API keys, and no server. The embedding model is
a small local model downloaded once from the public model hub; after that
everything runs offline and code never leaves the machine.

### How fast is it usable after indexing starts?

Keyword (BM25) search is live within seconds on a typical repo, before the
embedding model even finishes downloading. Vectors backfill in the
background and semantic and hybrid ranking unlock automatically when they
land. If the vector stage fails, keyword search stays live and the index
reports that honestly rather than failing.

### Do I have to index before I can search?

No. The first `search` or `sql` on a repo that has never been indexed builds
the index inline and answers on that same call - keyword search is live in
seconds, vectors backfill behind it. Call `reindex` first if you'd rather
kick the build off explicitly, or set `CX_AUTO_INDEX=0` to make an unindexed
query return a "index it first" error instead of building.

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
every `search` and `sql` result carries a `partial` note with how many files
were skipped and the cap in effect, so an agent treats a missing match as
"maybe not indexed" rather than "not in the repo." `cx status` shows the same,
and `cx search` prints a warning. Raise `CX_MAX_FILES` (CLI: `--max-files`)
and re-index for full coverage.

### What tools does the MCP server expose?

Three, by design: `search` (hybrid keyword + semantic retrieval, one ranked
pass, hits carry chunk content with `path:line` ranges), `sql` (read-only
`SELECT`/`WITH` over the index, with the engine's search functions usable as
table-valued relations and `regexp_like` for regex), and `reindex`
(incremental sync). Every additional near-duplicate retrieval tool worsens an
agent's tool selection, so the surface is kept deliberately small.

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

Any MCP client, over stdio. In Claude Code:
`claude mcp add code-context -- npx -y @infino-ai/code-context mcp`. Codex,
Gemini CLI, Windsurf, Cline, and others use the standard
stdio config in the README.

### What is it built on?

The [infino](https://github.com/infino-ai/infino) engine, which runs SQL,
full-text (BM25), and vector search over one copy of the data in-process. The
same engine and index format also serve logs, docs, and agent memory.
