// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Embedding is local by default: a transformers.js model downloaded once on
// first use - no API key, no per-query network, code never leaves the
// machine. Chunks and queries embed with the SAME model so they align.
//
// Semantic search is optional by design: indexing commits the keyword index
// first and backfills vectors after, so a failed model download degrades to
// keyword-only search instead of blocking indexing.
//
// Two embedders, one model:
//   createEmbedder()          in-process pipeline; stays warm for query-time
//                             embedding (one short string per call - arenas
//                             stay small) and small incremental syncs.
//   createIndexingEmbedder()  a short-lived child process for full builds;
//                             the ONNX runtime's arenas grow with everything
//                             ever embedded and never shrink, so bulk work
//                             runs where exit() can give the memory back.
//
// With --embed-provider platform there is no embedder on this machine at
// all: the hosted table's embedding column is filled and queried server-side,
// so both constructors return null and every caller that gets null must not
// embed (search stays keyword-ranked, a build skips its vector stage).
//
// CX_EMBED_MODEL / CX_EMBED_DTYPE exist for development and evaluation (see
// docs/embedder-eval.md) and are deliberately undocumented product surface.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { fileURLToPath } from "node:url";
import { embedProvider } from "./config.js";

export const LOCAL_MODEL_DEFAULT = "Xenova/all-MiniLM-L6-v2";
const MODEL = process.env.CX_EMBED_MODEL ?? LOCAL_MODEL_DEFAULT;

// Quantization is the main speed lever for local indexing; q8 measured
// faster than fp32 on CPU with similar retrieval quality on our eval
// (docs/embedder-eval.md).
const DTYPE = (process.env.CX_EMBED_DTYPE ?? "q8") as "fp32" | "fp16" | "q8" | "q4";

/** How long dispose() waits for a clean child exit before SIGKILL. */
const CHILD_EXIT_GRACE_MS = 3000;

/** Marks protocol lines on the worker's stdout; anything unprefixed (a
 * library's stray progress print) is ignored instead of desyncing the
 * lockstep protocol. Must match embed-worker.ts. */
export const WORKER_LINE_PREFIX = "@cx:";

/** Reply deadline once the model is warm. A wedged-but-alive worker must
 * fail the vector stage (keyword search stays live), not pin the repo at
 * vectors:"building" forever. 10 minutes for a 32-text batch is far past any
 * healthy CPU inference; CX_EMBED_WORKER_TIMEOUT_MS raises it for genuinely
 * slower setups (huge custom models via CX_EMBED_MODEL, loaded boxes). */
const WORKER_REPLY_TIMEOUT_MS = Number(process.env.CX_EMBED_WORKER_TIMEOUT_MS ?? 10 * 60 * 1000);

/** Reply deadline for the first round-trip, which may also include a full
 * model download on a slow link. Never below the warm deadline. */
const WORKER_FIRST_REPLY_TIMEOUT_MS = Math.max(15 * 60 * 1000, WORKER_REPLY_TIMEOUT_MS);

export interface Embedder {
  /** Embed a batch of texts into vectors (one per text). */
  embed(texts: string[]): Promise<number[][]>;
  /** Embed a batch into one packed row-major Float32Array (n × dim). The
   * streaming index path prefers this: native f32 is half the bytes of boxed
   * doubles and writes straight to the vector spill. Optional so test fakes
   * and older embedders keep working via `embed`. */
  embedToFloat32?(texts: string[]): Promise<{ vectors: Float32Array; dim: number }>;
  /** Vector dimension (learned from the first embedding when unknown). */
  dim(): Promise<number>;
  /** Release resources (kill the child process / drop the pipeline). Only
   * the creator of an embedder calls this. Optional and idempotent. */
  dispose?(): Promise<void>;
  provider: string;
  model: string;
  /** Quantization the model runs at ("fp32", "q8", …). */
  dtype?: string;
}

// Lazily load the pipeline once; the first call downloads + caches the model
// under the transformers.js cache dir.
let pipe: Promise<
  (texts: string[], opts: object) => Promise<{ data: Float32Array; dims: number[]; tolist(): number[][] }>
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

/** The in-process embedder, or null when the platform embeds server-side
 * (--embed-provider platform) - there is nothing to run here then. */
export function createEmbedder(): Embedder | null {
  return embedProvider() === "platform" ? null : createLocalEmbedder();
}

/** The in-process pipeline, unconditionally. The child-process embedder falls
 * back to this when its worker cannot start, so it must not go through the
 * provider switch again. */
function createLocalEmbedder(): Embedder {
  let knownDim: number | undefined;
  const embedToFloat32 = async (texts: string[]) => {
    const extractor = await getPipe();
    // Mean-pool token vectors and L2-normalize → one embedding per text.
    const output = await extractor(texts, { pooling: "mean", normalize: true });
    // `data` is the tensor's backing Float32Array (row-major [n, dim]) - no
    // per-float boxing, unlike tolist().
    const dim = output.dims[output.dims.length - 1];
    knownDim ??= dim;
    return { vectors: output.data.slice() as Float32Array, dim };
  };
  const embed = async (texts: string[]) => {
    const { vectors, dim } = await embedToFloat32(texts);
    return unpackRows(vectors, dim);
  };
  return {
    embed,
    embedToFloat32,
    dim: async () => {
      if (knownDim === undefined) await embedToFloat32(["probe"]);
      return knownDim!;
    },
    provider: "local",
    model: MODEL,
    dtype: DTYPE,
  };
}

