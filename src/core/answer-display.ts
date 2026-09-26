// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// How the platform's written answer reaches the person, without the model
// retyping it.
//
// In Claude Code the model's own message is the only text that reaches the
// screen, with one exception: a hook may return a `systemMessage`, and that
// is shown to the person directly, never to the model. So the `answer` tool
// has two ways to deliver, chosen at server start by CX_ANSWER_DISPLAY:
//
//   hook  - the answer is written to a file under the index directory, a
//           PostToolUse hook on the tool (written by `cx install`) reads the
//           file and shows it, and the tool tells the model the person has
//           it and to reply in one sentence. The result carries the answer's
//           text as well, so the model holds it for whatever the person asks
//           next: reading it in costs almost nothing, typing it out is what
//           costs (the owner, 2026-09-21: "intake doesn't take time nor cost
//           a lot"). Measured 2026-09-21 with Opus and Haiku: the model's
//           reply was one line, the answer appeared unchanged, and the wait
//           after the tool returned was nothing - against 48 s of retyping
//           for a 16k-character answer.
//   relay - no hook: the tool returns the answer itself with the instruction
//           to reply with it exactly. Opus relayed 15,889 characters
//           unchanged that way (2026-09-21); the wait is its typing speed.
//
// Claude Code shows a hook's message whole up to about 10,000 characters and
// saves a longer one to a file with a notice instead (measured 2026-09-21:
// 9,000 shown, 12,000 persisted). A long answer is therefore shown in chunks,
// one hook entry per chunk, each under the cap; `cx install` writes as many
// entries as ANSWER_DISPLAY_CHUNKS.

/** The marker the tool leaves in its result for the hook to find the file. */
const MARKER_OPEN = "[[answer-file:";
const MARKER_CLOSE = "]]";

/** Characters one hook message may carry and still be shown whole. */
export const ANSWER_DISPLAY_CHUNK_CHARS = 9000;
/** Hook entries `cx install` writes, one per chunk: room for 27k characters,
 * three times the longest answer the demo has recorded. */
export const ANSWER_DISPLAY_CHUNKS = 3;

/** The environment variable that selects hook delivery, and its value. */
export const ANSWER_DISPLAY_ENV = "CX_ANSWER_DISPLAY";
export const ANSWER_DISPLAY_HOOK = "hook";

export type AnswerDisplay = "hook" | "relay";

/** How this server delivers a written answer: `hook` when `cx install`
 * wrote the hook and set the variable on the server entry, `relay` otherwise. */
export function answerDisplayMode(env: NodeJS.ProcessEnv = process.env): AnswerDisplay {
  return (env[ANSWER_DISPLAY_ENV] ?? "").toLowerCase() === ANSWER_DISPLAY_HOOK ? "hook" : "relay";
}

/** The marker naming the answer file, as the tool result carries it. */
export function answerFileMarker(path: string): string {
  return `${MARKER_OPEN}${path}${MARKER_CLOSE}`;
}

/** The answer file a tool result names, or null. The hook is handed the
 * result as JSON, so the text may arrive with its quotes escaped; the path is
 * read up to the closing marker either way. */
export function answerFileFrom(text: string): string | null {
  const start = text.indexOf(MARKER_OPEN);
  if (start < 0) return null;
  const end = text.indexOf(MARKER_CLOSE, start);
  if (end < 0) return null;
  return text.slice(start + MARKER_OPEN.length, end).replace(/\\\//g, "/");
}

/** What the tool tells the model under hook delivery: the person has the
 * answer; say one sentence; here is the text, for what comes next. The
 * marker sits before the answer so the hook finds the file first. */
export function hookDeliveryText(path: string, answer: string): string {
  return (
    `The answer below has already been shown to the user in full. ${answerFileMarker(path)}\n` +
    "Reply with one short sentence and nothing else - do not repeat, summarize or rewrite the answer; the user has it in front of them. " +
    "It is given here so you have it for the user's next request.\n\n" +
    answer
  );
}

/** What the tool tells the model under relay delivery: the answer, to be
 * given back exactly. */
export function relayDeliveryText(answer: string): string {
  return `Reply with the following answer exactly as written, in full, and nothing else:\n\n${answer}`;
}

/** The answer in at most `count` pieces, each within the display cap, cut at
 * paragraph breaks where there are any and mid-text where a paragraph alone
 * is over the cap. Text past what `count` chunks can hold is dropped with a
 * note at the end of the last chunk, so the person is told rather than left
 * with a sentence that stops. */
export function answerChunks(text: string, count: number = ANSWER_DISPLAY_CHUNKS, cap: number = ANSWER_DISPLAY_CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > 0 && chunks.length < count) {
    if (rest.length <= cap) { chunks.push(rest); rest = ""; break; }
    let cut = rest.lastIndexOf("\n\n", cap);
    if (cut < cap / 2) cut = rest.lastIndexOf("\n", cap);
    if (cut < cap / 2) cut = cap;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0 && chunks.length > 0) {
    const note = `\n\n[${rest.length} more characters of the answer were not shown here]`;
    const last = chunks.length - 1;
    chunks[last] = chunks[last].slice(0, Math.max(0, cap - note.length)) + note;
  }
  return chunks;
}

/** The JSON a hook prints to show one chunk to the person. */
export function hookOutput(chunk: string): string {
  return JSON.stringify({ systemMessage: chunk });
}
