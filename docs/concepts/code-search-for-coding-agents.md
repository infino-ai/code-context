# Code search for coding agents

A coding agent answers a question about a codebase in one of two ways. It can
crawl (glob, grep, then read whole files into the context window until it has
enough to answer), or it can retrieve (ask a ranked index for the most
relevant code and read only that). SuperGrep is the retrieval path, and it
offers it two ways: `find`, `search` and `sql` for the agent to retrieve
itself against a local index, and `explore`/`ask` to hand the retrieval to a
subagent entirely, over the same index's platform copy, so the exploration
never enters the caller's own context at all.

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
  answer in one engine pass, where file tools would have to read the whole
  repo to tally it. That is a cost win, not a quality one: on a blind judge
  this is the category the retrieval path loses hardest, because a total over
  a ranked search is a fact about that query rather than about the
  repository, and the judge marks the gap - see
  [tradeoffs](../tradeoffs.md#the-quality-gap-is-real-and-it-is-not-close).
- **Finding by meaning**: the semantic half matches renamed symbols and
  paraphrases, so "where is auth handled" works without knowing the exact
  identifier.

## Pinpoint lookups

Jumping to one known symbol or literal string is a single grep's job, and
ranked search does not save tokens there: it returns content the agent did
not need for a path. SuperGrep answers that question with `find` instead:
every line containing the exact text, cited `path:line`, from the index's
token match plus a per-line check, so it returns grep's one-line-per-match
shape without scanning a file. The ranked tools are reached for when a
question spans files.

## Hybrid, not just semantic

Keyword (BM25) matching and vector similarity fuse into one ranked pass, so a
query works whether or not you know the exact words: exact identifiers and
error strings rank through the keyword half, paraphrases and renamed symbols
through the semantic half. There is no separate lexical tool to choose
between; one search covers both.

## Local, in files, always fresh

The local index lives in plain files inside the repo (`.infino/`), built and
queried in-process with a local embedding model - no accounts, no keys, no
server. Keyword search is live seconds after indexing starts; vectors
backfill in the background; and edits re-sync incrementally, so the index
tracks the working tree without anyone asking. With `--db` the same chunks
also load into a platform database, kept in sync the same way, where
`explore` and `ask` run; that half needs a bearer key and is billed by the
platform.

See the [README](../../README.md#the-numbers) for measured cost and quality
on real agent runs, and [tradeoffs](../tradeoffs.md) for the honest limits.
