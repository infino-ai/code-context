# Tradeoffs and honest limits

code-context is a ranked retrieval layer, not a do-everything code tool. The
honest boundaries:

### It does not do structural code intelligence

No call-graph tracing, dead-code detection, type resolution, or
symbol-precise references. It ranks and retrieves content and aggregates by
relevance. Tools that resolve structure (LSP servers, graph indexes) are
complementary: MCP servers stack, so run both when you need both.

### It does not beat grep on pinpoint lookups

Naming the one file a known symbol lives in is a single grep's job. There the
index does not save tokens: a grep returns one matching line, while ranked
search returns chunks that carry their content. That content is what pays off
on "how does X work" and whole-repo questions, and it is dead weight when all
you need is a path. Adding code-context does not reduce accuracy on
localization; it just does not win on cost there. Both are measured in the
[benchmark](benchmark.md).

### The first index of a repo pays a one-time vector cost

Keyword search is live in seconds, but the vector stage embeds every chunk
once with a local model, which takes on the order of a minute or two per few
thousand chunks on a laptop. It runs in the background and only happens once;
incremental syncs afterward re-embed only changed files.

### Semantic ranking waits for vectors

Until the vector stage finishes, search is keyword-ranked (BM25) and says so.
That is a graceful degrade, not a failure, but meaning-only queries with no
shared vocabulary are weaker until vectors land.

### Retrieval quality depends on the local embedding model

The default embedding model optimizes quality-per-minute on commodity
hardware; a larger model would rank better but index much slower. The choice
is documented in [the embedder eval](embedder-eval.md), and the model is
configurable.

### It is built for largely append-and-edit source trees

The index is a derived artifact you rebuild from the working tree, not a
system of record. It is read-only through queries; you never mutate it
through SQL. Rebuild it with `cx index`.

### Very large or hostile repos

Indexing scales roughly linearly with the tree. Pathological files (parser
stress fixtures, generated blobs) fall back to fixed-window chunking under a
per-parse deadline so a single file cannot stall a run. Practical caps
(`CX_MAX_FILES`, `CX_MAX_FILE_BYTES`) bound the work; see the
[benchmark](benchmark.md) for indexing-at-scale timings.

When a tree exceeds the file cap the index is partial, and it says so rather
than pretending to be complete: `search` and `sql` results carry a `partial`
marker (files skipped and the cap in effect), and `cx status` reports it. That
turns "no match" into "no match in the indexed subset" - raise `CX_MAX_FILES`
and re-index for full coverage.
