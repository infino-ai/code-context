# Local embedder evaluation

How the default local embedding model was chosen (2026-07-10).

## Setup

- **Corpus:** a ~180k-line Rust retrieval engine — 311 files, 3,042 chunks
  indexed by `cx index`.
- **Questions:** 15 paraphrase-style questions with a single gold file each,
  worded to avoid the gold file's literal identifiers (so keyword matching
  can't carry the answer) — e.g. *"clustering vectors into partitions for the
  approximate nearest neighbor index"* → `…/vector/kmeans.rs`.
- **Metrics:** hit@5 (gold file in the top 5 result files) and MRR@5, over
  pure vector ranking (isolates the embedder) and over hybrid ranking (the
  `search` tool's actual surface, where BM25 fuses in).
- **Hardware:** Apple Silicon laptop, CPU-only via transformers.js/ONNX.
  Times marked * ran with some CPU contention and are approximate.

## Results

| Model | Params | Index embed time | Vector hit@5 / MRR@5 | Hybrid hit@5 / MRR@5 |
|---|---|---|---|---|
| jina-embeddings-v2-base-code (fp32) | 161M | 39.0 min | **8/15 / 0.400** | — |
| jina-embeddings-v2-base-code (q8) | 161M | ~33 min* | **8/15 / 0.400** | **8/15 / 0.328** |
| **all-MiniLM-L6-v2 (q8) — default** | 22M | **1.9 min** | 7/15 / 0.311 | 6/15 / 0.228 |
| all-MiniLM-L6-v2 (fp32) | 22M | 2.7 min* | 7/15 / 0.289 | 7/15 / 0.241 |
| bge-small-en-v1.5 (q8) | 33M | 3.4 min | 6/15 / 0.197 | 5/15 / 0.200 |

Also considered: Model2Vec / potion static embeddings (no maintained
JavaScript inference path at eval time) and remote APIs (supported via
`CX_EMBED_PROVIDER=openai`, but the default must work with no key).

## Verdict

- **Default: `Xenova/all-MiniLM-L6-v2` (q8).** The code-trained jina model
  ranks meaningfully better (+40% MRR on hard paraphrase queries), but costs
  ~17× the indexing time — and a re-index today re-embeds every chunk, so the
  default optimizes quality-per-minute. On this corpus the vector stage
  finishes in under two minutes in the background while keyword search is
  already live.
- **Quality option:** `CX_EMBED_MODEL=jinaai/jina-embeddings-v2-base-code`
  — worth it for repos indexed rarely (CI-cached indexes, overnight builds),
  and int8 quantization loses nothing (identical scores to fp32).
- Revisit the default when incremental re-indexing ships: once only changed
  files re-embed, the code-trained model's one-time cost amortizes and it
  becomes the natural default again.

## Reproducing

The eval embeds each question, ranks with `vectorSearch` / `hybridSearch`
(k=5) against an index built with the same model and dtype, and scores the
gold file's rank. Build per-model indexes with:

```
CX_INDEX_DIR=/tmp/eval-<model> CX_EMBED_MODEL=<model> CX_EMBED_DTYPE=<dtype> cx index <repo>
```
