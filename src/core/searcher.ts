// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The one retrieval door, shared by the CLI and the MCP server:
//
//   sql - read-only SQL over the index. Ranked retrieval is a table-valued
//         function inside the query (hybrid_search for the fused keyword +
//         semantic pass, bm25_search for keyword-only), so finding, counting,
//         and ranking code are all one SELECT. {{name}} placeholders are
//         embedded server-side for the vector functions.

import type { IndexHandle } from "./context.js";
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
 * tree was indexed - every query surfaces the same "results may be incomplete"
 * signal. */
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

/** Agent-facing readiness note while the vector stage has not finished:
 * hybrid_search / vector_search rank keyword-only or partial until the
 * backfill lands, while bm25_search is unaffected. The old search() surfaced
 * this on every call; the SQL surface must too, or an early query on an
 * eagerly-building index silently reads as full hybrid recall. Undefined
 * once vectors are ready. */
export function vectorsNote(manifest: Manifest): string | undefined {
  if (manifest.vectors === "ready") return undefined;
  return (
    "vectors are still backfilling - hybrid_search/vector_search rank keyword-only or partial " +
    "results right now; bm25_search is unaffected. This note disappears when vectors are ready."
  );
}

/** JSON.stringify that survives the engine's bigint row values. */
export function jsonify(value: unknown, pretty = false): string {
  return JSON.stringify(
    value,
    (_k, v) => (typeof v === "bigint" ? Number(v) : v),
    pretty ? 2 : undefined,
  );
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
  // Embedder mismatch guard: a same-dimension model swap would otherwise
  // return silently wrong hybrid_search results.
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
