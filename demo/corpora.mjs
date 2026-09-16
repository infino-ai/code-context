// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Corpus definitions for the side-by-side demo. Checkout and index paths come
// from DEMO_BENCH_ROOT and optional DEMO_CORPUS_<ID>_REPO / _INDEX overrides —
// nothing is tied to a particular host layout.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { dataSystemPrompt } from "../bench/lanes.mjs";

/** Parent directory for default corpus checkout folder names. */
export const BENCH_ROOT = resolve(process.env.DEMO_BENCH_ROOT ?? join(homedir(), "bench-repos"));

const envKey = (id, suffix) => `DEMO_CORPUS_${id.toUpperCase().replace(/-/g, "_")}_${suffix}`;

/** Resolve a corpus checkout directory. */
export function corpusRepo(id, defaultDirName) {
  const fromEnv = process.env[envKey(id, "REPO")];
  return resolve(fromEnv ?? join(BENCH_ROOT, defaultDirName));
}

/** Resolve the index directory; optional second name is tried when the first is absent. */
export function corpusIndex(id, repo, preferredDir, alternateDir) {
  const fromEnv = process.env[envKey(id, "INDEX")];
  if (fromEnv) return resolve(fromEnv);
  const preferred = join(repo, preferredDir);
  if (existsSync(preferred)) return preferred;
  if (alternateDir) {
    const alt = join(repo, alternateDir);
    if (existsSync(alt)) return alt;
  }
  return preferred;
}

/** Whether repo and index paths exist on this machine. */
export function corpusPathsReady(repo, index) {
  return existsSync(repo) && existsSync(index);
}

const JOBS_DIR = corpusRepo("jobs", "jobs-ndjson");

/** Static corpus metadata; paths and `ready` are filled in by {@link resolveCorpus}. */
const CORPUS_DEFS = [
  {
    id: "infino",
    label: "infino — the engine, 450 files",
    name: "infino",
    repoDir: "infino-ed4e020",
    indexDir: ".infino-hosted",
    indexAlt: ".infino",
    blurb:
      "The engine repository: a retrieval engine that stores data on object storage and runs SQL, " +
      "full-text search and vector search over it. One file (a \"superfile\") is a valid Parquet file " +
      "with BM25 and vector indexes spliced in; the supertable layer composes many superfiles into a " +
      "queryable table with snapshot-isolated reads and an atomic-commit manifest.",
    table: "chunks",
    hostedTableReady: true,
    examples: [
      "Which files have the most code about the full-text-search (FTS) index? Ranked list.",
      "Which files have the most code about the vector index? Ranked list with reasons.",
      "How does incremental indexing work end to end when a file changes?",
      "Where does an append become durable, and what is the last step before other readers can see the new rows?",
      "How does hybrid search combine BM25 and vector results into one ranked list?",
    ],
  },
  {
    id: "opensearch",
    label: "OpenSearch — 17,092 files, 38x",
    name: "OpenSearch",
    repoDir: "opensearch-shallow",
    indexDir: ".infino",
    indexAlt: ".infino-hosted",
    blurb:
      "The search engine: a distributed search and analytics engine in Java. A REST layer takes a " +
      "query, the coordinating node fans it out to the shards that hold the data, each shard scores " +
      "its own segments with Lucene, and the results are merged back. Thirty-eight times the engine " +
      "repository's file count, which is the point - it is the size at which sweeping the tree stops " +
      "being free.",
    table: "chunks_opensearch",
    hostedTableReady: true,
    examples: [
      "Which files have the most code about query DSL parsing? Ranked list.",
      "Which files have the most code about shard allocation? Ranked list with reasons.",
      "How does a search request travel from the REST layer to the shards and back?",
      "Where does an index write become durable, and what is the last step before a search can see it?",
      "Where is the similarity scoring implemented, and which class computes the score?",
    ],
  },
  {
    id: "jobs",
    label: "job postings — 284,622 postings in 878,682 daily rows, Ashby · Greenhouse · Lever",
    name: "job postings",
    kind: "data",
    repoDir: "jobs-ndjson",
    indexDir: ".infino-hosted",
    indexAlt: ".infino",
    blurb:
      "284,622 job postings from three applicant-tracking systems — Ashby, Greenhouse and Lever — as daily " +
      "snapshots taken 8–11 September 2026 (the open-apply-jobs dataset): 878,682 rows, a posting appearing " +
      "once per day it was open. Every column is carried: the title, the whole description as HTML, employer, " +
      "department, locations, remote flag, posting dates, salary range and currency, and the apply link.",
    how:
      "Every arm sees the same 878,682 rows. The File Tools arm reads them off disk — one posting per line " +
      "as JSON, 250 lines per file, 6.4 GB — with Grep, Glob and Read; the others query an Infino table of " +
      "the same rows, full-text indexed on the title and the description and with a vector index over the " +
      "titles. A question that spans many postings — a count, a ranking, who is hiring for what — is where " +
      "they diverge; a question about one named posting usually comes out level.",
    table: "chunks_jobs",
    rows: 878_682,
    postings: 284_622,
    hostedTableReady: true,
    judge: false,
    examples: [
      "Which employers have the most open machine learning engineer roles, and where are they hiring? Ranked list.",
      "How many postings are remote, and which departments have the highest share of remote roles?",
      "What salary ranges do entry-level or new-grad software engineering postings list, and which employers pay the most?",
      "Which companies are hiring for GPU or CUDA experience, and what do those roles ask for?",
      "Which postings mention a security clearance, and which departments and locations do they cluster in?",
    ],
  },
];

/** Attach resolved paths and effective readiness for this host. */
export function resolveCorpus(def) {
  const repo =
    def.id === "jobs"
      ? JOBS_DIR
      : corpusRepo(def.id, def.repoDir);
  const index = corpusIndex(def.id, repo, def.indexDir, def.indexAlt);
  const onDisk = corpusPathsReady(repo, index);
  const hostedOk = def.hostedTableReady !== false;
  const ready = hostedOk && onDisk;
  let note = def.note ?? null;
  if (hostedOk && !onDisk) {
    note =
      `Checkout or index not on this host (repo: ${repo}, index: ${index}). ` +
      `Set DEMO_BENCH_ROOT or DEMO_CORPUS_${def.id.toUpperCase().replace(/-/g, "_")}_REPO / _INDEX.`;
  }
  const system =
    def.kind === "data"
      ? dataSystemPrompt(
          repo,
          "284,622 job postings from Ashby, Greenhouse and Lever, held as 878,682 rows of daily snapshots " +
            "(a posting repeats once per day it was open, so count postings by distinct id; columns: title, " +
            "description, employer, department, locations, salary, dates)",
        )
      : def.system;
  const { repoDir, indexDir, indexAlt, hostedTableReady, ...rest } = def;
  return { ...rest, repo, index, ready, note, system };
}

/** Corpora with paths resolved at process start. */
export const CORPORA = CORPUS_DEFS.map(resolveCorpus);

/** The corpus a request names, or the first. */
export function corpusFor(id) {
  return CORPORA.find((c) => c.id === id) ?? CORPORA[0];
}

/** Default infino checkout for CX_BENCH_REPO fallback in server boot logs. */
export const DEFAULT_INFINO_REPO = corpusRepo("infino", "infino-ed4e020");
