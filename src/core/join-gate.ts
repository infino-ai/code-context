// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The gate a statement across hosted tables passes before it runs: the
// platform's `join_keys` says which columns the tables join on, found on
// their values, and a statement that spans two or more tables without one
// of those keys in it is refused with the keys, so the model rewrites it on
// a key that holds instead of one that reads well.
//
// Measured before this existed (2026-09-24, host 79, Opus): asked a question
// that needed the issues joined to the logs, the model matched the two
// `instance_id` columns by name and wrote a correlated subquery, and never
// called join_keys though the tool was there and the sql text said to call
// it first. The owner: "either the model calls it or we force a rewrite
// internally". This is the second. The keys reach the model only here, in
// the refusal of a statement it already wrote without them; no key is in any
// tool text.

/** One join as `join_keys` returns it; only the two tables and the ready
 * predicate are read here. */
export interface PlatformJoin {
  from_table: string;
  to_table: string;
  predicate: string;
}

/** What the gate decided: the statement runs as written, or is refused with
 * the keys the platform found and the tables the statement spans. */
export type JoinGateVerdict = { kind: "run"; tables: string[]; keysAsked: boolean } | { kind: "refuse"; tables: string[]; keys: PlatformJoin[] };

/** Words that follow a table name in a statement and are not its alias. */
const NOT_AN_ALIAS = new Set([
  "on", "where", "join", "inner", "left", "right", "full", "cross", "outer", "natural", "using", "group", "order", "limit",
  "offset", "having", "union", "except", "intersect", "and", "or", "not", "as", "set", "window", "qualify", "fetch",
  "for", "with", "select", "from", "values", "returning", "lateral", "tablesample",
]);

/** The table-valued search functions whose first argument names a table
 * and whose result is aliased as that table's rows. */
const SEARCH_FUNCTIONS = ["hybrid_search", "bm25_search", "vector_search", "token_match", "exact_match"];

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The known tables a statement names, as identifiers or as the string
 * argument of a search function, each once in the order given. */
export function tablesNamed(query: string, tables: readonly string[]): string[] {
  const named: string[] = [];
  for (const table of tables) {
    if (!table) continue;
    const re = new RegExp(`(?<![\\w.])${escapeRegex(table)}(?![\\w])`, "i");
    if (re.test(query) && !named.includes(table)) named.push(table);
  }
  return named;
}

/** Every alias a statement gives one of `tables`: `FROM issues i`,
 * `JOIN logs AS l`, `hybrid_search('chunks', ...) AS c`. Alias to table. */
export function aliasesOf(query: string, tables: readonly string[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const table of tables) {
    const plain = new RegExp(`(?<![\\w.'"])${escapeRegex(table)}(?![\\w])\\s+(?:as\\s+)?([A-Za-z_]\\w*)`, "gi");
    for (const m of query.matchAll(plain)) {
      const alias = m[1];
      if (!NOT_AN_ALIAS.has(alias.toLowerCase()) && alias.toLowerCase() !== table.toLowerCase()) aliases.set(alias.toLowerCase(), table);
    }
    const searched = new RegExp(`(?:${SEARCH_FUNCTIONS.join("|")})\\(\\s*'${escapeRegex(table)}'[^)]*\\)\\s+(?:as\\s+)?([A-Za-z_]\\w*)`, "gi");
    for (const m of query.matchAll(searched)) {
      const alias = m[1];
      if (!NOT_AN_ALIAS.has(alias.toLowerCase()) && alias.toLowerCase() !== table.toLowerCase()) aliases.set(alias.toLowerCase(), table);
    }
  }
  return aliases;
}

/** A statement or predicate reduced to what its join condition is made of:
 * lowercase, aliases replaced by their tables, quotes and blanks gone. */
export function normalizeSql(text: string, aliases: ReadonlyMap<string, string>): string {
  let out = text.toLowerCase();
  for (const [alias, table] of aliases) {
    out = out.replace(new RegExp(`(?<![\\w.])${escapeRegex(alias)}\\.`, "g"), `${table.toLowerCase()}.`);
  }
  return out.replace(/["`]/g, "").replace(/\s+/g, "");
}

/** Whether `predicate` (`a.x = b.y`, either side possibly an expression) is
 * written in the statement, either way round. */
export function predicateHolds(query: string, predicate: string, aliases: ReadonlyMap<string, string>): boolean {
  const statement = normalizeSql(query, aliases);
  const sides = predicate.split(/\s=\s/);
  if (sides.length !== 2) return statement.includes(normalizeSql(predicate, aliases));
  const [l, r] = sides.map((s) => normalizeSql(s, aliases));
  return statement.includes(`${l}=${r}`) || statement.includes(`${r}=${l}`);
}

/** The gate. `known` is every hosted table the statement may name; `keys`
 * fetches the platform's joins among the named tables and is called only
 * when two or more are named. */
export async function joinGate(
  query: string,
  known: readonly string[],
  keys: (tables: string[]) => Promise<PlatformJoin[]>,
): Promise<JoinGateVerdict> {
  const tables = tablesNamed(query, known);
  if (tables.length < 2) return { kind: "run", tables, keysAsked: false };
  const joins = (await keys(tables)).filter((j) => tables.includes(j.from_table) && tables.includes(j.to_table));
  // Two tables the platform found no key between: nothing to hold the
  // statement to; it runs as written.
  if (joins.length === 0) return { kind: "run", tables, keysAsked: true };
  const aliases = aliasesOf(query, tables);
  if (joins.some((j) => predicateHolds(query, j.predicate, aliases))) return { kind: "run", tables, keysAsked: true };
  return { kind: "refuse", tables, keys: joins };
}

/** The refusal's text: what was spanned, what joins it, what to do. */
export function joinRefusal(tool: string, verdict: { tables: string[]; keys: PlatformJoin[] }): string {
  const list = verdict.keys.map((j) => `  ${j.predicate}`).join("\n");
  return (
    `${tool} refused: the statement spans ${verdict.tables.join(", ")} without a key the platform found on their values. ` +
    `join_keys says they join on:\n${list}\nRewrite the statement with one of these as its ON (or WHERE) condition and run it again; ` +
    "a subquery or a condition on other columns is not a join the data supports."
  );
}
