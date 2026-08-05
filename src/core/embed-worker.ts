// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Child-process embedding worker. The ONNX runtime's memory arenas grow with
// everything ever embedded and never shrink, so full-build embedding runs
// here, where process exit returns the memory to the OS - the long-lived MCP
// server never hosts the bulk pipeline (issue #9).
//
// Protocol (lockstep with the parent - see createIndexingEmbedder): one
// NDJSON request {texts: [...]} per line on stdin, one NDJSON response
// {n, dim, b64} (base64 of packed row-major f32) or {error} on stdout.
// stdin closing is the shutdown signal. stderr carries model logs.
//
// This file is a process entry point, not a module - it must stay
// import-free of the rest of src/ so the parent can spawn it cold.

import { createInterface } from "node:readline";

const MODEL = process.env.CX_EMBED_MODEL ?? "Xenova/all-MiniLM-L6-v2";
const DTYPE = process.env.CX_EMBED_DTYPE ?? "q8";

/** Protocol-line marker; the parent ignores unprefixed stdout (e.g. a
 * library's progress prints). Must match WORKER_LINE_PREFIX in embedder.ts
 * (not imported - this file stays dependency-free of src/). */
const LINE_PREFIX = "@cx:";

type Extractor = (
  texts: string[],
  opts: object,
) => Promise<{ data: Float32Array; dims: number[] }>;

let pipe: Promise<Extractor> | null = null;
function getPipe(): Promise<Extractor> {
  if (!pipe) {
    pipe = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      return (await pipeline("feature-extraction", MODEL, { dtype: DTYPE as never })) as never;
    })();
  }
  return pipe;
}

// Requests are processed strictly in order (the parent is lockstep anyway);
// chaining onto `tail` keeps responses ordered even if that ever changes.
let tail = Promise.resolve();
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  tail = tail.then(async () => {
    try {
      const { texts } = JSON.parse(line) as { texts: string[] };
      const extractor = await getPipe();
      const output = await extractor(texts, { pooling: "mean", normalize: true });
      const dim = output.dims[output.dims.length - 1];
      const bytes = Buffer.from(output.data.buffer, output.data.byteOffset, output.data.byteLength);
      process.stdout.write(
        LINE_PREFIX + JSON.stringify({ n: texts.length, dim, b64: bytes.toString("base64") }) + "\n",
      );
    } catch (err) {
      process.stdout.write(LINE_PREFIX + JSON.stringify({ error: (err as Error).message }) + "\n");
    }
  });
});
rl.on("close", () => {
  void tail.finally(() => process.exit(0));
});
