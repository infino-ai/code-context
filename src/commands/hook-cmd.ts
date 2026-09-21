// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// `cx hook answer` - the Claude Code PostToolUse hook `cx install` writes for
// the `answer` tool. Claude Code runs it after the tool returns, with the
// call and its result as JSON on stdin; it finds the answer file the result
// names, and prints the chunk it is responsible for as a `systemMessage`,
// which Claude Code shows to the person and never to the model. One hook
// entry per chunk (`--chunk i --chunks n`), so an answer longer than one
// message's cap is shown whole across them (see core/answer-display.ts).
//
// It never fails the tool call: no marker, no file, or a chunk past the end
// of the answer prints nothing and exits 0.

import { existsSync, readFileSync } from "node:fs";
import { ANSWER_DISPLAY_CHUNKS, answerChunks, answerFileFrom, hookOutput } from "../core/answer-display.js";

export interface HookCmdOptions {
  chunk?: string;
  chunks?: string;
}

/** The chunk this hook entry shows, from the hook input Claude Code gives
 * it; null when there is nothing to show. Pure, for the tests: `input` is the
 * stdin JSON text, `readFile` the file reader. */
export function hookChunk(input: string, opts: HookCmdOptions, readFile: (path: string) => string | null): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }
  const record = parsed as { tool_response?: unknown } | null;
  const response = record && typeof record === "object" && "tool_response" in record ? record.tool_response : parsed;
  const path = answerFileFrom(typeof response === "string" ? response : JSON.stringify(response ?? ""));
  if (!path) return null;
  const text = readFile(path);
  if (text === null) return null;
  const chunk = Math.max(1, Number(opts.chunk ?? 1));
  const count = Math.max(1, Number(opts.chunks ?? ANSWER_DISPLAY_CHUNKS));
  const pieces = answerChunks(text, count);
  return pieces[chunk - 1] ?? null;
}

export function hookCmd(event: string, opts: HookCmdOptions): void {
  if (event !== "answer") return;
  let input = "";
  try {
    input = readFileSync(0, "utf8");
  } catch {
    return;
  }
  const chunk = hookChunk(input, opts, (path) => (existsSync(path) ? readFileSync(path, "utf8") : null));
  if (chunk !== null) process.stdout.write(hookOutput(chunk));
}
