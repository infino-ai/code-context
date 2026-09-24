// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The dedicated MCP server: three tools over the local code index, and two
// more over the same index's platform copy when a database is configured.
//
//   find     - the grep door: every line containing an exact string, cited
//              path:line - complete and unranked
//   search   - find code: exact terms AND meaning in one ranked pass
//   sql      - the power door: relevance-ranked aggregation over the search
//              table functions (bm25_search / hybrid_search + GROUP BY)
//   ask      - with --db: a question handed to the platform's retrieval
//              loop, answered with the rows it retrieved
//
// Each tool is a different question: where does this exact text occur, what
// is most relevant to this, how much of what is where, what do the rows say.
// Freshness is not a tool: the first query on an unindexed
// repo builds the index (both places, with --db), and every query re-syncs
// it against the working tree (auto-sync, below). A reindex tool used to be
// one more; measured, no Sonnet run ever called it and Haiku called it where
// it hurt, and every tool in the list is prompt text on every turn.
// `cx index --full` is the forced rebuild.
// No near-duplicate retrieval tools - those worsen the agent's tool
// selection - so find is unranked and complete where search is ranked and
// top-k, and hybrid search's keyword half already ranks exact identifiers.
// Every sentence in the descriptions below is paid for on every turn and
// was measured to steer selection: change them with a measurement, not by
// taste. The harness lives with the demo it also drives, not here.
// Results carry took_ms - server-side time for the call (query embedding
// included where one happens; no transport).
//
// With CX_REMOTE_SEARCH the hosted table is the index `search` reads, and
// when CX_TABLE names a table that is not the chunks table (a hydrated data
// set) all three doors run over its ROWS, driven by the table's own schema
// (TableShape): find and sql then never touch the local index either, since
// a local build would drop and recreate the platform table it was pointed
// at. On the chunks table a `sql` statement that embeds a query (a `{{q}}`
// placeholder - a vector function's) runs on the platform whenever a
// database is configured, switch or no switch: the platform embeds it with
// the table's own model, and the local side is lexical - `find`, plain SQL.
// Which of the two it is - chunks or rows - is decided ONCE, at startup,
// from the table's schema (TableMode below) when CX_TABLE names another
// table, and every call reads that decision: no call asks the platform what
// it is about to run against, so a local tool never waits on the platform
// and the tool text registered at startup always describes what the calls
// do. The default table is never asked about - it is the chunks table this
// client builds - so its startup is what it always was, and the chunks
// table keeps every path and every word of tool text it had.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { connect } from "@infino-ai/infino";
import {
  indexDir,
  resolveRoot,
  TABLE,
  DEFAULT_TABLE,
  DEFAULT_CAPS,
  DEFAULT_SEARCH_K,
  DEFAULT_FIND_LIMIT,
  MAX_FIND_LIMIT,
  hostedTarget,
  hostedLabel,
  hostedAnalyzer,
  embedProvider,
  autoIndexEnabled as autoIndexSetting,
  autoSyncEnabled as autoSyncSetting,
  agentToolsEnabled,
  answerToolEnabled,
  apiToolsEnabled,
  siblingNotes,
  siblingTables,
  subagentK,
  subagentMaxTurns,
  subagentMaxWallSecs,
} from "../core/config.js";
import { keyFilePath, readStoredAccount } from "../core/keystore.js";
import { runRetrievalAgent } from "../core/retrieval-agent.js";
import { answerDisplayMode, hookDeliveryText, relayDeliveryText, type AnswerDisplay } from "../core/answer-display.js";
import { readManifest, readPlatformManifest, type Manifest } from "../core/manifest.js";

/** The one refusal whose fix is a person rather than a retry: the account has
 * nothing left to spend. It names the account to add the card to - this same
 * one, not a new sign-up - where to do it, and what keeps working meanwhile,
 * because the three local tools are unaffected and a model told only "402"
 * concludes the whole server is down and stops using any of them. */
export function outOfCreditSteps(): string {
  const where = readStoredAccount()?.consoleUrl ?? "the Infino console";
  return (
    `this Infino account has no credit left. find, search and sql keep working - they run on the ` +
    `local index and cost nothing - but ask needs a balance. To restore it, the ` +
    `account's owner adds their billing details and a card to this same account at ${where} ` +
    `(the key on this machine keeps working and nothing needs reinstalling), then retries`
  );
}

/** A key the platform would not accept. Names the file, because a machine can
 * hold a key for a different platform than the one this server points at. */
export function keyRefusedSteps(): string {
  return (
    `the Infino key this server is using was refused - expired, revoked, or issued by a different ` +
    `platform than the one configured. Run \`cx login\` to store a new one (it goes in ` +
    `${keyFilePath()}, mode 600). find, search and sql are unaffected`
  );
}

/** What to tell the model - and through it the person reading - when the
 * platform refused a call for a reason no rephrasing will fix. Three of those
 * matter and they have three unrelated fixes, so they get three sentences
 * rather than one status code:
 *
 * - capacity (429): a wait. The client already backed off inside the call's
 *   own budget, so a later call is all that is left.
 * - an empty balance (402): a person adding a payment method - the one fix
 *   not available to the agent at all, so it spells out the steps.
 * - a refused key (401): a sign-in, naming the command that does it.
 *
 * Anything else keeps the server's own words, already in the message. */
export function refusalHint(err: unknown): string {
  if (!(err instanceof HostedError)) return "";
  if (err.atCapacity) return " - the platform is at capacity right now; ask again in a moment";
  if (err.paymentRequired) return ` - ${outOfCreditSteps()}`;
  if (err.unauthenticated) return ` - ${keyRefusedSteps()}`;
  return "";
}
import { hostedDbFor, localDb, newHostedMemo, platformLabel, platformTableReady, type IndexHandle } from "../core/context.js";
import { devContext, devContextEnabled } from "../core/dev-context.js";
import { foldValidationFacts, rankRows } from "../core/facts.js";
import { HostedError, type HostedOptions, type RowRecord } from "../core/hosted.js";
import { RetrievalRecord } from "../core/retrieval-record.js";
import {
  analyzerOf,
  find,
  findRows,
  search,
  searchHosted,
  searchRows,
  runSql,
  runSqlRows,
  embedsAQuery,
  jsonify,
  numberRowLines,
  partialIndex,
  CONTENT_COLUMN,
} from "../core/searcher.js";
import {
  newSession,
  receiptEnabled,
  cardEntry,
  findEntry,
  rowFindEntry,
  searchEntry,
  rowSearchEntry,
  sqlEntry,
  subagentEntry,
  withPlatform,
  formatReceipt,
  recordUsage,
} from "../core/usage.js";
import { ENGINE_ID_COLUMN, resolveTableShape, SNIPPET_CHARS, type TableShape } from "../core/table-shape.js";
import {
  indexRepoStaged,
  syncRepo,
  syncInProgress,
  type IndexOptions,
  type SyncOutcome,
  type IndexStats,
  type StagedIndexRun,
} from "../core/indexer.js";
import { createEmbedder, createIndexingEmbedder, embedderInfo, platformEmbedderInfo, type Embedder } from "../core/embedder.js";
import { RepoRegistry, type RepoCtx } from "./repos.js";
import { ensureIndexed, type EnsureResult } from "./ensure.js";

/** The `sql` tool's description, named because it is the one description whose
 * every clause was put there by a measurement and can be regressed by an edit
 * that reads better. Five of its clauses are load-bearing in that sense and
 * `test/tool-text.test.ts` asserts each one, each assertion shown to fail when
 * its clause is rewritten: hybrid named before bm25 (a tool named second was
 * measured taken 0 times in 1,103 queries); the placeholder marked as the
 * caller's to fill (a model copied one literally in 8 of 8 calls); the total
 * named `ranked_lines` and reported as ranked, since fusion unions the keyword
 * and meaning arms so a row can place in the top k without holding the terms;
 * the pair that says a path filter narrows a search but is never the topic -
 * every aggregation statement in the bench that aggregated at all was a
 * directory guess measuring file lengths; and the scan clause naming every
 * predicate rather than ILIKE alone. */
/** The card tier folded into the `sql` description on a platform database.
 *
 * Lean, on a measurement (2026-09-11, 16 questions on the engine repo,
 * `hosted-index` lane, three arms differing by the prompt alone): the lean
 * card took 37% off the wall clock of the ten aggregation questions and the
 * enriched card 41%, while enriched cost +32% on the six comprehension
 * questions against lean's +14% and carried three times the prompt. A blind
 * grounded Opus judge scored both level against no card (7-7-1 and 7-7-2),
 * and cost moved ±3% either way: this is a latency change, not a spend or
 * quality one. So the cheap tier is nearly all of the win and half of the
 * harm. Move it only with a measurement that says otherwise. */
const CARD_TIER = "lean";

/** Every tool here reads the index; none writes. Said out loud because a
 * caller that runs a message's tool calls concurrently only when each one is
 * read-only - Claude Code does exactly that - otherwise runs them one at a
 * time. Without this, four `ask`s issued together were announced at once and
 * executed serially (measured 2026-09-12: 31s where the slowest alone was 15s),
 * so every fan-out sentence in the descriptions below (`PREFER_SEVERAL_ASKS`)
 * was a promise the harness could not keep. */
const READ_ONLY = { readOnlyHint: true } as const;

/** How long `sql` waits for the platform's verdict on its rows before
 * returning them without one. Short on purpose: the rows are the answer and
 * the verdict is advice about them, so a platform that is slow or down must
 * cost the caller a few seconds at most, never the answer.
 *
 * Measured the other way first. The verdict went through the client's normal
 * path, which reads a 503 as a cold start and retries for its whole budget
 * (two minutes by default). On 2026-09-11 the worker's S3 credential expired
 * mid-demo, every hosted call went 503, and a LOCAL `sql` - rows already in
 * hand - sat for 116 s waiting on a best-effort check. That is a regression
 * against the tool as it was, and a platform outage must not become one. */
const VERDICT_TIMEOUT_MS = 3_000;

/** What `sql` says about its verdict when a platform is there to give one.
 * It names the parameter and the field, and says what the verdict is NOT,
 * because the one misreading that costs an answer is taking "valid" for
 * "correct". Absent without a platform: there is then no 'validation' field,
 * and a description promising one would be wrong.
 *
 * `sql` ONLY. It rode on search and find too and was measured worse: blind
 * pairwise over 16 questions (lean-0559 against validate-1305, 2026-09-11),
 * the arm with the verdict lost 8-6-2 overall, and the split was exactly the
 * tool split - every aggregation question used sql alone and won 6-3-1,
 * every comprehension question used search/find alone and lost 0-5-1, with
 * unsupported claims rising 10 to 29 on that half. The anchor check is a
 * poor judge of a ranked search: a conceptual question's anchors are
 * capitalized words and identifiers that often do not appear literally in
 * rows that are genuinely relevant, so it refused good retrievals and sent
 * the model querying again (calls 37 to 48, tokens +25%) for longer answers
 * carrying more unsupported claims. The checks that CAN fire on a search are
 * the ones it does not need: a search result is never an aggregate, and no
 * rows is already plain. Keep it where the statement's shape is real. */
const VALIDATION_NOTE =
  " Pass the question you are answering as 'question' and the result carries 'validation': " +
  "whether these rows would be accepted as answering it - no rows, an aggregate of zeros, or rows " +
  "naming nothing the question named are refused, with the reason. A refusal names the question's " +
  "terms that occur nowhere in the index ('absent': no query will find them, so do not search for " +
  "them again) and the ones that do (query for those), and carries a 'suggestion' statement when " +
  "the one that ran should be rewritten. Query again on a refusal rather than answering from it. " +
  "Valid means the result answers the question's terms, not that it is correct. " +
  // The two columns the platform adds to a ranked aggregate's rows, named
  // here so the model expects them and reads them as what they are. The
  // measured failure they answer is in core/facts.ts.
  "On a ranking grouped by path, every row also carries file_lines, the file's whole length, and " +
  "term_lines, how many of its lines hold each search term: a ranked total is a share of file_lines, " +
  "never the file's size, and a file whose term_lines are all zero was ranked by meaning alone, so " +
  "say so or leave it out rather than renumber the rest.";

/** What introduces the card in the `sql` description. Stated as the table's
 * own measured shape, because that is what it is: the optimizer computed it
 * from the table after optimizing it, so the distinct counts and ranges are
 * the table's, not an estimate. */
const CARD_PREAMBLE =
  ` The table's own measured shape, computed from it - use it to choose columns and write the ` +
  `statement without discovering the shape first:\n`;

/** A `card` TOOL was built and measured first and is deliberately not here.
 * Registered, offered and working, it was simply not called: asked a real
 * aggregation question the model went straight to `sql` (2026-09-11), which
 * is the failure the note on `SQL_DESCRIPTION` below already records for a
 * tool named second. The reason is visible in that description - it already
 * names every column, so from the model's side a card tool adds nothing it
 * can see it needs, while what the card actually adds is the statistics. A
 * fact that cannot be declined has to be in the text, not behind a call. */
/** The first sentence of the sql text: what the statement runs over. Kept
 * apart so the sibling tables, when a deployment names some, are said right
 * after it and not at the tail. Measured on the demo's 64-project corpus
 * (2026-09-24, host 71): with the siblings appended after some 1,450
 * tokens of recipes and the card, Opus wrote four statements over the code
 * table alone, looked for logs among its files, and answered that the
 * corpus had no issues and no test runs; on the host before, with a shorter
 * text, it had joined the logs table at once. What the model must know to
 * choose a table has to come before what it must know to write the query. */
export const SQL_DESCRIPTION_OPENING =
  "Read-only SQL, one SELECT or WITH, over " +
  `${TABLE}(path, start_line, end_line, lang, symbol, content[, embedding]) - lang is the ` +
  "file extension, e.g. 'rs' - for counts, rankings, and GROUP BY across the whole repo. ";

