// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The facts the platform's verdict carries beside a ranked aggregate, folded
// into the rows the model reads.
//
// "Which files have the most code about X" runs as a search relation grouped
// by path, its lines and chunks summed per file. The rows are right and were
// read wrong, every time: the sums came out in the answer as file sizes
// ("reader.rs is ~1,089 lines" of an 11,847-line file), and files the ranking
// reached by meaning alone were named as files about the term. Measured on
// the side-by-side demo, 2026-09-17, on fresh runs against the fleet with
// the judge reproducing every recorded query row for row - and with the tool
// text's two sentences about exactly this in force in every run. A sentence
// the model ignores four times out of four is not the lever; two numbers on
// the row are. The platform's validate route reads them off the index for
// every aggregate of that shape (each file's whole length, and its lines
// holding each search term), and this folds them into the rows so the row
// reads "1,089 of 11,847 lines" and a file with zero lines of the term shows
// it. The facts are folded and then dropped from the verdict the model sees,
// which keeps the note saying what the two columns measure.

/** The facts about one group, as the platform reports them. */
export interface GroupFacts {
  value: unknown;
  file_lines?: number;
  term_lines?: Record<string, number>;
}

/** A verdict that may carry the facts. */
export interface FactsVerdict {
  group_column?: string;
  groups?: GroupFacts[];
  note?: string;
  [key: string]: unknown;
}

/** The columns a row gains, named as the platform names them. */
export const FILE_LINES_FIELD = "file_lines";
export const TERM_LINES_FIELD = "term_lines";
/** What a ranked row is numbered under: its 1-based place in the order the
 * statement asked for. Measured need (2026-09-18, the demo's after-run): the
 * model dropped the rows it judged off-topic - benches, tests, a Python file
 * - renumbered the rest and called them "the query's ranking", and the judge,
 * rerunning the query, marked the omission. With the query's own numbers on
 * the rows a row left out leaves a gap the reader can see. The platform's
 * loop numbers the rows it retrieves the same way. */
export const RANK_FIELD = "rank";

/** Whether `statement` orders its rows, so their places are its own answer. */
export function ordersRows(statement: string): boolean {
  return /\border\s+by\b/i.test(statement);
}

/** `rows` numbered under `rank` with their 1-based place when `statement`
 * orders them, there is more than one, and no row carries a rank already: a
 * single row has no order to keep, and a statement that selected a `rank`
 * column said what it meant. `rank` goes first so the row reads in order. */
export function rankRows<R extends Record<string, unknown>>(rows: readonly R[], statement: string): R[] {
  if (rows.length < 2 || !ordersRows(statement) || rows.some((row) => RANK_FIELD in row)) return [...rows];
  return rows.map((row, i) => ({ [RANK_FIELD]: i + 1, ...row }) as R);
}

/** Characters of cell text one `sql` result carries at most. A statement
 * that selects whole windows of a log table - `SELECT path, start_line,
 * content ... WHERE content LIKE '%##[error]%'` - came back as 217,262
 * characters over 214 rows on the demo's CI-logs corpus (2026-09-24), past
 * Claude Code's tool-result cap; the result went to a file, the model went
 * to the shell for the rest of the run. Past the budget a row keeps its
 * place and loses its long text, so no row is dropped. */
export const SQL_RESULT_CHAR_BUDGET = 24_000;
/** A text cell longer than this is cut and the cut marked, so one wide
 * column cannot spend the whole budget on its first rows. */
export const SQL_CELL_CHAR_CAP = 1_500;
/** A string cell at most this long is a key or a name, kept on a row past
 * the budget; a longer one is text, dropped there. */
const KEY_CELL_CHARS = 120;

/** What the budget did to a result: how many cells were cut, how many rows
 * carry their keys alone. */
export interface SqlBudget {
  cutCells: number;
  keysOnly: number;
}

function cutCell(text: string): string {
  if (text.length <= SQL_CELL_CHAR_CAP) return text;
  return `${text.slice(0, SQL_CELL_CHAR_CAP)} …[cut: ${text.length - SQL_CELL_CHAR_CAP} more characters]`;
}

/** `rows` held to the result budget: every row kept, in order. While the
 * budget lasts a row's long text cells are cut at the cell cap; past it a
 * row keeps only its short cells - keys, names, numbers, places - and its
 * text is one statement away by those. `jsonify` sizes the rows the way
 * they are written. */
export function budgetSqlRows<R extends Record<string, unknown>>(
  rows: readonly R[],
  size: (row: Record<string, unknown>) => number,
  budget = SQL_RESULT_CHAR_BUDGET,
): { rows: Record<string, unknown>[]; budget: SqlBudget } {
  const out: Record<string, unknown>[] = [];
  const tally: SqlBudget = { cutCells: 0, keysOnly: 0 };
  let chars = 0;
  for (const row of rows) {
    const capped: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (typeof value === "string" && value.length > SQL_CELL_CHAR_CAP) {
        capped[key] = cutCell(value);
        tally.cutCells += 1;
      } else capped[key] = value;
    }
    const cost = size(capped);
    if (out.length === 0 || chars + cost <= budget) {
      out.push(capped);
      chars += cost;
      continue;
    }
    const slim: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      if (typeof value !== "string" || value.length <= KEY_CELL_CHARS) slim[key] = value;
    }
    out.push(slim);
    tally.keysOnly += 1;
    chars += size(slim);
  }
  return { rows: out, budget: tally };
}

/** What a budgeted result tells the model, or null when nothing was cut. */
export function sqlBudgetHint(total: number, budget: SqlBudget): string | null {
  if (budget.cutCells === 0 && budget.keysOnly === 0) return null;
  const parts: string[] = [];
  if (budget.keysOnly > 0) parts.push(`${budget.keysOnly} of ${total} rows carry their keys and places only, their text left out`);
  if (budget.cutCells > 0) parts.push(`${budget.cutCells} long text cells were cut at ${SQL_CELL_CHAR_CAP} characters`);
  return (
    `${parts.join("; ")}: the result passed the tool's budget. Narrow with WHERE or LIMIT, select ` +
    "substr(content, 1, n) or the lines you mean by path and start_line, or count instead of reading."
  );
}

/** `rows` with the verdict's facts folded in, and the verdict without the
 * facts it no longer needs to carry. A row whose group value has facts gains
 * `file_lines` when the source's length is known and `term_lines` when any
 * term was counted; every other row, and a verdict with no facts, comes back
 * as it was. Group values are compared as text, the way JSON carries them. */
export function foldValidationFacts<R extends Record<string, unknown>>(
  rows: readonly R[],
  verdict: FactsVerdict | undefined,
): { rows: R[]; verdict: FactsVerdict | undefined } {
  const column = verdict?.group_column;
  const groups = verdict?.groups;
  if (!verdict || typeof column !== "string" || !Array.isArray(groups) || groups.length === 0) {
    return { rows: [...rows], verdict };
  }
  const byValue = new Map<string, GroupFacts>();
  for (const fact of groups) byValue.set(String(fact.value), fact);
  const folded = rows.map((row) => {
    if (!(column in row)) return row;
    const fact = byValue.get(String(row[column]));
    if (!fact) return row;
    const out: Record<string, unknown> = { ...row };
    if (typeof fact.file_lines === "number") out[FILE_LINES_FIELD] = fact.file_lines;
    if (fact.term_lines && Object.keys(fact.term_lines).length > 0) out[TERM_LINES_FIELD] = fact.term_lines;
    return out as R;
  });
  const { groups: _folded, ...rest } = verdict;
  return { rows: folded, verdict: rest };
}
