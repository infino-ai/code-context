// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The two retrieval doors, shared by the CLI and the MCP server:
//
//   search — the finding door: one ranked pass fuses exact keyword matching
//            (BM25) with semantic similarity (vectors, RRF) once vectors are
//            ready; ranked keyword search until then. Hits carry chunk
//            content, so answers come straight from results.
//   sql    — the power door: read-only SQL over the index, including search
//            table functions composed with GROUP BY, `regexp_like` for
//            regex predicates, and {{name}} placeholders embedded
//            server-side for the vector functions.

import type { IndexHandle } from "./context.js";
import { TABLE } from "./config.js";
import type { Embedder } from "./embedder.js";

/** JSON.stringify that survives the engine's bigint row values. */
export function jsonify(value: unknown, pretty = false): string {
  return JSON.stringify(
    value,
    (_k, v) => (typeof v === "bigint" ? Number(v) : v),
    pretty ? 2 : undefined,
  );
}

// --- search -----------------------------------------------------------------

export interface SearchHit {
  path: string;
  startLine: number;
  endLine: number;
  lang: string;
  score: number;
  content: string;
  /** Set when content was capped — Read path:startLine-endLine for the rest. */
  truncated?: boolean;
}

/** Per-hit content cap: enough to answer "how does X work" from the hit
 * itself (a whole ~60-line chunk fits; only pathological chunks truncate). */
const HIT_CONTENT_CAP = 4000;

export interface SearchResult {
  query: string;
  /** "hybrid" once vectors are ready; "keyword" while they backfill. */
  ranking: "hybrid" | "keyword";
  hits: SearchHit[];
  note?: string;
}

const PROJECTION = ["path", "start_line", "end_line", "lang", "content", "score"];

export async function search(
  handle: IndexHandle,
  embedder: Embedder,
  query: string,
  k = 6,
): Promise<SearchResult> {
  const table = handle.db.openTable(TABLE);
  let rows: Array<Record<string, unknown>>;
  let ranking: "hybrid" | "keyword";
  if (handle.manifest.vectors === "ready") {
    const indexed = handle.manifest.embedder;
    if (indexed && indexed.model !== embedder.model) {
      throw new Error(
        `query embedder (${embedder.model}) does not match the index embedder (${indexed.model}) — ` +
          `set CX_EMBED_MODEL=${indexed.model} or re-run \`cx index\``,
      );
    }
    const [vector] = await embedder.embed([query]);
    rows = table.hybridSearch("content", query, "embedding", vector, k, { projection: PROJECTION });
    ranking = "hybrid";
  } else {
    rows = table.bm25Search("content", query, k, { projection: PROJECTION });
    ranking = "keyword";
  }
  return {
    query,
    ranking,
    hits: rows.map((r) => {
      const full = String(r.content);
      return {
        path: String(r.path),
        startLine: Number(r.start_line),
        endLine: Number(r.end_line),
        lang: String(r.lang ?? ""),
        score: Number(r.score),
        content: full.slice(0, HIT_CONTENT_CAP),
        ...(full.length > HIT_CONTENT_CAP ? { truncated: true } : {}),
      };
    }),
    ...(ranking === "keyword" && handle.manifest.vectors !== "ready"
      ? { note: "vectors not ready yet — keyword-ranked only (re-run `cx index` or wait for the vector stage to finish)" }
      : {}),
  };
}

// --- sql --------------------------------------------------------------------

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Substitute `{{name}}` placeholders with embedded query vectors, inlined as
 * comma-separated float literals — this is what lets the vector_search /
 * hybrid_search table functions run from SQL (the engine itself never
 * embeds). The injected values are model floats, so there is no injection
 * surface; a referenced placeholder with no supplied text is a hard error. */
export async function applyEmbeds(
  sql: string,
  embeds: Record<string, string> | undefined,
  embedder: Embedder,
): Promise<string> {
  const referenced = new Set<string>();
  for (const m of sql.matchAll(PLACEHOLDER)) referenced.add(m[1]);
  if (referenced.size === 0) return sql;
  if (!embeds) {
    throw new Error(
      `query has placeholder(s) {{${[...referenced].join("}}, {{")}}} but no 'embed' map was provided`,
    );
  }
  const literals = new Map<string, string>();
  for (const name of referenced) {
    const text = embeds[name];
    if (typeof text !== "string" || text.length === 0) {
      throw new Error(`no 'embed' text supplied for placeholder {{${name}}}`);
    }
    const [vec] = await embedder.embed([text]);
    literals.set(name, `'${vec.join(",")}'`);
  }
  return sql.replace(PLACEHOLDER, (full, name) => literals.get(name) ?? full);
}

/** Read-only guard: one statement, must be SELECT/WITH. The index is a
 * derived artifact — mutating it through SQL is never useful; re-index instead. */
export function guardSql(sql: string): string {
  const stripped = sql.trim().replace(/;\s*$/, "");
  if (stripped.includes(";")) throw new Error("only a single statement is allowed");
  if (!/^(select|with)\b/i.test(stripped)) {
    throw new Error("only read-only SELECT / WITH queries are allowed (the index is rebuilt by `cx index`, not mutated through SQL)");
  }
  return stripped;
}

export async function runSql(
  handle: IndexHandle,
  embedder: Embedder,
  sql: string,
  embeds?: Record<string, string>,
): Promise<Array<Record<string, unknown>>> {
  const withVectors = await applyEmbeds(sql, embeds, embedder);
  return handle.db.querySql(guardSql(withVectors)) as Array<Record<string, unknown>>;
}
