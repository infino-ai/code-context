// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// CLI output helpers: minimal ANSI styling (TTY only), aligned tables,
// durations. No output dependencies - the CLI stays lean.

const tty = process.stdout.isTTY === true;

export const bold = (s: string) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
export const dim = (s: string) => (tty ? `\x1b[2m${s}\x1b[0m` : s);
export const green = (s: string) => (tty ? `\x1b[32m${s}\x1b[0m` : s);
export const yellow = (s: string) => (tty ? `\x1b[33m${s}\x1b[0m` : s);
export const red = (s: string) => (tty ? `\x1b[31m${s}\x1b[0m` : s);
export const cyan = (s: string) => (tty ? `\x1b[36m${s}\x1b[0m` : s);

export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export function fmtCount(n: number): string {
  return n.toLocaleString("en-US");
}

export function fmtAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Render rows as an aligned text table (column order from the first row). */
export function table(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "(no rows)";
  const cols = Object.keys(rows[0]);
  const cells = rows.map((r) => cols.map((c) => renderCell(r[c])));
  const widths = cols.map((c, i) => Math.max(c.length, ...cells.map((row) => row[i].length)));
  const line = (parts: string[]) => parts.map((p, i) => p.padEnd(widths[i])).join("  ");
  return [
    bold(line(cols)),
    dim(line(widths.map((w) => "─".repeat(w)))),
    ...cells.map((row) => line(row)),
  ].join("\n");
}

function renderCell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(4);
  const s = String(v).replace(/\s+/g, " ");
  return s.length > 80 ? s.slice(0, 77) + "…" : s;
}

/** In-place progress line on stderr (TTY), plain lines otherwise. */
export function progressLine(text: string): void {
  if (process.stderr.isTTY) process.stderr.write(`\r\x1b[2K${text}`);
  else process.stderr.write(text + "\n");
}

export function progressDone(): void {
  if (process.stderr.isTTY) process.stderr.write("\r\x1b[2K");
}
