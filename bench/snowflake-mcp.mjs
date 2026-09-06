// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The Snowflake arm of the bench: a stdio MCP server that opens the same
// three doors code-context does - find, search, sql - over a repository's
// code chunks loaded into a Snowflake table, so an agent lane can run against
// Snowflake with nothing but the server swapped. The table carries the six
// chunk columns code-context writes (path, start_line, end_line, lang,
// symbol, content). The account has no Cortex, so the keyword door is
// Snowflake's SEARCH predicate and every result says so: there is no semantic
// ranking behind these tools.
//
//   find    - every line containing an exact string, path:line like grep -n:
//             the chunks are cut back into lines in SQL and de-duplicated,
//             since chunks can overlap
//   search  - keyword retrieval: SEARCH picks the candidates, the rank is how
//             many of the query's terms a chunk contains, shorter chunk first
//             on a tie
//   sql     - one read-only SELECT or WITH over the chunk table
//
// Settings are read from the environment once at startup (snowflakeSettings
// in snowflake-rest.mjs); the token comes from a file and never reaches a log
// line or a tool result. Results carry took_ms (this process's time for the
// call, the Snowflake round trips included) and a one-line usage receipt in
// the shape of code-context's.
//
// Usage: SF_TOKEN_FILE=<path holding the token> node snowflake-mcp.mjs
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { snowflakeSettings, snowflakeClient, CHUNK_COLUMNS } from "./snowflake-rest.mjs";

/** Lines find returns by default, and the most it will (the ceiling
 * code-context's find has); total and byFile are complete whatever the limit. */
export const DEFAULT_FIND_LIMIT = 200;
const MAX_FIND_LIMIT = 500;
/** Hits search returns by default, and the most it will. */
export const DEFAULT_SEARCH_K = 10;
const MAX_SEARCH_K = 50;
/** Rows a sql result carries back at most; a statement that produced more is
 * cut here and flagged truncated. */
export const MAX_SQL_ROWS = 200;
/** The receipt's token estimate: about four characters per token. */
const CHARS_PER_TOKEN = 4;
/** The separator SPLIT_TO_TABLE cuts a chunk's content on - a newline, as
 * the SQL literal Snowflake reads it. */
const LINE_SEPARATOR_SQL = "'\\n'";
/** The shape sql accepts: one statement opening with SELECT or WITH. */
const READ_ONLY_START = /^\s*(select|with)\b/i;
/** Unquoted Snowflake identifier. The table name is built from the settings,
 * so anything else there is a configuration error, not something to send. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
/** Said once in every result: what this arm cannot do. */
const KEYWORD_ONLY_NOTE =
  "keyword search only: this Snowflake account has no semantic (embedding) search, so query with the words that appear in the code";

/** Whitespace-separated query terms, empty for a blank query. */
export const splitTerms = (query) => query.trim().split(/\s+/).filter(Boolean);

/** Why sql refuses a statement, or null when it is a single read-only
 * SELECT/WITH. No semicolons at all: a second statement behind the first is
 * exactly what the check exists to keep out. */
export function readOnlyError(statement) {
  if (!READ_ONLY_START.test(statement)) return "sql runs a single read-only statement: it must begin with SELECT or WITH";
  if (statement.includes(";")) return "sql runs a single statement: remove the semicolon(s)";
  return null;
}

/** The fully qualified chunk table from the settings, each part checked as
 * an identifier. */
export function tableName({ database, schema, table }) {
  for (const part of [database, schema, table]) {
    if (!IDENTIFIER.test(part)) throw new Error(`Snowflake identifier "${part}" must be letters, digits, _ or $ and not start with a digit`);
  }
  return `${database}.${schema}.${table}`;
}

/** The DISTINCT (path, line, text) set of lines containing the bound string:
 * every chunk cut back into its lines, the line number recovered from the
 * chunk's start_line and the line's position within it. Two overlapping
 * chunks yield the same line twice; DISTINCT folds them. */
const findLinesSql = (table) =>
  `SELECT DISTINCT c.path, c.start_line + s.index - 1 AS line, s.value AS text ` +
  `FROM ${table} c, LATERAL SPLIT_TO_TABLE(c.content, ${LINE_SEPARATOR_SQL}) s ` +
  `WHERE CONTAINS(s.value, ?)`;

/** find's two statements over the same set: the lines in path order up to
 * the limit, and the per-file count over all of them. */
