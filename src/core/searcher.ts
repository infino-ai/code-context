// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The two retrieval doors, shared by the CLI and the MCP server:
//
//   search - the finding door: one ranked pass fuses exact keyword matching
//            (BM25) with semantic similarity (vectors, RRF) once vectors are
//            ready; ranked keyword search until then. Hits carry chunk
//            content, so answers come straight from results.
//   sql    - the power door: read-only SQL over the index, including search
//            table functions composed with GROUP BY, `regexp_like` for
//            regex predicates, and {{name}} placeholders embedded
//            server-side for the vector functions.

import type { IndexHandle } from "./context.js";
import { TABLE } from "./config.js";
import type { Embedder } from "./embedder.js";
import type { Manifest } from "./manifest.js";

/** Set when the index omitted files over the cap - the index is incomplete, so
 * an absence in results is not proof of absence in the repo. */
export interface PartialIndex {
  filesSkipped: number;
  fileCap: number;
  note: string;
}

/** Build the partial-index marker from a manifest, or undefined when the whole
 * tree was indexed. Shared by search (below) and the SQL path (server-side),
 * so every query surfaces the same "results may be incomplete" signal. */
export function partialIndex(manifest: Manifest): PartialIndex | undefined {
  if (!manifest.truncatedFiles) return undefined;
  const cap = manifest.maxFiles ?? 0;
  return {
    filesSkipped: manifest.truncatedFiles,
    fileCap: cap,
    note:
      `${manifest.truncatedFiles} file(s) over the ${cap}-file cap were left out of the index, so ` +
      "results may be incomplete - a missing match is not proof it's absent. Raise CX_MAX_FILES " +
      "(CLI: --max-files) and re-index for full coverage.",
  };
}

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
  /** Set when content was capped - Read path:startLine-endLine for the rest. */
  truncated?: boolean;
}

/** Rank-adaptive content budget. The top hits carry full content so the
 * answer comes straight from them; lower-ranked hits are trimmed to a snippet
 * (their path:line + a `truncated` flag let the agent Read the rest only if a
 * top hit didn't already answer it). This keeps the ranked payload lean once an
 * agent leans on search, without starving the "answer without opening files"
 * behaviour that the top hits provide. All three are env-tunable for evaluation.
 *   CX_HIT_CONTENT_CAP - char cap for a full-content (top) hit
 *   CX_FULL_HITS       - how many hits get the full cap; the rest get the snippet
 *   CX_SNIPPET_CAP     - char cap for a trimmed (lower-ranked) hit */
const HIT_CONTENT_CAP = Number(process.env.CX_HIT_CONTENT_CAP ?? 4000);
const FULL_HITS = Number(process.env.CX_FULL_HITS ?? 2);
const SNIPPET_CAP = Number(process.env.CX_SNIPPET_CAP ?? 1000);

/** Trim to at most `cap` chars, preferring a line boundary so a snippet ends on
 * a whole line rather than mid-token. */
function trimToCap(s: string, cap: number): string {
  if (s.length <= cap) return s;
  const slice = s.slice(0, cap);
  const nl = slice.lastIndexOf("\n");
  return nl > cap / 2 ? slice.slice(0, nl) : slice;
}

export interface SearchResult {
  query: string;
  /** "hybrid" once vectors are ready; "keyword" while they backfill. */
  ranking: "hybrid" | "keyword";
  hits: SearchHit[];
  note?: string;
  /** Present when the index omitted files over the cap - results may be incomplete. */
  partial?: PartialIndex;
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
        `query embedder (${embedder.model}) does not match the index embedder (${indexed.model}) - ` +
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
    hits: rows.map((r, i) => {
      const full = String(r.content);
      const cap = i < FULL_HITS ? HIT_CONTENT_CAP : SNIPPET_CAP;
      const content = trimToCap(full, cap);
      return {
        path: String(r.path),
        startLine: Number(r.start_line),
        endLine: Number(r.end_line),
        lang: String(r.lang ?? ""),
        score: Number(r.score),
        content,
        ...(content.length < full.length ? { truncated: true } : {}),
      };
    }),
    ...(ranking === "keyword" && handle.manifest.vectors !== "ready"
      ? { note: "vectors not ready yet - keyword-ranked only (re-run `cx index` or wait for the vector stage to finish)" }
      : {}),
    ...(() => {
      const partial = partialIndex(handle.manifest);
      return partial ? { partial } : {};
    })(),
  };
}

// --- sql --------------------------------------------------------------------

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Substitute `{{name}}` placeholders with embedded query vectors, inlined as
 * comma-separated float literals - this is what lets the vector_search /
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
 * derived artifact - mutating it through SQL is never useful; re-index instead. */
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
  // The mismatch guard applies to every path that embeds a query, not just
  // `search` - a same-dimension model swap would otherwise return silently
  // wrong vector_search/hybrid_search results through SQL.
  if (PLACEHOLDER.test(sql)) {
    PLACEHOLDER.lastIndex = 0;
    const indexed = handle.manifest.embedder;
    if (indexed && indexed.model !== embedder.model) {
      throw new Error(
        `query embedder (${embedder.model}) does not match the index embedder (${indexed.model}) - ` +
          `set CX_EMBED_MODEL=${indexed.model} or re-run \`cx index\``,
      );
    }
  }
  const withVectors = await applyEmbeds(sql, embeds, embedder);
  return handle.db.querySql(guardSql(withVectors)) as Array<Record<string, unknown>>;
}
