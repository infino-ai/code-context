// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Gitignore-aware repository walk. Respects .gitignore files at every level
// (each applies to its own subtree), always skips VCS internals, vendored /
// generated directories, and the index directory itself.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ignoreFactory, { type Ignore } from "ignore";
import { INDEX_DIR_NAME } from "./config.js";

// Vendored/generated directories skipped wherever they appear, gitignored or
// not - indexing them helps no one and bloats every search.
const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", INDEX_DIR_NAME,
  "node_modules", "vendor", "dist", "build", "target", "out",
  "__pycache__", ".next", ".nuxt", ".venv", "venv", ".tox",
  ".gradle", ".idea", ".vscode", "coverage", ".cache", ".turbo",
]);

interface IgnoreLayer {
  /** Path of the directory the .gitignore lives in, relative to root ("" at root). */
  base: string;
  ig: Ignore;
}

export interface WalkedFile {
  /** Repo-root-relative path, "/"-separated. */
  path: string;
  size: number;
  mtimeMs: number;
}

export interface WalkOptions {
  /** Whether `.gitignore` files are honoured (default true). Off indexes
   * gitignored content too; `SKIP_DIRS` still applies either way. */
  respectGitignore?: boolean;
}

export interface WalkResult {
  files: WalkedFile[];
  /** Directories left out because a `.gitignore` matched them, root-relative
   * and outermost-only (the walk does not descend, so each entry stands for
   * its whole subtree). Empty when nothing was ignored, or when the walk was
   * asked not to honour `.gitignore`. `SKIP_DIRS` prunes are deliberately NOT
   * here: `.git` and `node_modules` are the normal state of every walk and
   * reporting them would bury the ones that matter. */
  ignoredDirs: string[];
}

/** Yield candidate files under `root`, gitignore-aware, sorted shallow-first
 * (a README or top-level src file beats a deeply nested one when a cap
 * truncates), plus the directories `.gitignore` kept out.
 *
 * The ignored list exists because `.gitignore` means "do not version-control"
 * and not "do not search": a workspace whose sibling repos are gitignored, a
 * generated docs tree, a vendored dependency somebody greps - all are worth
 * indexing, and dropping them silently turns "no match" into a wrong answer
 * the caller cannot see. The walk still honours `.gitignore` by default; it
 * just stops being quiet about it. */
export function walkRepo(root: string, options: WalkOptions = {}): WalkResult {
  const files: WalkedFile[] = [];
  const ignoredDirs: string[] = [];
  walk(root, "", [], files, options.respectGitignore !== false, ignoredDirs);
  files.sort((a, b) => {
    const depth = a.path.split("/").length - b.path.split("/").length;
    return depth !== 0 ? depth : a.path.localeCompare(b.path);
  });
  ignoredDirs.sort();
  return { files, ignoredDirs };
}

function loadGitignore(dir: string, base: string): IgnoreLayer | undefined {
  try {
    const content = readFileSync(join(dir, ".gitignore"), "utf8");
    return { base, ig: ignoreFactory().add(content) };
  } catch {
    return undefined;
  }
}

function isIgnored(relPath: string, isDir: boolean, layers: IgnoreLayer[]): boolean {
  for (const { base, ig } of layers) {
    // A layer only sees paths inside its own directory, relative to it.
    const sub = base === "" ? relPath : relPath.slice(base.length + 1);
    // The ignore package rejects "."-style paths; directories are tested with
    // a trailing slash so `dir/` patterns match.
    if (sub && ig.ignores(isDir ? sub + "/" : sub)) return true;
  }
  return false;
}

function walk(
  dir: string,
  rel: string,
  layers: IgnoreLayer[],
  acc: WalkedFile[],
  respectGitignore: boolean,
  ignoredDirs: string[],
): void {
  const layer = respectGitignore ? loadGitignore(dir, rel) : undefined;
  const active = layer ? [...layers, layer] : layers;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory - skip, don't fail the walk
  }

  for (const entry of entries) {
    const name = entry.name;
    const childRel = rel === "" ? name : `${rel}/${name}`;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(name.toLowerCase())) continue;
      if (isIgnored(childRel, true, active)) {
        ignoredDirs.push(childRel);
        continue;
      }
      walk(join(dir, name), childRel, active, acc, respectGitignore, ignoredDirs);
    } else if (entry.isFile()) {
      if (isIgnored(childRel, false, active)) continue;
      let stat;
      try {
        stat = statSync(join(dir, name));
      } catch {
        continue;
      }
      acc.push({ path: childRel, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    // symlinks are skipped: following them risks cycles and out-of-repo reads
  }
}
