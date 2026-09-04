# Code search for coding agents

A coding agent answers a question about a codebase in one of two ways. It can
crawl (glob, grep, then read whole files into the context window until it has
enough to answer), or it can retrieve (ask a ranked index for the most
relevant code and read only that). code-context is the retrieval path.

## Why crawling is expensive

Every file an agent reads to answer a question becomes tokens in the context
window, and those tokens are re-sent on every subsequent turn of the
conversation. A question like "how does scoring work here" or "which files
hold the most code about vector indexing" can pull tens of thousands of
tokens of source into context before the agent can answer. The cost grows
with how much the agent decides to read, not with the size of the answer.

## What retrieval changes

An index answers from ranked results instead of raw files. The rule of thumb:
the more a question spans the repo, the more retrieval saves, because the
answer is assembled from a handful of ranked chunks rather than from whole
files read one at a time.

- **Understanding** ("how does X work"): hybrid search returns the most
  relevant chunks with their content and `path:line` ranges, so the agent
  answers and cites from the results and opens a file only for what the
  chunks do not show.
- **Aggregation** ("which files have the most code about X", "tally the
  codebase by language"): search composed with SQL `GROUP BY` computes the
  answer in one engine pass. File tools have no equivalent at any budget,
  because they would have to read the whole repo to tally it.
- **Finding by meaning**: the semantic half matches renamed symbols and
  paraphrases, so "where is auth handled" works without knowing the exact
  identifier.

## Why grep is blocked anyway

On tokens alone, jumping to one known symbol is a single grep's job: one
line out. But an agent working from grep fragments reasons about code it
never read, and fragment-born claims are confidently wrong in ways a ranked
chunk - which carries its content - is not. code-context therefore ships a
PreToolUse guard that denies grep-family commands; `bm25_search` covers the
pinpoint case, and Read fills in whatever the chunk does not show.

Blocking grep by itself does not hold, which is not obvious until you watch
an agent work with it denied: it reaches for `awk`, then `sed`, then `cut`,
then a one-line `python3 -c`, and answers from the handful of lines whichever
one printed. The failure is reasoning from an extracted fragment, not the
name of the program that extracted it, so the guard denies the whole family
of utilities whose job is to emit file contents — readers and pagers, the
text filters, and interpreters run as one-liners.

Nothing in that blocks doing work. Builds, tests, benchmarks, git, file
moves, and scripts run from a file are untouched; only "show me the bytes"
is redirected to Read and to the index. Neither is a downgrade: Read takes
an offset and the index answers over a corpus of any size, so file size is
never a reason to reach for a filter, and both return the surrounding
context that a matched line leaves out.

## Hybrid, not just semantic

Keyword (BM25) matching and vector similarity fuse into one ranked pass, so a
query works whether or not you know the exact words: exact identifiers and
error strings rank through the keyword half, paraphrases and renamed symbols
through the semantic half. There is no separate lexical tool to choose
between; one search covers both.

## Local, in files, always fresh

The index lives in plain files inside the repo (`.infino/`), built and queried
in-process with a local embedding model. Keyword search is live seconds after
indexing starts; vectors backfill in the background; and edits re-sync
incrementally, so the index tracks the working tree without anyone asking. No
accounts, no keys, no server.

See the [benchmark](../benchmark.md) for measured token and tool-call
differences on real agent runs, and [tradeoffs](../tradeoffs.md) for the
honest limits.
