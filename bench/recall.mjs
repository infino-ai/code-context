// Recall / ranking eval, run on each PR (report-only, no API key).
//
// Indexes THIS repo (code-context) to a temp dir with the default local
// embedder, then runs a fixed set of paraphrase queries whose gold file is
// known, and reports hit@5 / MRR@5 for vector-only ranking (isolates the
// embedder) and hybrid ranking (the `search` tool's real surface).
//
// It's deterministic (same model+dtype -> same vectors) and needs no network
// beyond the one-time model download, which makes it a good regression signal.
// Report-only for now: it always exits 0; the numbers show in the CI log.
//
// Run locally: `npm run build && node bench/recall.mjs`

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Paraphrase query -> the one file that should rank first. Worded to avoid the
// file's literal identifiers so keyword matching can't carry the answer.
const GOLD = [
  ["split source files into chunks at function and class boundaries", "src/core/chunker.ts"],
  ["walk the project tree while honoring ignore files", "src/core/walker.ts"],
  ["blend keyword scoring and vector similarity into one ranked list", "src/core/searcher.ts"],
  ["re-embed only the files that changed since the last run", "src/core/indexer.ts"],
  ["the terse line summarizing how many tokens a query returned", "src/core/usage.ts"],
  ["load a local sentence embedding model with no api key", "src/core/embedder.ts"],
  ["the on-disk record of what the index holds and how fresh it is", "src/core/manifest.ts"],
  ["expose the retrieval tools to an agent over standard input output", "src/mcp/server.ts"],
  ["per-file fingerprints to detect which files were modified", "src/core/filestate.ts"],
  ["aligned text table output for the terminal", "src/core/output.ts"],
  ["keep one index connection per repo in a small lru cache", "src/mcp/repos.ts"],
  ["the command line entry point that parses subcommands", "src/cli.ts"],
];

// Build the index for the current repo into a throwaway dir.
const tmp = mkdtempSync(join(tmpdir(), "cx-recall-"));
process.env.CX_INDEX_DIR = tmp;

const { indexRepo } = await import(`${ROOT}/dist/core/indexer.js`);
const { openForIndexing, openIndex } = await import(`${ROOT}/dist/core/context.js`);
const { createEmbedder } = await import(`${ROOT}/dist/core/embedder.js`);
const { search } = await import(`${ROOT}/dist/core/searcher.js`);
const { TABLE, DEFAULT_CAPS } = await import(`${ROOT}/dist/core/config.js`);

console.log(`indexing ${ROOT}`);
const { root, dir, db } = openForIndexing(ROOT);
const stats = await indexRepo({ root, db, indexDirPath: dir, embedder: createEmbedder(), caps: DEFAULT_CAPS });
console.log(`  ${stats.chunks} chunks / ${stats.files} files, vectors=${stats.vectors}\n`);

const handle = openIndex(ROOT);
const table = handle.db.openTable(TABLE);
const embedder = createEmbedder();

const rankOf = (rows, gold) => {
  const files = [];
  for (const r of rows) {
    const p = String(r.path);
    if (!files.includes(p)) files.push(p);
  }
  return files.findIndex((p) => p === gold) + 1; // 1-based; 0 = not in top files
};

let vHit = 0, vRr = 0, hHit = 0, hRr = 0;
const misses = [];
for (const [q, gold] of GOLD) {
  const [vec] = await embedder.embed([q]);
  const vRank = rankOf(table.vectorSearch("embedding", vec, 15, { projection: ["path"] }), gold);
  if (vRank >= 1 && vRank <= 5) { vHit++; vRr += 1 / vRank; }
  const hRank = rankOf((await search(handle, embedder, q, 15)).hits, gold);
  if (hRank >= 1 && hRank <= 5) { hHit++; hRr += 1 / hRank; } else misses.push(`${gold}  ("${q}")`);
}

const n = GOLD.length;
const pct = (x) => (x / n).toFixed(3);
console.log(`recall over ${n} paraphrase queries (code-context corpus):`);
console.log(`  vector-only   hit@5 ${vHit}/${n}   MRR@5 ${pct(vRr)}`);
console.log(`  hybrid        hit@5 ${hHit}/${n}   MRR@5 ${pct(hRr)}`);
if (misses.length) {
  console.log(`  hybrid misses (gold not in top 5):`);
  for (const m of misses) console.log(`    - ${m}`);
}

rmSync(tmp, { recursive: true, force: true });
// Report-only: never fail the build. A soft floor can be added once the
// numbers are stable across the CI OS/Node matrix.
