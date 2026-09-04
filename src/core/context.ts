// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Opening an existing index: connection + manifest in one handle.
//
// Two kinds of target. A LOCAL index is an engine catalog in the index dir,
// opened synchronously in-process. A HOSTED index is the chunks table of a
// platform database (CX_DB_URL): the index dir is then only a sidecar (the
// manifest, file state, usage ledger, spills), the connection is a REST
// client, and readiness is the server's - the table exists or it does not.
// Opening a hosted index is async, so the async openers are the ones every
// caller that may see either mode uses; the sync ones stay for local-only
// paths and refuse a hosted target instead of quietly opening a local catalog
// beside it.

import { existsSync } from "node:fs";
import { connect, type Connection } from "@infino-ai/infino";
import {
  indexDir,
  resolveRoot,
  TABLE,
  DB_URL_ENV,
  hostedTarget,
  hostedLabel,
  hostedClientOptions,
} from "./config.js";
import { readManifest, writeManifest, INDEX_FORMAT_VERSION, type Manifest, type VectorState } from "./manifest.js";
import { HostedDb, type HostedOptions, type HostedTarget } from "./hosted.js";
import { PLATFORM_DEFAULT_ANALYZER } from "./analyzer.js";

// The platform's default analyzer is defined with the analyzers themselves;
// it is re-exported here because callers that describe a hosted table (the
// loader, the tests) reach for it alongside the other platform constants below.
export { PLATFORM_DEFAULT_ANALYZER };

/** Provider recorded for a table whose vector column the platform fills. */
export const PLATFORM_EMBEDDER_PROVIDER = "platform";

/** Model recorded for a platform-filled column. The deployment's embedding
 * server picks the model and the JSON schema descriptor does not carry its
 * name, so the manifest can only say where it runs. */
export const PLATFORM_EMBEDDER_MODEL = "server-side";

/** The vector column of the chunks table, in both modes. */
export const EMBEDDING_COLUMN = "embedding";

/** The platform's type spelling for a column it embeds itself (see the
 * platform's `schema_to_value`: `{name, type: "embedding", source, nullable}`). */
const EMBEDDING_COLUMN_TYPE = "embedding";

/** Counts a synthesized manifest needs, in one statement: chunks and distinct
 * files per language (a path has one language, so the per-language file counts
 * sum to the distinct paths overall). */
const COUNTS_SQL = `SELECT lang, COUNT(*) AS n, COUNT(DISTINCT path) AS f FROM ${TABLE} GROUP BY lang`;

export interface IndexHandle {
  root: string;
  /** The index directory - the catalog root locally, the sidecar when hosted. */
  dir: string;
  /** Where the chunks table lives, for messages and logs: the index dir for a
   * local index, `https://host/<database>` for a hosted one (never the key). */
  target: string;
  /** The in-process engine connection; absent for a hosted index. */
  db?: Connection;
  /** The platform client; present for a hosted index only. */
  hosted?: HostedDb;
  manifest: Manifest;
}

/** What a build needs: like IndexHandle without a manifest (there may be none
 * yet). Exactly one of `db` / `hosted` is set. */
export interface IndexTarget {
  root: string;
  dir: string;
  target: string;
  db?: Connection;
  hosted?: HostedDb;
}

/** Per-target memo for a hosted index: once the table has been seen it is not
 * listed again (a table does not vanish under a session), and a manifest
 * synthesized from the server is kept so no query pays a schema round trip. */
export interface HostedMemo {
  ready: boolean;
  synthesized?: Manifest;
}

export const newHostedMemo = (): HostedMemo => ({ ready: false });

export class NoIndexError extends Error {
  /** `hostedAt` names the hosted target whose chunks table is missing; without
   * it the message is the local one. */
  constructor(root: string, hostedAt?: string) {
    super(
      hostedAt === undefined
        ? `no index found under ${root} - run \`cx index\` there first (keyword search is ready in seconds).`
        : `no ${TABLE} table at ${hostedAt} - load it with \`cx index --db ${hostedAt}\`.`,
    );
    this.name = "NoIndexError";
  }
}

/** The local engine connection of a handle or repo context, for code paths
 * that only exist locally (a build, a sync, an in-process query). Throws for a
 * hosted target so the caller's mistake is named rather than a property of
 * undefined. */
export function localDb(handle: { db?: Connection; target: string }): Connection {
  if (!handle.db) {
    throw new Error(`${handle.target} is a hosted target - this operation runs against a local index only`);
  }
  return handle.db;
}

/** The platform client for a hosted target, tuned from the environment
 * (CX_DB_TIMEOUT_MS, CX_DB_COLD_START_SECS); `opts` overrides, and is how tests
 * inject a fetch. One place constructs the client so every path shares the
 * tuning. */
export function hostedDbFor(target: HostedTarget, opts: HostedOptions = {}): HostedDb {
  return new HostedDb(target, { ...hostedClientOptions(), ...opts });
}

/** Refuse to open a local catalog while a hosted target is configured: a sync
 * caller reaching this in hosted mode would otherwise index or query a local
 * table nobody asked for. */
function refuseHostedForSyncPath(): void {
  const target = hostedTarget();
  if (target) {
    throw new Error(
      `${DB_URL_ENV} is set (${hostedLabel(target)}) but this command only knows the local index - unset it, or use a command with hosted support`,
    );
  }
}

