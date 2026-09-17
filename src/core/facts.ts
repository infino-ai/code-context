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
