// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Opening an existing index: connection + manifest in one handle.

import { existsSync } from "node:fs";
import { connect, type Connection } from "@infino-ai/infino";
import { indexDir, resolveRoot } from "./config.js";
import { readManifest, type Manifest } from "./manifest.js";

export interface IndexHandle {
  root: string;
  dir: string;
  db: Connection;
  manifest: Manifest;
}

export class NoIndexError extends Error {
  constructor(root: string) {
    super(
      `no index found under ${root} — run \`cx index\` there first (keyword search is ready in seconds).`,
    );
    this.name = "NoIndexError";
  }
}

/** Open the index for a repo root; throws NoIndexError when there isn't one. */
export function openIndex(path?: string): IndexHandle {
  const root = resolveRoot(path);
  const dir = indexDir(root);
  const manifest = existsSync(dir) ? readManifest(dir) : undefined;
  if (!manifest) throw new NoIndexError(root);
  return { root, dir, db: connect(dir), manifest };
}

/** Open (creating the catalog dir if needed) for indexing. */
export function openForIndexing(path?: string): { root: string; dir: string; db: Connection } {
  const root = resolveRoot(path);
  const dir = indexDir(root);
  return { root, dir, db: connect(dir) };
}
