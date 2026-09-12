---
name: code-context
description: >
  How to answer codebase questions with the SuperGrep MCP tools: find, search
  and sql locally (exact-text lookup that replaces grep, ranked hybrid
  keyword+semantic search, relevance-ranked SQL aggregation over the index),
  and ask over the platform copy when the server has --db (a retrieval
  subagent that returns the facts it found instead of you crawling the repo
  yourself). Use when you would grep for an identifier or literal, when a
  question spans many files ("how does X work", "where is Y handled"), when
  ranking or counting code by topic across a repo, or when the code-context
  tools are present but deferred and need loading before use.
---

# code-context: search over the repository

code-context maintains a local index of the repository (in `.infino/` at the
repo root) and exposes three MCP tools; one more runs over the same index's
platform copy when the server has `--db`. Every lookup an agent would
otherwise do with grep or by crawling files runs against the index instead,
or is delegated to a retrieval subagent entirely: `find` for the exact-text
case, one ranked pass for everything that spans the repo, `ask`
when you would rather hand the retrieval off than do it yourself.

## If the tools are deferred

When the tool names appear in a deferred-tools listing but their schemas are
not loaded, load them in ONE ToolSearch call before the first use, e.g. query
`+code-context find search sql ask` (or `select:` with the exact
listed names, comma-separated) - name only the tools that actually appear in
the deferred listing, since `ask` is registered only when the
server has `--db`. Never load them one call at a time.

## Choosing the right tool

| Situation | Use |
| --- | --- |
| Every occurrence of an exact identifier, string, or key (where you would grep) | `find` |
| A file you already know the path of | Read |
| "How does X work", "where is Y handled", concept without exact name - and `ask` is registered | `ask` (or `search` - see below) |
| "How does X work", "where is Y handled", concept without exact name - local only | `search` |
| Counts, rankings, GROUP BY across the repo ("which files have the most code about X") | `sql` |
| Several independent questions at once | one `ask` each, issued in the same turn |
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

- `hybrid_search('chunks','content','<terms>','embedding', {{q}}, k)` -
  keyword fused with meaning. **Rank with this unless you have a reason
  not to**: the words in a question are rarely the words in the code. It
  takes a `{{name}}` placeholder filled via the `embed` argument, e.g.
  `{"q": "query text"}`.
- `bm25_search('chunks','content','<terms>', k)` - keyword only. Use it
  when the topic *is* a literal string you know appears in the source and
  you want counts a reader can check as occurrences. No embedding needed.
- `vector_search('chunks','embedding', {{q}}, k)` - meaning alone.
- `token_match('chunks','content','<term>','and')` - **unranked and
  complete**: every chunk holding the token, with no top-k at all. This is
  the one to count with.
- `regexp_like(content, 'pattern')` works in WHERE.

The canonical move - "which files have the most code about X". Fill in your
own words in both places; `<terms>` is never the literal string to send:

```sql
SELECT path, SUM(end_line - start_line + 1) AS ranked_lines, COUNT(*) AS chunks
FROM hybrid_search('chunks','content','merge small superfiles','embedding', {{q}}, 300)
GROUP BY path ORDER BY ranked_lines DESC LIMIT 15
```

with `embed` `{"q": "how small superfiles are merged into larger ones"}`.
The alias says `ranked_lines` and not `matched_lines` on purpose: fusion
unions the keyword and meaning arms, so a row can rank in the top 300
without containing your terms. Report such a total as "lines ranked in the
top 300 for X", never as occurrences.

**Two relations compose in one statement, which is what makes this worth
learning.** A ranked search says which files matter; an unranked match
counts them exactly. One query, no round trips, and a count a reader can
verify by opening the line:

```sql
WITH about AS (
  SELECT DISTINCT path
  FROM hybrid_search('chunks','content','merge small superfiles','embedding', {{q}}, 300)
)
SELECT t.path, COUNT(*) AS chunks_with_term
FROM token_match('chunks','content','merge','and') t
JOIN about USING (path)
GROUP BY t.path ORDER BY chunks_with_term DESC LIMIT 15
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
- When the server was started with `--db`, the same index is also kept on an
  infino-platform database; the build and every sync write both, so nothing
  about the lifecycle changes for you.

## ask (when present)

When the server was started with `--db` one more tool is registered, running
on the platform copy of the index. `ask` hands a question or
task in plain language to the platform's
retrieval agent and returns the facts it retrieved, never a summary: `hits`
(`path`, `startLine`-`endLine`, `content` - the shape of a `search` hit),
`rows` (aggregates: a count or rank per path), and `sql` (the statement whose
rows answer the question, when there is one). Use it for how does X work,
where is Y handled, which files or symbols; spawn several in parallel for
independent questions instead of exploring the code yourself. A mechanism
that spans files is several asks issued together, one per part of it, not
one long loop: they run at once, so the wait is the slowest of them rather
than the sum. For every
occurrence of an exact string, and for how many times it occurs per file,
use `find` (`byFile` is the `grep -c` answer); for a file you already know,
Read it. Answer from the rows and cite `path:line`. Like the other tools,
its result carries a one-line `usage` receipt.

## Reading results honestly

- A result carrying a `partial` marker means the repo exceeded the index's
  file cap and some files were left out: treat a missing match as
  possibly-unindexed, not as proof the code doesn't exist.
- Every tool's result carries a one-line `usage` receipt - find/search/sql's
  computed locally (tokens returned, matches or chunks / files, session
  running total), ask's naming what the platform metered for the
  call. It is there for the user who asks what a lookup cost; `cx usage`
  keeps the local ledger.

## Multi-repo sessions

`find`, `search` and `sql` take an optional `path` (an **absolute** repo
root) to target a different repository than the one the server started in,
each with its own local index. `ask` reads the one platform
database the server was started with, which holds one repository's index;
it refuses a `path` naming a different one.

## Cost awareness

- `find`/`search`/`sql` calls are cheap: milliseconds against the local
  index. `ask` is a platform round trip plus the
  platform's own retrieval loop, and is metered there.
- The first index of a repo and the vector backfill are the expensive part
  (CPU for the local embedding model, proportional to repo size). Avoid
  forcing `cx index --full` rebuilds unless the index is actually wrong, and
  avoid triggering first-time indexing of large repos that the task does
  not need.
