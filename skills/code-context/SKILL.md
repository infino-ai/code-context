---
name: code-context
description: >
  How to answer codebase questions with the code-context MCP tools (sql,
  reindex): ranked retrieval and relevance-ranked aggregation in one
  read-only SQL statement via search table functions, plus index lifecycle.
  Use when a question spans many files ("how does X work", "where is Y
  handled"), when ranking or counting code by topic across a repo, or when
  the code-context tools are present but deferred and need loading before
  use.
---

# code-context: ranked search over the repository, through SQL

code-context maintains a local index of the repository (in `.infino/` at the
repo root) and exposes two MCP tools: `sql` and `reindex`. All retrieval goes
through `sql` — ranked search is a table-valued function inside the query, so
finding, counting, and ranking code are all one SELECT. The more a question
spans the repo, the more one ranked query beats crawling files into context.

## If the tools are deferred

When the tool names appear in a deferred-tools listing but their schemas are
not loaded, load both in ONE ToolSearch call before the first use, e.g.
query `+code-context sql reindex` (or `select:` with the exact listed names,
comma-separated). Never load them one call at a time.

## Choosing the right query

| Situation | Use |
| --- | --- |
| "How does X work", "where is Y handled", concept without exact name | `hybrid_search` in FROM |
| One known identifier or literal string | `bm25_search` in FROM |
| Counts, rankings, GROUP BY across the repo ("which files have the most code about X") | either TVF + `GROUP BY` |
| Working tree changed a lot mid-session | `reindex` (usually unnecessary - see lifecycle) |

## sql

One read-only SELECT/WITH statement over the table
`chunks(path, start_line, end_line, lang, symbol, content[, embedding])`.
Search functions are table-valued relations, so ranking happens in the FROM
clause and everything above it is ordinary SQL.

Finding code is a query:

```sql
SELECT path, start_line, end_line, symbol, content
FROM hybrid_search('chunks','content','<terms>','embedding', {{q}}, 10)
```

with the `embed` argument filling `{{q}}`, e.g. `{"q": "where is auth
handled"}`. The functions:

- `hybrid_search('chunks','content','<terms>','embedding', {{q}}, k)` - one
  ranked pass fusing BM25 keyword matching with semantic similarity; works
  whether or not you know the exact words. The default choice.
- `bm25_search('chunks','content','<terms>', k)` - keyword ranking alone, no
  embedding needed; use it for exact identifiers and while vectors are still
  backfilling.
- `vector_search('chunks','embedding', {{q}}, k)` - semantic ranking alone;
  prefer `hybrid_search`, which keeps the keyword arm too.
- `regexp_like(content, 'pattern')` works in WHERE.

One good query beats several narrow ones - put both the identifiers you know
and the intent into a single terms string. `k` bounds the ranked rows; raise
it for survey-style questions. Never scan the table with `LIKE` when a TVF
can rank.

The canonical aggregation - "which files have the most code about X":

```sql
SELECT path, SUM(end_line - start_line + 1) AS lines, COUNT(*) AS chunks
FROM bm25_search('chunks','content','<terms>', 300)
GROUP BY path ORDER BY lines DESC LIMIT 15
```

Answer from the returned chunk content when it suffices, citing the
`path:start_line-end_line` ranges; open a file only for what the chunks
don't show, and Read exactly that range (offset/limit), not the whole file.

## Index lifecycle (usually zero-touch)

- **The index builds as the server starts**, so it is typically live before
  your first query; a query that beats the build still triggers it inline
  and answers on the same call. Do not pre-emptively reindex.
- A result noting that **vectors are still backfilling** means
  `hybrid_search`/`vector_search` rank keyword-only/partial for the moment;
  `bm25_search` is unaffected. The note disappears when vectors are ready.
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
- Results carry a one-line `usage` receipt (tokens returned, rows, session
  running total), computed locally. End your reply by showing that line to
  the user verbatim.

## Multi-repo sessions

Every tool takes an optional `path` (an **absolute** repo root) to target a
different repository than the one the server started in.

## Cost awareness

- `sql` calls are cheap (local, milliseconds).
- The first index of a repo and the vector backfill are the expensive part
  (CPU for the local embedding model, proportional to repo size). Avoid
  forcing `full: true` rebuilds unless the index is actually wrong, and
  avoid triggering first-time indexing of large repos that the task does
  not need.