export function findSql(table) {
  return {
    lines: `${findLinesSql(table)} ORDER BY c.path, line LIMIT ?`,
    counts: `SELECT path, COUNT(*) AS n FROM (${findLinesSql(table)}) GROUP BY path ORDER BY path`,
  };
}

/** search's statement: SEARCH over the whole query picks the candidates (any
 * term), one CASE per term counts how many the chunk contains regardless of
 * case, and the order is that count, then the shorter chunk, then position.
 * Binds are positional: the terms for the CASEs first, then the query for
 * SEARCH, then k. */
export function searchSql(table, terms) {
  const score = terms.map(() => "CASE WHEN CONTAINS(LOWER(content), LOWER(?)) THEN 1 ELSE 0 END").join(" + ");
  return (
    `SELECT ${CHUNK_COLUMNS.join(", ")}, (${score}) AS matched_terms FROM ${table} ` +
    `WHERE SEARCH(content, ?) ORDER BY matched_terms DESC, LENGTH(content) ASC, path, start_line LIMIT ?`
  );
}

const jsonText = (value) => JSON.stringify(value, null, 2);
const estTokens = (s) => Math.ceil(s.length / CHARS_PER_TOKEN);
/** 1203 -> "1.2k", 300 -> "300". */
const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const tookMs = (t0) => Math.round((performance.now() - t0) * 1000) / 1000;
const ok = (value) => ({ content: [{ type: "text", text: jsonText(value) }] });
const fail = (message) => ({ content: [{ type: "text", text: message }], isError: true });