export const SQL_DESCRIPTION =
  SQL_DESCRIPTION_OPENING +
  "The search functions are table-valued: a ranked search is a relation, so WHERE, GROUP BY, " +
  "ORDER BY and joins compose with it in one pass, and one query replaces the several round " +
  "trips of searching, then filtering, then counting. Rank through a search relation rather " +
  "than scanning the whole table - with ILIKE, LIKE, regexp_like, or a bare filter on path " +
  "or lang: a scan has no relevance ranking, reads every chunk, and answers 'contains this " +
  "substring' when the question asked which code is about something. " +
  `Rank with hybrid_search('${TABLE}','content','terms','embedding', {{q}}, k) - 'terms' and ` +
  "{{q}} are yours to fill in, not literals to copy - unless you have " +
  "a reason not to: it fuses exact terms with meaning, so it reaches the code whether or not " +
  "the question's words are the code's words, and they rarely are. That covers a concept, a " +
  "subsystem, 'code about X', 'files that do Y' - the shape of almost every ranking question. " +
  `bm25_search('${TABLE}','content','terms', k) is keyword only: reach for it when the topic ` +
  "is itself a literal string you know appears in the source and you want counts a reader can " +
  `check as occurrences. vector_search('${TABLE}','embedding', {{q}}, k) is meaning alone - for a ` +
  "question whose words will not be the code's words: SELECT path, start_line, content FROM " +
  `vector_search('${TABLE}','embedding', {{q}}, 20). token_match('${TABLE}','content','the terms','and') is ` +
  "every row holding every term, unranked and complete - an identifier, an exact phrase, a count a reader " +
  `can check: SELECT count(*) FROM token_match('${TABLE}','content','separability_matrix','and'). ` +
  `exact_match('${TABLE}','content','value') is the rows whose whole value equals the string - a lookup on ` +
  "a short indexed column, never on content. " +
  "The {{name}} placeholders are filled server-side from the embed " +
  "map, so they cost you nothing but the name. Which files have the most code about a topic, " +
  "ranked - the whole question in one statement, filtered on the " +
  "same pass, with your own words in place of the example's: SELECT path, SUM(end_line - start_line + 1) " +
  `AS ranked_lines, COUNT(*) AS chunks FROM hybrid_search('${TABLE}','content','merge small superfiles','embedding', {{q}}, 300) WHERE ` +
  "path LIKE 'src/%' GROUP BY path ORDER BY ranked_lines DESC LIMIT 15, with embed " +
  '{"q":"how small superfiles are merged into larger ones"}. Where the topic is a literal ' +
  "string you want counted as occurrences, the same shape over " +
  `bm25_search('${TABLE}','content','compaction', 300) instead - every row then holds the word, ` +
  "so a reader can check it. " +
  "What such a total means: a search relation holds only the top k chunks of that query, so a " +
  "SUM or COUNT over it is the lines or chunks that ranked within the top k - a share of the " +
  "file about the topic - and never the file's length or the repository's count; report it as " +
  "'lines ranked in the top 300 for <topic>', and expect files outside the top k, including " +
  "large ones, to be missing from it. A question with no topic in it - a file's length, the " +
  `largest files, a count over the whole repository - comes from ${TABLE} with no search ` +
  `function: SELECT path, MAX(end_line) AS lines FROM ${TABLE} WHERE lang IN ('rs','ts','py') ` +
  "GROUP BY path ORDER BY lines DESC. Name the languages you mean, as that example does, on " +
  "any question about code: an unfiltered ranking over a real repository comes back topped by " +
  "generated data - benchmark result JSON, fixtures, vendored blobs - which genuinely are the " +
  "longest files and are never the answer. `lang` is the file extension, so the filter is the " +
  "cheapest way to say 'code, not data', and it works the same inside a ranked search's " +
  "aggregate. A path prefix is not a topic: filtering on WHERE path LIKE 'src/thing/%' and " +
  "measuring lengths answers how big those files are, not which code is about the thing, and " +
  "it guesses the answer from a directory name instead of retrieving it. " +
  // Reading is sql's too, and it has to be said with the statements written
  // out: on the demo's 64-project corpus (2026-09-24) the model ranked the
  // longest test logs with sql and then read them with the shell - wc, grep,
  // awk, cut | sort | uniq -c - because nothing here said how a file or a
  // log is read and shaped in sql. The owner: "we should be more explicit
  // maybe with better examples." Each statement below was run on the
  // platform before it was written here.
  "sql is also how you READ here, and never the shell, Grep or Read - with the search functions doing " +
  `the finding: the lines of a file, SELECT start_line, content FROM ${TABLE} WHERE path = 'src/x.rs' ORDER BY ` +
  "start_line (a stretch: AND start_line BETWEEN 380 AND 440); every place a phrase occurs, complete and " +
  `unranked, token_match('${TABLE}', 'content', 'the terms', 'and') - how often, SELECT count(*) FROM ` +
  `token_match('${TABLE}', 'content', 'the terms', 'and') WHERE path LIKE 'x/%'; the lines about something, ` +
  "ranked, bm25_search or hybrid_search as above; what a long file or log is made of, the shell's " +
  "cut | sort | uniq -c, SELECT substr(line, 1, 50) AS head, count(*) AS n FROM (SELECT " +
  `unnest(string_to_array(content, chr(10))) AS line FROM ${TABLE} WHERE path = '...') GROUP BY head ORDER BY n ` +
  "DESC LIMIT 20; the kinds of error in a log, the same unnest over " +
  `bm25_search('${TABLE}', 'content', 'Error Exception', 200) WHERE path = '...', then regexp_replace(line, ` +
  "'^.*?([A-Za-z.]+(Error|Exception)).*$', '\\1') AS kind, count(*) ... GROUP BY kind - the search function " +
  "finds the windows, string functions only shape their lines, and a LIKE or regexp_like scan over the whole " +
  "table is the one form to avoid. Rows are windows that overlap by a few lines, so a per-line count runs a " +
  "little high and the ranking is right; log lines may carry colour codes, so match inside an unnested line " +
  "(LIKE '%FAILED%'), never at its start. " +
  "Select start_line beside content whenever you mean to read or cite the code: a row's text " +
  "comes back with each line's own number in the file when the row carries its start line, and " +
  "unnumbered when it does not, since nothing then places the text. " +
  "The result includes a 'usage' field, a one-line receipt of tokens returned and rows.";

// --- the tool text for a hosted table of another shape ---------------------------
//
// With CX_REMOTE_SEARCH the hosted table is the index, and when CX_TABLE
// names a table that is not the chunks table (a hydrated data set - job
// postings, tickets) the doors run over its rows, driven by its TableShape.
// The text below describes them for that table: the same doors said for
// rows, with the table's own column names where the chunks text has its
// constants. None of it has been through the bench. What it keeps are the
// chunks descriptions' measured clauses, transposed: hybrid named before
// bm25, the placeholder marked as the caller's to fill, a total over a
// search relation reported as ranked and never as the table's count, the
// scan discouraged by every predicate that reaches for it. Measure before
// polishing, as with the text above.

/** The columns of a shape as `name type` pairs. */
function columnList(shape: TableShape): string {
  return shape.columns.map((c) => `${c.name} ${c.type}`).join(", ");
}

/** A scalar column to write the examples with - not the key, so a filter or
 * GROUP BY on it reads as one would on any table; the key when the table
 * has nothing else. */
function exampleScalar(shape: TableShape): string {
  return shape.scalarColumns.find((name) => name !== shape.keyColumn) ?? shape.keyColumn;
}

/** Two sentences every model that reads these instructions is told, word for
 * word the ones the hosted retrieval loop's own answer writer is told, so the
 * outer model and the loop cite under one instruction and reach for tools the
 * same way. They ride in the server's instructions, which Claude Code adds to
 * its own system prompt beside the user's; nothing of the user's prompt is
 * replaced. The first is what a citation is: a place copied from a tool
 * result, never remembered. The second is what a sweep is: one call to a
 * tool built for it, not a walk through files by hand. */
export const CITE_EXACTLY =
  "Cite the places your tool results gave you exactly as they gave them - the path and line numbers " +
  "copied, never recalled or adjusted.";
export const SWEEP_TO_A_TOOL =
  "Be efficient: prefer few, well-chosen tool calls, and hand a sweep across many files to a tool " +
  "built for it rather than searching by hand.";

/** The fan-out as a preference, not a permission. "Spawn several in
 * parallel for independent questions" said the parallel call was allowed;
 * the outer model kept asking one broad question and waiting, or walking
 * the files itself between asks. Several asks in one reply are the cheaper
 * shape on every axis - the wait is the slowest of them, not the sum, and
 * every ask replaces a turn of the outer model's own searching, which
 * re-sends the whole transcript. One sentence, shared by the instructions
 * and the ask tool's own text on both table shapes. */
export const PREFER_SEVERAL_ASKS =
  "Prefer several asks in one reply, one per part of the question, over one broad ask or a chain of " +
  "your own searches.";

/** The order among the tools a model holds beside this server's: the index
 * first. Claude Code's own prompt prefers dedicated file and search tools
 * over shell commands, and Grep and Glob are as dedicated as ours, so
 * nothing the model read ranked them - a code question still went to Bash
 * again and again beside its asks. One sentence sets the order and names
 * the tools this server actually registers; Read keeps its place, the tool
 * for a hit marked truncated. A rows table has no files behind it and does
 * not carry the sentence. */
/** How a definition is found with an exact-text tool: by the bare name with
 * `defines`, never by a signature the model has composed. Told in find's
 * description, and again in the result when a find for a phrase or a
 * signature comes back empty (`findHint`) - the moment the model would
 * otherwise reach for a regex grep. */
export const FIND_BY_BARE_NAME =
  "Find a definition by its bare name with defines - `refresh(` lists every refresh declared - never by " +
  "a signature you have composed: find matches characters, so a guessed line matches nothing.";

/** The hint on an empty find, or null when the result needs none: a query
 * with spaces is a phrase or a signature, which one exact line may never
 * hold; with `defines` on and nothing found, the name itself is in doubt.
 * A bare identifier that is simply absent gets no hint - zero is the answer. */
