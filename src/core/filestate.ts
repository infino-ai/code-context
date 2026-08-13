// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Incremental-reindex state: a flat map of every indexed file's size, mtime,
// and content hash, stored next to the manifest. A sync stat-walks the tree,
// re-hashes only files whose size/mtime moved, and diffs against this map  - 
// so an unchanged repo costs a stat walk (~100ms), and an edit costs
// re-chunking (and re-embedding) only the files it touched. A flat map is
// deliberate: tree-structured (Merkle) diffing pays off across a
// client/remote boundary; this state sits next to a local index.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface FileEntry {
  size: number;
  mtimeMs: number;
  hash: string;
  /** Rows this file contributed to the `chunks` table - `0` for a file that is
   * fingerprinted but produced none (binary bytes behind an indexable
   * extension, an empty `__init__.py`, a bare barrel `index.ts`). The state has
   * to fingerprint those anyway, or every sync rediscovers them as "added";
   * the count is what keeps the state from reading as a superset of the
   * queryable table. The enforcement hook needs exactly that distinction: it
   * may only deny grep on a path sql can answer for, so a file with no rows
   * must not count as covered. Optional, and absent means "unknown" - state
   * written before the field existed still reads, and the hook treats those
   * entries as covered. */
  chunks?: number;
}

export interface FileState {
  version: 1;
  files: Record<string, FileEntry>;
}

const FILESTATE_NAME = "filestate.json";

export function fileStatePath(indexDirPath: string): string {
  return join(indexDirPath, FILESTATE_NAME);
}

export function readFileState(indexDirPath: string): FileState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(fileStatePath(indexDirPath), "utf8")) as FileState;
    if (parsed.version !== 1 || typeof parsed.files !== "object") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeFileState(indexDirPath: string, state: FileState): void {
  writeFileSync(fileStatePath(indexDirPath), JSON.stringify(state) + "\n");
}

export function hashContent(buf: Buffer): string {
  return createHash("sha1").update(buf).digest("hex");
}

export interface RepoDiff {
  /** Paths new since the last index. */
  added: string[];
  /** Paths whose content changed. */
  changed: string[];
  /** Paths that disappeared (or stopped being indexable). */
  deleted: string[];
  /** Candidate files whose size+mtime matched the stored entry (not hashed). */
  unchanged: number;
  /** The next state to persist after the sync applies. Entries carried over
   * from the previous state keep their chunk count; `added`/`changed` entries
   * are stamped by the caller, which is the only place the new count is
   * knowable. */
  next: FileState;
}

export function emptyFileState(): FileState {
  return { version: 1, files: {} };
}

/** Diff the walked candidates against the stored state. `candidates` are the
 * already-filtered indexable files; `readFile` loads content for hashing
 * (only called when size/mtime moved or the path is new). Returns undefined
 * hash entries pruned - a candidate that can't be read is treated as absent. */
export function diffFiles(
  candidates: Array<{ path: string; size: number; mtimeMs: number }>,
  prev: FileState,
  readFile: (path: string) => Buffer | undefined,
): RepoDiff {
  const next = emptyFileState();
  const added: string[] = [];
  const changed: string[] = [];
  let unchanged = 0;

  const seen = new Set<string>();
  for (const c of candidates) {
    seen.add(c.path);
    const before = prev.files[c.path];
    if (before && before.size === c.size && before.mtimeMs === c.mtimeMs) {
      next.files[c.path] = before;
      unchanged++;
      continue;
    }
    const buf = readFile(c.path);
    if (buf === undefined) continue; // racing delete - drops out of the index
    const hash = hashContent(buf);
    if (before && before.hash === hash) {
      // Touched but identical - refresh the stat fingerprint only, and carry
      // the chunk count over: identical content chunks identically, and the
      // caller never re-chunks this file to restamp it.
      const refreshed: FileEntry = { size: c.size, mtimeMs: c.mtimeMs, hash };
      if (before.chunks !== undefined) refreshed.chunks = before.chunks;
      next.files[c.path] = refreshed;
      unchanged++;
      continue;
    }
    next.files[c.path] = { size: c.size, mtimeMs: c.mtimeMs, hash };
    (before ? changed : added).push(c.path);
  }

  const deleted = Object.keys(prev.files).filter((p) => !seen.has(p));
  return { added, changed, deleted, unchanged, next };
}
