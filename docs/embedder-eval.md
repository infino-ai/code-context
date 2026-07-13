# Local embedder evaluation

How the default local embedding model was chosen (2026-07-10).

## Setup

- **Corpus:** a ~180k-line Rust retrieval engine - 311 files, 3,042 chunks
  indexed by `cx index`.
- **Questions:** 15 paraphrase-style questions with a single gold file each,
  worded to avoid the gold file's literal identifiers (so keyword matching
  can't carry the answer) - e.g. *"clustering vectors into partitions for the
  approximate nearest neighbor index"* → `…/vector/kmeans.rs`.
- **Metrics:** hit@5 (gold file in the top 5 result files) and MRR@5, over
  pure vector ranking (isolates the embedder) and over hybrid ranking (the
  `search` tool's actual surface, where BM25 fuses in).
- **Hardware:** Apple Silicon laptop, CPU-only via transformers.js/ONNX.
  Times marked * ran with some CPU contention and are approximate.

## Results

| Model | Params | Index embed time | Vector hit@5 / MRR@5 | Hybrid hit@5 / MRR@5 |
|---|---|---|---|---|
| jina-embeddings-v2-base-code (fp32) | 161M | 39.0 min | **8/15 / 0.400** | - |
| jina-embeddings-v2-base-code (q8) | 161M | ~33 min* | **8/15 / 0.400** | **8/15 / 0.328** |
| **all-MiniLM-L6-v2 (q8) - default** | 22M | **1.9 min** | 7/15 / 0.311 | 6/15 / 0.228 |
| all-MiniLM-L6-v2 (fp32) | 22M | 2.7 min* | 7/15 / 0.289 | 7/15 / 0.241 |
| bge-small-en-v1.5 (q8) | 33M | 3.4 min | 6/15 / 0.197 | 5/15 / 0.200 |

Also considered: Model2Vec / potion static embeddings (no maintained
JavaScript inference path at eval time) and remote embedding APIs
(evaluated but not shipped: the embedder is local-only, so the default
works with no key and code never leaves the machine).

## Verdict

- **Default: `Xenova/all-MiniLM-L6-v2` (q8).** The code-trained jina model
  ranks meaningfully better on hard paraphrase queries (hybrid MRR 0.328 vs
  0.228; vector MRR 0.400 vs 0.311), but costs ~17x the indexing time.
  Every first index and every full rebuild embeds the whole repo (only
  incremental syncs are scoped to changed files), so the default optimizes
  quality-per-minute for the experience most users hit first. On this
  corpus the vector stage finishes in under two minutes in the background
  while keyword search is already live.
- **Quality option:** `CX_EMBED_MODEL=jinaai/jina-embeddings-v2-base-code`
  - worth it for repos indexed rarely (CI-cached indexes, overnight
  builds). For jina, int8 quantization scored identically to fp32; for
  MiniLM the q8/fp32 deltas are small and mixed (q8 better on vector MRR,
  slightly worse on hybrid hit@5) - within the noise of a 15-question eval.
- The timings marked * above ran with CPU contention; treat them as
  approximate. The unstarred timings are clean runs.

## Reproducing

The eval embeds each question, ranks with `vectorSearch` / `hybridSearch`
(k=5) against an index built with the same model and dtype, and scores the
gold file's rank. Build per-model indexes with:

```
CX_INDEX_DIR=/tmp/eval-<model> CX_EMBED_MODEL=<model> CX_EMBED_DTYPE=<dtype> cx index <repo>
```