/** Split a packed row-major Float32Array into number[] rows (the shape the
 * engine binding's row-object append accepts). Bounded by the batch that
 * produced it - never called on a whole corpus. */
export function unpackRows(vectors: Float32Array, dim: number): number[][] {
  const rows: number[][] = [];
  for (let off = 0; off < vectors.length; off += dim) {
    rows.push(Array.from(vectors.subarray(off, off + dim)));
  }
  return rows;
}

// --- child-process embedder for full builds ---------------------------------
//
// Protocol (lockstep, one in flight): parent writes one NDJSON request line
// {texts: [...]} to the child's stdin and awaits one NDJSON response line
// {n, dim, b64} (b64 = base64 of the packed f32 rows) or {error} on stdout.
// Model logs go to stderr. stdin end = shutdown. Lockstep means no pipe
// backpressure handling and strictly bounded child memory.

interface WorkerOk {
  n: number;
  dim: number;
  b64: string;
}

/** A build-scoped embedder that runs the model in a child process and gives
 * the memory back on dispose(). Falls back to the in-process embedder if the
 * child can't start (missing dist worker when running from source, exotic
 * node setups) - indexing never fails over process plumbing. Null when the
 * platform embeds server-side (--embed-provider platform). */
export function createIndexingEmbedder(): Embedder | null {
  if (embedProvider() === "platform") return null;
  let child: ChildProcess | null = null;
  let lines: Interface | null = null;
  let pending: Array<{ resolve: (line: string) => void; reject: (err: Error) => void }> = [];
  let fallback: Embedder | null = null;
  let knownDim: number | undefined;
  let disposed = false;

  const start = () => {
    const workerPath = fileURLToPath(new URL("./embed-worker.js", import.meta.url));
    const proc = spawn(process.execPath, [workerPath], {
      stdio: ["pipe", "pipe", "inherit"],
      env: process.env,
    });
    const rl = createInterface({ input: proc.stdout! });
    rl.on("line", (line) => {
      // Only prefixed lines are protocol; a dependency printing to stdout
      // must not shift the lockstep pairing.
      if (line.startsWith(WORKER_LINE_PREFIX)) {
        pending.shift()?.resolve(line.slice(WORKER_LINE_PREFIX.length));
      }
    });
    const fail = (why: string) => {
      const waiting = pending;
      pending = [];
      for (const p of waiting) p.reject(new Error(why));
    };
    proc.on("error", (err) => fail(`embed worker failed to start: ${err.message}`));
    proc.on("exit", (code) => {
      if (!disposed && code !== 0) fail(`embed worker exited with code ${code}`);
    });
    child = proc;
    lines = rl;
  };

  let firstReply = true;
  const roundTrip = (texts: string[]): Promise<WorkerOk> => {
    const timeoutMs = firstReply ? WORKER_FIRST_REPLY_TIMEOUT_MS : WORKER_REPLY_TIMEOUT_MS;
    firstReply = false;
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        // The lockstep pairing is unrecoverable after a missed reply; kill
        // the worker so the failure is prompt and the process can't linger.
        reject(new Error(`embed worker unresponsive for ${Math.round(timeoutMs / 60000)}m`));
        void stopChild();
      }, timeoutMs);
      timer.unref();
      pending.push({
        resolve: (line) => {
          clearTimeout(timer);
          resolve(line);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      child!.stdin!.write(JSON.stringify({ texts }) + "\n", (err) => {
        if (err) pending.shift()?.reject(err);
      });
    }).then((line) => {
      const msg = JSON.parse(line) as WorkerOk | { error: string };
      if ("error" in msg) throw new Error(`embed worker: ${msg.error}`);
      return msg;
    });
  };

  const embedToFloat32 = async (texts: string[]) => {
    if (fallback) return fallback.embedToFloat32!(texts);
    if (!child) {
      try {
        start();
        // Prove the pipeline works before trusting the child with the run;
        // a dead worker surfaces here, once, instead of on every batch.
        const probe = await roundTrip(["probe"]);
        knownDim ??= probe.dim;
      } catch (err) {
        process.stderr.write(
          `code-context: embed worker unavailable (${(err as Error).message}); embedding in-process\n`,
        );
        await stopChild();
        fallback = createLocalEmbedder();
        return fallback.embedToFloat32!(texts);
      }
    }
    const msg = await roundTrip(texts);
    knownDim ??= msg.dim;
    // Copy out of the (possibly pooled, unaligned) base64 Buffer into an
    // owned, 4-byte-aligned array. Bounded by one batch.
    const bytes = Buffer.from(msg.b64, "base64");
    const vectors = new Float32Array(bytes.byteLength / 4);
    new Uint8Array(vectors.buffer).set(bytes);
    return { vectors, dim: msg.dim };
  };

  const stopChild = async () => {
    const proc = child;
    child = null;
    lines?.close();
    lines = null;
    if (!proc) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, CHILD_EXIT_GRACE_MS);
      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      proc.stdin?.end();
    });
  };

  return {
    embed: async (texts) => {
      const { vectors, dim } = await embedToFloat32(texts);
      return unpackRows(vectors, dim);
    },
    embedToFloat32,
    dim: async () => {
      if (knownDim === undefined) await embedToFloat32(["probe"]);
      return knownDim!;
    },
    dispose: async () => {
      disposed = true;
      await stopChild();
      fallback = null;
    },
    provider: "local",
    model: MODEL,
    dtype: DTYPE,
  };
}

/** Human-readable description of the embedder, for status output. */
export function embedderInfo(): string {
  return embedProvider() === "platform" ? "platform (server-side)" : `local ${MODEL} (no key, no network)`;
}
