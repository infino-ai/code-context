// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Fill the Snowflake arm's chunks table from a LOCAL code-context index, so
// both arms of the comparison search the identical corpus: the same chunking,
// the same rows, the same six columns. Re-chunking the repo on the Snowflake
// side would put the chunker under test instead of the retrieval.
//
// The rows go up through the SQL REST API as batched multi-row INSERTs with
// positional bindings (no staging, no driver), then the table gets search
// optimization on `content` so Snowflake's SEARCH() predicate runs against an
// index rather than a scan. Rerunning replaces the table.
//
// Usage: node load-snowflake.mjs <repoDir> [--index <indexDir>]
//   indexDir  --index, else $CX_INDEX_DIR, else <repoDir>/.infino
// Connection settings are the Snowflake lane's: the harness's CX_BENCH_SF_*
// variables (snowflakeServerEnv in lanes.mjs maps them onto the SF_* names
// the REST client reads, so one exported line serves the load and the run),
// or the SF_* names directly; the token comes from the file SF_TOKEN_FILE
// names and is never read here.
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openIndex } from "../dist/core/context.js";
import { runSql } from "../dist/core/searcher.js";
import { createEmbedder } from "../dist/core/embedder.js";
import { INDEX_DIR_NAME, TABLE } from "../dist/core/config.js";
import { snowflakeServerEnv } from "./lanes.mjs";
import { snowflakeSettings, snowflakeClient, CHUNK_COLUMNS } from "./snowflake-rest.mjs";

/** Snowflake column types, by chunk column. The DDL is generated from
 * CHUNK_COLUMNS through this map so the table's column order is the loader's
 * select order and the queries' names, by construction. */
const SNOWFLAKE_TYPES = {
  path: "VARCHAR",
  start_line: "INTEGER",
  end_line: "INTEGER",
  lang: "VARCHAR",
  symbol: "VARCHAR",
  content: "VARCHAR",
};
/** Rows per INSERT statement. Six bindings a row puts 500 rows at 3,000
 * binding variables - comfortably inside the SQL API's per-statement limit -
 * and keeps each request a modest, retryable unit of work. */
const INSERT_BATCH_ROWS = 500;
/** The SQL API caps a request body at 10 MB. Content is nearly all of a row's
 * bytes, so a batch also closes when its content reaches this budget, leaving
 * room for the statement text, the other columns and JSON escaping. */
const INSERT_BATCH_BYTES = 4 * 1024 * 1024;
/** The local index's SELECT: every chunk, in the order the files were read. */
const LOCAL_SELECT = `SELECT ${CHUNK_COLUMNS.join(", ")} FROM ${TABLE} ORDER BY path, start_line`;

/** Parse `<repoDir> [--index <indexDir>]`. */
function parseArgs(argv) {
  let repo;
  let index;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--index") index = argv[++i];
    else if (repo === undefined) repo = argv[i];
    else return null;
  }
  return repo ? { repo, index } : null;
}

/** The engine's row objects carry bigint in integer columns; Snowflake's
 * FIXED bindings want plain integers. Everything else binds as it is. */
const plain = (value) => (typeof value === "bigint" ? Number(value) : value);

/** Split rows into INSERT batches, closing a batch on either the row cap or
 * the content-byte budget. Exported, like insertStatement, so the batching
 * can be checked without a Snowflake account. */
export function batchRows(rows) {
  const batches = [];
  let current = [];
  let bytes = 0;
  for (const row of rows) {
    const size = Buffer.byteLength(String(row.content ?? ""), "utf8");
    if (current.length > 0 && (current.length >= INSERT_BATCH_ROWS || bytes + size > INSERT_BATCH_BYTES)) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(row);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** One multi-row INSERT with a '?' per value, and its bindings in order. */
export function insertStatement(table, rows) {
  const tuple = `(${CHUNK_COLUMNS.map(() => "?").join(",")})`;
  const statement = `INSERT INTO ${table} (${CHUNK_COLUMNS.join(", ")}) VALUES ${rows.map(() => tuple).join(",")}`;
  const binds = rows.flatMap((row) => CHUNK_COLUMNS.map((column) => plain(row[column])));
  return { statement, binds };
}

/** Read every chunk row from the local index at `indexDir`. The statement
 * embeds nothing, so the embedder passed along is never asked to load its
 * model; it is there because that is the SQL door's signature. */
async function localChunks(repo, indexDir) {
  process.env.CX_INDEX_DIR = indexDir;
  const handle = openIndex(repo);
  return runSql(handle, createEmbedder(), LOCAL_SELECT);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error("usage: node load-snowflake.mjs <repoDir> [--index <indexDir>]");
    process.exit(1);
  }
  const repo = resolve(args.repo);
  const indexDir = resolve(args.index ?? process.env.CX_INDEX_DIR ?? join(repo, INDEX_DIR_NAME));
  const settings = snowflakeSettings({ ...process.env, ...snowflakeServerEnv() });
  const sf = snowflakeClient(settings);
  const schema = `${settings.database}.${settings.schema}`;
  const table = `${schema}.${settings.table}`;
  const t0 = performance.now();

  const rows = await localChunks(repo, indexDir);
  console.error(`${rows.length} chunk rows read from ${indexDir}`);

  await sf.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  const columns = CHUNK_COLUMNS.map((column) => `${column} ${SNOWFLAKE_TYPES[column]}`).join(", ");
  await sf.query(`CREATE OR REPLACE TABLE ${table} (${columns})`);

  const batches = batchRows(rows);
  let loaded = 0;
  for (const [i, batch] of batches.entries()) {
    const { statement, binds } = insertStatement(table, batch);
    const { tookMs } = await sf.query(statement, binds);
    loaded += batch.length;
    console.error(`  batch ${i + 1}/${batches.length}: ${batch.length} rows in ${tookMs}ms (${loaded} so far)`);
  }

  await sf.query(`ALTER TABLE ${table} ADD SEARCH OPTIMIZATION ON FULL_TEXT(content)`);

  const check = await sf.query(`SELECT COUNT(*), COUNT(DISTINCT path) FROM ${table}`);
  const [counted, paths] = check.rows[0].map(Number);
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  console.log(`loaded ${loaded} rows into ${table}; counted back ${counted} rows, ${paths} distinct paths; ${secs}s`);
  if (counted !== loaded) {
    console.error(`row count mismatch: ${loaded} inserted, ${counted} in the table`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}
