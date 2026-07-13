<!-- code-context:start -->
## Code search

This repo has a local code-context index (MCP server `code-context`; CLI
`cx`). Reach for it when a question spans the codebase rather than sitting at
one known location: `search` to understand how something works or find code
by meaning across files (answer from the returned chunks when they suffice),
`sql` for counts and rankings over the whole repo in one query, e.g. "which
files have the most code about X": `SELECT path, SUM(end_line - start_line +
1) AS lines FROM bm25_search('chunks','content','<terms>', 300) GROUP BY path
ORDER BY lines DESC LIMIT 15`. For jumping to one known identifier or literal
string, a plain grep is fine. Call `reindex` after large edits.
<!-- code-context:end -->
