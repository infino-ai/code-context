// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Embedding is local, always: a transformers.js model downloaded once on
// first use - no API key, no per-query network, code never leaves the
// machine. Chunks and queries embed with the SAME model so they align.
//
// Semantic search is optional by design: indexing commits the keyword index
// first and backfills vectors after, so a failed model download degrades to
// keyword-only search instead of blocking indexing.
//
// CX_EMBED_MODEL / CX_EMBED_DTYPE exist for development and evaluation (see
// docs/embedder-eval.md) and are deliberately undocumented product surface.

export const LOCAL_MODEL_DEFAULT = "Xenova/all-MiniLM-L6-v2";
const MODEL = process.env.CX_EMBED_MODEL ?? LOCAL_MODEL_DEFAULT;

// Quantization is the main speed lever for local indexing (q8 embeds this
// model ~40% faster than fp32 on CPU with equivalent retrieval quality).
const DTYPE = (process.env.CX_EMBED_DTYPE ?? "q8") as "fp32" | "fp16" | "q8" | "q4";

export interface Embedder {
  /** Embed a batch of texts into vectors (one per text). */
  embed(texts: string[]): Promise<number[][]>;
  /** Vector dimension (learned from the first embedding when unknown). */
  dim(): Promise<number>;
  provider: string;
  model: string;
  /** Quantization the model runs at ("fp32", "q8", …). */
  dtype?: string;
}

// Lazily load the pipeline once; the first call downloads + caches the model
// under the transformers.js cache dir.
let pipe: Promise<
  (texts: string[], opts: object) => Promise<{ tolist(): number[][] }>
> | null = null;
function getPipe() {
  if (!pipe) {
    pipe = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      return (await pipeline("feature-extraction", MODEL, { dtype: DTYPE })) as never;
    })();
  }
  return pipe;
}

export function createEmbedder(): Embedder {
  let knownDim: number | undefined;
  const embed = async (texts: string[]) => {
    const extractor = await getPipe();
    // Mean-pool token vectors and L2-normalize → one embedding per text.
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    const vectors = output.tolist();
    knownDim ??= vectors[0]?.length;
    return vectors;
  };
  return {
    embed,
    dim: async () => {
      if (knownDim === undefined) await embed(["probe"]);
      return knownDim!;
    },
    provider: "local",
    model: MODEL,
    dtype: DTYPE,
  };
}

/** Human-readable description of the embedder, for status output. */
export function embedderInfo(): string {
  return `local ${MODEL} (no key, no network)`;
}
