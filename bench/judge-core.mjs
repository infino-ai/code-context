// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The judge's shared core: how a stronger model verifies answers about a
// repository, the grounded call that runs it, and how its JSON verdict is
// read back. Two callers, one judge: the bench's pairwise judge (judge.mjs,
// two builds' answers over a results file) and the demo's per-arm grader
// (demo/judge.mjs, three arms' answers as they finish). What they share is
// everything that decides whether a claim is supported; what differs is the
// verdict each asks for.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { cxServer, mcpEnvBase, foldToolMessage, newToolAccounting, recordedQueries } from "./lanes.mjs";

/** The judge: a stronger model than any arm runs. JUDGE_MODEL overrides. */
export const DEFAULT_JUDGE_MODEL = process.env.JUDGE_MODEL ?? "claude-opus-5";

/** Turns a judging call may take to verify. Enough to rerun every recorded
 * query and read the files an answer names; a judge that needs more is
 * exploring, not verifying. Two recorded questions (Q15, Q16) hit it. */
export const JUDGE_MAX_TURNS = 30;

/** The checkout's tools. The index's (find, sql) come from the local
 * code-context server the call attaches - local only, never `--db`, so a
 * verification never spends a platform call. */
export const JUDGE_TOOLS = ["Read", "Grep", "Glob"];

/** How a claim is verified: with the tool that measures it at the grain the
 * answer states. The one rule every verdict is judged under; it names the
 * index tools and the recorded queries so a count built on a ranked search is
 * reproduced by rerunning that search, never by one the judge writes. */
export const VERIFICATION_RULES =
  `Verify what each answer claims (file paths, line numbers, identifiers, counts, rankings, behaviour) ` +
  `with the tool that measures the claim at the grain the answer states. Read, Grep and Glob on the ` +
  `checkout measure code, lines and occurrences. The code-context tools measure the repository's own ` +
  `index, which some answers report from: find gives every line containing a literal with its per-file ` +
  `line counts (byFile); sql gives chunk counts and rankings over a search relation, e.g. SELECT path, ` +
  `COUNT(*) AS chunks FROM bm25_search('chunks','content','<terms>', k) GROUP BY path ORDER BY chunks DESC, ` +
  `or the same over hybrid_search('chunks','content','<terms>','embedding', {{q}}, k) with an embed map ` +
  `{"q":"<topic>"} passed beside the statement. Under each answer are the queries its run made through ` +
  `these tools, in order, with the statements the platform ran for it marked "ran:". Reproduce a count ` +
  `built on the index by rerunning the recorded query as written, embed map included, before writing ` +
  `your own: a ranked search's total is a property of that query, so it reproduces only from that query. ` +
  `A count is supported when it reproduces at its stated grain (lines, occurrences, hits, chunks, the ` +
  `top-k of a named query), whichever tool that takes; a count that reproduces at no grain, a ranked ` +
  `query's total presented as a property of the repository with no measure named, a ranking its own ` +
  `measure does not give, an attribution the code contradicts, or a name the code does not have is ` +
  `unsupported. An answer whose queries were not recorded is verified with your own queries. ` +
  `Judge correctness and how well each claim is supported; do not reward length or formatting.`;

/** The queries one answer's run made, as the judge is handed them; a run
 * written before inputs were kept says so, and the judge falls back to its
 * own queries for that side. */
export function queriesBlock(run) {
  const lines = recordedQueries(run?.toolDetails ?? []);
  return lines.length ? lines.join("\n") : "(this run's queries were not recorded; verify with your own)";
}

/** The last JSON object in the judge's text, or null. The judge is told to
 * end with the verdict and nothing after it; anything it wrote before is its
 * working.
 *
 * The object is the OUTERMOST one ending at the last `}`: every `{` from the
 * first onward is tried as its start, and the first slice that parses is the
 * verdict. Taking the text from the last `{` instead - the first version -
 * picks the innermost object of a nested verdict (`"reasons":{...}` with an
 * extra `}` after it), which does not parse, and the demo's first live
 * verdict was lost that way. The bench's pairwise verdict is flat, which is
 * why it never showed there. */
export function parseVerdict(text) {
  const end = text.lastIndexOf("}");
  if (end < 0) return null;
  for (let start = text.indexOf("{"); start >= 0 && start < end; start = text.indexOf("{", start + 1)) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // Not the verdict's opening brace; try the next one.
    }
  }
  return null;
}

/** One grounded judging call. The model reads `prompt` under `system` with
 * the checkout's tools and the local index's, and what comes back is its
 * final text and what the call cost - the caller parses the verdict, because
 * only the caller knows what shape it asked for. */
export async function judgeOnce({ repoDir, indexDir, system, prompt, model = DEFAULT_JUDGE_MODEL, maxTurns = JUDGE_MAX_TURNS }) {
  const t0 = performance.now();
  const acc = newToolAccounting();
  let text = "";
  let costUsd = null;
  let usage = null;
  let error = null;
  try {
    for await (const m of query({
      prompt,
      options: {
        model,
        maxTurns,
        systemPrompt: system,
        permissionMode: "bypassPermissions",
        env: { ...process.env, IS_SANDBOX: "1" },
        cwd: repoDir,
        settingSources: [],
        strictMcpConfig: true,
        tools: JUDGE_TOOLS,
        mcpServers: cxServer(mcpEnvBase(repoDir, indexDir)),
      },
    })) {
      foldToolMessage(acc, m);
      if (m.type === "result") {
        usage = m.usage ?? null;
        costUsd = m.total_cost_usd ?? null;
        if (m.result) text = m.result;
      }
    }
  } catch (err) {
    error = String(err?.message ?? err).slice(0, 300);
  }
  const u = usage ?? {};
  return {
    model,
    text,
    costUsd,
    tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0),
    wallMs: Math.round(performance.now() - t0),
    // The tools the judge called to verify, in order, and the ones that
    // errored - whether a verdict on an index-grain count was measured.
    toolCalls: acc.toolCalls,
    toolDetails: acc.toolDetails,
    toolErrors: acc.toolDetails.filter((d) => d.isError).map((d) => d.name),
    error,
  };
}
