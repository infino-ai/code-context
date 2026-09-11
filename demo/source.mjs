// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The stretch of a file a citation names, for the page to show inline when a
// reader clicks `path:line` in an answer. Reads only inside the corpus
// checkout: the path is resolved, then realpath'd, and both must sit under
// the root - so neither `..` nor a symlink planted in the checkout can reach
// past it. The agents already read this checkout; this shows the reader what
// they cited, nothing more.

import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve, sep } from "node:path";

/** Lines shown on each side of the cited line(s): enough to read a function
 * signature above and the body below, little enough that one click never
 * pastes a file. */
export const SOURCE_CONTEXT_LINES = 12;

/** Files past this are not read whole for one citation; a generated file or
 * a fixture blob is not what a reader clicked to see. */
export const SOURCE_MAX_BYTES = 2 * 1024 * 1024;

/** A window of `rel` under `root` around lines `line..end`.
 * `{ ok: true, path, line, end, from, to, total, lines }`, or
 * `{ ok: false, status, error }` with the HTTP status the refusal deserves. */
export function sourceWindow({ root, rel, line, end = line, context = SOURCE_CONTEXT_LINES }) {
  const cleaned = String(rel ?? "").replace(/^\.\//, "");
  if (!cleaned || cleaned.startsWith("/") || cleaned.includes("\0")) {
    return { ok: false, status: 400, error: "path must be relative to the corpus" };
  }
  let realRoot;
  try {
    realRoot = realpathSync(root);
  } catch {
    return { ok: false, status: 500, error: "corpus root is not readable" };
  }
  const abs = resolve(realRoot, cleaned);
  if (abs !== realRoot && !abs.startsWith(realRoot + sep)) {
    return { ok: false, status: 400, error: "path is outside the corpus" };
  }
  let real;
  try {
    real = realpathSync(abs);
  } catch {
    return { ok: false, status: 404, error: "no such file in the corpus" };
  }
  // The realpath must sit under the root too: a symlink inside the checkout
  // pointing outside it resolves outside it.
  if (!real.startsWith(realRoot + sep)) {
    return { ok: false, status: 400, error: "path resolves outside the corpus" };
  }
  const st = statSync(real);
  if (!st.isFile()) return { ok: false, status: 404, error: "not a file" };
  if (st.size > SOURCE_MAX_BYTES) return { ok: false, status: 413, error: `file is ${st.size} bytes; not shown whole` };

  const all = readFileSync(real, "utf8").split("\n");
  const total = all.length;
  const first = clamp(Math.floor(Number(line)) || 1, 1, total);
  const last = clamp(Math.floor(Number(end)) || first, first, total);
  const from = Math.max(1, first - context);
  const to = Math.min(total, last + context);
  return { ok: true, path: cleaned, line: first, end: last, from, to, total, lines: all.slice(from - 1, to) };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
