---
name: code-context
description: Use when answering questions about this codebase - finding code, explaining how something works, or counting/ranking anything across the repo. The code-context MCP tools (search, sql, reindex) query a local ranked index instead of crawling files into context.
version: 0.1.0
---

# code-context

This repository has a local search index. The `code-context` MCP server
exposes three tools over it. Prefer them over reading files blindly  - 
results are ranked, cite `path:start-end` line ranges, and cost a fraction
of the tokens of a grep-and-read crawl.

## Which tool, when

- **search** - finding code, always: exact identifiers, error strings, and
  function names (matched precisely by the keyword half) AND paraphrases,
  renamed symbols, "where is X handled" (the semantic half) - one ranked
  pass covers both. Hits include the chunk content: answer from it directly
  when it's enough.
- **sql** - counts, rankings, and aggregates over the whole repo in one
  query. The table is `chunks(path, start_line, end_line, lang, content)`.
- **reindex** - sync after the working tree changes significantly (the
  server also auto-syncs in the background).

## The SQL move nobody else has

Search functions compose with GROUP BY, so "which files have the most code
about X" is one query instead of a grep-read-tally loop:

```sql
SELECT path, SUM(end_line - start_line + 1) AS lines, COUNT(*) AS chunks
FROM bm25_search('chunks', 'content', 'your topic terms here', 300)
GROUP BY path ORDER BY lines DESC LIMIT 15
```

For meaning-aware ranking use `hybrid_search('chunks','content','terms','embedding', {{q}}, 300)`
with the tool's embed map: `{"q": "your topic"}`. `regexp_like(content, 'pattern')`
works in WHERE clauses for regex matching.

## Ground rules

- Answer from the chunk content search returns when it suffices; cite the
  `path:start-end` ranges. Open a file only for what the chunks don't show,
  and Read just that line range (offset/limit), never whole files.
- One good search beats several narrow ones - put both the identifiers you
  know and the intent into a single query.
- After large edits or a branch switch, call `reindex` (keyword search is
  live again in seconds; semantic ranking follows automatically).
