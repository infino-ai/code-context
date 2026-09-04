// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Per-repo registry for the MCP server. One server instance serves every repo
// a session touches: the optional `root` tool argument targets one, defaulting
// to the startup root. Each repo keeps its own engine connection, auto-sync
// clock, and mutation lock, held in a small LRU so a session that roams across
// many repos doesn't accumulate connections without bound.
//
// Hosted mode changes one repo only: the DEFAULT root's chunks table lives on
// the platform database the server was started against, so that context gets
// the platform client instead of an engine connection. A `path` naming another
// repo stays local - a hosted database holds one chunks table, and a second
// repo's chunks in it would be indistinguishable from the first's.
//
// The connection and filesystem-stat calls are injected so this unit tests
// without a real engine or on-disk repo.

import { statSync } from "node:fs";
import { join } from "node:path";
import type { Connection } from "@infino-ai/infino";
import { indexDir, resolveRoot, INDEX_DIR_NAME, hostedLabel } from "../core/config.js";
import { hostedDbFor, newHostedMemo, type HostedMemo } from "../core/context.js";
import type { HostedDb, HostedOptions, HostedTarget } from "../core/hosted.js";

/** Live state for one repository the server has been asked about. */
export interface RepoCtx {
  /** Absolute, resolved repo root. */
  root: string;
  /** Index directory for this repo (the sidecar, when hosted). */
  dir: string;
  /** Where the chunks table lives: the index dir, or the hosted URL (no key). */
  target: string;
  /** The in-process engine connection; absent for the hosted default root. */
  db?: Connection;
  /** The platform client; present for the hosted default root only. */
  hosted?: HostedDb;
  /** Readiness / synthesized-manifest memo for the hosted client. */
  hostedMemo?: HostedMemo;
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
  /** The hosted target of the default root, when the server runs hosted.
   * `options` tune the client (tests inject a fetch through it). */
  hosted?: { target: HostedTarget; options?: HostedOptions };
}

const DEFAULT_MAX_OPEN = 8;

export class RepoRegistry {
  private readonly repos = new Map<string, RepoCtx>();
  private readonly defaultRoot: string;
  private readonly connect: (dir: string) => Connection;
  private readonly stat: (path: string) => StatLike;
  private readonly maxOpen: number;
  private readonly hosted?: { target: HostedTarget; options?: HostedOptions };

  constructor(defaultRoot: string, opts: RepoRegistryOptions) {
    this.defaultRoot = defaultRoot;
    this.connect = opts.connect;
    this.stat = opts.stat ?? statSync;
    this.maxOpen = opts.maxOpen ?? DEFAULT_MAX_OPEN;
    this.hosted = opts.hosted;
  }

  /** Index directory for a root. CX_INDEX_DIR is a single-repo override that
   * only redirects the startup root, so a multi-repo session never collapses
   * every repo onto one index dir. */
  dirFor(root: string): string {
    return root === this.defaultRoot ? indexDir(root) : join(root, INDEX_DIR_NAME);
  }

  /** Where a root's chunks table lives: the hosted URL for the default root
   * when the server runs hosted, else the root's own index dir. Only the
   * default root is ever hosted - the server was started against one
   * database, which holds one chunks table; a `path` naming another repo is
   * served from that repo's local index. */
  targetFor(root: string): string {
    return this.isHostedRoot(root) ? hostedLabel(this.hosted!.target) : this.dirFor(root);
  }

  private isHostedRoot(root: string): boolean {
    return this.hosted !== undefined && root === this.defaultRoot;
  }

  /** Roots currently held open, most-recently-used last. Test/introspection. */
  openRoots(): string[] {
    return [...this.repos.keys()];
  }

  /** Resolve + validate a requested root into its (cached) context. Throws a
   * clear error for a missing or non-directory path. Most-recently-used repos
   * stay live; the least-recently-used is evicted past `maxOpen`. An engine
   * connection is opened for local targets only. */
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
    const target = this.targetFor(root);
    const ctx: RepoCtx = this.isHostedRoot(root)
      ? {
          root,
          dir,
          target,
          hosted: hostedDbFor(this.hosted!.target, this.hosted!.options),
          hostedMemo: newHostedMemo(),
          lastSyncCheck: 0,
          mutation: null,
        }
      : { root, dir, target, db: this.connect(dir), lastSyncCheck: 0, mutation: null };
    this.repos.set(root, ctx);
    if (this.repos.size > this.maxOpen) {
      const lru = this.repos.keys().next().value!;
      this.repos.delete(lru);
    }
    return ctx;
  }
}