export function findHint(query: string, total: number, defines: boolean): string | null {
  if (total > 0) return null;
  const words = query.trim().split(/\s+/);
  if (words.length > 1) {
    const name = /[A-Za-z_][A-Za-z0-9_]*\s*\(/.exec(query)?.[0].replace(/\s+/g, "") ?? null;
    return (
      "No line holds this exact text. " +
      (name
        ? `For the declaration, find the bare name with defines: query "${name}", defines: true. `
        : "For a definition, find the bare name with defines. ") +
      "For words that may not sit on one line, use search."
    );
  }
  if (defines) return `Nothing declares "${query}". Check the name: find it without defines to see where it is used, or search for what it does.`;
  return null;
}

/** Where an `answer` call's text is kept, under the index directory. */
const ANSWERS_DIR = "answers";
/** Heads the model's narration in the writer's context, when the installed
 * hook supplied it. */
const NARRATION_HEADING = "What the model said while it gathered the rows:";

/** The routing line for `answer`, by how the answer reaches the person. */
export function answerInstruction(display: AnswerDisplay): string {
  const tail =
    display === "hook"
      ? "it writes the answer from the rows and shows it to the user itself; then reply with one short sentence and nothing else."
      : "it writes the answer from the rows; reply with its text exactly as returned, in full, and nothing else.";
  // Imperative, because a model that has the rows in front of it is tempted
  // to write: Haiku did on one question in three on the demo (2026-09-21),
  // where Sonnet and Opus called the tool every time.
  return (
    `- answer - REQUIRED after retrieving: never write the answer yourself. Once you have what the question needs, ` +
    `call answer with the question alone - the writer already has every row this server returned to you: ${tail}\n`
  );
}

/** The `answer` tool's description, by display mode and table shape. The
 * model is asked for the question and nothing else: the rows it was shown
 * are on this server's record, and what it said as it worked reaches the
 * writer through the installed hook (commands/hook-cmd.ts). A model asked to
 * restate what it found typed 4,000 characters of notes, 26 s of a 45 s run
 * (measured 2026-09-21), for the writer to read what the server already had.
 *
 * Nothing here, or in the tool's inputs, says how the hook works or names
 * the model's thinking: Opus 5's safeguards refused a whole session at its
 * first request, before any tool call, over an input described as "what you
 * said and thought while gathering" (`reasoning_extraction`, 2026-09-21).
 * The hook is the installer's business; the model is told what to do. */
export function answerDescription(display: AnswerDisplay, rows: boolean): string {
  const from = rows
    ? "the rows this server returned to you in this session"
    : "the rows this server returned to you in this session, read back from the index with their lines";
  const delivery =
    display === "hook"
      ? "The finished answer is shown to the user directly by this tool, and returned to you so you have it for what the user asks next. After it returns, reply with one short sentence such as 'The answer is shown above.' and nothing else - do not repeat, summarize or rewrite the answer."
      : "It returns the finished answer. Reply with that text exactly as returned, in full, and nothing else - do not summarize or rewrite it.";
  return (
    `Write the final answer to the question, by the platform's own writer, from ${from} - every ask, search, find and sql - with checked citations. ` +
    "This is how a question is answered here: never write the answer yourself. Once you have what the question needs, " +
    `call this tool with the question. Do not restate what you found: the writer has the rows. ${delivery}`
  );
}

/** What `sql` says about itself when the card and the verdict are tools
 * rather than parts of it (CX_API_TOOLS). */
const API_TOOLS_SQL_NOTE =
  " The result is the rows alone: read the table's measured shape with table_card before your first " +
  "statement, and check a result against the question with validate.";

/** The routing lines for the platform's routes offered as tools: the card,
 * the retrieval check, and - over a code table - the citation pass. */
export function apiToolsInstruction(rows: boolean): string {
  return (
    "\n- table_card - what a model needs to know about the table before its first query: its columns with " +
    "their index roles, per-column statistics and sample rows, as the platform measured them. Call it once, first.\n" +
    "- validate - did this result answer this question? The same check the platform's own retrieval loop " +
    "gates itself on: pass the question, the statement that ran and the rows it returned; a refusal names " +
    "the question's terms the index does not hold (do not search for those again) and a statement to run instead.\n" +
    (rows
      ? ""
      : "- cite - check the citations of the answer you drafted against the index: each path:line is " +
        "repaired where the index says it belongs and each cited sentence is graded against its lines. " +
        "Run it on your draft before you reply, and reply with the answer it returns.\n")
  );
}

/** Whether an index is an index of logs: more of its chunks are log windows
 * than anything else. The chunker tags `.log`, `.out` and `.err` files
 * `log`. */
export function isLogIndex(manifest: { languages?: Record<string, number>; chunks?: number } | undefined): boolean {
  const logs = manifest?.languages?.log ?? 0;
  const total = manifest?.chunks ?? Object.values(manifest?.languages ?? {}).reduce((n, c) => n + c, 0);
  return logs > 0 && logs * 2 > total;
}

/** The instructions for an index of log files, in the words of the thing
 * indexed. The code instructions say "this repository" and "code", and on
 * the demo's CI-logs corpus (2026-09-23) Opus read a folder of `.log` files
 * as not that: three arms, three Bash-only runs, zero calls to find,
 * search, sql or ask, with "Look with the index first" in front of it. The
 * owner: "we need to somehow tell claude to use our tools even for logs";
 * and, on the order, "maybe it should try find or sql first and then try
 * ask etc for broader questions. but just going to bash is not what i
 * meant." So: the tools named for logs, find and sql first, ask for the
 * questions that span the logs, and the one thing not to do said plainly. */
export function logIndexInstructions(agentTools: boolean, files: number, chunks: number): string {
  return (
    `code-context is an index of the ${files} log files in this directory - every line of every log, in ` +
    `${chunks} windows. Which tool for which question:\n` +
    "- find - every line in every log containing an exact string (an error text, a test name, a step name), " +
    "with the count per log. Where you would grep, use this.\n" +
    "- search - which log windows are about X: exact terms and meaning in one ranked pass over every log.\n" +
    "- sql - counts and rankings across the logs in one statement: which logs mention X and how many lines " +
    "each (rank through bm25_search or hybrid_search over the chunks table and GROUP BY path).\n" +
    (agentTools
      ? "- ask - a question or task in plain language over all the logs; returns the log lines it retrieved " +
        "(facts with path:line and the text), not an answer: compose from them. Spawn several in parallel for " +
        "independent questions.\n"
      : "") +
    "Start with find or sql - a literal, a count, a ranking across the logs" +
    (agentTools ? " - and use ask for a question that spans the logs. " : ". ") +
    "Do not open, read or grep the log files with Bash, Grep or Read: the index holds every line of every log " +
    "and answers in one call, and a single log here can run to tens of thousands of lines. Read a file only " +
    "for a hit marked truncated.\n" +
    SWEEP_TO_A_TOOL +
    "\n" +
    "Hits carry the lines: when a hit answers the question, answer from it. A hit's content shows each line " +
    "with its own number in the file, so cite a place as path:line or path:start-end from those numbers and " +
    "only where the thing you name sits - never the hit's whole line range, which spans the window. " +
    CITE_EXACTLY +
    " A 'partial' marker means files over the index cap were left out, so a missing match is not proof of absence."
  );
}

/** What `sql` says about the sibling tables: each one's columns as the
 * platform describes them, its indexed text and vector columns, that a
 * statement across them is one call, and the deployment's own words on the
 * keys that join them. */
export function siblingsNote(table: string, siblings: TableShape[], unresolved: string[], notes: string): string {
  const described = siblings.map(
    (s) =>
      `${s.table}(${columnList(s)})` +
      (s.textColumns.length ? `, full-text indexed on ${s.textColumns.join(", ")}` : "") +
      (s.vectorColumn ? `, vector column ${s.vectorColumn}` : ""),
  );
  return (
    ` Also in this database, and joinable with ${table} in one statement: ${described.join("; ")}.` +
    (unresolved.length ? ` (${unresolved.join(", ")} could not be described when this server started; name them by their columns as you know them.)` : "") +
    ` Every statement here runs on the platform, so a JOIN, a subquery or a UNION across these tables is one call, ` +
    `and the search functions take any of them as their first argument and their rows join like a table's: ` +
    // The join is the move, written out: a model that had the keys and the
    // tables still answered one table at a time and read the rest from
    // files (the owner, 2026-09-24: "i don't think opus or the models are
    // using joins. that's the key advantage we have we have to be explicit").
    `write the JOIN - FROM hybrid_search('${siblings[0]?.table ?? table}', '<text column>', '<terms>', 'embedding', {{q}}, 50) AS s ` +
    `JOIN ${table} AS t ON <key> = <key> WHERE ... - and not one query per table.` +
    (notes ? ` ${notes}` : "")
  );
}

/** The routing line for a server with sibling tables. */
export function siblingsInstruction(table: string, siblings: string[]): string {
  return (
    `\n- sql also joins ${table} with ${siblings.join(", ")} in one statement - a question that touches two of ` +
    "these tables is one JOIN on their keys, with the search functions inside it, not one query per table and " +
    "not a walk through files; their columns, the keys and the statement's shape are in the sql tool's text.\n"
  );
}

export function indexFirst(agentTools: boolean, table = "chunks"): string {
  const tools = agentTools ? "find, search, sql and ask" : "find, search and sql";
  // "only for what the index could not give you" left the model the judge
  // of what the index gives, and it judged reading a file's lines as not
  // that: on the demo's 64-project corpus (2026-09-24) a run ranked the
  // longest test logs with one sql JOIN and then read the logs with ten
  // Bash calls, wc, grep, tail and sed, when their lines were one statement
  // away. So the statement is written out, and the file tools are named as
  // not the way to read (the owner: "instruction sentence only").
  return (
    `Look with the index first: ${tools} cover every file in one call and return the lines themselves, ` +
    `and the lines of any file or row are one sql statement away (SELECT start_line, content FROM ${table} ` +
    "WHERE path = '...' ORDER BY start_line), and ranked when you want the lines about something rather " +
    `than all of them - hybrid_search, bm25_search or vector_search inside the statement (SELECT path, ` +
    `start_line, content FROM hybrid_search('${table}', 'content', '<terms>', 'embedding', {{q}}, 50) ` +
    "WHERE ...). Do not open the checkout with Grep, Glob, Bash or Read for what they can answer."
  );
}

/** How a hit names a row and where the rest of the row is: the sentence the
 * instructions and the search text share. */
function citeRows(shape: TableShape): string {
  return (
    `Answer from the hits and cite a row by its ${shape.keyColumn}; the whole of a row is one sql away ` +
    `(SELECT * FROM ${shape.table} WHERE ${shape.keyColumn} = '...').`
  );
}

export function rowsInstructions(shape: TableShape, platformTools: boolean): string {
  const { table, keyColumn: key, primaryText: text } = shape;
  return (
    `code-context is an index of the ${table} table, one row per record. Which tool for which question:\n` +
    `- find - every row whose ${text} holds every word of an exact phrase, where you would grep: complete ` +
    "and unranked, with the table-wide count.\n" +
    `- search - which rows are about X: exact terms and meaning in one ranked pass over ${text}.\n` +
    // On a table every question reads as counts and rankings, so the code
    // text's sql line ("counts, rankings, filters") claimed all of them and
    // the caller never delegated (zero ask on the first day's jobs runs,
    // against a platform call every hour on the code corpora). The question
    // shapes a table gets - who has the most X and where, what the rows
    // about X ask for - are named on ask here, and sql is the tool for one
    // statement the caller already knows.
    "- sql - one statement you already know: a count, a filter, a lookup by " +
    `${key}, a ranking in one SELECT. Ranking rows by how much they are about a topic goes through ` +
    "hybrid_search, not bm25, when the topic is a concept; a total over a search relation counts the top " +
    `k, never the table - a complete count comes from token_match, a WHERE, or the ${table} table with no ` +
    "search function.\n" +
    (platformTools
      ? "- ask - a question or task in plain language about the rows - which rows are about X, how many and " +
        "where, who has the most and where - it runs the searches and statements itself and returns the rows " +
        "it retrieved (facts as rows, with their columns and the text cut to snippets), not an answer: compose " +
        `from them. ${PREFER_SEVERAL_ASKS}\n` +
        "  A question that spans the table - who is hiring for X and what those roles ask for, how two groups " +
        "of rows compare - is one ask per part: they run at the same time, and you compose from the rows " +
        "they return.\n"
      : "") +
    `${SWEEP_TO_A_TOOL}\n` +
    `Hits are rows: a score, the row's ${key}, its scalar columns, and its text columns cut to a snippet of ` +
    `${SNIPPET_CHARS} characters. ${citeRows(shape)} ` +
    "Every tool takes an optional 'path' (an absolute repo root) to target a repository instead, whose local " +
    "code index it then reads."
  );
}

export function rowsSearchDescription(shape: TableShape): string {
  const { table, keyColumn: key, primaryText: text, vectorColumn, vectorSource } = shape;
  const ranking = vectorColumn
    ? `fusing exact keyword matching over ${text} with semantic similarity over ${vectorColumn} (the platform's ` +
      `embedding of ${vectorSource.join(", ") || text}), so it works whether or not you know the words`
    : `ranked by exact keyword matching (BM25) over ${text} - the table has no embedding column, so use the ` +
      "words the rows use";
  return (
    `Ranked search over the rows of ${table}, ${ranking}. Use it for which rows are about X, rows like ` +
    `this one, the best matches for a description. Each hit is a row: score, ${key}, the scalar columns ` +
    `(${shape.scalarColumns.join(", ")}), and ${shape.textColumns.join(", ")} as snippets of at most ` +
    `${SNIPPET_CHARS} characters. ${citeRows(shape)} When one search is not enough, refine the query and ` +
    "search again. For every row holding an exact phrase use find; for counts, rankings and filters use " +
    "sql. The result includes a 'usage' field, a one-line receipt of tokens returned and rows."
  );
}

export function rowsFindDescription(shape: TableShape): string {
  const { table, keyColumn: key, primaryText: text } = shape;
  return (
    `Every row of ${table} whose ${text} holds every word of an exact string, like grep over a table: ` +
    "complete and unranked, with the table-wide total. Matching is by the index's words - case-insensitive, " +
    "whole words, punctuation ignored - so a match holds the words, not necessarily the phrase in that order; " +
    "the literal is not checked character by character as it is over a code index. Use it where you would " +
    `grep: a name, a product, a phrase that must appear. Each match is a row: ${key}, the scalar columns, and ` +
    "the text columns as snippets. ignoreCase, defines and under describe a code index and do nothing here. " +
    "For meaning or 'which rows are about X' use search; for counts and rankings use sql. The result includes " +
    "a 'usage' field, a one-line receipt of tokens returned and rows."
  );
}

/** The `sql` description for a hosted table of another shape: the table's
 * columns with their types, which are indexed for text (said to be inferred
 * from the schema when no card named them - the type then stands in for the
 * role, and can name a column the platform embeds but does not index) and
 * which the platform embeds, and the search functions with the table's real
 * names - hybrid_search(table, text, terms, vector, {{q:"..."}}, k),
 * bm25_search, vector_search, token_match - each of which returns _id, the
 * table's scalar columns and score. */
export function rowsSqlDescription(shape: TableShape): string {
  const { table, keyColumn: key, primaryText: text, vectorColumn, vectorSource } = shape;
  const scalar = exampleScalar(shape);
  // A card that names no full-text column is a table with no full-text
  // index (the optimizer probed every text column), so the search functions
  // are left out of the text rather than shown with an empty column name.
  const textColumns = shape.textColumns.join(", ") || "none";
  const ranked = vectorColumn
    ? `hybrid_search('${table}','${text}','terms','${vectorColumn}', {{q:"..."}}, 300)`
    : `bm25_search('${table}','${text}','terms', 300)`;
  const searchGuide = text
    ? "The search functions are table-valued: a ranked search is a relation, so WHERE, GROUP BY, ORDER BY and " +
    "joins compose with it in one pass, and one query replaces the several round trips of searching, then " +
    "filtering, then counting. Rank through a search relation rather than scanning the whole table - with " +
    `ILIKE, LIKE, regexp_like, or a bare filter on ${scalar}: a scan has no relevance ranking, reads every ` +
    "row, and answers 'contains this substring' when the question asked which rows are about something. " +
    (vectorColumn
      ? `Rank with hybrid_search('${table}','${text}','terms','${vectorColumn}', {{q:"..."}}, k) - 'terms' and ` +
        'the text inside {{q:"..."}} are yours to fill in, not literals to copy - unless you have a reason not ' +
        "to: it fuses exact terms with meaning, so it reaches the rows whether or not the question's words are " +
        "the rows' words, and they rarely are. That covers a concept, a subject, 'rows about X' - the shape of " +
        "almost every ranking question. "
      : "") +
    `bm25_search('${table}','${text}','terms', k) is keyword only: reach for it when the topic is a literal ` +
    `phrase you know appears in ${text} and you want counts a reader can check as occurrences. ` +
    (vectorColumn ? `vector_search('${table}','${vectorColumn}', {{q:"..."}}, k) is meaning alone. ` : "") +
    `token_match('${table}','${text}','terms','and') is unranked and complete: every row holding every term, ` +
    "with no k, so a COUNT over it is the table's count and not a share of the top k. " +
    // One sentence, no more: on 2026-09-11 a caller wrote ILIKE '%...%' over
    // the jobs table's 6.7 GB description column three times at 38-45 s each,
    // where token_match on the same words runs in under a second. A longer
    // version of this warning made the caller write many small statements
    // instead; the text around it is otherwise the measured wording.
    `Match words on ${textColumns} with these functions, never with LIKE '%word%', which scans the stored text ` +
    "(38-45 s per query on this table's description column against under a second through token_match). " +
    (vectorColumn
      ? 'The {{q:"..."}} placeholder is embedded on the platform with the table\'s own model, so it costs you ' +
        "nothing but the text (a bare {{q}} with the embed map is folded into it). "
      : "") +
    "Every search function returns _id, the table's scalar columns and score, so select and filter them " +
    `directly: SELECT ${key}, ${scalar}, score FROM ${ranked} WHERE ${scalar} = '...' ORDER BY score DESC ` +
    `LIMIT 20. Which ${scalar} values have the most rows about a topic, ranked - the whole question in one ` +
    `statement, with your own words in place of the example's: SELECT ${scalar}, COUNT(*) AS ranked_rows FROM ` +
    `${ranked} GROUP BY ${scalar} ORDER BY ranked_rows DESC LIMIT 15. What such a total means: a search ` +
    "relation holds only the top k rows of that query, so a COUNT over it is the rows that ranked within the " +
    "top k - a share of the table about the topic - and never the table's count; report it as 'rows ranked " +
    "in the top 300 for <topic>', and expect values outside the top k, including common ones, to be missing " +
    "from it. A question with no topic in it - how many rows, the largest values, a count over the whole " +
    `table - comes from ${table} with no search function: SELECT ${scalar}, COUNT(*) AS rows FROM ${table} ` +
    `GROUP BY ${scalar} ORDER BY rows DESC LIMIT 15. `
    : "No column here is full-text indexed, so the search functions do not apply to this table: answer from " +
      `plain SQL over the columns above - SELECT ${scalar}, COUNT(*) AS rows FROM ${table} GROUP BY ${scalar} ` +
      "ORDER BY rows DESC LIMIT 15. ";
  const textGuide = text
    ? `${textColumns} hold long text${/html/i.test(textColumns) ? " (HTML where the name says so)" : ""}: select ` +
      `substr(${text}, 1, 300) rather than the column unless you mean to quote it, and select ${key} beside it ` +
      "so a row can be cited. "
    : "";
  return (
    `Read-only SQL, one SELECT or WITH, over ${table}(${columnList(shape)}) - for counts, rankings, filters ` +
    `and GROUP BY across the whole table. Full-text indexed: ${textColumns}` +
    (shape.textColumnsInferred
      ? " (inferred from the schema - the table has no card naming its indexes yet, so its long-text columns " +
        "are taken as the indexed ones; one the platform only embeds may be among them)"
      : "") +
    ". " +
    (vectorColumn
      ? `Vector column: ${vectorColumn}, the platform's embedding of ${vectorSource.join(", ") || text}. `
      : "No vector column: rank by terms alone. ") +
    searchGuide +
    (shape.listColumns.length > 0
      ? `A list column (${shape.listColumns.join(", ")}) holds several values per row: filter it with ` +
        `array_has(${shape.listColumns[0]}, '...') or unnest it, not with equality. `
      : "") +
    textGuide +
    "The result includes a 'usage' field, a one-line receipt of tokens returned and rows."
  );
}

export function rowsAskDescription(shape: TableShape, devContextNote: string): string {
  const { table, keyColumn: key } = shape;
  return (
    `Ask the ${table} table's index a question or task in plain language: a read-only retrieval subagent ` +
    "chooses and runs the searches and statements itself over the whole table and returns the rows it " +
    "found, never hits - " +
    `each the row's ${key}, its scalar and list columns, and its text columns cut to a snippet of ` +
    `${SNIPPET_CHARS} characters - plus aggregate rows (counts, rankings) and the SQL whose rows answer the ` +
    "question - never a summary. Use it for which rows are about X, how many and where, what the rows about X have in common. " +
    `${PREFER_SEVERAL_ASKS} For every row holding ` +
    `an exact phrase use find; for a row you already know, sql by its ${key}. Answer from the rows and cite ` +
    `them by ${key}. ` +
    devContextNote +
    "The result includes a 'usage' field, a one-line receipt of what the call cost."
  );
}

/** What the default root's doors run against, decided once at startup and
 * never re-asked on a call.
 *
 * - `chunks`: the chunks table this client builds. Every path and constant
 *   as before: find and plain sql on the local index, search on the hosted
 *   index under CX_REMOTE_SEARCH, and a sql statement that embeds a query
 *   on the platform whenever there is one (see the sql tool). The mode of
 *   the default table always, without a probe - it is the table this client
 *   builds, so there is nothing to ask - and the mode without
 *   CX_REMOTE_SEARCH.
 * - `rows`: a hosted table of another shape, whose rows the doors run over
 *   with its own columns; nothing touches the local index.
 * - `unresolved`: CX_TABLE names a table that is not the default and the
 *   platform could not describe it at startup. The rows tools are registered
 *   - the chunks text would name columns the table does not have - and every
 *   call reports the cause, because the alternative, the local path, BUILDS
 *   an index and the build drops and recreates the platform table.
 *
 * One decision for the process rather than a lookup per call: a call that
 * asked the platform first made every local tool wait out a platform outage
 * (the cold-start budget is two minutes), and a startup probe that could miss
 * left the chunks text registered over calls that ran rows. */
export type TableMode = { kind: "chunks" } | { kind: "rows"; shape: TableShape } | { kind: "unresolved"; cause: string };

/** The tool text when the table could not be described (TableMode
 * `unresolved`): the doors are registered for its rows, say what the table
 * is, and say that every call reports the cause - so a model reading the
 * text is not sent to write chunks-shaped SQL against it. */
export function unresolvedInstructions(table: string, cause: string, platformTools: boolean): string {
  return (
    `code-context is an index of the ${table} table on the platform, one row per record. The table could not be ` +
    `described from the platform when this server started (${cause}), so ` +
    (platformTools ? "find, search, sql and ask" : "find, search and sql") +
    " each return that error until the server is restarted with the platform reachable; nothing runs against a " +
    "local index in its place. Every tool takes an optional 'path' (an absolute repo root) to target a repository " +
    "instead, whose local code index it then reads."
  );
}

export function unresolvedDescription(door: string, table: string): string {
  return (
    `${door} over the rows of the ${table} table on the platform. The table could not be described from the ` +
    "platform when this server started, so every call returns that error (with the cause) until the server is " +
    "restarted with the platform reachable; nothing runs against a local index in its place."
  );
}

/** What a test injects: a transport in place of stdio, and the platform
 * client's options (a scripted fetch) for every client the server builds. */
export interface ServeOptions {
  transport?: Transport;
  hostedOptions?: HostedOptions;
}

export async function serveMcp(rootPath?: string, serveOptions: ServeOptions = {}): Promise<void> {
  const { hostedOptions } = serveOptions;
  const defaultRoot = resolveRoot(rootPath);

  // The platform database (--db <url>), when one is configured: the default
  // root's chunks table also lives there, written by every build and sync
  // beside the local index and read by the `ask` tool.
  // Resolved once here - a bad URL or a missing key fails the server at
  // startup, not on the first tool call. The key stays inside the target;
  // only `hostedLabel` ever reaches a log line.
  const hosted = hostedTarget();

  // The local model: query embedding for search/sql and the sync's small
  // batches. Null under CX_NO_EMBED.
  let embedder: Embedder | null = null;
  const getEmbedder = (): Embedder | null => (process.env.CX_NO_EMBED ? null : (embedder ??= createEmbedder()));

  // CX_REMOTE_SEARCH=1 makes `search` read the HOSTED index instead of the
  // local one, when a platform database is configured. Off by default, and
  // deliberately a switch rather than the new behaviour: every measurement
  // taken so far read the local index under this tool's name, and silently
  // changing what it reads would reinterpret all of them. (A `sql` statement
  // that embeds a query goes to the platform with or without the switch -
  // see the sql tool; a plain one is local either way.)
  //
  // It exists because the hosted index could not be read without the
  // platform's answering loop. `ask` was the only remote retrieval, and it
  // runs that loop, so the two things a caller might want separately - the
  // index and the decider - could only be taken together.
  // With this on, a cheap local agent can hold the hosted index directly,
  // which is the configuration to beat before the loop is worth its cost.
  const remoteSearch = ["1", "true", "yes"].includes((process.env.CX_REMOTE_SEARCH ?? "").toLowerCase());

  // --- per-repo state ---------------------------------------------------------
  // One server serves every repo a session touches: the optional `path` tool
  // arg targets one, defaulting to the startup root. Each repo keeps its own
  // connection, auto-sync clock, and mutation lock, held in a small LRU so a
  // session that roams across many repos doesn't accumulate connections. Only
  // the default root's context carries the platform client (see RepoRegistry).
  const registry = new RepoRegistry(defaultRoot, {
    connect,
    ...(hosted ? { hosted: { target: hosted, ...(hostedOptions ? { options: hostedOptions } : {}) } } : {}),
  });
  const repoFor = (requested?: string): RepoCtx => registry.get(requested);

  // The manifest is re-read per call so staged vector readiness is noticed
  // the moment it lands.
  const getHandle = (ctx: RepoCtx): IndexHandle | null => {
    if (!existsSync(ctx.dir)) return null;
    const manifest = readManifest(ctx.dir);
    if (!manifest) return null;
    return { root: ctx.root, dir: ctx.dir, target: ctx.target, db: ctx.db, manifest };
  };

  /** The indexer options a build or sync of `ctx` shares: the local index
   * always, and the platform table when the context carries the client - the
   * two are written together, so no path here ever writes one without the
   * other. CX_NO_EMBED means keyword-only in both places, as --no-embed does
   * on the CLI: with no local embedder, the `local` provider gives the
   * platform table no embedding column either. The analyzer is passed only
   * when a flag named one; otherwise a build keeps the table's own. */
  const noEmbed = Boolean(process.env.CX_NO_EMBED);
  const analyzer = hostedAnalyzer();
  const indexTargets = (ctx: RepoCtx): Pick<IndexOptions, "root" | "db" | "hosted" | "indexDirPath" | "embedProvider" | "analyzer" | "caps"> => ({
    root: ctx.root,
    db: localDb(ctx),
    indexDirPath: ctx.dir,
    caps: DEFAULT_CAPS,
    ...(ctx.hosted
      ? { hosted: ctx.hosted, embedProvider: noEmbed ? "local" : embedProvider(), ...(analyzer !== undefined ? { analyzer } : {}) }
      : {}),
  });

  // --- freshness: one index mutation at a time per repo, auto-sync on queries -
  // Queries are not queued behind syncs; they run against the current index and
  // the next query sees the fresh one. CX_AUTO_SYNC=0 disables; the debounce
  // keeps the stat walk off the hot path (~20ms to ~2s depending on repo size).
  // A sync writes the platform table too, so the two never drift.
  const autoSyncEnabled = autoSyncSetting();
  const syncIntervalMs = Number(process.env.CX_SYNC_INTERVAL_SECS ?? 30) * 1000;
  // A search/sql on a never-indexed repo builds the index inline, then answers
  // on the same call (staged: keyword search live in seconds). Off restores the
  // strict "index it first" error.
  const autoIndexEnabled = autoIndexSetting();

  // A terse, local, factual receipt appended to each query result (tokens
  // returned, files touched, whole-file size it stood in for, session running
  // total). Default on - the trust signal only works when it's there; silence
  // it with CX_NO_RECEIPT. One accumulator per session (this long-lived process).
  const receiptOn = receiptEnabled();
  const session = newSession();
  // What this server returned to the model, per repository, for the `answer`
  // tool to hand the platform's writer as the rows to write from
  // (core/retrieval-record.ts). Cleared once an answer is written from it,
  // so the next question starts its own.
  const records = new Map<string, RetrievalRecord>();
  const recordOf = (ctx: RepoCtx): RetrievalRecord => {
    let record = records.get(ctx.root);
    if (!record) {
      record = new RetrievalRecord();
      records.set(ctx.root, record);
    }
    return record;
  };
  // Said in the ask tool text only when it is true: with the dev
  // context off (the default) the loop's model sees the question alone, and
  // telling the caller otherwise would have it leave out what the loop needs.
  const DEV_CONTEXT_NOTE = devContextEnabled()
    ? "The subagent is handed this repository's own instructions (CLAUDE.md, AGENTS.md, skills) with " +
      "the question, so it knows the layout you know; do not restate them. "
    : "";

  /** Run an index mutation on a repo exclusively; null if one is in flight. */
  const exclusive = <T,>(ctx: RepoCtx, fn: () => Promise<T>): Promise<T> | null => {
    if (ctx.mutation) return null;
    const p = fn().finally(() => {
      ctx.mutation = null;
    });
    ctx.mutation = p.catch(() => undefined); // guard must not reject
    return p;
  };

  /** Fresh build-scoped embedder: full builds embed in a child process so the
   * bulk pipeline's memory leaves with it (issue #9). Query and sync
   * embedding keep the warm in-process singleton via getEmbedder(). */
  const buildEmbedder = (): Embedder | null => (noEmbed ? null : createIndexingEmbedder());

  /** Let the build finish in-process - vectors backfill (the manifest flips
   * to "ready"), then the platform table loads when one is configured - and
   * release the build's embedder. The rest of the build is held on
   * `ctx.completion` so no sync starts under it and the platform tools can say
   * the table is being loaded. `completion` never rejects by contract, but
   * nothing on this chain may take that on faith - an unhandled rejection
   * here would kill the whole server. A failed platform load is logged: the
   * next sync asks for a build, which retries it. */
  const backfill = (ctx: RepoCtx, run: StagedIndexRun, emb: Embedder | null) => {
    const held = run.completion
      .then((stats) => {
        if (stats.hostedError) console.error(`platform load failed for ${ctx.root}: ${stats.hostedError} (the next sync reloads it)`);
      })
      .catch(() => undefined)
      .finally(() => {
        if (ctx.completion === held) ctx.completion = null;
        void emb?.dispose?.()?.catch(() => undefined);
      });
    ctx.completion = held;
  };

  /** Acquire the repo's mutation lock and run a staged build; resolves at
   * keyword-live with stage-1 stats, or null if a build is already in flight.
   * The build's completion (vectors, then the platform table when one is
   * configured) runs on in the background, held on `ctx.completion`. */
  const buildIndex = (ctx: RepoCtx): Promise<IndexStats> | null =>
    exclusive(ctx, async () => {
      const emb = buildEmbedder();
      const run = await indexRepoStaged({ ...indexTargets(ctx), embedder: emb });
      backfill(ctx, run, emb);
      return run.text;
    });

  const doSync = async (ctx: RepoCtx): Promise<SyncOutcome> => {
    const outcome = await syncRepo({ ...indexTargets(ctx), embedder: getEmbedder() });
    // A rebuild for every reason but "a build is already in flight" (the
    // vector stage, or the platform load - a second build would race it).
    if (outcome.action === "rebuild-required" && !syncInProgress(outcome)) {
      const emb = buildEmbedder();
      const run = await indexRepoStaged({ ...indexTargets(ctx), embedder: emb });
      backfill(ctx, run, emb);
    }
    return outcome;
  };

  /** Whether this process may write the platform table a build or sync of
   * `ctx` would write: the context carries no platform client (a repo named
   * by `path` writes its local index alone), or the table is the default one
   * this client builds. A CX_TABLE override names a table something else
   * loaded - a hydrated corpus - and a build DROPS and recreates it, a sync
   * appends this repository's chunks to it; neither may happen because a
   * query found no index or a stale one. Ownership, not the table's columns:
   * a hydrated table that happens to carry path and start_line is no more
   * this process's than one that does not. `cx index` is the explicit path
   * and is not gated here. */
  const ownsTable = (ctx: RepoCtx): boolean => !ctx.hosted || TABLE === DEFAULT_TABLE;

  const maybeAutoSync = (ctx: RepoCtx) => {
    // Never under a build's completion: a diff or a second build would race
    // the vector stage or the platform load. The clock is not advanced, so
    // the first query after the build lands syncs. And never against a
    // table this process does not own (ownsTable).
    if (!autoSyncEnabled || !ownsTable(ctx) || ctx.completion || performance.now() - ctx.lastSyncCheck < syncIntervalMs) return;
    ctx.lastSyncCheck = performance.now();
    // Deferred so the triggering query's engine call runs first; the sync's
    // stat walk still shares the process, so on very large repos a
    // concurrent query can feel it. Queries are never queued behind syncs.
    setImmediate(() => {
      const p = exclusive(ctx, () => doSync(ctx));
      p?.catch((err) => console.error(`auto-sync failed: ${(err as Error).message}`));
    });
  };

  /** The client the verdict is asked through: the same database, a few
   * seconds' budget, and NO cold-start retries (`coldStartSecs: 0`). The
   * repo's own client (`ctx.hosted`) is tuned for calls whose answer IS the
   * result and therefore worth waiting a cold start out for; the verdict is
   * not one of those, and sharing that client made a platform outage into
   * a minute-long stall on a local query (see VERDICT_TIMEOUT_MS). */
  const verdictDb = hosted ? hostedDbFor(hosted, { ...hostedOptions, coldStartSecs: 0, timeoutMs: VERDICT_TIMEOUT_MS }) : null;

  /** The platform's verdict on a `sql` result, or undefined when there is no
   * platform to ask or it could not answer within VERDICT_TIMEOUT_MS.
   *
   * The platform's answering loop gates every query it runs on this check;
   * a caller driving retrieval itself has the same problem and could not
   * ask. It is attached to the result rather than offered as a tool because
   * a check the model may call is a check the model declines - measured on
   * the card tool the same day (2026-09-11). `statement` is the statement the
   * caller wrote, read only to tell an aggregate from rows; `question` is the
   * caller's question, not the query: the query's own words count for
   * nothing, which is the defect the check exists to catch. Without a
   * question the empty and aggregate halves still apply.
   *
   * `sql` alone calls this; see VALIDATION_NOTE for the measurement that took
   * it off `search` and `find`.
   *
   * Best-effort throughout: the rows are the answer and a check that failed
   * must not take them with it. A caller without a platform database (the
   * local-only server) gets no verdict at all rather than a second
   * implementation of the rules here, which would drift from the loop's.
   *
   * `column` is the text column the refusal is diagnosed against - the
   * chunks table's content unless the statement ran over a hosted table of
   * another shape, whose own text column it then is. */
  const platformVerdict = async (
    ctx: RepoCtx,
    statement: string,
    rows: readonly object[],
    question?: string,
    column: string = CONTENT_COLUMN,
  ): Promise<{ verdict?: Record<string, unknown>; telemetry?: { rttMs: number; readTokens?: number } }> => {
    // Under the API tools the verdict is the model's to ask for (`validate`),
    // not attached to every statement.
    if (!ctx.hosted || !verdictDb || apiTools) return {};
    try {
      const verdict = await verdictDb.validate({
        table: TABLE,
        column,
        statement,
        rows,
        ...(question ? { question } : {}),
      });
      // The validate call is a metered platform read (a floor Read Token),
      // so its cost belongs in the ledger like a search's - otherwise the
      // gateway bills it and the demo's "our charge" never shows it. Captured
      // here, right after the await, so a concurrent verdict cannot overwrite
      // `lastCall` before the caller reads it. It goes through its own client,
      // which is why `withPlatform(entry, ctx)` (reading ctx.hosted) would
      // miss it.
      const info = verdictDb.lastCall();
      const telemetry = info
        ? { rttMs: info.rttMs, ...(info.readTokens !== undefined ? { readTokens: info.readTokens } : {}) }
        : undefined;
      // `anchors` and `rows` are the check's own working, not news to the
      // caller, and on a valid result the whole verdict is one word; the
      // reason is the part worth prompt space - with the terms the corpus
      // does not hold and the rewrite to run, when the platform found them.
      // A ranked aggregate's verdict also carries the facts about its
      // groups (each file's whole length, its lines holding each search
      // term) and the note saying what they measure; the caller folds the
      // facts into the rows (foldValidationFacts) and shows the note.
      const facts = {
        ...(typeof verdict.group_column === "string" && Array.isArray(verdict.groups) && verdict.groups.length > 0
          ? { group_column: verdict.group_column, groups: verdict.groups }
          : {}),
        // The note travels on its own: a ranking whose groups the table does
        // not name still has totals that read as sizes.
        ...(typeof verdict.note === "string" ? { note: verdict.note } : {}),
      };
      if (verdict.valid === true) return { verdict: { valid: true, check: verdict.check, ...facts }, telemetry };
      const absent = Array.isArray(verdict.absent) && verdict.absent.length > 0 ? { absent: verdict.absent } : {};
      const suggestion = typeof verdict.suggestion === "string" ? { suggestion: verdict.suggestion } : {};
      return {
        verdict: { valid: false, check: verdict.check, reason: verdict.reason, ...absent, ...suggestion },
        telemetry,
      };
    } catch (err) {
      console.error(`validation unavailable: ${(err as Error).message}`);
      return {};
    }
  };

  const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: jsonify(value, true) }] });
  const fail = (message: string) => ({
    content: [{ type: "text" as const, text: message }],
    isError: true,
  });
  const noIndex = (ctx: RepoCtx) =>
    fail(`no index for ${ctx.root} yet - run \`cx index\` there once (keyword search is live in seconds).`);

  /** The refusal when a query would build the index but the process does
   * not own the platform table a build writes (ownsTable): CX_AUTO_INDEX is
   * not consulted, because no setting makes dropping another loader's table
   * the right answer to "no index yet". */
  const foreignTable = (ctx: RepoCtx) =>
    fail(
      `no index for ${ctx.root} yet, and this server will not build one: CX_TABLE=${TABLE} names a table this ` +
        `process does not own at ${platformLabel(ctx.hosted!)} (a build drops and recreates it) - build it with ` +
        "`cx index` explicitly if that is what you mean",
    );

  /** The local index a door runs over: the one there is, or the one this
   * call builds when auto-index is on and the process owns the table its
   * build would write. Every local door goes through here, so the ownership
   * rule cannot be missed by one of them. */
  const localIndex = async (ctx: RepoCtx): Promise<{ handle: IndexHandle; autoIndexed?: IndexStats } | { failed: ReturnType<typeof fail> }> => {
    let ensured: EnsureResult;
    try {
      ensured = await ensureIndexed(ctx, { autoIndexEnabled: autoIndexEnabled && ownsTable(ctx), getHandle, build: buildIndex });
    } catch (err) {
      return { failed: fail(`indexing failed: ${(err as Error).message}`) };
    }
    if ("needsIndex" in ensured) return { failed: ownsTable(ctx) ? noIndex(ctx) : foreignTable(ctx) };
    return ensured;
  };

  /** Marker attached to a query result when this call built the index. */
  const autoIndexNote = (stats: IndexStats) => ({
    files: stats.files,
    chunks: stats.chunks,
    note:
      "no index existed - built one on this call; keyword search is live now" +
      (stats.vectors === "building" ? " and vectors are backfilling in the background" : ""),
  });

  /** The platform tools' first precondition, checked before any build: the
   * context carries the platform client. A repo other than the default root
   * never does - the database holds one chunks table - and building its local
   * index for a tool that will not serve it would be waste. Null when it does. */
  const noPlatform = (tool: string, ctx: RepoCtx): ReturnType<typeof fail> | null =>
    ctx.hosted
      ? null
      : fail(`${tool} works on the repository the server was started for, whose index is also on the platform database; ${ctx.root} is served by find, search and sql only`);

  /** The platform tools' second precondition, after the index exists: the
   * platform's chunks table does too. A table not there yet is either being
   * loaded by the build in flight (its completion, or a sync's rebuild) or was
   * never loaded. Null when ready. */
  const platformNotReady = async (tool: string, ctx: RepoCtx): Promise<ReturnType<typeof fail> | null> => {
    const missing = noPlatform(tool, ctx);
    if (missing) return missing;
    // This probe is a network call, so it fails the same ways the tool itself
    // does - a refused key and an empty balance among them. It runs before the
    // tool's own try/catch, so without this one an authentication or billing
    // refusal escaped as a raw thrown HostedError and the model saw a stack
    // trace instead of what to do about it.
    let ready: boolean;
    try {
      ready = await platformTableReady(ctx.hosted!, (ctx.hostedMemo ??= newHostedMemo()));
    } catch (err) {
      return fail(`${tool} failed: ${(err as Error).message}${refusalHint(err)}`);
    }
    if (ready) return null;
    const label = platformLabel(ctx.hosted!);
    return fail(
      ctx.mutation || ctx.completion
        ? `the ${TABLE} table at ${label} is being loaded by the index build in progress - retry when it finishes`
        : `no ${TABLE} table at ${label} yet - run \`cx index --db ${label}\` to load it`,
    );
  };

  // The platform tool (`ask`) is registered whenever a platform database is
  // configured and CX_AGENT_TOOLS does not say otherwise. Its routing line
  // joins the instructions only then: the instructions are prompt text on
  // every turn, and a line for a tool that is not there would cost tokens
  // and steer toward nothing - measured: a lane that hid the platform tools
  // through the SDK's disallowedTools alone still carried their lines here,
  // and the caller spent a turn calling into the refusal. `platformTools`
  // keeps what belongs to the database rather than to the loop: the sql
  // text's card and validation note.
  const platformTools = hosted !== null;
  const agentTools = platformTools && agentToolsEnabled();
  // Whether `answer` rides beside `ask`. Off (CX_ANSWER_TOOL=0) the caller's
  // model writes the final answer from the rows itself, and the tool and its
  // routing line are both absent - for the same reason `ask` is taken out at
  // the source above: a line for a tool that is not there costs a turn.
  const answerTool = agentTools && answerToolEnabled();
  // The platform's own routes as tools the model calls (CX_API_TOOLS):
  // table_card, validate, cite. With them on, sql carries no card and no
  // verdict - the model asks for both - see apiToolsEnabled.
  const apiTools = platformTools && apiToolsEnabled();
  // How the `answer` tool delivers the written answer: through the hook `cx
  // install` wrote (the entry sets CX_ANSWER_DISPLAY), or as text the model
  // relays. Read once; the instructions and the tool text say the same thing.
  const answerDisplay = answerDisplayMode();

  // What the default root's doors run against (TableMode), decided here and
  // once. With CX_REMOTE_SEARCH, a platform database and a CX_TABLE that is
  // not the default, the table's schema says whether it is the chunks table
  // or another shape, and the tool text below is registered to match - so
  // the text and the calls cannot disagree, whichever way the probe went.
  // Resolved through the default root's own client, with its normal
  // cold-start budget: for that table the answer decides the mode, so a
  // database still coming up is waited for here, at startup, the one place
  // a wait costs no query. (The probe's two reads - schema and card - are
  // per-spawn overhead and go to no ledger: they are the price of knowing
  // what the tools are, not of any answer.) On a failure the table goes
  // `unresolved`, because the chunks text over a table of another shape
  // sends the model to write SQL naming columns it does not have, and the
  // local path would build.
  //
  // The DEFAULT table is not probed. It is the chunks table this client
  // builds, so the probe's only possible outcome is `chunks` - the fallback
  // too - and the wait would buy nothing. It would cost a great deal: this
  // runs before `server.connect`, so a platform that is cold or answering
  // 503 at spawn would hold the MCP handshake for the whole cold-start
  // budget (two minutes), past the client's startup timeout (Claude Code
  // gives a server 30 s), and the session would lose find, search and sql -
  // three local tools - to a probe whose answer was known. The default
  // table keeps the startup it always had: the card alone, with no
  // cold-start retries, below.
  //
  // The card comes with the shape (resolving it read the card's roles), so
  // this is the one card read at startup when the probe runs; otherwise the
  // card is fetched on its own below, as it always was.
  let mode: TableMode = { kind: "chunks" };
  let card: RowRecord | undefined;
  const noCard = (err: unknown) => console.error(`no table card in the sql description: ${(err as Error).message}`);
  if (hosted && remoteSearch && TABLE !== DEFAULT_TABLE) {
    try {
      const shape = await resolveTableShape(registry.get().hosted!, TABLE, CARD_TIER, noCard);
      card = shape.card;
      if (!shape.isChunks) mode = { kind: "rows", shape };
    } catch (err) {
      const cause = `${(err as Error).message}${refusalHint(err)}`;
      console.error(`the ${TABLE} table could not be described (${cause}); every tool call will say so`);
      mode = { kind: "unresolved", cause };
    }
  } else if (platformTools) {
    // The table's card, folded into the `sql` description once at startup so
    // every statement is written knowing the table's shape. Measured worth:
    // 37% off the wall clock of aggregation questions, with quality level and
    // cost flat (see CARD_TIER). It is fetched here rather than offered as a
    // tool because a tool was measured and not called.
    //
    // Best-effort, and deliberately so: a card is a help, not a precondition.
    // A platform that cannot serve one (no card computed for this table yet -
    // the optimizer writes it after it first optimizes the table - a refused
    // key, a database still coming up) leaves `sql` with the description it
    // always had. Failing the server here would make a help into a
    // dependency, and the one thing worse than a slower first statement is no
    // server at all. No cold-start retries (`coldStartSecs: 0`), for the
    // reason above: one attempt, and the handshake goes ahead.
    try {
      const record = await hostedDbFor(hosted, { ...hostedOptions, coldStartSecs: 0 }).tableCard(TABLE, CARD_TIER);
      card = (record.card ?? record) as RowRecord;
    } catch (err) {
      noCard(err);
    }
  }

  // Sibling tables (CX_SIBLING_TABLES): the other hosted tables a statement
  // may join with the primary. Each is described once here, best-effort as
  // the card is - one that cannot be described is named in the text as such
  // rather than dropped, since the join is still the model's to write.
  const siblingNames = hosted ? siblingTables() : [];
  const siblings: TableShape[] = [];
  const siblingsUnresolved: string[] = [];
  if (siblingNames.length > 0) {
    const describer = hostedDbFor(hosted!, { ...hostedOptions, coldStartSecs: 0 });
    for (const name of siblingNames) {
      try {
        siblings.push(await resolveTableShape(describer, name, CARD_TIER, noCard));
      } catch (err) {
        siblingsUnresolved.push(name);
        console.error(`sibling table ${name} could not be described: ${(err as Error).message}${refusalHint(err)}`);
      }
    }
  }

  /** The rows a call on `ctx` runs over, read off the startup decision - no
   * platform call, no await: the shape when the context carries the platform
   * client (the default root) and the table is of another shape; `failed`
   * when it could not be described; null for every other case, where the
   * call takes the path it always took. */
  const rowsOver = (tool: string, ctx: RepoCtx): { shape: TableShape } | { failed: ReturnType<typeof fail> } | null => {
    if (!ctx.hosted || mode.kind === "chunks") return null;
    if (mode.kind === "rows") return { shape: mode.shape };
    return {
      failed: fail(
        `${tool} failed: table ${TABLE} could not be described from the platform at ${platformLabel(ctx.hosted)} when ` +
          `this server started: ${mode.cause}; nothing runs against a local index in its place - restart the server ` +
          "with the platform reachable",
      ),
    };
  };

  /** The `projection` the platform's loop is asked for in rows mode: the
   * column that keys a row, so every fact can be cited by it; none when the
   * table has no key of its own and the engine's id stands in, since that
   * is no column of the table's and the platform refuses a projection
   * naming none - omitted, it gives each fact the row id itself. */
  const rowsProjection = (shape: TableShape): readonly string[] => (shape.keyColumn === ENGINE_ID_COLUMN ? [] : [shape.keyColumn]);

  /** A `sql` statement run on the platform, whichever table it is over: the
   * statement with its `{{name}}` placeholders folded into the platform's
   * own `{{q:"..."}}`, which it embeds with the table's model - no local
   * index and no local embedder come into it - then the platform's verdict
   * on the rows, and one ledger line carrying both metered reads. `column`
   * is the text column the verdict is diagnosed against (the chunks table's
   * content unless the table is of another shape); `numbered` says whether
   * the rows are chunks, whose multi-line text is numbered from the row's
   * start_line as the local path numbers it - a table of rows has no lines
   * to number. */
  const sqlOnPlatform = async (
    ctx: RepoCtx,
    query: string,
    embeds: Record<string, string> | undefined,
    question: string | undefined,
    opts: { column?: string; numbered: boolean; key?: string },
  ) => {
    try {
      const t0 = performance.now();
      const fromPlatform = await runSqlRows(ctx.hosted!, query, embeds);
      recordOf(ctx).addRows(TABLE, fromPlatform, opts.key);
      const placed = opts.numbered ? fromPlatform.map(numberRowLines) : fromPlatform;
      const { verdict: judged, telemetry } = await platformVerdict(ctx, query, placed, question, opts.column);
      // A ranked aggregate's rows gain the platform's facts about their
      // groups - `file_lines`, `term_lines` - so a top-k total sits beside
      // the file's whole length in the row the model reads, and an ordered
      // result's rows carry their place in its order (core/facts.ts).
      const { rows: folded, verdict } = foldValidationFacts(placed, judged);
      const rowsOut = rankRows(folded, query);
      let usage: string | undefined;
      if (receiptOn) {
        // The statement's own metered tokens, then the verdict's: two
        // platform reads, one ledger line, so the charge shows both.
        const entry = withPlatform(sqlEntry(query, rowsOut), ctx);
        if (telemetry) {
          entry.platform = {
            rttMs: (entry.platform?.rttMs ?? 0) + telemetry.rttMs,
            ...(entry.platform?.readTokens !== undefined || telemetry.readTokens !== undefined
              ? { readTokens: (entry.platform?.readTokens ?? 0) + (telemetry.readTokens ?? 0) }
              : {}),
          };
        }
        recordUsage(ctx.dir, entry);
        usage = formatReceipt(entry, session);
      }
      return ok({
        rows: rowsOut,
        ...(verdict ? { validation: verdict } : {}),
        index: "platform",
        took_ms: Math.round((performance.now() - t0) * 1000) / 1000,
        ...(usage ? { usage } : {}),
      });
    } catch (err) {
      return fail(`sql failed: ${(err as Error).message}${refusalHint(err)}`);
    }
  };

  const rows = mode.kind === "rows" ? mode.shape : null;
  // The sibling tables come second, right after what the statement runs
  // over, on the code text; the other texts take them at the end.
  const siblingText = siblingNames.length > 0 ? siblingsNote(TABLE, siblings, siblingsUnresolved, siblingNotes()) : "";
  let sqlDescription = rows
    ? rowsSqlDescription(rows) + siblingText
    : mode.kind === "unresolved"
    ? unresolvedDescription("Read-only SQL", TABLE) + siblingText
    : SQL_DESCRIPTION_OPENING + (siblingText ? `${siblingText.trimStart()} ` : "") + SQL_DESCRIPTION.slice(SQL_DESCRIPTION_OPENING.length);
  if (platformTools && !apiTools) {
    sqlDescription += VALIDATION_NOTE;
    if (card) sqlDescription += CARD_PREAMBLE + JSON.stringify(card);
  }
  if (apiTools) sqlDescription += API_TOOLS_SQL_NOTE;

  // What the local index holds, read once here: an index of logs gets its
  // instructions in log words (`logIndexInstructions`), a code index the
  // text below.
  const startManifest = readManifest(indexDir(defaultRoot));
  const logIndex = mode.kind === "chunks" && isLogIndex(startManifest);

  const server = new McpServer(
    { name: "code-context", version: "0.1.2" },
    {
      instructions: (rows
        ? rowsInstructions(rows, agentTools)
        : mode.kind === "unresolved"
        ? unresolvedInstructions(TABLE, mode.cause, agentTools)
        : logIndex
        ? logIndexInstructions(agentTools, startManifest?.files ?? 0, startManifest?.chunks ?? 0)
        : // The first move was ls and cat CLAUDE.md, every run, before any of
          // these tools (the demo, 2026-09-24): the model looks around a
          // checkout it has been told nothing about. It has been told: the
          // table's columns, what is in it and how to read it are in the
          // sql tool's text, so the looking around is named as not needed.
          "code-context is a local index of this repository: every file's lines are in it" +
          (siblingNames.length > 0
            ? `, and beside it in the same database the tables ${siblingNames.join(", ")}, which one sql statement joins with it`
            : "") +
          ", and what the repository holds is in the sql tool's text, so begin with these tools, not with ls, cat or a look " +
          "at CLAUDE.md. Which tool for which question:\n" +
        "- find - every line containing an exact string, where you would grep.\n" +
        // With `ask` on the surface, `search` must not claim the same question.
        // It did - "how does X work, where is Y handled" on both lines - and
        // once a reply's searches ran together the model took six of those
        // over one ask every time (measured 2026-09-12). So search's line names
        // what search is: one ranked pass in the caller's own terms.
        (agentTools
          ? "- search - one ranked pass in your own words, when you already know roughly what the code calls the thing; a question you cannot write as one query is ask's.\n"
          : "- search - how does X work, where is Y handled, code by meaning.\n") +
        "- sql - counts, rankings, and aggregates across the repo, including ranking files by how " +
        "much of them is about a topic (rank by hybrid_search, not bm25, when the topic is a concept; " +
        "a total over a search relation is the top k's matched lines, never a file's length - sizes " +
        "and whole-repo counts come from the chunks table with no search function).\n" +
        (agentTools
          ? // The whole-mechanism question is ask's too, as several asks in one
            // reply: a tool that had the platform write the answer in one long
            // call (`explore`) lost to this twice on the judged passes - see the
            // note on `retrieve` - and the routing the model reads is this list.
            `- ask - a question or task in plain language; returns the rows it retrieved (facts with path:line and the code), not an answer: compose from them. ${PREFER_SEVERAL_ASKS} How many - files, projects, places - is an ask or one sql statement, never a walk through files; a question across projects is ask's, several at once.\n` +
            // Several asks in one reply beat a loop that waits on itself for a
            // question that splits into independent parts (measured
            // 2026-09-12: one exploration took longer than four asks running
            // at once).
            "  A mechanism that spans files - how X works end to end, what calls what - is one ask per part: they run at the same time, and you do the following-up yourself from the rows they return. " +
            "If an ask did not bring back what you wanted, rephrase it - more specific, or broader - and ask again, or ask several at once, rather than read files yourself.\n" +
            // The written answer is the platform's, not the caller's, and it
            // must reach the person without the caller's model retyping it -
            // see core/answer-display.ts for the two deliveries and what
            // each was measured to do.
            (answerTool ? answerInstruction(answerDisplay) : "")
          : "") +
        indexFirst(agentTools, TABLE) +
        "\n" +
        SWEEP_TO_A_TOOL +
        "\n" +
        "Hits carry the code: when a hit answers the question, answer from it. A hit's content shows " +
        "each line with its own number in the file, so cite a place as path:line or path:start-end " +
        "from those numbers and only where the thing you name sits - never the hit's whole line " +
        "range, which spans the chunk. " +
        CITE_EXACTLY +
        " Read a file only for a hit marked truncated. " +
        "Every tool takes an optional 'path' (an absolute repo root) to target another repository. " +
        "A 'partial' marker means files over the index cap were left out, so a missing match is not " +
        "proof of absence.") +
        (apiTools ? apiToolsInstruction(Boolean(rows)) : "") +
        (siblingNames.length > 0 ? siblingsInstruction(TABLE, siblingNames) : ""),
    },
  );

  server.registerTool(
    "search",
    {
      title: "Code search (exact terms + meaning)",
      annotations: READ_ONLY,
      description: rows
        ? rowsSearchDescription(rows)
        : mode.kind === "unresolved"
        ? unresolvedDescription("Ranked search", TABLE)
        : "Ranked code search fusing exact keyword matching with semantic similarity, so it works " +
        "whether or not you know the words. " +
        // The same split as the instructions: with `ask` on the surface, search
        // does not also claim the question - it claims the query.
        (agentTools
          ? "One ranked pass in your own words: use it when you can say roughly what the code calls " +
            "the thing - context before a change, similar implementations, a name to locate. A " +
            "question you cannot write as one query - how a mechanism works, where something is " +
            "handled across files - is ask's, several at once. "
          : "Use it for 'how does X work', 'where is Y handled', code by meaning, context before a " +
            "change, similar implementations. ") +
        "Each hit carries path, line " +
        "range, and the chunk content: answer from the hits. The content shows each line with its " +
        "own number in the file, so cite from those numbers - the hit's line range spans the whole " +
        "chunk and is not the line a quoted or named thing sits on. Quote only text a hit shows, " +
        "from the lines you cite it to. When one " +
        "search is not enough, refine the query and search again. " +
        // Measured on LogDx-CI (35 CI failure logs, evidence lines marked):
        // at 200 lines returned per log, whole chunks kept 0.797 of the
        // critical signals and the matching lines 0.853; see focusLines.
        "Set lines to get each hit as only the lines carrying your query's words, with two lines " +
        "of context, in place of the whole chunk - for logs, test output and other long records, " +
        "where the matching lines are the answer; put the words you expect on those lines in the " +
        "query. For every occurrence of an exact " +
        "string use find; for counts and rankings use sql. The result includes a 'usage' field, a " +
        "one-line receipt of tokens returned, chunks and files.",
      inputSchema: {
        query: z.string().describe("What you're looking for - terms, a phrase, or a description."),
        k: z.number().int().positive().max(50).default(DEFAULT_SEARCH_K).describe("Maximum hits."),
        lines: z
          .boolean()
          .optional()
          .describe(
            "Return each hit as only the lines of its chunk that carry one of the query's words, with " +
              "two lines of context, each numbered with its line in the file - not the whole chunk. A " +
              "hit reporting matchedLines 0 ranked on meaning alone and comes back whole.",
          ),
        path: z
          .string()
          .optional()
          .describe(
            "Absolute path to the repository root to search. Defaults to the server's configured root; " +
              "set it to target a specific repo when a session spans more than one.",
          ),
      },
    },
    async ({ query, k, lines, path }) => {
      let ctx: RepoCtx;
      try {
        ctx = repoFor(path);
      } catch (err) {
        return fail((err as Error).message);
      }
      // Over the rows of a hosted table of another shape: the platform
      // fuses the table's own text and embedding columns. No local index, no
      // readiness probe - the startup decision already said the table is
      // there and what it is (rowsOver). A row has no lines to cut to, so
      // `lines` has no meaning here and is left out.
      const over = rowsOver("search", ctx);
      if (over && "failed" in over) return over.failed;
      if (over) {
        try {
          const t0 = performance.now();
          const result = await searchRows(ctx.hosted!, over.shape, query, k);
          recordOf(ctx).addKeys(TABLE, over.shape.keyColumn, result.hits);
          let usage: string | undefined;
          if (receiptOn) {
            const entry = withPlatform(rowSearchEntry(result), ctx);
            recordUsage(ctx.dir, entry);
            usage = formatReceipt(entry, session);
          }
          return ok({
            ...result,
            index: "platform",
            took_ms: Math.round((performance.now() - t0) * 1000) / 1000,
            ...(usage ? { usage } : {}),
          });
        } catch (err) {
          return fail(`search failed: ${(err as Error).message}${refusalHint(err)}`);
        }
      }
      // Reading the hosted index needs no local index at all, so this comes
      // before ensureIndexed: requiring a local build first would make the
      // hosted path depend on the very thing it exists to do without.
      if (remoteSearch && ctx.hosted) {
        const notReady = await platformNotReady("search", ctx);
        if (notReady) return notReady;
        try {
          const t0 = performance.now();
          // The hosted table's analyzer decides which lines carry a term
          // (`lines`): the platform manifest this machine wrote when it loaded
          // the table records it; a table loaded some other way is read with
          // the platform's default for a bare column, as analyzerOf says.
          const hostedAnalyzer = analyzerOf(readPlatformManifest(ctx.dir) ?? { origin: "hosted" });
          const result = await searchHosted(ctx.hosted, query, k, { lines, analyzer: hostedAnalyzer });
          recordOf(ctx).addPlaces(TABLE, result.hits);
          let usage: string | undefined;
          if (receiptOn) {
            // withPlatform, as the ask path does: the platform
            // returns the tokens it metered for this call, and without this
            // a remote search is the one hosted path whose read tokens never
            // reach the ledger. They were being estimated at a measured rate
            // per search instead, which is a made-up number standing in for
            // one the response already carried.
            const entry = withPlatform(searchEntry(result, ctx.root), ctx);
            recordUsage(ctx.dir, entry);
            usage = formatReceipt(entry, session);
          }
          return ok({
            ...result,
            index: "platform",
            took_ms: Math.round((performance.now() - t0) * 1000) / 1000,
            ...(usage ? { usage } : {}),
          });
        } catch (err) {
          return fail(`search failed: ${(err as Error).message}${refusalHint(err)}`);
        }
      }
      const ensured = await localIndex(ctx);
      if ("failed" in ensured) return ensured.failed;
      const { handle, autoIndexed } = ensured;
      if (!autoIndexed) maybeAutoSync(ctx); // a fresh build is already current
      try {
        const t0 = performance.now();
        const result = await search(handle, getEmbedder(), query, k, { lines });
        recordOf(ctx).addPlaces(TABLE, result.hits);
        let usage: string | undefined;
        if (receiptOn) {
          const entry = searchEntry(result, ctx.root);
          recordUsage(ctx.dir, entry);
          usage = formatReceipt(entry, session);
        }
        return ok({
          ...result,
          ...(autoIndexed ? { auto_indexed: autoIndexNote(autoIndexed) } : {}),
          took_ms: Math.round((performance.now() - t0) * 1000) / 1000,
          ...(usage ? { usage } : {}),
        });
      } catch (err) {
        return fail(`search failed: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "find",
    {
      title: "Find exact text (every occurrence, like grep -n)",
      annotations: READ_ONLY,
      description: rows
        ? rowsFindDescription(rows)
        : mode.kind === "unresolved"
        ? unresolvedDescription("Every row holding every word of an exact string", TABLE)
        : "Every line in the repository containing an exact string, like grep -n: complete and " +
        "unranked, with the repo-wide total and per-file counts (byFile, the grep -c answer). " +
        "Literal text within one line, case-sensitive unless ignoreCase. Use it where you would " +
        "grep: every use or definition of an identifier, an error message, a config key. Set defines " +
        "to get only where a name is defined rather than everywhere it appears. " +
        // Measured 2026-09-20: three finds for guessed signatures returned
        // nothing and the model fell back to a regex Grep; the bare name with
        // defines would have listed the declarations on the first call.
        FIND_BY_BARE_NAME +
        " Not for a file you already know - Read that file. " +
        // find's hand-off must name the tool that owns the question on this
        // surface, or it sends a mechanism question to search.
        (agentTools
          ? "For code by meaning, when you know roughly the words, use search; for a question - how " +
            "X works, where Y is handled - use ask, several at once; for rankings use sql. "
          : "For meaning or 'how does X work' use search; for rankings use sql. ") +
        "The result includes a 'usage' field, a one-line receipt of tokens returned, matches and files.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "The exact text to find, as it appears in the code - an identifier, a string, a key. Never a " +
              "signature or a line you have not read: one character off and nothing matches.",
          ),
        ignoreCase: z
          .boolean()
          .optional()
          .describe("Match regardless of letter case. Default false: case-sensitive, like grep."),
        defines: z
          .boolean()
          .optional()
          .describe(
            "Keep only lines inside a definition of the query - where the name is declared, not every " +
              "place it is used. Answers 'where is X defined' in one call instead of reading use sites " +
              "until one turns out to be the declaration. The result reports definedFrom, how many " +
              "matching lines there were before the filter.",
          ),
        under: z
          .string()
          .optional()
          .describe(
            "Repo-relative path prefix to scope to - one repository of a workspace, one subtree of a " +
              "monorepo, one directory. The total and the per-file counts then describe that subtree, " +
              "and the result echoes `under` so the numbers are not mistaken for the whole repository. " +
              "Reach for it when a common name would return thousands of lines across everything: " +
              "scoping is exact here, because find retrieves every match and cuts afterwards.",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_FIND_LIMIT)
          .default(DEFAULT_FIND_LIMIT)
          .describe("Maximum matching lines to return; the result reports the total either way."),
        path: z
          .string()
          .optional()
          .describe(
            "Absolute path to the repository root to search. Defaults to the server's configured root; " +
              "set it to target a specific repo when a session spans more than one. This is a different " +
              "index; `under` narrows within one.",
          ),
      },
    },
    async ({ query, ignoreCase, defines, under, limit, path }) => {
      let ctx: RepoCtx;
      try {
        ctx = repoFor(path);
      } catch (err) {
        return fail((err as Error).message);
      }
      // Over the rows of a hosted table of another shape the find needs no
      // local index, so this comes before the local index - which would be
      // built, and with it drop the platform table (see ownsTable). The
      // code-index options (ignoreCase, defines, under) have no meaning for a
      // row and are left out, as the tool text says. Read off the startup
      // decision: in chunks mode this is the local tool it always was, and
      // nothing here waits on the platform.
      const over = rowsOver("find", ctx);
      if (over && "failed" in over) return over.failed;
      if (over) {
        try {
          const t0 = performance.now();
          const result = await findRows(ctx.hosted!, over.shape, query, { limit });
          recordOf(ctx).addKeys(TABLE, over.shape.keyColumn, result.matches);
          let usage: string | undefined;
          if (receiptOn) {
            const entry = withPlatform(rowFindEntry(result), ctx);
            recordUsage(ctx.dir, entry);
            usage = formatReceipt(entry, session);
          }
          return ok({
            ...result,
            index: "platform",
            took_ms: Math.round((performance.now() - t0) * 1000) / 1000,
            ...(usage ? { usage } : {}),
          });
        } catch (err) {
          return fail(`find failed: ${(err as Error).message}${refusalHint(err)}`);
        }
      }
      const ensured = await localIndex(ctx);
      if ("failed" in ensured) return ensured.failed;
      const { handle, autoIndexed } = ensured;
      if (!autoIndexed) maybeAutoSync(ctx); // a fresh build is already current
      try {
        const t0 = performance.now();
        const result = await find(handle, query, { ignoreCase, defines, under, limit });
        recordOf(ctx).addLines(TABLE, result.matches);
        let usage: string | undefined;
        if (receiptOn) {
          const entry = findEntry(result);
          recordUsage(ctx.dir, entry);
          usage = formatReceipt(entry, session);
        }
        const hint = findHint(query, result.total, Boolean(defines));
        return ok({
          ...result,
          ...(hint ? { hint } : {}),
          ...(autoIndexed ? { auto_indexed: autoIndexNote(autoIndexed) } : {}),
          took_ms: Math.round((performance.now() - t0) * 1000) / 1000,
          ...(usage ? { usage } : {}),
        });
      } catch (err) {
        return fail(`find failed: ${(err as Error).message}`);
      }
    },
  );

  server.registerTool(
    "sql",
    {
      title: "SQL over the code index",
      annotations: READ_ONLY,
      description: sqlDescription,
      inputSchema: {
        query: z
          .string()
          .describe("A single read-only SELECT or WITH statement. May use search table functions and {{name}} vector placeholders."),
        embed: z
          .record(z.string(), z.string())
          .optional()
          .describe('Map of placeholder name → query text, embedded server-side. E.g. {"q":"vector indexing"} fills {{q}}.'),
        question: z
          .string()
          .optional()
          .describe(
            "The question these rows are meant to answer, in the words it was asked. Used only to check " +
              "the rows against it - the result's 'validation' then says whether they answer it and what " +
              "is missing if not.",
          ),
        path: z
          .string()
          .optional()
          .describe(
            "Absolute path to the repository root to query. Defaults to the server's configured root; " +
              "set it to target a specific repo when a session spans more than one.",
          ),
      },
    },
    async ({ query, embed, question, path }) => {
      let ctx: RepoCtx;
      try {
        ctx = repoFor(path);
      } catch (err) {
        return fail((err as Error).message);
      }
      const embeds = embed as Record<string, string> | undefined;
      // Over the rows of a hosted table of another shape the statement runs
      // on the platform - and this comes before the local index for the
      // reason find's does. The rows come back as the platform gave them: a
      // table of rows has no lines to number. The verdict is diagnosed
      // against the table's own text column.
      const over = rowsOver("sql", ctx);
      if (over && "failed" in over) return over.failed;
      if (over) return sqlOnPlatform(ctx, query, embeds, question, { column: over.shape.primaryText, numbered: false, key: over.shape.keyColumn });
      // With sibling tables named, every statement runs on the platform: a
      // JOIN across them has nowhere else to run, and a plain statement over
      // the primary alone gives the same rows there as here.
      if (ctx.hosted && siblingNames.length > 0) {
        const notReady = await platformNotReady("sql", ctx);
        if (notReady) return notReady;
        return sqlOnPlatform(ctx, query, embeds, question, { numbered: true });
      }
      // The chunks table's statement runs on the platform when it embeds a
      // query, whatever else is configured: a `{{q}}` is a vector function's,
      // the platform embeds it with the table's own model, and the local side
      // is lexical - a plain statement stays local (owner, 2026-09-09: "all
      // vector search happens on the cloud ... only pure sql runs locally").
      // Until 2026-09-12 every such statement ran on the local index. On the
      // engine corpus that ranked against the old local vectors while the
      // tool read as hosted; on a corpus whose local index was built
      // keyword-only (OpenSearch, in the side-by-side demo) it failed every
      // hybrid_search the model wrote, and the arm was graded on the keyword
      // fallback. Same readiness probe as search: the table has to be there.
      if (ctx.hosted && embedsAQuery(query)) {
        const notReady = await platformNotReady("sql", ctx);
        if (notReady) return notReady;
        return sqlOnPlatform(ctx, query, embeds, question, { numbered: true });
      }
      const ensured = await localIndex(ctx);
      if ("failed" in ensured) return ensured.failed;
      const { handle, autoIndexed } = ensured;
      if (!autoIndexed) maybeAutoSync(ctx); // a fresh build is already current
      try {
        const t0 = performance.now();
        // Numbered where the projection places the text, so a line cited out
        // of a SQL row is read off the row rather than counted. Numbered
        // before the receipt, not after: a receipt is only worth having if it
        // is the thing that was returned, and these rows are what the caller
        // gets.
        // Ranked the same way the platform path's rows are: an ordered
        // result carries each row's place in its order (core/facts.ts).
        const raw = await runSql(handle, getEmbedder(), query, embed as Record<string, string> | undefined);
        recordOf(ctx).addRows(TABLE, raw);
        const rows = rankRows(raw.map(numberRowLines), query);
        const partial = partialIndex(handle.manifest);
        // The platform's own retrieval contract, applied to these rows before
        // they go back. The answering loop gates every query it runs on this
        // check; a caller writing its own SQL has the same problem and could
        // not ask. Attached to the result rather than offered as a tool
        // because a check the model may call is a check the model declines -
        // measured on the card tool the same day (2026-09-11).
        //
        // `question` is not the SQL: the statement's own text counts for
        // nothing here, which is the defect the check exists to catch. With
        // no question the aggregate half still applies, and that is the half
        // that matters for a ranking or a count - the case where a statement
        // runs, returns a row of zeros, and reads as an answer.
        const { verdict, telemetry } = await platformVerdict(ctx, query, rows, question);
        let usage: string | undefined;
        if (receiptOn) {
          const entry = sqlEntry(query, rows);
          // The validate call's metered Read Tokens: filed so "our charge"
          // reflects what the platform actually billed for this sql.
          if (telemetry) entry.platform = telemetry;
          recordUsage(ctx.dir, entry);
          usage = formatReceipt(entry, session);
        }
        return ok({
          rows,
          ...(verdict ? { validation: verdict } : {}),
          ...(partial ? { partial } : {}),
          ...(autoIndexed ? { auto_indexed: autoIndexNote(autoIndexed) } : {}),
          took_ms: Math.round((performance.now() - t0) * 1000) / 1000,
          ...(usage ? { usage } : {}),
        });
      } catch (err) {
        return fail(`sql failed: ${(err as Error).message}`);
      }
    },
  );

  if (apiTools && hosted) {
    // The platform's routes as tools (CX_API_TOOLS). One client for the
    // three, no cold-start retries: a model asking for a card or a check
    // waits on the answer, not on a database coming up.
    const apiDb = hostedDbFor(hosted, { ...hostedOptions, coldStartSecs: 0 });
    // The text column a check or a citation is read against: the chunks
    // table's content, or a rows table's own primary text.
    const apiColumn = rows ? rows.primaryText : CONTENT_COLUMN;

    server.registerTool(
      "table_card",
      {
        title: "The table's measured shape, before the first query",
        annotations: READ_ONLY,
        description:
          `What a model needs to know about ${TABLE} before its first query: its columns with their index ` +
          "roles, per-column statistics (min, max, distinct counts) and sample rows, as the platform's " +
          "optimizer last measured them from the table itself. Use it to choose columns and write a statement " +
          "without discovering the shape by trial. Call it once, before sql or search.",
        inputSchema: {
          tier: z.enum(["lean", "enriched"]).optional().describe("The card's depth: lean (the measured shape, the default) or enriched (adds column descriptions and synonyms)."),
        },
      },
      async ({ tier }: { tier?: "lean" | "enriched" }) => {
        try {
          const record = await apiDb.tableCard(TABLE, tier);
          return ok((record.card ?? record) as Record<string, unknown>);
        } catch (err) {
          return fail(`table_card failed: ${(err as Error).message}${refusalHint(err)}`);
        }
      },
    );

    server.registerTool(
      "validate",
      {
        title: "Did this result answer this question?",
        annotations: READ_ONLY,
        description:
          "Did this result answer this question? The same check the platform's own retrieval loop gates " +
          "itself on, for a caller driving its own retrieval: pass the question you are answering, the " +
          "statement that ran and the rows it returned. 'valid' means the rows would be accepted as answering " +
          "the question's terms - no rows, an aggregate of zeros, or rows naming nothing the question named " +
          "are refused with the reason - not that they are correct. A refusal names the question's terms that " +
          "occur nowhere in the index ('absent': no query will find them, so do not search for them again) and " +
          "carries a 'suggestion' statement when the one that ran should be rewritten. Sent with no rows, it " +
          "is the diagnosis alone: which of the question's terms the index holds, to check before a query.",
        inputSchema: {
          question: z.string().min(1).describe("The question the rows are meant to answer, as the user asked it."),
          statement: z.string().min(1).describe("The statement that produced the rows, as it ran - a SQL statement, or the search or find call."),
          rows: z.array(z.record(z.string(), z.unknown())).describe("The rows it returned, as objects; an empty array checks the question's terms against the index alone."),
        },
      },
      async ({ question, statement, rows: given }: { question: string; statement: string; rows: Record<string, unknown>[] }) => {
        try {
          const verdict = await apiDb.validate({ table: TABLE, column: apiColumn, statement, rows: given, question });
          return ok(verdict as Record<string, unknown>);
        } catch (err) {
          return fail(`validate failed: ${(err as Error).message}${refusalHint(err)}`);
        }
      },
    );

    // Citations are path:line over a code table; a rows table is cited by
    // its key, and the pass has nothing to check there.
    if (!rows) {
      server.registerTool(
        "cite",
        {
          title: "Check and repair an answer's citations, grade each cited sentence",
          annotations: READ_ONLY,
          description:
            "Check an answer's citations against the index: every path:line and path:start-end in your draft " +
            "is checked against the rows of the cited file, repaired where the index says it belongs, and each " +
            "cited sentence is graded against the lines it cites. Returns the answer as it stands after the " +
            "pass, how many citations held, what was repaired or could not be placed, and the grades. Run it " +
            "on your draft before you reply, and reply with the answer it returns.",
          inputSchema: {
            answer: z.string().min(1).describe("The answer you drafted, with its citations as you wrote them."),
            question: z.string().optional().describe("The question the answer answers, shown to the grader beside each claim."),
          },
        },
        async ({ answer, question }: { answer: string; question?: string }) => {
          try {
            const result = await apiDb.cite({ table: TABLE, column: CONTENT_COLUMN, answer, ...(question ? { question } : {}) });
            return ok(result as Record<string, unknown>);
          } catch (err) {
            return fail(`cite failed: ${(err as Error).message}${refusalHint(err)}`);
          }
        },
      );
    }
  }

  if (agentTools) {
    /** The inputs of `ask`. */
    const retrievalInputs = {
      question: z.string().min(1).describe("The question or task, in plain language, about the indexed code."),
      under: z
        .string()
        .optional()
        .describe(
          "Repo-relative path prefix to scope to - one repository of a workspace, one subtree of a " +
            "monorepo, one directory. Carried to the retrieval loop as a constraint on where to look, " +
            "and echoed back on the result so a scoped answer's facts are not read as the whole " +
            "repository's.",
        ),
      path: z
        .string()
        .optional()
        .describe(
          "Absolute path to the repository root to ask about. Defaults to the server's configured root; " +
            "set it to target a specific repo when a session spans more than one.",
        ),
    };

    /** One retrieval through the platform's loop: the facts back.
     *
     * The platform can also write the answer from the rows (`answer: true`
     * on `runRetrievalAgent`, kept for a caller that wants it). No tool here
     * asks for it any more: an `explore` tool did, and was measured twice
     * against the same model fanning out asks - once with Sonnet in early
     * September, and on 2026-09-19/20 with Opus on both arms of the demo,
     * twelve questions, the same judge: with explore 8 A / 1 B / 3 C and four
     * contradicted claims at a median 52 s; without it 12 A, none
     * contradicted, 47 s, at 1.9x the caller's tokens. The owner: "we have to
     * go with faster even if a bit more expensive. quality is better and
     * performance is better." */
    /** What every call into the platform's loop settles first, for `ask` and
     * `answer` alike. A repo without the platform client is refused before
     * any build. Then the same first-query build and auto-sync the other
     * tools make (both write the platform table too), then the platform
     * table's own readiness: without a chunks table the platform would spend
     * the whole cold-start budget on "no table described yet" before saying
     * anything useful. Over a hosted table of another shape there is no
     * local index to build or sync - and a build would drop that table (see
     * ownsTable) - and no readiness to probe: the startup decision saw the
     * table. The facts are then keyed by the table's own key column, not the
     * chunks table's place columns (rowsProjection), and come back as rows of
     * that shape, text cut to snippets as a search hit's is. */
    const loopContext = async (tool: string, path: string | undefined): Promise<{ ctx: RepoCtx; over: { shape: TableShape } | null } | { failed: ReturnType<typeof fail> }> => {
      let ctx: RepoCtx;
      try {
        ctx = repoFor(path);
      } catch (err) {
        return { failed: fail((err as Error).message) };
      }
      const missing = noPlatform(tool, ctx);
      if (missing) return { failed: missing };
      const over = rowsOver(tool, ctx);
      if (over && "failed" in over) return { failed: over.failed };
      if (!over) {
        const ensured = await localIndex(ctx);
        if ("failed" in ensured) return { failed: ensured.failed };
        if (!ensured.autoIndexed) maybeAutoSync(ctx); // a fresh build is already current
        const notReady = await platformNotReady(tool, ctx);
        if (notReady) return { failed: notReady };
      }
      return { ctx, over };
    };

    const retrieve = async ({ question, under, path }: { question: string; under?: string; path?: string }) => {
      const settled = await loopContext("ask", path);
      if ("failed" in settled) return settled.failed;
      const { ctx, over } = settled;
      try {
        const t0 = performance.now();
        // The spend (turns, tokens) goes to the ledger and the receipt only;
        // the result the model sees is the facts: sql, hits, rows, queries.
        // The repository's own instructions ride with the question only
        // when asked for (CX_DEV_CONTEXT=1); off, the loop's model gets the
        // question alone.
        const context = devContextEnabled() ? devContext(ctx.root) : undefined;
        // `under` names a subtree of a code index, and a row of a hosted
        // table of another shape sits in no directory - so it is left out
        // there, exactly as find leaves its own out.
        const { result, spend } = await runRetrievalAgent(
          ctx.hosted!,
          {
            question,
            ...(context !== undefined ? { context } : {}),
            ...(under !== undefined && !over ? { under } : {}),
            ...(over ? { projection: rowsProjection(over.shape), shape: over.shape } : {}),
            // The table this client reads, in either mode: the database can
            // hold several and the loop, shown all of them, does not always
            // pick this one (measured 2026-09-12: two code indexes, and every
            // ask about the second was answered from the first).
            table: TABLE,
          },
          { maxTurns: subagentMaxTurns(), maxWallSecs: subagentMaxWallSecs(), k: subagentK() },
        );
        // On the record for `answer`: the places the hits name, and the
        // rows of a table of another shape by their key.
        const record = recordOf(ctx);
        record.addPlaces(TABLE, result.hits);
        if (over) record.addKeys(TABLE, over.shape.keyColumn, result.rows);
        else record.addRows(TABLE, result.rows);
        let usage: string | undefined;
        if (receiptOn) {
          const entry = withPlatform(subagentEntry(result, spend), ctx);
          recordUsage(ctx.dir, entry);
          usage = formatReceipt(entry, session);
        }
        return ok({
          ...result,
          took_ms: Math.round((performance.now() - t0) * 1000) / 1000,
          ...(usage ? { usage } : {}),
        });
      } catch (err) {
        return fail(`ask failed: ${(err as Error).message}${refusalHint(err)}`);
      }
    };

    server.registerTool(
      "ask",
      {
        title: "Ask the repository index: one retrieval, the facts back",
        annotations: READ_ONLY,
        description: rows
          ? rowsAskDescription(rows, DEV_CONTEXT_NOTE)
          : mode.kind === "unresolved"
          ? unresolvedDescription("A question or task in plain language, answered with the rows it retrieved,", TABLE)
          : // The first sentence is what the choice between ask and the model's
            // own file tools turns on, so it says what one call does and covers
            // before it says what comes back. How the subagent works inside -
            // which model, how many searches at once - stays out: the caller
            // cannot act on it, and a call that advertises its own parallelism
            // invites one broad question where several asks in one reply are
            // the shape wanted (PREFER_SEVERAL_ASKS).
            "Ask the repository index a question or task in plain language: a read-only retrieval " +
          "subagent chooses and runs the searches itself - keyword, hybrid, vector and SQL, as the " +
          "question needs - over the whole repository and returns the rows it found, with exact path, " +
          "start_line, end_line and the code, in the shape of search hits, plus aggregate rows (counts, " +
          "rankings) and the SQL whose rows answer the question - never a summary. Use it " +
          "for a lookup you will read yourself - where is Y handled, which files or symbols. " +
          `${PREFER_SEVERAL_ASKS} ` +
          "A single question over a large codebase splits the same way: one call per section with " +
          "`under` naming its subtree, all issued together. " +
          // The whole-mechanism question is ask's too, as several asks in one
          // reply (see the note on `retrieve`).
          "A mechanism that spans files - how X works end to end, what calls what - is one ask per " +
          "part: they run at the same time, and you do the following-up yourself from the rows they " +
          "return. " +
          // A model whose ask came back thin went to Read next, file after
          // file (Fable on the demo, 2026-09-24). The owner: "you can
          // rephrase ask to be more specific and re-issue the question again
          // if you don't get what you want from ask. it can handle a lot of
          // parallelism so you could even be broader in your search."
          "If an ask did not bring back what you wanted, rephrase it - more specific, or broader - and " +
          "ask again, or ask several at once: it runs many searches in parallel, so several asks in one " +
          "reply cost one wait, and a second ask is cheaper than reading files yourself. " +
          // A count and a question across projects were going to Bash: the
          // sentence here sent "how many" to find and "a file you already
          // know" to Read, and the model took that as the file tools' turn
          // (the owner, 2026-09-24: "it should use sql or find but it should
          // also use ask extensively it's just cheaper and faster").
          "How many - files, projects, places that do X - is one ask, or one sql statement when you " +
          "can already write it; every line holding one exact string is find's. A question across " +
          "projects or repositories is ask's, several at once. Never Grep, Glob or Read for what one " +
          "of these answers; a hit marked truncated is its row, one sql statement away. Answer from " +
          "the rows and cite path:line. " +
          DEV_CONTEXT_NOTE +
          "The result includes a 'usage' field, a one-line receipt of what the call cost.",
        inputSchema: retrievalInputs,
      },
      retrieve,
    );

    /** The written answer: the platform's loop retrieves for the question
     * once more with the caller's notes as its context, its writer composes
     * from the rows under the same citation instruction the caller has, the
     * cite pass checks the places, and the text comes back. How it reaches
     * the person is the display mode's business (core/answer-display.ts):
     * under the hook it goes to a file the hook shows and the model is told
     * to say one sentence, with the text beside the instruction so the
     * model holds it for the next request; without a hook the model is told
     * to relay it exactly. Either way nothing in the result invites a
     * rewrite: no rows, no coverage, no receipt beside the text. */
    const writeAnswer = async ({ question, narration, under, path }: { question: string; narration?: string; under?: string; path?: string }) => {
      const settled = await loopContext("answer", path);
      if ("failed" in settled) return settled.failed;
      const { ctx, over } = settled;
      try {
        const dev = devContextEnabled() ? devContext(ctx.root) : undefined;
        // What the model said while it worked - its text between tool calls,
        // as the installed hook read it from the session transcript; the
        // model itself types nothing here.
        const said = narration?.trim();
        const context = [dev, said ? `${NARRATION_HEADING}\n${said}` : undefined].filter(Boolean).join("\n\n");
        // The rows this server returned to the model in the session: the
        // platform writes from them and runs no loop. With none on record -
        // a question answered without a retrieval through this server - the
        // platform retrieves for the question itself.
        const record = recordOf(ctx);
        const facts = record.facts();
        const { result, spend } = await runRetrievalAgent(
          ctx.hosted!,
          {
            question,
            answer: true,
            ...(facts.length ? { facts } : {}),
            ...(context ? { context } : {}),
            ...(under !== undefined && !over ? { under } : {}),
            ...(over ? { projection: rowsProjection(over.shape), shape: over.shape } : {}),
            table: TABLE,
          },
          { maxTurns: subagentMaxTurns(), maxWallSecs: subagentMaxWallSecs(), k: subagentK() },
        );
        if (receiptOn) recordUsage(ctx.dir, withPlatform(subagentEntry(result, spend, "answer"), ctx));
        if (!result.answer) return fail(`answer: ${result.error ?? "the platform wrote no answer from the rows it retrieved"} - answer the question yourself from what you have gathered.`);
        // The answer consumed the record: the next question starts its own.
        record.clear();
        // The file the hook reads, kept under the index directory beside the
        // ledger; written in both modes so a run's answers can be read back.
        const dir = join(ctx.dir, ANSWERS_DIR);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
        writeFileSync(file, result.answer);
        const text = answerDisplay === "hook" ? hookDeliveryText(file, result.answer) : relayDeliveryText(result.answer);
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return fail(`answer failed: ${(err as Error).message}${refusalHint(err)}`);
      }
    };

    if (answerTool) {
      server.registerTool(
        "answer",
        {
          title: "Write the answer from what was retrieved, and deliver it",
          annotations: READ_ONLY,
          description: answerDescription(answerDisplay, Boolean(rows)),
          inputSchema: {
            question: z.string().min(1).describe("The question as the user asked it."),
            narration: z.string().optional().describe("Set by the installed hook. Leave it out."),
            under: retrievalInputs.under,
            path: retrievalInputs.path,
          },
        },
        writeAnswer,
      );
    }
  }

  const transport = serveOptions.transport ?? new StdioServerTransport();
  await server.connect(transport);
  const manifest: Manifest | undefined = readManifest(indexDir(defaultRoot));
  // The platform's host and its embedder, never the key. The table's
  // readiness is not probed here: a cold database can take a while to answer,
  // and the first platform tool call reports "no chunks table" itself. When
  // the doors run over the rows of a table of another shape, say so and by
  // what a row is named.
  const platform = hosted
    ? `, ${TABLE} table also at ${hostedLabel(hosted)} (embedder there: ${platformEmbedderInfo()})` +
      (rows ? `; find, search and sql run over its rows, keyed by ${rows.keyColumn}` : "") +
      (mode.kind === "unresolved" ? "; the table could not be described, so every tool call says so" : "")
    : "";
  console.error(
    `code-context MCP server ready on stdio (default root: ${defaultRoot}, index: ${
      manifest ? `${manifest.chunks} chunks, vectors ${manifest.vectors}` : "none yet"
    }, embedder: ${embedderInfo()}${platform}; tools accept an optional 'path' to target other repos)`,
  );
}
