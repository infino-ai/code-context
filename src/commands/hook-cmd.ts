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
// `cx hook answer-due` - PostToolUse, on the RETRIEVAL tools rather than on
// `answer`. Runs the moment rows come back and puts one sentence in front of
// the model through `additionalContext`: the writer has these rows, do not
// write the answer yourself, call `answer` when ready. It exists because the
// two halves of that rule were enforced unequally - a Stop hook sends a model
// back for the call it skipped, while not-writing was only a sentence in the
// tool text, read once at the top of the turn. Measured 2026-09-22: Haiku
// wrote its own answer first in 9 runs of 11 and called the tool afterwards
// anyway; Opus 0 of 25, Sonnet 0 of 23.
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
export const HOOK_ANSWER_STOP = "answer-stop";
export const HOOK_ANSWER_DUE = "answer-due";

/** The tool names, as Claude Code spells an MCP tool, whose use in a turn
 * means the model retrieved through this server; and the one whose use
 * means the answer was written. The server name is the install's; the
 * suffixes are the tools'. */
const RETRIEVAL_TOOL_SUFFIXES = ["__ask", "__search", "__find", "__sql"];
const ANSWER_TOOL_SUFFIX = "__answer";
/** What the Stop hook tells the model when it stopped without calling
 * `answer` after retrieving: the one thing left to do. */
export const ANSWER_STOP_REASON =
  "You retrieved through code-context but did not call its answer tool. Call answer now with the question; " +
  "the answer is written from the rows you retrieved. Do not write it yourself.";

/** What the PostToolUse hook puts in front of the model the moment rows come
 * back, before it has decided what to do with them.
 *
 * The asymmetry this closes: the `answer` call is enforced - the Stop hook
 * sends a model back for it - while "never write the answer yourself" was
 * only a sentence in the tool text, read once at the top of the turn and
 * many thousands of tokens before the moment it applies. Measured on the
 * demo 2026-09-22, across every run that called `answer`: Haiku wrote its own
 * answer first in 9 of 11, up to 3,918 characters of it, and then called the
 * tool anyway; Opus did so in 0 of 25 and Sonnet in 0 of 23, neither emitting
 * more than a 212-character status line. So the instruction holds for the
 * stronger models and not the weaker one, and what the weaker one needs is
 * the rule beside the rows rather than at the top of the turn.
 *
 * It names no thinking, for the reason the file header gives. */
export const ANSWER_DUE_NOTE =
  "code-context: the answer tool's writer already holds these rows. Do not write the answer yourself. " +
  "When you have what the question needs, call answer with the question alone.";

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

/** The tool calls the model made since the person's last question, from a
 * session transcript: every `tool_use` block of its own messages after the
 * last user prompt, in order; a subagent's are not its own. */
export function transcriptToolCalls(jsonl: string): string[] {
  const entries: Array<{ type?: string; isSidechain?: boolean; message?: { content?: unknown } }> = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") entries.push(parsed as (typeof entries)[number]);
    } catch {
      /* a partial last line */
    }
  }
  let from = -1;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== "user" || e.isSidechain) continue;
    const content = e.message?.content;
    const prompt =
      typeof content === "string"
        ? content.trim().length > 0
        : Array.isArray(content) && (content as Array<{ type?: string }>).some((b) => b.type === "text") && !(content as Array<{ type?: string }>).some((b) => b.type === "tool_result");
    if (prompt) from = i;
  }
  if (from < 0) return [];
  const calls: string[] = [];
  for (const e of entries.slice(from + 1)) {
    if (e.type !== "assistant" || e.isSidechain) continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<{ type?: string; name?: string }>) {
      if (block.type === "tool_use" && typeof block.name === "string") calls.push(block.name);
    }
  }
  return calls;
}

/** The Stop hook's output: when the model retrieved through this server in
 * this turn and stopped without calling `answer`, it is sent back for that
 * one call (`decision: block`, the reason as its instruction); otherwise
 * nothing, and it stops. `stop_hook_active` set means this hook already
 * sent it back once in this turn, and a model that still did not call the
 * tool is let go rather than looped. Measured 2026-09-21 on the demo:
 * Haiku made three asks and wrote the answer itself, where Sonnet and Opus
 * called the tool; the instruction alone does not hold every model to it. */
export function hookStopOutput(input: string, readFile: (path: string) => string | null): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }
  const event = parsed as { transcript_path?: unknown; stop_hook_active?: unknown } | null;
  if (!event || typeof event !== "object" || typeof event.transcript_path !== "string") return null;
  if (event.stop_hook_active === true) return null;
  const transcript = readFile(event.transcript_path);
  if (transcript === null) return null;
  const calls = transcriptToolCalls(transcript);
  const retrieved = calls.some((name) => name.startsWith("mcp__") && RETRIEVAL_TOOL_SUFFIXES.some((s) => name.endsWith(s)));
  const answered = calls.some((name) => name.startsWith("mcp__") && name.endsWith(ANSWER_TOOL_SUFFIX));
  if (!retrieved || answered) return null;
  return JSON.stringify({ decision: "block", reason: ANSWER_STOP_REASON });
}

/** The PostToolUse output that puts the rule beside the rows: the note goes
 * to the model through `additionalContext`, which is the model's half of a
 * PostToolUse result (`systemMessage` is the person's half and the model
 * never sees it). Returns null for input that is not this event, so a
 * malformed event prints nothing rather than a stray note.
 *
 * Deliberately stateless and unconditional: it fires on every retrieval
 * result rather than once a turn. A reply issuing five queries gets five
 * copies of one short sentence, which is cheap against what it is there to
 * prevent - the run that prompted this wrote 3,899 characters of answer
 * nobody used - and repetition is what the weaker model needs. The matcher
 * that selects the retrieval tools is the install's, so this never runs on
 * the `answer` tool's own result. */
export function hookAnswerDueOutput(input: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: ANSWER_DUE_NOTE,
    },
  });
}

export function hookCmd(event: string, opts: HookCmdOptions): void {
  if (event !== HOOK_ANSWER && event !== HOOK_ANSWER_INPUT && event !== HOOK_ANSWER_STOP && event !== HOOK_ANSWER_DUE) return;
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
  if (event === HOOK_ANSWER_STOP) {
    const output = hookStopOutput(input, readFile);
    if (output !== null) process.stdout.write(output);
    return;
  }
  if (event === HOOK_ANSWER_DUE) {
    const output = hookAnswerDueOutput(input);
    if (output !== null) process.stdout.write(output);
    return;
  }
  const chunk = hookChunk(input, opts, readFile);
  if (chunk !== null) process.stdout.write(hookOutput(chunk));
}
