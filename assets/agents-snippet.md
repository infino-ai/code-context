<!-- code-context:start -->
## Code search

This repo has a local code-context index (MCP server `code-context`; CLI
`cx`). For codebase questions, prefer its tools over crawling files:
`search` for finding code (exact identifiers AND meaning, one ranked pass —
answer from the returned chunks when they suffice), `sql` for counts and
rankings over the whole repo in one query — e.g. "which files have the most
code about X": `SELECT path, SUM(end_line - start_line + 1) AS lines FROM
bm25_search('chunks','content','<terms>', 300) GROUP BY path ORDER BY lines
DESC LIMIT 15`. Call `reindex` after large edits.
<!-- code-context:end -->