/** Open the LOCAL index for a repo root; throws NoIndexError when there isn't
 * one, and refuses a configured hosted target (use openIndexAsync). */
export function openIndex(path?: string): IndexHandle {
  refuseHostedForSyncPath();
  const root = resolveRoot(path);
  const dir = indexDir(root);
  const manifest = existsSync(dir) ? readManifest(dir) : undefined;
  if (!manifest) throw new NoIndexError(root);
  return { root, dir, target: dir, db: connect(dir), manifest };
}

/** Open the index for a repo root in either mode. Hosted when CX_DB_URL is
 * set: the handle carries the platform client and a manifest that is the
 * sidecar's when it describes a hosted table, else one synthesized from the
 * server. Throws NoIndexError when the table (or the local index) is missing. */
export async function openIndexAsync(path?: string, hostedOpts?: HostedOptions): Promise<IndexHandle> {
  const target = hostedTarget();
  if (!target) return openIndex(path);
  const root = resolveRoot(path);
  const dir = indexDir(root);
  const handle = await openHostedHandle(hostedDbFor(target, hostedOpts), root, dir, newHostedMemo());
  if (!handle) throw new NoIndexError(root, hostedLabel(target));
  return handle;
}

/** Open (creating the catalog dir if needed) the LOCAL target for indexing;
 * refuses a configured hosted target (use openForIndexingAsync). */
export function openForIndexing(path?: string): { root: string; dir: string; target: string; db: Connection } {
  refuseHostedForSyncPath();
  const root = resolveRoot(path);
  const dir = indexDir(root);
  return { root, dir, target: dir, db: connect(dir) };
}

/** The target a build writes to, in either mode. A hosted target is not
 * checked for the table here - the loader creates it. */
export async function openForIndexingAsync(path?: string, hostedOpts?: HostedOptions): Promise<IndexTarget> {
  const target = hostedTarget();
  if (!target) return openForIndexing(path);
  const root = resolveRoot(path);
  const dir = indexDir(root);
  return { root, dir, target: hostedLabel(target), hosted: hostedDbFor(target, hostedOpts) };
}

/** The handle for a hosted target, or null while the server has no chunks
 * table. Readiness comes from the server (list_tables), memoized once seen;
 * the manifest is the sidecar's when it is a hosted one (re-read per call, so
 * a reload by `cx index --db` is noticed), else synthesized once from the
 * server's schema and memoized. */
export async function openHostedHandle(
  hosted: HostedDb,
  root: string,
  dir: string,
  memo: HostedMemo,
): Promise<IndexHandle | null> {
  if (!memo.ready) {
    const tables = await hosted.listTables();
    if (!tables.includes(TABLE)) return null;
    memo.ready = true;
  }
  const manifest = hostedSidecarManifest(dir) ?? (memo.synthesized ??= await synthesizeHostedManifest(hosted, dir));
  return { root, dir, target: hostedLabel(hosted.target), hosted, manifest };
}

/** The sidecar manifest when it describes a hosted table; a local index's
 * manifest in the same directory is not it. */
function hostedSidecarManifest(dir: string): Manifest | undefined {
  const manifest = existsSync(dir) ? readManifest(dir) : undefined;
  return manifest?.origin === "hosted" ? manifest : undefined;
}

/** One column descriptor as the platform's `schema` answers it. */
interface SchemaDescriptor {
  name?: unknown;
  type?: unknown;
}

/** A manifest for a hosted table nobody loaded from this machine, built from
 * the server: vectors are ready iff the table has its embedding column, the
 * embedder is the platform's when that column is one the platform fills (a
 * client-vector column names no model, so none is recorded), the analyzer is
 * the platform default, and the counts come from one GROUP BY. Cached to the
 * sidecar when the directory holds no manifest yet; an existing local one is
 * left alone (a local index may still be using it). */
export async function synthesizeHostedManifest(hosted: HostedDb, dir?: string): Promise<Manifest> {
  const label = hostedLabel(hosted.target);
  const columns = (await hosted.schema(TABLE)) as unknown;
  if (!Array.isArray(columns)) {
    throw new Error(`schema of ${TABLE} at ${label}: expected a JSON array of column descriptors`);
  }
  const embedding = (columns as SchemaDescriptor[]).find((c) => c.name === EMBEDDING_COLUMN);
  const vectors: VectorState = embedding ? "ready" : "none";
  const platformEmbedded = embedding?.type === EMBEDDING_COLUMN_TYPE;

  const languages: Record<string, number> = {};
  let chunks = 0;
  let files = 0;
  for (const row of await hosted.querySql(COUNTS_SQL)) {
    const n = Number(row.n);
    languages[String(row.lang ?? "") || "other"] = n;
    chunks += n;
    files += Number(row.f);
  }

  const manifest: Manifest = {
    version: INDEX_FORMAT_VERSION,
    table: TABLE,
    origin: "hosted",
    vectors,
    analyzer: PLATFORM_DEFAULT_ANALYZER,
    ...(platformEmbedded ? { embedder: { provider: PLATFORM_EMBEDDER_PROVIDER, model: PLATFORM_EMBEDDER_MODEL } } : {}),
    files,
    chunks,
    languages,
    indexedAt: new Date().toISOString(),
    // The build ran elsewhere; no wall clock of it is known here.
    indexMs: 0,
  };
  if (dir !== undefined && !(existsSync(dir) && readManifest(dir))) writeManifest(dir, manifest);
  return manifest;
}
