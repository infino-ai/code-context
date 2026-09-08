// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Asking whether indexed content may leave the machine.
//
// The three local tools read an index on this disk and send nothing anywhere.
// The two cloud tools need the same index on a platform database, which means
// the repository's content - the code itself, not metadata about it - is
// uploaded. That is a decision for the person at the keyboard, and this is
// where they make it.
//
// Two rules shape the wording and the placement:
//
// The agent must never be the one who agrees. An MCP client already prompts
// the human before it runs a tool, but the model can retry, rephrase and
// answer its own way around a question posed inside a tool result - and it has
// no standing to agree to uploading someone's employer's source. So the
// question is asked by a command a person typed in their own terminal, and if
// nobody is at the terminal the answer is no.
//
// It has to say what actually leaves, not "data". Someone who reads "sends
// data to Infino" hears telemetry; what is sent is the file contents. The gap
// between what a person thinks they agreed to and what happened is the whole
// of the harm here, so the text names it.

import { createInterface } from "node:readline";
import { bold, dim, yellow } from "./output.js";
import { readStoredAccount, writeStoredAccount } from "./keystore.js";

/** What is disclosed before anything is uploaded. Written to be read once, by
 * someone who did not go looking for it. */
export function consentNotice(baseUrl: string, database: string, root: string): string {
  return [
    `${bold("The cloud tools upload this repository's contents.")}`,
    ``,
    `  ask and explore run on ${baseUrl}, over a copy of the index kept there.`,
    `  Building that copy sends the ${bold("text of the files")} under ${root} - the code`,
    `  itself, not just names or metrics - into the database ${bold(database)}.`,
    `  Every later sync sends what changed.`,
    ``,
    `  find, search and sql do not. They read the index on this disk and`,
    `  send nothing anywhere, and they keep working if you say no.`,
    ``,
    dim(`  If this code is not yours to upload, say no. You can enable it later`),
    dim(`  with \`cx install\`, or never, and the local tools are unaffected.`),
  ].join("\n");
}

/** Whether this machine has already agreed. */
export function hasUploadConsent(): boolean {
  return readStoredAccount()?.uploadConsentAt !== undefined;
}

/** Record the agreement, so it is asked once per machine rather than once per
 * checkout. Returns false when there is no account to record it against. */
export function recordUploadConsent(at: string): boolean {
  const account = readStoredAccount();
  if (!account) return false;
  writeStoredAccount({ ...account, uploadConsentAt: at });
  return true;
}

/** Why consent was not obtained, for a caller that has to explain itself. */
export type ConsentOutcome = "already-given" | "granted" | "declined" | "no-terminal";

export interface ConsentDeps {
  /** Ask the question and return the raw answer. Injected by tests. */
  ask?: (prompt: string) => Promise<string>;
  /** Whether a person is present to answer. */
  interactive?: boolean;
  /** Clock, so a test can assert the recorded timestamp. */
  now?: () => Date;
}

/** Obtain consent for uploading `root` to `database` on `baseUrl`, printing
 * the notice first unless it has already been given.
 *
 * With nobody at the terminal the answer is no, not "assume yes": this runs
 * inside `cx install`, which a CI job or a dotfiles script may run
 * unattended, and an unattended default of yes would upload a repository
 * nobody chose to upload. `--yes` is how a script says yes on purpose. */
export async function askUploadConsent(
  baseUrl: string,
  database: string,
  root: string,
  deps: ConsentDeps = {},
): Promise<ConsentOutcome> {
  if (hasUploadConsent()) return "already-given";

  const interactive = deps.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  if (!interactive) return "no-terminal";

  console.log(consentNotice(baseUrl, database, root));
  console.log("");
  const answer = (await (deps.ask ?? promptStdin)("Upload this repository's contents to Infino? [y/N] ")).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    console.log(yellow("Not uploading."));
    return "declined";
  }
  recordUploadConsent((deps.now ?? (() => new Date()))().toISOString());
  return "granted";
}

/** Read one line from the terminal. */
function promptStdin(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
