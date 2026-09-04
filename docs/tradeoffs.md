# Tradeoffs and honest limits

code-context is a ranked retrieval layer, not a do-everything code tool. The
honest boundaries:

### It does not do structural code intelligence

No call-graph tracing, dead-code detection, type resolution, or
symbol-precise references. It ranks and retrieves content and aggregates by
relevance. Tools that resolve structure (LSP servers, graph indexes) are
complementary: MCP servers stack, so run both when you need both.

### Pinpoint lookups are the smaller win

Naming the one file a known symbol lives in is a single grep's job, and
`find` does that job from the index: every matching line as `path:line`, per
file counts, no file scanned. A grep hit still needs a follow-up read before
it is a cited line; a `find` hit already is one, so on exact lookups the
saving is the reads that never happen, not a change in what gets found.
Measured against the grep path on eight such questions: -35% tokens, -17%
dollars, -38% tool calls, with answer quality level under a blind judge (see
the [benchmark](benchmark.md#find-the-grep-replacement)). Ranked `search` is
the wrong tool there: it returns chunks that carry their content, which is
what pays off on "how does X work" and whole-repo questions and is dead
weight when all you need is a path. The large savings are still on questions
that span the repo, and a fourth tool has a standing cost of about a thousand
prompt tokens per turn plus the occasional wrong pick; the benchmark records
both.

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
configurable. A hosted index is embedded by the platform by default;
`--embed-provider local` keeps this machine's model and ships the vectors if
that matters to you.

### A hosted index puts the network in the loop

With `--db` every query is an HTTPS round trip to the platform, and a
database that is not yet ready is retried for a bounded time
(`--cold-start-secs`) before the client gives up. The table is shared, so the
conveniences of the local index that rewrite it behind your back - the first
query building it, every query re-syncing it - are off; loading and syncing
are the explicit `cx index --db`. What you get in exchange is no model and no
build on the machine, and one index for every machine and agent that points
at it.

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
