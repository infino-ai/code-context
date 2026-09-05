// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Opening the index: connection + manifest in one handle.
//
// The index `find`, `search` and `sql` read is the LOCAL one: an engine catalog
// in the index dir, opened synchronously in-process. When a platform database
// is configured (--db <url>) the same repository's chunks table also lives
// there, written by every build and sync beside the local one, and read by
// the `subagent` and `explore` tools through a REST client; its readiness is
// the server's - the table exists or it does not.

import { existsSync } from "node:fs";
import { connect, type Connection } from "@infino-ai/infino";
import { indexDir, resolveRoot, TABLE, hostedTarget, hostedLabel, hostedClientOptions } from "./config.js";
import { readManifest, type Manifest } from "./manifest.js";
import { HostedDb, type HostedOptions, type HostedTarget } from "./hosted.js";
import { PLATFORM_DEFAULT_ANALYZER } from "./analyzer.js";

// The platform's default analyzer is defined with the analyzers themselves;
// it is re-exported here because callers that describe the platform table
// (the loader, the tests) reach for it alongside the other platform constants.
export { PLATFORM_DEFAULT_ANALYZER };

/** Provider recorded for a table whose vector column the platform fills. */
export const PLATFORM_EMBEDDER_PROVIDER = "platform";

/** Model recorded for a platform-filled column. The deployment's embedding
 * server picks the model and the JSON schema descriptor does not carry its
 * name, so the manifest can only say where it runs. */
export const PLATFORM_EMBEDDER_MODEL = "server-side";

/** The vector column of the chunks table, local and platform alike. */
export const EMBEDDING_COLUMN = "embedding";

export interface IndexHandle {
  root: string;
  /** The index directory - the engine's catalog root. */
  dir: string;
  /** Where the chunks table lives, for messages and logs: the index dir. */
  target: string;
  /** The in-process engine connection. */
  db: Connection;
  manifest: Manifest;
}

/** What a build writes to: the local catalog always, and the platform table
 * when a database is configured. Like IndexHandle without a manifest (there
 * may be none yet). */
export interface IndexTarget {
  root: string;
  dir: string;
  target: string;
  db: Connection;
  hosted?: HostedDb;
}

/** Per-client memo for the platform table: once it has been seen it is not
 * listed again (a table does not vanish under a session). */
export interface HostedMemo {
  ready: boolean;
}

export const newHostedMemo = (): HostedMemo => ({ ready: false });

export class NoIndexError extends Error {
  constructor(root: string) {
    super(`no index found under ${root} - run \`cx index\` there first (keyword search is ready in seconds).`);
    this.name = "NoIndexError";
  }
}

/** The local engine connection of a handle or repo context. Kept as a
 * function so the call sites read as "the local side" where a platform client
 * sits beside it. */
export function localDb(handle: { db: Connection }): Connection {
  return handle.db;
}

/** The platform client for the configured database, tuned from the platform
 * settings (--db-timeout-ms, --cold-start-secs); `opts` overrides, and is how
 * tests inject a fetch. One place constructs the client so every path shares
 * the tuning. */
export function hostedDbFor(target: HostedTarget, opts: HostedOptions = {}): HostedDb {
  return new HostedDb(target, { ...hostedClientOptions(), ...opts });
}

/** Open the index for a repo root; throws NoIndexError when there isn't one. */
export function openIndex(path?: string): IndexHandle {
  const root = resolveRoot(path);
  const dir = indexDir(root);
  const manifest = existsSync(dir) ? readManifest(dir) : undefined;
  if (!manifest) throw new NoIndexError(root);
  return { root, dir, target: dir, db: connect(dir), manifest };
}

/** Open (creating the catalog dir if needed) the targets a build writes to:
 * the local catalog, and the platform table's client when a database is
 * configured. The platform table is not checked for existence here - the
 * loader creates it. */
export function openForIndexing(path?: string, hostedOpts?: HostedOptions): IndexTarget {
  const root = resolveRoot(path);
  const dir = indexDir(root);
  const target = hostedTarget();
  return {
    root,
    dir,
    target: dir,
    db: connect(dir),
    ...(target ? { hosted: hostedDbFor(target, hostedOpts) } : {}),
  };
}

/** Whether the platform's chunks table exists, memoized once seen. The
 * `subagent` and `explore` tools ask this before a call; `label` is the
 * loggable name of the database for their message when it does not. */
export async function platformTableReady(hosted: HostedDb, memo: HostedMemo): Promise<boolean> {
  if (!memo.ready) {
    const tables = await hosted.listTables();
    if (!tables.includes(TABLE)) return false;
    memo.ready = true;
  }
  return true;
}

/** The loggable name of the configured platform database, for messages. */
export function platformLabel(hosted: HostedDb): string {
  return hostedLabel(hosted.target);
}
