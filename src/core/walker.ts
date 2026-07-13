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

/** Yield candidate files under `root`, gitignore-aware, sorted shallow-first
 * (a README or top-level src file beats a deeply nested one when a cap
 * truncates). */
export function walkRepo(root: string): WalkedFile[] {
  const files: WalkedFile[] = [];
  walk(root, "", [], files);
  files.sort((a, b) => {
    const depth = a.path.split("/").length - b.path.split("/").length;
    return depth !== 0 ? depth : a.path.localeCompare(b.path);
  });
  return files;
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

function walk(dir: string, rel: string, layers: IgnoreLayer[], acc: WalkedFile[]): void {
  const layer = loadGitignore(dir, rel);
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
      if (isIgnored(childRel, true, active)) continue;
      walk(join(dir, name), childRel, active, acc);
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
