// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Auto-index on first query. A search/sql against a repo that has never been
// indexed builds the index inline and then answers on the same call, instead
// of erroring with "index it first". Staged readiness makes this cheap: the
// build resolves the moment keyword search is live (seconds), with vectors
// backfilling in the background - so the first query returns real hits, not a
// "come back later" message. CX_AUTO_INDEX=0 restores the strict error.
//
// The build goes through the repo's one-mutation-at-a-time lock, so a first
// query can't race a concurrent reindex/auto-sync: if a build is already in
// flight, this waits for it to reach keyword-live rather than starting another.

import type { RepoCtx } from "./repos.js";
import type { IndexHandle } from "../core/context.js";
import type { IndexStats } from "../core/indexer.js";

export interface EnsureDeps {
  /** Whether a missing index should be built on demand (CX_AUTO_INDEX). */
  autoIndexEnabled: boolean;
  /** Open the current index for a repo, or null when there isn't one. */
  getHandle(ctx: RepoCtx): IndexHandle | null;
  /** Acquire the repo's mutation lock and run a staged build, resolving at
   * keyword-live with the stage-1 stats; null if a build/sync is already in
   * flight on this repo (its promise lives on `ctx.mutation`). */
  build(ctx: RepoCtx): Promise<IndexStats> | null;
}

export type EnsureResult =
  /** Index is available (freshly built when `autoIndexed` is set). */
  | { handle: IndexHandle; autoIndexed?: IndexStats }
  /** No index and none was built (auto-index disabled, or the build produced
   * nothing) - the caller should return the usual "index it first" message. */
  | { needsIndex: true };

/** Return a usable index handle for `ctx`, building one on first query when
 * auto-index is enabled. Throws only if the build itself fails (e.g. a
 * read-only index dir); a disabled or empty outcome is reported as
 * `needsIndex`, never an exception. */
export async function ensureIndexed(ctx: RepoCtx, deps: EnsureDeps): Promise<EnsureResult> {
  const existing = deps.getHandle(ctx);
  if (existing) return { handle: existing };
  if (!deps.autoIndexEnabled) return { needsIndex: true };

  const build = deps.build(ctx);
  let stats: IndexStats | undefined;
  if (build) {
    stats = await build; // our build - propagate a real failure to the caller
  } else if (ctx.mutation) {
    // Someone else is mid-build; wait for it to reach keyword-live. The lock
    // promise is guarded against rejection, so this never throws.
    await ctx.mutation;
  }

  const handle = deps.getHandle(ctx);
  if (!handle) return { needsIndex: true };
  return { handle, autoIndexed: stats };
}
