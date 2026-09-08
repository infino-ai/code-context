# Tradeoffs

SuperGrep is a ranked retrieval layer, not a do-everything code tool. 

### Small language models do not reason the same as large language models

A blind judge - `claude-opus-5` with the repository checked out - scores
SuperGrep's answers against Sonnet's own tools on the same thirty-six
questions. It holds the exact lookups: `find` ties or wins pinpoint (where is
this symbol) and known-file (what does this file do), with no more
unsupported claims than the baseline. It loses aggregation, comprehension and
by-meaning, in both comparisons, with more unsupported claims overall - **9
wins, 9 ties, 18 losses** against plain Sonnet; **7, 7, 21** against
Sonnet's own Explore subagents. So SuperGreps answers are slightly worse when the questions
are more general, according to an Opus judge, than Sonnet alone. This does not mean
that answers will appear worse in production, but worth flagging. A model that reads
the files writes an answer with more of the code in it, and this judge rewards that.
The full tables and categories are in the [README](../README.md#quality). 

### It does not do structural code intelligence

No call-graph tracing, dead-code detection, type resolution, or
symbol-precise references. It ranks and retrieves content and aggregates by
relevance. Tools that resolve structure (LSP servers, graph indexes) are
complementary: MCP servers stack, so run both when you need both.

### The first index of a repo pays a one-time vector cost

Keyword search is live in seconds, but the vector stage embeds every chunk
once with a local model, which takes on the order of a minute or two per few
thousand chunks on a laptop. It runs in the background and only happens once;
incremental syncs afterward re-embed only changed files.

### Semantic ranking waits for vectors to be created

Until the vector stage finishes, search is keyword-ranked (BM25) and says so.
That is a graceful degrade, not a failure, but meaning-only queries with no
shared vocabulary are weaker until vectors land.

### Retrieval quality depends on the local embedding model

The default embedding model optimizes quality-per-minute on commodity
hardware; a larger model would rank better but index much slower. The choice
is documented in [the embedder eval](embedder-eval.md), and the model is
configurable. The platform copy of the index (`--db`) is embedded by the
platform's own model by default; `--embed-provider local` ships this
machine's vectors there instead if that matters to you.

### The platform copy puts the network in the build

With `--db` every build and every sync also writes the platform table, over
HTTPS, and a database that is not yet ready is retried for a bounded time
(`--cold-start-secs`) before the client gives up. `find`, `search` and `sql`
never wait on it - they read the local index - but a sync is not done until
both sides have the diff, and a platform failure is reported and retried by
the next sync rather than papered over. What you get in exchange is the
`ask` and `explore` tools, which run on the platform and return facts
and grounded answers instead of the coding agent crawling the repo itself.


### Very large or hostile repos

Indexing scales roughly linearly with the tree. Pathological files (parser
stress fixtures, generated blobs) fall back to fixed-window chunking under a
per-parse deadline so a single file cannot stall a run. Practical caps
(`CX_MAX_FILES`, `CX_MAX_FILE_BYTES`) bound the work.

When a tree exceeds the file cap the index is partial, and it says so rather
than pretending to be complete: `cx index` warns on the build and on every
sync while the tree is over the cap, `find`, `search` and `sql` results carry a
`partial` marker (files skipped and the cap in effect), and `cx status`
reports it. That turns "no match" into "no match in the indexed subset" - raise
`CX_MAX_FILES` and re-index for full coverage. Or use hydration to index parquet 
files directly from object storage without impacting your local machine.
