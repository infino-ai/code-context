---
name: code-context
description: >
  How to answer codebase questions with the code-context MCP tools (search,
  sql, reindex): ranked hybrid keyword+semantic search, relevance-ranked SQL
  aggregation over the index, and index lifecycle. Use when a question spans
  many files ("how does X work", "where is Y handled"), when ranking or
  counting code by topic across a repo, or when the code-context tools are
  present but deferred and need loading before use. Not needed for jumping
  to one known identifier - plain grep is fine there.
---

# code-context: ranked search over the repository

code-context maintains a local index of the repository (in `.infino/` at the
repo root) and exposes three MCP tools. The more a question spans the repo,
the more one ranked pass beats crawling files into context.

## If the tools are deferred

When the tool names appear in a deferred-tools listing but their schemas are
not loaded, load all three in ONE ToolSearch call before the first use, e.g.
query `+code-context search sql reindex` (or `select:` with the exact
listed names, comma-separated). Never load them one call at a time.

## Choosing the right tool

| Situation | Use |
| --- | --- |
| One known identifier, literal string, or file | plain grep / file tools |
| "How does X work", "where is Y handled", concept without exact name | `search` |
| Counts, rankings, GROUP BY across the repo ("which files have the most code about X") | `sql` |
| Working tree changed a lot mid-session | `reindex` (usually unnecessary - see lifecycle) |

## search

- Pass terms, a phrase, or a plain-language description; one pass fuses BM25
  keyword matching with semantic similarity, so it works whether or not you
  know the exact words.
- One good search beats several narrow ones - put both the identifiers you
  know and the intent into a single query.
- Every hit carries `path`, `startLine`-`endLine`, and the chunk content with
  a relevance score. Answer from the chunk content when it suffices, citing
  the `path:line` ranges; open a file only for what the chunks don't show.
- If a hit is marked `truncated`, Read exactly its start-end range
  (offset/limit), not the whole file.
- `k` (default 10, max 50) bounds hits; raise it for survey-style questions.
- Until the index's vector stage finishes, results say they are
  keyword-ranked; they are still real, cited hits.

## sql

One read-only SELECT/WITH statement over the table
`chunks(path, start_line, end_line, lang, symbol, content[, embedding])`.
Search functions are callable as table-valued relations, so one query can
rank AND aggregate:

- `bm25_search('chunks','content','<terms>', k)` - keyword ranking, no
  embedding needed.
- `hybrid_search('chunks','content','<terms>','embedding', {{q}}, k)` and
  `vector_search('chunks','embedding', {{q}}, k)` - take a `{{name}}`
  placeholder filled via the `embed` argument, e.g. `{"q": "query text"}`.
- `regexp_like(content, 'pattern')` works in WHERE.

The canonical move - "which files have the most code about X":

```sql
SELECT path, SUM(end_line - start_line + 1) AS lines, COUNT(*) AS chunks
FROM bm25_search('chunks','content','<terms>', 300)
GROUP BY path ORDER BY lines DESC LIMIT 15
```

## Index lifecycle (usually zero-touch)

- **First query in a never-indexed repo auto-builds the index** and answers
  on the same call: it returns as soon as keyword search is live (seconds),
  while vectors backfill in the background. Do not pre-emptively reindex.
- **Later queries auto-sync**: the server re-chunks only files that changed
  since the last index. An unchanged tree is a fast no-op.
- Call `reindex` explicitly only after sweeping working-tree changes you
  want reflected immediately, or `full: true` to force a rebuild.
- Each repo's index is keyed to its own root directory: a fresh git worktree
  is a new root and builds its own index on first query (the main checkout's
  index does not carry over).

## Reading results honestly

- A result carrying a `partial` marker means the repo exceeded the index's
  file cap and some files were left out: treat a missing match as
  possibly-unindexed, not as proof the code doesn't exist.
- Search and sql results carry a one-line `usage` receipt (tokens returned,
  chunks/files, session running total), computed locally. End your reply by
  showing that line to the user verbatim.

## Multi-repo sessions

Every tool takes an optional `path` (an **absolute** repo root) to target a
different repository than the one the server started in.

## Cost awareness

- `search`/`sql` calls are cheap (local, milliseconds).
- The first index of a repo and the vector backfill are the expensive part
  (CPU for the local embedding model, proportional to repo size). Avoid
  forcing `full: true` rebuilds unless the index is actually wrong, and
  avoid triggering first-time indexing of large repos that the task does
  not need.
