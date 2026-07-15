// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Per-repo registry for the MCP server. One server instance serves every repo
// a session touches: the optional `root` tool argument targets one, defaulting
// to the startup root. Each repo keeps its own engine connection, auto-sync
// clock, and mutation lock, held in a small LRU so a session that roams across
// many repos doesn't accumulate connections without bound.
//
// The connection and filesystem-stat calls are injected so this unit tests
// without a real engine or on-disk repo.

import { statSync } from "node:fs";
import { join } from "node:path";
import type { Connection } from "@infino-ai/infino";
import { indexDir, resolveRoot, INDEX_DIR_NAME } from "../core/config.js";

/** Live state for one repository the server has been asked about. */
export interface RepoCtx {
  /** Absolute, resolved repo root. */
  root: string;
  /** Index directory for this repo. */
  dir: string;
  db: Connection;
  /** performance.now() of the last auto-sync staleness check. */
  lastSyncCheck: number;
  /** In-flight index mutation, or null; enforces one mutation at a time. */
  mutation: Promise<unknown> | null;
}

/** Just the piece of `fs.Stats` the registry needs, so tests can fake it. */
interface StatLike {
  isDirectory(): boolean;
}

export interface RepoRegistryOptions {
  /** Open (or create) an engine connection for an index directory. */
  connect: (dir: string) => Connection;
  /** Filesystem stat, injectable for tests. Throws when the path is absent. */
  stat?: (path: string) => StatLike;
  /** Max repos kept open at once; the least-recently-used is evicted past it. */
  maxOpen?: number;
}

const DEFAULT_MAX_OPEN = 8;

export class RepoRegistry {
  private readonly repos = new Map<string, RepoCtx>();
  private readonly defaultRoot: string;
  private readonly connect: (dir: string) => Connection;
  private readonly stat: (path: string) => StatLike;
  private readonly maxOpen: number;

  constructor(defaultRoot: string, opts: RepoRegistryOptions) {
    this.defaultRoot = defaultRoot;
    this.connect = opts.connect;
    this.stat = opts.stat ?? statSync;
    this.maxOpen = opts.maxOpen ?? DEFAULT_MAX_OPEN;
  }

  /** Index directory for a root. CX_INDEX_DIR is a single-repo override that
   * only redirects the startup root, so a multi-repo session never collapses
   * every repo onto one index dir. */
  dirFor(root: string): string {
    return root === this.defaultRoot ? indexDir(root) : join(root, INDEX_DIR_NAME);
  }

  /** Roots currently held open, most-recently-used last. Test/introspection. */
  openRoots(): string[] {
    return [...this.repos.keys()];
  }

  /** Resolve + validate a requested root into its (cached) context. Throws a
   * clear error for a missing or non-directory path. Most-recently-used repos
   * stay live; the least-recently-used is evicted past `maxOpen`. */
  get(requested?: string): RepoCtx {
    const root = requested ? resolveRoot(requested) : this.defaultRoot;
    const existing = this.repos.get(root);
    if (existing) {
      // Reinsert to mark most-recently-used (Map preserves insertion order).
      this.repos.delete(root);
      this.repos.set(root, existing);
      return existing;
    }
    let stat: StatLike;
    try {
      stat = this.stat(root);
    } catch {
      throw new Error(`path does not exist: ${root}`);
    }
    if (!stat.isDirectory()) throw new Error(`not a directory: ${root}`);
    const dir = this.dirFor(root);
    const ctx: RepoCtx = { root, dir, db: this.connect(dir), lastSyncCheck: 0, mutation: null };
    this.repos.set(root, ctx);
    if (this.repos.size > this.maxOpen) {
      const lru = this.repos.keys().next().value!;
      this.repos.delete(lru);
    }
    return ctx;
  }
}
