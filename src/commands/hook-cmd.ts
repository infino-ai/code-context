// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The Claude Code hooks `cx install` writes for the `answer` tool, both run
// by Claude Code with the event as JSON on stdin.
//
// `cx hook answer` - PostToolUse. Runs after the tool returns; finds the
// answer file the result names and prints the chunk it is responsible for
// as a `systemMessage`, which Claude Code shows to the person and never to
// the model. One hook entry per chunk (`--chunk i --chunks n`), so an answer
// longer than one message's cap is shown whole across them (see
// core/answer-display.ts).
//
// `cx hook answer-input` - PreToolUse. Runs before the tool; reads the
// session transcript Claude Code names in the event and fills the call's
// `narration` with what the model said since the person's question - its
// text between tool calls - through the hook's `updatedInput`. The writer
// then reads the model's own account of the evidence beside the rows, and
// the model typed none of it for the purpose: measured 2026-09-21, a model
// asked to write notes for the writer spent 26 s of a 45 s run on them,
// while its narration was already in the transcript.
//
// The model's thinking blocks are not read. They are the model's own, and
// a product that lifts them out of the transcript for another model is what
// Opus 5's safeguards call reasoning extraction (a description that merely
// mentioned "what you thought" refused a whole session on 2026-09-21). What
// the model says is what it chose to put on the record.
//
// Neither ever fails the tool call: no marker, no file, no transcript, or a
// chunk past the end of the answer prints nothing and exits 0.

import { existsSync, readFileSync } from "node:fs";
import { ANSWER_DISPLAY_CHUNKS, answerChunks, answerFileFrom, hookOutput } from "../core/answer-display.js";

export interface HookCmdOptions {
  chunk?: string;
  chunks?: string;
}

/** The hook events this command serves. */
export const HOOK_ANSWER = "answer";
export const HOOK_ANSWER_INPUT = "answer-input";

/** The `answer` tool's input the PreToolUse hook fills. */
export const NARRATION_INPUT = "narration";
/** Characters of narration handed to the writer at most, the most recent
 * kept: a long investigation narrates more than a writer needs, and what it
 * said last is what it concluded. */
export const NARRATION_CHARS = 12_000;
/** What replaces the narration cut from the front when it is over the cap. */
const NARRATION_CUT_NOTE = "[earlier narration left out]";

/** What the model said since the person's last question, from a Claude
 * Code session transcript (JSON lines): the `text` blocks of its messages
 * after the last user prompt, in order, joined by blank lines; null when
 * there is none. Thinking blocks, tool calls and tool results are not
 * narration, and a subagent's lines (`isSidechain`) are not the model's.
 * Over `cap` characters the front is cut at a paragraph and a note says
 * so. */
export function transcriptNarration(jsonl: string, cap: number = NARRATION_CHARS): string | null {
  const entries: Array<{ type?: string; isSidechain?: boolean; message?: { content?: unknown } }> = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") entries.push(parsed as (typeof entries)[number]);
    } catch {
      /* a partial last line while Claude Code is still writing: not an entry */
    }
  }
  const isPrompt = (e: (typeof entries)[number]) => {
    if (e.type !== "user" || e.isSidechain) return false;
    const content = e.message?.content;
    if (typeof content === "string") return content.trim().length > 0;
    if (!Array.isArray(content)) return false;
    const blocks = content as Array<{ type?: string }>;
    return blocks.some((b) => b.type === "text") && !blocks.some((b) => b.type === "tool_result");
  };
  let from = -1;
  for (let i = 0; i < entries.length; i++) if (isPrompt(entries[i])) from = i;
  if (from < 0) return null;
  const pieces: string[] = [];
  for (const e of entries.slice(from + 1)) {
    if (e.type !== "assistant" || e.isSidechain) continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: string; text?: string }>) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim()) pieces.push(block.text.trim());
    }
  }
  if (!pieces.length) return null;
  const whole = pieces.join("\n\n");
  if (whole.length <= cap) return whole;
  const keepFrom = whole.length - (cap - NARRATION_CUT_NOTE.length - 2);
  const paragraph = whole.indexOf("\n\n", keepFrom);
  const tail = whole.slice(paragraph >= 0 ? paragraph + 2 : keepFrom);
  return `${NARRATION_CUT_NOTE}\n\n${tail}`;
}

/** The PreToolUse output that fills the call's narration from the session
 * transcript the event names, or null when there is nothing to add. Pure,
 * for the tests: `input` is the stdin JSON text, `readFile` the file reader.
 *
 * `permissionDecision: allow` rides with the input: Claude Code applies an
 * `updatedInput` under an allow, and the tool is a read-only tool of a
 * server the person installed, so allowing it here changes nothing the
 * person would have been asked about. */
export function hookNarrationOutput(input: string, readFile: (path: string) => string | null): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }
  const event = parsed as { transcript_path?: unknown; tool_input?: unknown } | null;
  if (!event || typeof event !== "object" || typeof event.transcript_path !== "string") return null;
  const transcript = readFile(event.transcript_path);
  if (transcript === null) return null;
  const narration = transcriptNarration(transcript);
  if (narration === null) return null;
  const toolInput = event.tool_input && typeof event.tool_input === "object" && !Array.isArray(event.tool_input) ? (event.tool_input as Record<string, unknown>) : {};
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: "code-context: the answer tool's narration is filled from the session transcript",
      updatedInput: { ...toolInput, [NARRATION_INPUT]: narration },
    },
  });
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
  if (event !== HOOK_ANSWER && event !== HOOK_ANSWER_INPUT) return;
  let input = "";
  try {
    input = readFileSync(0, "utf8");
  } catch {
    return;
  }
  const readFile = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);
  if (event === HOOK_ANSWER_INPUT) {
    const output = hookNarrationOutput(input, readFile);
    if (output !== null) process.stdout.write(output);
    return;
  }
  const chunk = hookChunk(input, opts, readFile);
  if (chunk !== null) process.stdout.write(hookOutput(chunk));
}
