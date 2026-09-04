---
name: code-context
description: >
  How to answer codebase questions with the code-context MCP tools (find,
  search, sql): exact-text lookup that replaces grep, ranked hybrid
  keyword+semantic search, relevance-ranked SQL aggregation over the index,
  and index lifecycle. Use when you would grep for an identifier or literal,
  when a question spans many files ("how does X work", "where is Y
  handled"), when ranking or counting code by topic across a repo, or when
  the code-context tools are present but deferred and need loading before
  use.
---

# code-context: search over the repository

code-context maintains a local index of the repository (in `.infino/` at the
repo root) and exposes three MCP tools. Every lookup an agent would otherwise
do with grep or by crawling files runs against the index instead: `find` for
the exact-text case, one ranked pass for everything that spans the repo.

## If the tools are deferred

When the tool names appear in a deferred-tools listing but their schemas are
not loaded, load all three in ONE ToolSearch call before the first use, e.g.
query `+code-context find search sql` (or `select:` with the exact listed
names, comma-separated). Never load them one call at a time.

## Choosing the right tool

| Situation | Use |
| --- | --- |
| Every occurrence of an exact identifier, string, or key (where you would grep) | `find` |
| A file you already know the path of | Read |
| "How does X work", "where is Y handled", concept without exact name | `search` |
| Counts, rankings, GROUP BY across the repo ("which files have the most code about X") | `sql` |
| Working tree changed a lot mid-session | nothing - the next query re-syncs (see lifecycle) |

## find

- Pass the exact text as it appears in the code: an identifier, an error
  message, a config key. Literal, not a regex; within one line;
  case-sensitive unless `ignoreCase`.
- Complete, not ranked: every matching line comes back as `path`, `line`,
  and the line's `text` (plus the enclosing definition's `symbol` when
  known), in path order, up to `limit` (default and cap 500, so it only
  bites on a flood; pass a smaller `limit` when you want fewer). `total` is
  the repo-wide count either way, `byFile` lists matching lines per file
  over every match (the `grep -c` answer, never cut), and `truncated` says
  when the line list was cut - narrow the text.
- Not for a file you already know the path of: Read it. `find` locates
  occurrences across the repo; pulling a few lines out of one known file
  is a Read.
- The index's token match picks the candidate chunks and each line is then
  checked for the literal, so a hit is always a real occurrence and no file
  is scanned. The index stores identifiers as tokens (`parse_config` is
  `parse` and `config`), but that only widens the candidates: `find` returns
  only lines containing the exact text you gave.
- Read `path:line` (a few lines around it) when you need the surrounding
  code; most grep-shaped questions are answered by the list itself.

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
- There is no reindex tool. If the index is actually wrong (not merely
  behind an edit the next query will pick up), `cx index --full` from a
  shell rebuilds it.
- Each repo's index is keyed to its own root directory: a fresh git worktree
  is a new root and builds its own index on first query (the main checkout's
  index does not carry over).
- A hosted index (the server was started with `--db`, and `cx status` names
  an `https://` table) is shared and never built or re-synced by a query:
  `cx index --db <url> --api-key-file <path>` from a shell is the explicit
  load, and it is the user's step, not yours.

## retrieval_agent (hosted index only, when present)

When the server was started with `--retrieval-agent` a fourth tool is
registered: `retrieval_agent` hands one question to the platform and returns
`answer` and `hits` (`path`, `startLine`-`endLine`, a text snippet: the places
it found, in the shape of a `search` result). Use it for a question that
would take several `find`, `search`, or `sql` calls of your own - counts,
which files or symbols, rankings, where something is handled. Not for reading
or explaining a file you already know: Read it. Like the other tools, its
result carries a one-line `usage` receipt.

## Reading results honestly

- A result carrying a `partial` marker means the repo exceeded the index's
  file cap and some files were left out: treat a missing match as
  possibly-unindexed, not as proof the code doesn't exist.
- Find, search, and sql results carry a one-line `usage` receipt (tokens
  returned, matches or chunks / files, session running total), computed
  locally. It is there for the user who asks what a lookup cost; `cx usage`
  keeps the ledger.

## Multi-repo sessions

Every tool takes an optional `path` (an **absolute** repo root) to target a
different repository than the one the server started in.

## Cost awareness

- `find`/`search`/`sql` calls are cheap: milliseconds against a local index,
  one HTTPS round trip (tens of milliseconds) against a hosted one.
- The first index of a repo and the vector backfill are the expensive part
  (CPU for the local embedding model, proportional to repo size). Avoid
  forcing `cx index --full` rebuilds unless the index is actually wrong, and
  avoid triggering first-time indexing of large repos that the task does
  not need.