export async function serveSnowflakeMcp(env = process.env) {
  const settings = snowflakeSettings(env);
  const table = tableName(settings);
  const client = snowflakeClient(settings);

  // One receipt accumulator for this long-lived process, as code-context
  // keeps per session: tokens returned by this call, then the running total.
  const session = { queries: 0, returnedTokens: 0 };
  const receipt = (payload, detail) => {
    const tokens = estTokens(jsonText(payload));
    session.queries++;
    session.returnedTokens += tokens;
    return `returned ~${fmtTokens(tokens)} tokens | ${detail} | invoked ${session.queries}x this session (~${fmtTokens(session.returnedTokens)} tokens total)`;
  };

  const server = new McpServer(
    { name: "snowflake", version: "0.1.0" },
    {
      instructions:
        "snowflake holds this repository's code as chunks in a Snowflake table. Which tool for which question:\n" +
        "- find - every line containing an exact string, where you would grep.\n" +
        "- search - keyword retrieval by the words in the code.\n" +
        "- sql - counts, rankings and aggregates over the whole repository.\n" +
        "Hits carry the code: answer from them and cite path:line. " +
        "There is no semantic search on this account: query with the words that appear in the code.",
    },
  );

  server.registerTool(
    "find",
    {
      title: "Find exact text (every occurrence, like grep -n)",
      description:
        "Every line containing an exact string, path:line like grep -n, with per-file counts; complete " +
        "and unranked, over the repository's chunk table in Snowflake. Literal text within one line, " +
        "case-sensitive. Use it where you would grep: every use or definition of an identifier, an error " +
        "message, a config key. byFile counts every file (the grep -c answer) and total is the repo-wide " +
        "count, whatever the limit on returned lines. For code by keyword use search; for rankings use sql. " +
        "The result includes a 'usage' field, a one-line receipt of tokens returned, matches and files.",
      inputSchema: {
        query: z.string().min(1).describe("The exact text to find, as it appears in the code - an identifier, a string, a key."),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_FIND_LIMIT)
          .default(DEFAULT_FIND_LIMIT)
          .describe("Maximum matching lines to return; total and byFile are complete either way."),
      },
    },
    async ({ query, limit }) => {
      const t0 = performance.now();
      try {
        const sql = findSql(table);
        const [lineRows, countRows] = await Promise.all([client.query(sql.lines, [query, limit]), client.query(sql.counts, [query])]);
        const lines = lineRows.rows.map(([path, line, text]) => ({ path, line: Number(line), text }));
        const byFile = {};
        let total = 0;
        for (const [path, n] of countRows.rows) {
          byFile[path] = Number(n);
          total += Number(n);
        }
        const result = { query, total, byFile, lines, truncated: lines.length < total, note: KEYWORD_ONLY_NOTE };
        return ok({
          ...result,
          took_ms: tookMs(t0),
          usage: receipt(result, `${plural(total, "match", "matches")} / ${plural(Object.keys(byFile).length, "file", "files")}`),
        });
      } catch (err) {
        return fail(`find failed: ${err.message}`);
      }
    },
  );

  server.registerTool(
    "search",
    {
      title: "Keyword search (Snowflake SEARCH)",
      description:
        "Keyword full-text search over the chunk table (Snowflake SEARCH); ranks by how many query terms " +
        "a chunk contains, shorter chunk first on a tie; no semantic ranking on this account, so use the " +
        "words that appear in the code - identifiers, error strings, comment words. Each hit carries path, " +
        "start_line, end_line, lang, symbol and the chunk content in full: answer and cite path:line from " +
        "the hits. For every occurrence of an exact string use find; for counts and rankings use sql. " +
        "The result includes a 'usage' field, a one-line receipt of tokens returned, chunks and files.",
      inputSchema: {
        query: z.string().min(1).describe("Whitespace-separated terms as they appear in the code."),
        k: z.number().int().positive().max(MAX_SEARCH_K).default(DEFAULT_SEARCH_K).describe("Maximum hits."),
      },
    },
    async ({ query, k }) => {
      const t0 = performance.now();
      const terms = splitTerms(query);
      if (terms.length === 0) return fail("search needs at least one term");
      try {
        const { rows } = await client.query(searchSql(table, terms), [...terms, terms.join(" "), k]);
        const hits = rows.map((row) => ({
          path: row[0],
          start_line: Number(row[1]),
          end_line: Number(row[2]),
          lang: row[3],
          symbol: row[4],
          content: row[5],
        }));
        const result = { query, hits, note: KEYWORD_ONLY_NOTE };
        const files = new Set(hits.map((h) => h.path)).size;
        return ok({
          ...result,
          took_ms: tookMs(t0),
          usage: receipt(result, `${plural(hits.length, "chunk", "chunks")} / ${plural(files, "file", "files")}`),
        });
      } catch (err) {
        return fail(`search failed: ${err.message}`);
      }
    },
  );

  server.registerTool(
    "sql",
    {
      title: "SQL over the chunk table",
      description:
        `Read-only SQL, one SELECT or WITH, over ${table}(path, start_line, end_line, lang, symbol, ` +
        "content) - one row per code chunk, lang the file extension, e.g. 'rs' - for counts, rankings and " +
        "GROUP BY across the whole repository. SEARCH(content, 'terms') is the full-text predicate: a " +
        "boolean filter (a chunk matches when it contains any of the terms), no score; GROUP BY, ORDER BY " +
        "and joins compose with it. Rank files by how much of them matches: SELECT path, " +
        `SUM(end_line - start_line + 1) AS matched_lines, COUNT(*) AS chunks FROM ${table} WHERE ` +
        "SEARCH(content, '<terms>') GROUP BY path ORDER BY matched_lines DESC LIMIT 15. Such a total is the " +
        "lines of the chunks that matched, never a file's length; a file's length is MAX(end_line) with no " +
        `filter: SELECT path, MAX(end_line) AS lines FROM ${table} GROUP BY path ORDER BY lines DESC. ` +
        `Results are cut at ${MAX_SQL_ROWS} rows (truncated says so), so use LIMIT. No semantic search on ` +
        "this account. The result includes a 'usage' field, a one-line receipt of tokens returned and rows.",
      inputSchema: {
        query: z.string().min(1).describe("A single read-only SELECT or WITH statement over the chunk table."),
      },
    },
    async ({ query }) => {
      const t0 = performance.now();
      const refused = readOnlyError(query);
      if (refused) return fail(refused);
      try {
        const { columns, rows } = await client.query(query);
        const kept = rows.slice(0, MAX_SQL_ROWS);
        const result = { columns, rows: kept, row_count: kept.length, truncated: rows.length > kept.length, note: KEYWORD_ONLY_NOTE };
        return ok({ ...result, took_ms: tookMs(t0), usage: receipt(result, plural(kept.length, "row", "rows")) });
      } catch (err) {
        return fail(`sql failed: ${err.message}`);
      }
    },
  );

  await server.connect(new StdioServerTransport());
  // The table and where it lives; never the token.
  console.error(
    `snowflake MCP server ready on stdio (table ${table}, account ${settings.account}, user ${settings.user}, ` +
      `role ${settings.role}, warehouse ${settings.warehouse}; keyword search only, no Cortex)`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  serveSnowflakeMcp().catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}
