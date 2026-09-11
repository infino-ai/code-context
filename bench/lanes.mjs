// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Shared lane plumbing: hermetic agent runs where the only variable is the
// toolset. Exported for the question and localization runners.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

export const BENCH = dirname(fileURLToPath(import.meta.url));
export const WORK = join(BENCH, ".work");
export const RESULTS = join(WORK, "results");
/** The server build the MCP lanes run: this checkout's `dist/cli.js`, or
 * `CX_BENCH_CLI` to point the same harness at another build (a variant of the
 * tool surface in a sibling worktree), so lanes differ in the server alone. */
export const CX = process.env.CX_BENCH_CLI ? resolve(process.env.CX_BENCH_CLI) : resolve(BENCH, "..", "dist", "cli.js");
/** A label for the build under test, recorded on every result so runs from
 * different variants can be told apart in one results file. */
export const BUILD = process.env.CX_BENCH_BUILD ?? null;
export const MODEL = process.env.BENCH_MODEL ?? "claude-sonnet-4-6";

/** The built-in tool set of real Claude Code (Bash included, since a real
 * client has it). Every lane but `cx` gets exactly this. */
const STOCK_TOOLS = ["Glob", "Grep", "Read", "LS", "Bash"];
/** The prefix the SDK puts on the code-context MCP tools; results record the
 * short `cx:<tool>` form so they stay readable and comparable across builds. */
const CX_TOOL_PREFIX = "mcp__code-context__";
const CX_SHORT_PREFIX = "cx:";
/** The prefix the SDK puts on the Snowflake server's tools, and the short
 * `sf:<tool>` form results record for them, beside `cx:` for code-context. */
const SF_TOOL_PREFIX = "mcp__snowflake__";
const SF_SHORT_PREFIX = "sf:";
/** Every (SDK prefix, short prefix) pair a result row shortens; a built-in
 * tool's name carries no prefix and is kept as is. */
const TOOL_PREFIXES = [
  [CX_TOOL_PREFIX, CX_SHORT_PREFIX],
  [SF_TOOL_PREFIX, SF_SHORT_PREFIX],
];
/** The three retrieval tools, hidden from the model in the agent-only lane
 * so that every retrieval has to go through `ask`. */
const CX_RETRIEVAL_TOOLS = ["find", "search", "sql"];
/** The built-in tool that spawns subagents, and the built-in read-only
 * exploration subagent the explore lanes override: a programmatic agent
 * definition under the same name replaces it (probed: the overridden Explore
 * sees only the tools its definition names, the main agent keeps its own). */
const AGENT_TOOL = "Agent";
const EXPLORE = "Explore";
/** The turn budget of one run. Named because a delegating lane has to hand the
 * same number to the subagent: a truncated run's cost is a capped cost, and a
 * cap that applies to one side of a comparison and not the other would price
 * the architecture rather than measure it. */
const SESSION_MAX_TURNS = 50;
/** The model inside an overridden Explore: the cheap one, since the index
 * does the finding and the subagent only reads results and writes the
 * conclusion. */
const EXPLORE_MODEL = "haiku";

/** What the main agent reads when deciding to delegate: the same job the
 * built-in Explore advertises (broad, read-only, conclusion not file dumps),
 * with the index named as how it gets there. Shared by both overrides so the
 * two differ only in what runs underneath. */
const EXPLORE_DESCRIPTION =
  "Read-only exploration agent for questions that span the repository: how X works, where Y is " +
  "handled, which files are about Z, every occurrence of an identifier. It searches the repository's " +
  "code index and returns the conclusion with path:line citations, not file dumps. Use it when " +
  "answering means sweeping many files and you only need the conclusion.";

/** Explore over code-context's own tools, Haiku inside. */
const exploreOnIndex = {
  description: EXPLORE_DESCRIPTION,
  tools: [...CX_RETRIEVAL_TOOLS.map((tool) => `${CX_TOOL_PREFIX}${tool}`), "Read"],
  prompt:
    "You explore this repository through code-context's index. find: every occurrence of an exact " +
    "identifier or string, where you would grep. search: how something works, where it is handled, code " +
    "by meaning. sql: counts and rankings across the repo (bm25_search('chunks','content','<terms>', k) " +
    "as a table function with GROUP BY). Answer from the hits and cite path:line; Read a file only for a " +
    "hit marked truncated. Return a concise, complete answer with citations - the caller will not see " +
    "your tool results.",
  model: EXPLORE_MODEL,
};

/** Explore over the platform's explore mode alone, Haiku relaying: the
 * platform's loop reads what it finds and follows it, and answers in writing
 * beside the facts and the chain of queries; the relay hands that answer up
 * with its citations. The exploration's turn budget is the platform's
 * (--explore-max-turns lowers it), so the platform decides how far to go. */
const exploreOnPlatform = {
  description: EXPLORE_DESCRIPTION,
  tools: [`${CX_TOOL_PREFIX}explore`, "Read"],
  prompt:
    "You explore this repository by calling explore with the question, once (rephrase and call " +
    "once more only if it returns no answer). Return its answer, checked against and cited from " +
    "the facts it returned as path:line; if there is still no answer, return the facts it found and " +
    "say so. The caller will not see your tool results.",
  model: EXPLORE_MODEL,
};
/** The model inside the delegating lane's Explore: the mid-tier one, because
 * that lane asks whether a strong writer over the index beats a strong model
 * doing its own reading. The outer model is the lane's (`BENCH_MODEL`), so the
 * two differ and the split is visible in the bill. */
const DELEGATE_MODEL = "sonnet";

/** What the delegating lane's Explore advertises: the shared description plus
 * the names of the instruments it holds. That lane hides nothing from the outer
 * model, so this line is the whole of the case for delegating - it has to say
 * that going one level down reaches the same index, with a model that spends
 * all of its turns on retrieval. */
const DELEGATED_DESCRIPTION =
  `${EXPLORE_DESCRIPTION} It runs find and explore over the index itself and returns cited places, ` +
  "so a question that spans the repository costs the caller one call.";

/** Explore over the whole code-context surface, Sonnet inside: the shape where
 * the outer model delegates exploring rather than doing it, and every retrieval
 * happens one level down. The subagent gets the platform tools as well as the
 * local ones so it can escalate when one retrieval will not do, and its prompt
 * requires a citation per claim - a written conclusion with no places in it is
 * what let confident wrong details through to an outer model before. */
const exploreDelegated = {
  description: DELEGATED_DESCRIPTION,
  tools: [...[...CX_RETRIEVAL_TOOLS, "explore", "ask"].map((tool) => `${CX_TOOL_PREFIX}${tool}`), "Read"],
  prompt:
    "You explore this repository through code-context's index, and the caller sees only what you " +
    "write. find: every occurrence of an exact identifier or string, where you would grep. search: " +
    "how something works or where it is handled, by meaning. sql: counts and rankings across the " +
    "repo. explore: a mechanism that spans files, when one retrieval will not do. ask: one " +
    "retrieval returned as rows. Answer from the rows you retrieved and give every claim a " +
    "path:line citation from them; Read a file only for a hit marked truncated. If you could not " +
    "ground a claim in a row, leave it out and say what you could not find - an unplaced claim is " +
    "worse to the caller than a gap, because the caller cannot check it.",
  model: DELEGATE_MODEL,
};

/** The relay gets the session's own turn budget, like every other lane, and the
 * prompt is the only thing steering it. A small cap was tried and it is a
 * hazard rather than a lever: a subagent cut off mid-question returns something
 * thin, the outer model spawns another, and each spawn re-pays the whole prompt
 * at the outer model's output rate. Measured three times on the same shape - at
 * 50 turns the outer model spawned twice, at 12 three times, at 4 it spawned
 * thirteen on one counting question for 911 seconds and twenty times the cost
 * of the same question uncapped. So capping the inner agent converts cheap
 * inner turns into expensive outer respawns, and CX_BENCH_INNER_MAX_TURNS
 * exists to reproduce that rather than to tune it. */
const RELAY_MAX_TURNS = SESSION_MAX_TURNS;

/** The same surface as `exploreDelegated` and the same model, differing only in
 * what it is told to do with them: spend one retrieval and then write. The
 * local primitives stay, because an exact string is a local lookup and going
 * to the platform for one would be absurd; what changes is that a question
 * spanning files goes to the platform's loop in a single call rather than
 * being taken apart into searches here. Measured on the same question, a
 * subagent left to its own judgment spent 26 calls, twelve of them repeated
 * searches, and cost eight times what the retrieval it was standing in for
 * costs inside the platform - so the instruction, not the tool set, is what
 * this lane changes. */
const exploreRelay = {
  description: DELEGATED_DESCRIPTION,
  tools: exploreDelegated.tools,
  prompt:
    "You answer one question about this repository and the caller sees only what you write. Spend one " +
    "retrieval on it, then write. If the question names an exact string, that is find. Anything that " +
    "spans files - how something works, where it is handled, what calls what - is explore, in one call, " +
    "with the question as it was asked: explore runs its own grounded loop over the index and comes back " +
    "with facts, a written answer and the queries behind it, so taking the question apart into searches " +
    "here does that work again more expensively. Then write the answer from the rows you have, with a " +
    "path:line citation from them on every claim, and leave out whatever you could not place - a claim " +
    "the caller cannot check is worse to it than a gap you name.",
  model: DELEGATE_MODEL,
};

/** Who fills the platform table's vectors when the caller does not pick: the
 * product default - the platform embeds - since the platform lanes measure the
 * product as shipped. CX_BENCH_EMBED_PROVIDER=local ships the local model's
 * vectors instead. */
export const DEFAULT_HOSTED_EMBED_PROVIDER = "platform";

/** The harness's own env for a platform lane: the database URL, the FILE
 * holding its key, and the optional provider override. The server takes these
 * as flags (--db, --api-key-file, --embed-provider), never from its
 * environment; these names carry the CX_BENCH_ prefix of the other harness
 * knobs so nothing the server could read is set by accident. */
export const BENCH_DB_URL = "CX_BENCH_DB_URL";
export const BENCH_KEY_FILE = "CX_BENCH_KEY_FILE";
export const BENCH_EMBED_PROVIDER = "CX_BENCH_EMBED_PROVIDER";
/** Optional turn cap for ask in the agent lanes, passed through as
 * the server's --subagent-max-turns; unset leaves the server's default. */
export const BENCH_AGENT_MAX_TURNS = "CX_BENCH_AGENT_MAX_TURNS";
/** Optional turn cap for the model inside a delegating lane's subagent. The
 * session's own budget is the default, so the subagent is not handicapped
 * against an outer model doing the same work; lowering it is how the lane
 * measures whether the inner model's turn count is the cost or the answer. */
export const BENCH_INNER_MAX_TURNS = "CX_BENCH_INNER_MAX_TURNS";
/** Optional facts-per-call for ask in the agent lanes, passed through as
 * the server's --subagent-k; unset leaves the server's default. */
export const BENCH_AGENT_K = "CX_BENCH_AGENT_K";

/** The env a platform lane needs before it can run. */
const HOSTED_REQUIRES = [BENCH_DB_URL, BENCH_KEY_FILE];

/** The harness's own env for the Snowflake lane, each name mapped onto the
 * variable of the same meaning that the Snowflake server and its REST client
 * read. The account, the user and the FILE holding the programmatic access
 * token are required; role, warehouse, database, schema and table are passed
 * only when set, so the client's defaults hold otherwise. As with the
 * platform key, the token travels as the path of its file: nothing here
 * reads it. */
export const BENCH_SF_ACCOUNT = "CX_BENCH_SF_ACCOUNT";
export const BENCH_SF_USER = "CX_BENCH_SF_USER";
export const BENCH_SF_TOKEN_FILE = "CX_BENCH_SF_TOKEN_FILE";
const SF_SERVER_ENV = {
  [BENCH_SF_ACCOUNT]: "SF_ACCOUNT",
  [BENCH_SF_USER]: "SF_USER",
  CX_BENCH_SF_ROLE: "SF_ROLE",
  CX_BENCH_SF_WAREHOUSE: "SF_WAREHOUSE",
  CX_BENCH_SF_DATABASE: "SF_DATABASE",
  CX_BENCH_SF_SCHEMA: "SF_SCHEMA",
  CX_BENCH_SF_TABLE: "SF_TABLE",
  [BENCH_SF_TOKEN_FILE]: "SF_TOKEN_FILE",
};
/** The env the Snowflake lane needs before it can run. */
const SNOWFLAKE_REQUIRES = [BENCH_SF_ACCOUNT, BENCH_SF_USER, BENCH_SF_TOKEN_FILE];
/** The Snowflake MCP server: a sibling of this file, started with node the
 * way the code-context server is. */
const SNOWFLAKE_MCP = join(BENCH, "snowflake-mcp.mjs");

/** Server env that is common to every MCP lane. Auto-sync is off in every
 * lane: the index is built before the run (load-hosted.mjs, which with --db
 * writes the local index and the platform table in one build) and a re-sync
 * mid-question would put a stat walk on the clock. */
export const mcpEnvBase = (repoDir, indexDir) => ({ CX_ROOT: repoDir, CX_INDEX_DIR: indexDir, CX_AUTO_SYNC: "0" });

/** The code-context server as the SDK starts it, for the lanes and for the
 * judge: this checkout's build, `cx mcp` plus the given flags, the given
 * server env over the process's. Without flags the server has the local index
 * alone (find, search, sql), which is what the judge verifies index-grain
 * counts against. */
export function cxServer(serverEnv, args = []) {
  return {
    "code-context": {
      command: "node",
      args: [CX, "mcp", ...args],
      // present in the turn-1 prompt (not deferred behind tool search),
      // and startup blocks until connected - no race on the first call
      alwaysLoad: true,
      env: { ...process.env, ...serverEnv },
    },
  };
}

/** The SF_* variables the Snowflake REST client reads, filled from the
 * harness's CX_BENCH_SF_* variables in the given env: only the ones that are
 * set, so the client's default holds for the rest. One mapping for the lane's
 * server and for the loader, so the same exported CX_BENCH_SF_* line
 * configures both. The token reaches either as the path of its file
 * (SF_TOKEN_FILE), never as a value. */
export function snowflakeServerEnv(env = process.env) {
  const serverEnv = {};
  for (const [bench, sf] of Object.entries(SF_SERVER_ENV)) if (env[bench]) serverEnv[sf] = env[bench];
  return serverEnv;
}

/** The Snowflake MCP server as the SDK starts it, in the code-context
 * server's place: bench/snowflake-mcp.mjs under the name "snowflake", so its
 * tools reach the model as mcp__snowflake__<tool>. It is configured through
 * its environment - the SF_* names its REST client reads - laid over the
 * given env by snowflakeServerEnv. */
export function snowflakeServer(env = process.env) {
  return {
    snowflake: {
      command: "node",
      args: [SNOWFLAKE_MCP],
      // as for the code-context server: in the turn-1 prompt, and startup
      // blocks until connected
      alwaysLoad: true,
      env: { ...env, ...snowflakeServerEnv(env) },
    },
  };
}

/** The server flags that name the platform database: the same for the MCP
 * server of a platform lane and for the `cx index` of load-hosted.mjs, so the
 * table is loaded the way the lane's tools expect it. With --db the server
 * registers the ask and explore tools; find, search and sql read the
 * local index either way. The key travels as the path of its file; nothing
 * here reads it. */
export function hostedFlags(env = process.env) {
  return [
    "--db",
    env[BENCH_DB_URL],
    "--api-key-file",
    env[BENCH_KEY_FILE],
    "--embed-provider",
    env[BENCH_EMBED_PROVIDER] ?? DEFAULT_HOSTED_EMBED_PROVIDER,
  ];
}

/** The turn budget of the model inside a delegating lane's subagent: the
 * session's own unless the harness names a lower one. Recorded per run by the
 * lane's own definition, so a row's inner cost can be read against the cap
 * that produced it. */
export function innerMaxTurns(env = process.env, fallback = SESSION_MAX_TURNS) {
  const named = Number(env[BENCH_INNER_MAX_TURNS]);
  return Number.isFinite(named) && named > 0 ? named : fallback;
}

/** The server flags that cap the agent tools, when the harness names a turn
 * cap or a facts-per-call; empty otherwise (the tools themselves come with
 * --db). */
export function agentFlags(env = process.env) {
  const cap = env[BENCH_AGENT_MAX_TURNS];
  const k = env[BENCH_AGENT_K];
  return [...(cap ? ["--subagent-max-turns", cap] : []), ...(k ? ["--subagent-k", k] : [])];
}

/** The lane table. Each lane is the identical hermetic base plus:
 *   kind      "local" (the server has the local index alone), "hosted" (the
 *             server also has the platform database, where the ask and
 *             explore tools run) or "snowflake" (the Snowflake server in the
 *             code-context server's place) - recorded on every row as laneKind
 *   tools     the built-in tools the agent gets
 *   mcp       whether an MCP server is attached
 *   server    the MCP servers to attach (repoDir, indexDir, env) => object,
 *             for a lane whose server is not code-context; absent, the lane
 *             gets the code-context server built from env and args
 *   env       server env for the code-context lanes (repoDir, indexDir) => object
 *   args      extra flags for the server command line (env) => string[]
 *   disallowedTools  MCP tool names the SDK removes from the model's context
 *   agents    subagent definitions by name; a built-in name (Explore) is overridden
 *   requires  harness env vars that must be set before the lane can run
 *
 *   files      - stock file tools only
 *   cx         - the MCP tools plus Read (retrieval via the index)
 *   combo      - both, which is what installing the MCP server actually
 *                produces in a real client
 *   hosted     - combo with the platform database configured, and the
 *                ask and explore tools it brings hidden: the three
 *                local tools alone, as a control for the lanes below
 *   hosted-agent - combo plus the ask tool (the platform's own agent
 *                  loop); explore hidden
 *   agent-only - Read plus ask alone: find, search and sql are
 *                hidden, so every retrieval goes through the platform's agent.
 *                Measures that agent's answers and cost in isolation - not how
 *                often a model would choose it (hosted-agent measures that).
 *   stock-explore    - files plus the Agent tool with the built-in Explore
 *                      subagent: pure Sonnet as a real session has it
 *   index-explore    - stock-explore plus the MCP server, with Explore
 *                      overridden to run on code-context's tools (Haiku inside)
 *   hosted-full-remote - hosted-full with `search` reading the hosted index as
 *                      well, so nothing in the lane reads the old local
 *                      vectors. hosted-full's own `search` is local, which
 *                      means every hosted-full row ever recorded did part of
 *                      its index work on the 384-dim local index; this lane is
 *                      the comparison that actually prices the hosted index
 *                      for the full surface
 *   hosted-index     - the stock tools plus find/search/sql over the HOSTED
 *                      index, read by the session model itself: no subagent,
 *                      no platform loop, `ask` and `explore` hidden. The
 *                      `hosted` lane with CX_REMOTE_SEARCH, so the pair
 *                      prices the hosted index against the local one with
 *                      nothing else moving - and if neither decider earns its
 *                      cost, this lane is the product
 *   hosted-index-explore - index-explore reading the PLATFORM's index: the same
 *                      Haiku subagent with the same find/search/sql, but
 *                      `search` goes to the hosted table (CX_REMOTE_SEARCH),
 *                      and the platform's `ask` and `explore` are hidden from
 *                      both levels. It separates the two things every other
 *                      hosted lane moves together - the index and the decider
 *                      - by keeping the index and removing the decider.
 *                      Against `index-explore` it prices the index alone (same
 *                      brain, better vectors); against `hosted-full` it prices
 *                      the decider alone (same index, cheap brain)
 *   platform-explore - the same with the platform database, with Explore
 *                      overridden to run on the explore tool alone (the
 *                      platform's explore mode: reads, follows, answers)
 *   find-subagent    - stock tools, find, and ask (the tool was named
 *                      subagent when the lane was; the lane keeps its name
 *                      so its rows stay comparable), with search, sql and
 *                      explore hidden. Exact-text questions have find;
 *                      everything that spans the repo has the platform's
 *                      agent, which returns the rows it retrieved
 *   find-explore     - find-subagent with explore in ask's place: the
 *                      main agent asks the platform's explore mode directly
 *                      and gets a written answer beside the facts
 *   hosted-full      - everything at once: the stock tools plus all five
 *                      code-context tools, nothing hidden. The other hosted
 *                      lanes each remove something to isolate it; this one
 *                      asks the opposite question - given the whole surface,
 *                      what does the model reach for, and does more choice
 *                      help or confuse? (The `find`/`explore` lanes hide
 *                      `search` and `sql`, which are the local instruments
 *                      for questions by meaning and for counts.)
 *   hosted-full-agent - hosted-full plus the Agent tool, with Explore left
 *                      exactly as Claude Code ships it: no override, so its
 *                      built-in Explore keeps whatever tools a real session
 *                      would give it (the full cx surface, since mcp is on),
 *                      beside the outer model holding that same surface
 *                      itself. Unlike `delegated`, nothing about Explore's
 *                      definition is touched - this measures the free choice
 *                      a real client actually offers: retrieve directly, or
 *                      spawn Explore, with neither path special-cased
 *   delegated        - hosted-full plus the Agent tool, with Explore
 *                      overridden to run the whole code-context surface with
 *                      the mid-tier model inside. The outer model can retrieve
 *                      for itself or hand a repository-spanning question to a
 *                      model that only retrieves; the lane measures which it
 *                      does when both are offered, and what the answers cost
 *                      when the reading happens a level down
 *   delegated-forced - the same split with the choice removed: the outer model
 *                      has the Agent tool and nothing else, and the server
 *                      travels on the subagent rather than in the session, so
 *                      every retrieval happens a level down by construction.
 *                      `delegated` measures whether a model picks the split;
 *                      this one prices the split itself
 *   delegated-relay  - delegated-forced with the retrieving put back where it
 *                      is cheap: same outer surface, same subagent tools and
 *                      model, but told to spend one retrieval and then write,
 *                      on a relay's turn budget. The pair isolates what the
 *                      layer in the middle costs when it retrieves against
 *                      what it costs when it only writes
 *   snowflake        - the stock tools plus the Snowflake server in the
 *                      index's place: the same outer model with Snowflake as
 *                      the index - keyword search and SQL over the chunks
 *                      table, no semantic ranking on this account. Measures
 *                      what a warehouse gives the same agent, next to the
 *                      lanes above */
export const LANES = {
  files: { kind: "local", tools: STOCK_TOOLS, mcp: false, requires: [] },
  cx: { kind: "local", tools: ["Read"], mcp: true, env: mcpEnvBase, requires: [] },
  combo: { kind: "local", tools: STOCK_TOOLS, mcp: true, env: mcpEnvBase, requires: [] },
  hosted: {
    kind: "hosted",
    tools: STOCK_TOOLS,
    mcp: true,
    env: mcpEnvBase,
    args: hostedFlags,
    disallowedTools: ["ask", "explore"].map((tool) => `${CX_TOOL_PREFIX}${tool}`),
    requires: HOSTED_REQUIRES,
  },
  "hosted-agent": {
    kind: "hosted",
    tools: STOCK_TOOLS,
    mcp: true,
    env: mcpEnvBase,
    args: (env) => [...hostedFlags(env), ...agentFlags(env)],
    disallowedTools: [`${CX_TOOL_PREFIX}explore`],
    requires: HOSTED_REQUIRES,
  },
  "hosted-full": {
    kind: "hosted",
    tools: STOCK_TOOLS,
    mcp: true,
    env: mcpEnvBase,
    args: (env) => [...hostedFlags(env), ...agentFlags(env)],
    requires: HOSTED_REQUIRES,
  },
  "hosted-full-agent": {
    kind: "hosted",
    tools: [...STOCK_TOOLS, AGENT_TOOL],
    mcp: true,
    env: mcpEnvBase,
    args: (env) => [...hostedFlags(env), ...agentFlags(env)],
    requires: HOSTED_REQUIRES,
  },
  "agent-only": {
    kind: "hosted",
    tools: ["Read"],
    mcp: true,
    env: mcpEnvBase,
    args: (env) => [...hostedFlags(env), ...agentFlags(env)],
    disallowedTools: [...CX_RETRIEVAL_TOOLS, "explore"].map((tool) => `${CX_TOOL_PREFIX}${tool}`),
    requires: HOSTED_REQUIRES,
  },
  "stock-explore": { kind: "local", tools: [...STOCK_TOOLS, AGENT_TOOL], mcp: false, requires: [] },
  "index-explore": {
    kind: "local",
    tools: [...STOCK_TOOLS, AGENT_TOOL],
    mcp: true,
    env: mcpEnvBase,
    agents: { [EXPLORE]: exploreOnIndex },
    requires: [],
  },
  "hosted-full-remote": {
    kind: "hosted",
    tools: STOCK_TOOLS,
    mcp: true,
    // hosted-full with `search` reading the hosted index too. It is a separate
    // lane and not a change to hosted-full because that name carries 734
    // recorded rows: hosted-full's `search` has always read the LOCAL index,
    // so every one of those rows did a third of its index work on the old
    // 384-dim vectors, and switching what the name means would reinterpret
    // them all. This lane is the honest "the whole surface, all of it hosted".
    env: (repoDir, indexDir) => ({ ...mcpEnvBase(repoDir, indexDir), CX_REMOTE_SEARCH: "1" }),
    args: (env) => [...hostedFlags(env), ...agentFlags(env)],
    requires: HOSTED_REQUIRES,
  },
  "hosted-index": {
    kind: "hosted",
    tools: STOCK_TOOLS,
    mcp: true,
    // The hosted index read by the SESSION model directly - no subagent, no
    // platform loop. If the index is what carries the value and neither
    // decider earns its cost, this is the whole product: three tools over a
    // hosted table. It is the `hosted` lane plus CX_REMOTE_SEARCH, and the
    // pair prices the index against the local one with nothing else moving.
    env: (repoDir, indexDir) => ({ ...mcpEnvBase(repoDir, indexDir), CX_REMOTE_SEARCH: "1" }),
    args: hostedFlags,
    disallowedTools: ["ask", "explore"].map((tool) => `${CX_TOOL_PREFIX}${tool}`),
    requires: HOSTED_REQUIRES,
  },
  "hosted-index-explore": {
    kind: "hosted",
    tools: [...STOCK_TOOLS, AGENT_TOOL],
    mcp: true,
    // CX_REMOTE_SEARCH makes `search` read the platform's index instead of the
    // local one. Without it this lane would be `index-explore` with a `--db`
    // flag that changes nothing a searcher can see: `find` and `sql` are local
    // by construction, and `search` was too, so the subagent would sit on the
    // local MiniLM index while the lane's name claimed otherwise. Measured
    // that way once by mistake — the platform served zero queries for the
    // whole run, which is the only reason it was caught.
    env: (repoDir, indexDir) => ({ ...mcpEnvBase(repoDir, indexDir), CX_REMOTE_SEARCH: "1" }),
    args: hostedFlags,
    disallowedTools: ["ask", "explore"].map((tool) => `${CX_TOOL_PREFIX}${tool}`),
    agents: { [EXPLORE]: exploreOnIndex },
    requires: HOSTED_REQUIRES,
  },
  "platform-explore": {
    kind: "hosted",
    tools: [...STOCK_TOOLS, AGENT_TOOL],
    mcp: true,
    env: mcpEnvBase,
    args: (env) => [...hostedFlags(env), ...agentFlags(env)],
    agents: { [EXPLORE]: exploreOnPlatform },
    requires: HOSTED_REQUIRES,
  },
  delegated: {
    kind: "hosted",
    // The outer model keeps everything a real session gives it - shell, file
    // search, and all five code-context tools - and gets the Agent tool with
    // an Explore that runs on the index underneath. Nothing is hidden, because
    // what the offer draws is the thing being measured: a model that picks
    // `find` over `grep` with both in front of it should also pick an explorer
    // whose description says it runs find, and if it does not, that is the
    // result rather than a reason to confiscate the alternatives. A shape that
    // only holds when the other tools are taken away would not survive
    // shipping, where nothing can be taken away.
    tools: [...STOCK_TOOLS, AGENT_TOOL],
    mcp: true,
    env: mcpEnvBase,
    args: (env) => [...hostedFlags(env), ...agentFlags(env)],
    agents: { [EXPLORE]: exploreDelegated },
    requires: HOSTED_REQUIRES,
  },
  "delegated-forced": {
    kind: "hosted",
    // The outer model's only built-in is the one that spawns the subagent, and
    // the lane registers no session-level server, so nothing but the subagent
    // can reach the index. This is the shape `delegated` measures the *choice*
    // of; this lane removes the choice so the architecture can be priced on
    // its own - what it costs when the retrieving happens a level down, and
    // the outer model only reads a written answer and digests it.
    tools: [AGENT_TOOL],
    // No session-level server. The tools are not denied to the session - they
    // were never registered in it - which is what leaves the subagent's own
    // copy reachable. Denying them would have been the obvious route and it is
    // the wrong one: `disallowedTools` is a session-level list, and whether it
    // also reaches a subagent that names the tool itself is unestablished.
    mcp: false,
    // The server travels on the subagent instead, so the index is one level
    // down by construction rather than by the model's good judgment.
    agents: (repoDir, indexDir) => ({
      [EXPLORE]: {
        ...exploreDelegated,
        mcpServers: [cxServer(mcpEnvBase(repoDir, indexDir), [...hostedFlags(), ...agentFlags()])],
        // The session's own budget by default, so a short inner run is the
        // model's choice and not a cap the lane imposed on one side of the
        // comparison. CX_BENCH_INNER_MAX_TURNS lowers it, which is the one
        // knob that changes the inner model's token volume directly.
        maxTurns: innerMaxTurns(),
      },
    }),
    requires: HOSTED_REQUIRES,
  },
  "delegated-relay": {
    kind: "hosted",
    // `delegated-forced` with the retrieving put back where it is cheap. Same
    // outer surface, same subagent tools, same subagent model: the only
    // differences are the subagent's prompt and its turn budget, so the pair
    // isolates one thing - what the layer in the middle costs when it
    // retrieves for itself, against what it costs when it spends one call on
    // the platform's loop and writes the answer.
    tools: [AGENT_TOOL],
    mcp: false,
    agents: (repoDir, indexDir) => ({
      [EXPLORE]: {
        ...exploreRelay,
        mcpServers: [cxServer(mcpEnvBase(repoDir, indexDir), [...hostedFlags(), ...agentFlags()])],
        maxTurns: innerMaxTurns(process.env, RELAY_MAX_TURNS),
      },
    }),
    requires: HOSTED_REQUIRES,
  },
  "find-subagent": {
    kind: "hosted",
    tools: STOCK_TOOLS,
    mcp: true,
    env: mcpEnvBase,
    args: (env) => [...hostedFlags(env), ...agentFlags(env)],
    disallowedTools: ["search", "sql", "explore"].map((tool) => `${CX_TOOL_PREFIX}${tool}`),
    requires: HOSTED_REQUIRES,
  },
  "find-explore": {
    kind: "hosted",
    tools: STOCK_TOOLS,
    mcp: true,
    env: mcpEnvBase,
    args: (env) => [...hostedFlags(env), ...agentFlags(env)],
    disallowedTools: ["search", "sql", "ask"].map((tool) => `${CX_TOOL_PREFIX}${tool}`),
    requires: HOSTED_REQUIRES,
  },
  snowflake: {
    kind: "snowflake",
    tools: STOCK_TOOLS,
    mcp: true,
    server: (_repoDir, _indexDir, env) => snowflakeServer(env),
    requires: SNOWFLAKE_REQUIRES,
  },
};

/** The lane definition for a name; an unknown name is a usage error, not a
 * silent fall-through to the files lane (which used to make a typo look like
 * a real baseline run). */
export function laneDef(lane) {
  const def = LANES[lane];
  if (!def) throw new Error(`unknown lane "${lane}" - one of: ${Object.keys(LANES).join(", ")}`);
  return def;
}

/** Fail fast, before any model call is paid for, when a lane's required env
 * is missing. Names only - the values are credentials. */
export function checkLaneEnv(lane, env = process.env) {
  const missing = laneDef(lane).requires.filter((name) => !env[name]);
  if (missing.length) {
    throw new Error(`lane "${lane}" needs ${missing.join(" and ")} in the environment (${missing.length === 1 ? "it is" : "they are"} not set)`);
  }
}

/** The host of the platform database a hosted lane targets - host only, never
 * the key and never the path; null for a local lane or when unset. */
export function dbHost(lane, env = process.env) {
  if (laneDef(lane).kind !== "hosted" || !env[BENCH_DB_URL]) return null;
  try {
    return new URL(env[BENCH_DB_URL]).host;
  } catch {
    return null;
  }
}

/** The MCP servers a lane attaches, from its own definition: the lane's
 * `server` when it names one, else the code-context server with the lane's
 * env and flags. */
function laneServers(def, repoDir, indexDir, env = process.env) {
  if (def.server) return def.server(repoDir, indexDir, env);
  return cxServer(def.env(repoDir, indexDir), def.args?.(env) ?? []);
}

/** Lane options: identical hermetic base; only the toolset and, for a hosted
 * lane, the server's command line differ (and for the Snowflake lane, the
 * server itself). */
export function laneOptions(lane, repoDir, indexDir) {
  const def = laneDef(lane);
  checkLaneEnv(lane);
  const hermetic = {
    cwd: repoDir,
    // The repository's own instructions and skills (CLAUDE.md / AGENTS.md,
    // `.claude/skills/`) load for EVERY arm, as they do in any session opened
    // in that checkout: they are the developer's context, not part of either
    // side of the comparison (owner, 2026-09-11: "claude.md and skills we
    // should send those to all 3"). Infino's CLAUDE.md is a 28 KB map of the
    // source tree, exactly what a developer's agent reads before it greps;
    // `[]` withheld it from every arm until 2026-09-11 and made the grep arm
    // slower than the real thing. Project scope only: no user settings, so
    // nothing from this machine's configuration reaches a run; and the
    // bench repositories carry no `.claude/settings.json`, so no hooks or
    // permission rules ride in - a repository that did would need them read
    // before it was benchmarked.
    //
    // What DOES differ between the two kinds of arm is the system prompt,
    // decided in `runLane`: Claude without infino gets Claude Code's own,
    // Claude with infino gets the prompt infino ships.
    settingSources: ["project"],
    strictMcpConfig: true,
    tools: def.tools,
    // A lane's `agents` may be a factory rather than a literal, because a
    // subagent that carries its own MCP server has to be handed the run's
    // paths and env to build the server's command line. The factory runs here,
    // in the hermetic base, so it is available whether or not the lane also
    // registers a session-level server.
    ...(def.agents ? { agents: typeof def.agents === "function" ? def.agents(repoDir, indexDir) : def.agents } : {}),
  };
  if (!def.mcp) return hermetic;
  return {
    ...hermetic,
    // The SDK drops disallowed tools from the model's context entirely (not a
    // permission denial the model would see), which is what makes a forced
    // lane a fair measurement: the hidden tools cost no prompt text either.
    ...(def.disallowedTools ? { disallowedTools: def.disallowedTools } : {}),
    mcpServers: laneServers(def, repoDir, indexDir),
  };
}

/** A tool name as the row records it: an MCP tool's SDK prefix shortened
 * (mcp__code-context__sql -> cx:sql, mcp__snowflake__sql -> sf:sql), a
 * built-in's name unchanged. */
export function shortToolName(name) {
  for (const [long, short] of TOOL_PREFIXES) if (name.startsWith(long)) return `${short}${name.slice(long.length)}`;
  return name;
}
export const isCxTool = (shortName) => shortName.startsWith(CX_SHORT_PREFIX);
export const isSfTool = (shortName) => shortName.startsWith(SF_SHORT_PREFIX);
/** A tool of either MCP server: the ones whose result carries the took_ms
 * and usage telemetry, and whose input is a query the answer was built on. */
export const isMcpTool = (shortName) => isCxTool(shortName) || isSfTool(shortName);

/** The text a tool returned, from the structured `tool_use_result` the SDK
 * attaches to the user message when it has one (for an MCP tool that is the
 * server's own {content:[{type:"text",text}]} output), else from the
 * tool_result block's content (a string, or text blocks). null when neither
 * carries text. */
export function toolResultText(block, toolUseResult) {
  const fromBlocks = (content) => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const texts = content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text);
      return texts.length ? texts.join("\n") : null;
    }
    return null;
  };
  const structured = toolUseResult && typeof toolUseResult === "object" ? fromBlocks(toolUseResult.content) : null;
  return structured ?? fromBlocks(block?.content);
}

/** The per-call telemetry of one code-context result: the server-side
 * took_ms and the one-line usage receipt, both fields of the JSON the tool
 * returns, and the queries the platform ran for the call - `sql`, the
 * statement whose rows an ask result holds, and `chain`, every query an
 * exploration ran - so a judge can rerun what the answer was built on. The
 * Snowflake server's results carry took_ms and usage the same way, so the
 * same parse serves its tools. A result that is not JSON (an error message)
 * yields nulls and no queries; the call is still counted. */
export function parseCxResult(text) {
  const none = { tookMs: null, usage: null, queries: [] };
  if (typeof text !== "string") return none;
  try {
    const v = JSON.parse(text);
    const queries = [];
    if (typeof v?.sql === "string" && v.sql.length > 0) queries.push(v.sql);
    if (Array.isArray(v?.chain)) {
      for (const q of v.chain) if (typeof q === "string" && q.length > 0 && !queries.includes(q)) queries.push(q);
    }
    return {
      tookMs: typeof v?.took_ms === "number" ? v.took_ms : null,
      usage: typeof v?.usage === "string" ? v.usage : null,
      queries,
    };
  } catch {
    return none;
  }
}

/** The most characters of one string field of a tool's input that a result
 * row keeps: long enough for any statement, short enough that a shell
 * heredoc or a pasted file does not become the row. */
const INPUT_CHARS_KEPT = 4000;

/** A tool call's input as the row keeps it: the object as given, each string
 * field cut at INPUT_CHARS_KEPT with its full length noted. Anything that is
 * not an object (the SDK gives one) is kept as is. */
export function keepInput(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
  const kept = {};
  for (const [k, v] of Object.entries(input)) {
    kept[k] = typeof v === "string" && v.length > INPUT_CHARS_KEPT ? `${v.slice(0, INPUT_CHARS_KEPT)}... (${v.length} chars)` : v;
  }
  return kept;
}

/** The queries a run made through an MCP server, one line each, in the order
 * it made them: the call's input (the sql statement with its embed map, the
 * find literal, the search query, the question put to ask or explore)
 * and, indented under a platform call, each statement the platform ran for
 * it. A code-context call is listed by its bare tool name; a Snowflake call
 * keeps its `sf:` prefix, so a reader (the judge, which reruns the
 * code-context queries on the index) can tell `sf:sql` from `sql`. Rows
 * written before inputs were kept yield nothing. */
export function recordedQueries(toolDetails) {
  const lines = [];
  for (const d of toolDetails ?? []) {
    if (!isMcpTool(d.name) || d.input === undefined) continue;
    const label = isCxTool(d.name) ? d.name.slice(CX_SHORT_PREFIX.length) : d.name;
    lines.push(`${label} ${JSON.stringify(d.input)}`);
    for (const q of d.queries ?? []) lines.push(`  ran: ${q}`);
  }
  return lines;
}

/** Fold one SDK message into the per-run tool accounting. Assistant messages
 * carry the tool_use blocks (name + id); the user messages the CLI emits
 * carry the matching tool_result blocks, so the id joins the two. A message
 * with parent_tool_use_id set came from inside a subagent: its calls are
 * counted like any other and marked, and an Agent call records which
 * subagent type it spawned. Exported so the parsing is testable without a
 * model.
 *
 * `batch` tags every call with which assistant message it came from
 * (`acc.batchSeq`, incremented once per message that carries at least one
 * tool_use block). This is the ONLY sound way to detect fan-out: several
 * tool_use blocks in ONE assistant message are the model choosing to run them
 * concurrently, and the SDK does. `toolCalls`/`toolDetails` is one flat list
 * across the whole run, outer and every subagent's calls interleaved in
 * stream order - runs of consecutive entries in that list do NOT mean
 * concurrent messages, because a subagent's own calls land between an outer
 * batch's entries. Group by (`batch`, `inSubagent`) instead of by adjacency.
 *
 * `now` is the caller's clock, in milliseconds since the run began. Pass it and
 * every call gets `startedAt` when its tool_use is folded and `endedAt` when its
 * result comes back - a WALL span, which is the only timing a built-in tool has
 * (`tookMs` is the MCP servers' own and is null for Read, Grep, Bash and the
 * rest). Omit it and the details are byte-for-byte what they were before, which
 * is what keeps the recorded rows and their tests unchanged. The end stamp is
 * when the result message was folded, so it is an upper bound on the call.
 *
 * Returns the details this message started and ended, so a caller streaming the
 * run can emit an event per transition without re-deriving which block was
 * which. Nothing in the harness reads it. */
export function foldToolMessage(acc, m, now) {
  const started = [];
  const ended = [];
  if (m.type === "assistant") {
    const inSubagent = Boolean(m.parent_tool_use_id);
    const batch = acc.batchSeq;
    let sawToolUse = false;
    for (const b of m.message?.content ?? []) {
      if (b.type === "tool_use") {
        sawToolUse = true;
        const name = shortToolName(b.name);
        acc.toolCalls.push(name);
        // The input is kept for every call, so the queries an answer was
        // built on can be rerun by whoever grades it.
        const detail = { name, input: keepInput(b.input), tookMs: null, usage: null, batch, ...(inSubagent ? { inSubagent: true } : {}), ...(now === undefined ? {} : { startedAt: now }) };
        acc.toolDetails.push(detail);
        started.push(detail);
        if (b.id) acc.pending.set(b.id, detail);
        if (inSubagent) acc.subagentCalls++;
        if (b.name === AGENT_TOOL) acc.subagents.push(typeof b.input?.subagent_type === "string" ? b.input.subagent_type : "?");
      }
    }
    if (sawToolUse) acc.batchSeq++;
  }
  if (m.type === "user") {
    const content = m.message?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b.type !== "tool_result") continue;
      const detail = acc.pending.get(b.tool_use_id);
      if (!detail) continue;
      acc.pending.delete(b.tool_use_id);
      // Stamped before the MCP-only branch below, because the wall span is the
      // whole point for a built-in tool: Read, Grep and Bash have no `tookMs`.
      if (now !== undefined) detail.endedAt = now;
      ended.push(detail);
      if (b.is_error) detail.isError = true;
      if (!isMcpTool(detail.name)) continue;
      const parsed = parseCxResult(toolResultText(b, m.tool_use_result));
      detail.tookMs = parsed.tookMs;
      detail.usage = parsed.usage;
      if (parsed.queries.length) detail.queries = parsed.queries;
    }
  }
  return { started, ended };
}

export const newToolAccounting = () => ({ toolCalls: [], toolDetails: [], pending: new Map(), subagentCalls: 0, subagents: [], batchSeq: 0 });

/** Sum of the server-side took_ms over the calls of one server's tools in a
 * run - that server's work inside the question's wall clock. */
const tookMsOf = (toolDetails, isTool) => Math.round(toolDetails.reduce((n, d) => n + (isTool(d.name) && d.tookMs ? d.tookMs : 0), 0));
/** The code-context calls' share - the engine work - unchanged in meaning for
 * every lane that has the server. */
export const cxTookMs = (toolDetails) => tookMsOf(toolDetails, isCxTool);
/** The Snowflake calls' share: the warehouse's work, 0 in every other lane. */
export const sfTookMs = (toolDetails) => tookMsOf(toolDetails, isSfTool);

/** What every lane tells the model before the question, in one place.
 *
 * The runner and the demo drive the same lanes against the same repository, so
 * a second copy of this text is a second experiment: the moment one is edited
 * the demo stops showing what the bench measured, and nothing fails to say so.
 * `run-questions.mjs` appends the table card to it when CX_CARD_TIER asks for
 * one; the base is shared.
 *
 * CHANGED 2026-09-10/11; every figure recorded before then was measured on a
 * wording that closed with "Be efficient: prefer few, well-chosen tool calls"
 * and nothing about issuing them together. Across 622 recorded runs no
 * assistant message ever carried two tool calls, so the caller was serial by
 * habit. The first rewrite dropped "prefer few" and asked for independent
 * lookups in one turn; the caller did fan out - at its OWN retrieval: on the
 * subagents arm Sonnet ran `explore` and then four `search` calls and a Read
 * on top, 126 s against 44 s for the index-only arm. So both halves are
 * here: few calls, and a sweep handed to the tool built for it, AND the
 * independent ones issued together. A run under this wording is not
 * comparable to the recorded set; the baseline has to be re-run beside it. */
/** The efficiency guidance every lane gets, whatever the corpus is. One
 * constant so the code prompt and the data prompt below cannot drift apart on
 * the part the measurement is about. */
const PROMPT_EFFICIENCY =
  `Be efficient: prefer few, well-chosen tool calls, and hand a sweep across many files to a tool ` +
  `built for it rather than searching by hand. When two or more calls do not depend on each other, ` +
  `issue them in the SAME turn rather than one after another - the wait is then the slowest of them ` +
  `instead of their sum.`;

export const systemPrompt = (repoDir) =>
  `You answer questions about the repository checked out at ${repoDir}. ` +
  `Use the available tools to find the answer. Cite file paths (with line ranges when you have them). ` +
  PROMPT_EFFICIENCY;

/** The same prompt for a corpus that is records rather than code - a table of
 * job postings, say - which sits at `dir` as data files (one record per line)
 * and in the hosted table the search tools read. Only the framing and the
 * citation unit change: a record is cited by its id or a file path with line
 * numbers, not by a symbol. The efficiency text is the shared constant, so a
 * data run is measured under the same instructions as a code run. */
export const dataSystemPrompt = (dir, subject) =>
  `You answer questions about ${subject}, held at ${dir} as data files and in the table the search tools read. ` +
  `Use the available tools to find the answer. Cite the records you relied on - an id or a title, ` +
  `or a file path with line numbers when you have one. ` +
  PROMPT_EFFICIENCY;

/** Run one agent conversation; returns the measured record.
 *
 * `onEvent`, when given, is called as the run happens rather than after it:
 * `{at, kind, name, batch, inSubagent}` for every tool call that starts and
 * every one that ends, `at` in milliseconds since this run began. It is how a
 * live page draws a bar while the answer is still being written; every caller
 * that does not pass it gets exactly the behaviour it had before. A throwing
 * callback must not take the run down with it - the run is the expensive
 * thing - so each call is guarded. */
export async function runLane({ lane, prompt, system, repoDir, indexDir, maxTurns = SESSION_MAX_TURNS, onEvent }) {
  const t0 = performance.now();
  const acc = newToolAccounting();
  const emit = onEvent
    ? (event) => {
        try {
          onEvent(event);
        } catch {
          /* a listener's fault is not the run's */
        }
      }
    : null;
  let usage = null;
  let costUsd = null;
  let modelUsage = null;
  let durationApiMs = null;
  let answer = "";
  let error = null;
  try {
    for await (const m of query({
      prompt,
      options: {
        model: MODEL,
        maxTurns,
        // A bare string here is a CUSTOM prompt: the SDK drops Claude Code's
        // default system prompt entirely, and with it Claude Code's guidance
        // on its own tools - when to hand an open-ended search to Explore,
        // when to batch independent calls, how Grep, Glob and Read are meant
        // to be used.
        //
        // Claude WITHOUT infino (no MCP server) therefore gets the preset
        // with the bench text appended: the session a developer actually
        // has. Until 2026-09-11 it ran on the bare string, which is why the
        // grep arm was slower than the real thing; every grep figure recorded
        // before that date is a handicapped one. Claude WITH infino keeps the
        // bare string: that prompt is part of what infino ships - it is
        // where the caller is told to spawn parallel workers and to reach for
        // hybrid search first - and the owner wants it as infino chooses, not
        // as stock Claude has it ("we should keep our custom prompts").
        // Project instructions and skills reach both kinds alike; see
        // `laneOptions`.
        systemPrompt: laneDef(lane).mcp ? system : { type: "preset", preset: "claude_code", append: system },
        permissionMode: "bypassPermissions",
        env: { ...process.env, IS_SANDBOX: "1" },
        ...laneOptions(lane, repoDir, indexDir),
      },
    })) {
      const at = Math.round(performance.now() - t0);
      const { started, ended } = foldToolMessage(acc, m, at);
      if (emit) {
        for (const d of started) emit({ at, kind: "tool_start", name: d.name, batch: d.batch, inSubagent: Boolean(d.inSubagent) });
        for (const d of ended) emit({ at, kind: "tool_end", name: d.name, batch: d.batch, inSubagent: Boolean(d.inSubagent) });
      }
      if (m.type === "assistant") {
        for (const b of m.message.content ?? []) {
          if (b.type === "text") answer = b.text;
        }
      }
      if (m.type === "result") {
        usage = m.usage ?? null;
        costUsd = m.total_cost_usd ?? null;
        // The SDK's own split of the run: time spent waiting on the model API
        // against total. A second, independent estimate of the model share, so
        // the bar drawn from tool spans can be checked rather than trusted.
        durationApiMs = m.duration_api_ms ?? null;
        // `usage` is the main loop alone; `modelUsage` is every model call the
        // run made, subagents included, and carries a cost per model. It is
        // the only field that separates what the outer model spent from what
        // the model underneath spent, which is the whole question a delegating
        // lane asks.
        modelUsage = m.modelUsage ?? null;
        if (m.result) answer = m.result;
      }
    }
  } catch (err) {
    error = String(err?.message ?? err).slice(0, 300);
  }
  const u = usage ?? {};
  const tokens =
    (u.input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.output_tokens ?? 0);
  const { toolCalls, toolDetails, subagentCalls, subagents } = acc;
  return {
    lane,
    laneKind: laneDef(lane).kind,
    dbHost: dbHost(lane),
    model: MODEL,
    build: BUILD,
    cli: CX,
    tokens,
    usage: u,
    costUsd,
    modelUsage,
    durationApiMs,
    wallMs: Math.round(performance.now() - t0),
    toolCalls,
    toolDetails,
    cxTookMs: cxTookMs(toolDetails),
    sfTookMs: sfTookMs(toolDetails),
    calls: toolCalls.length,
    // Calls made inside subagents (a subset of `calls`) and the subagent
    // types the main agent spawned, in order - the delegation signal.
    subagentCalls,
    subagents,
    answer,
    error,
    ts: new Date().toISOString(),
  };
}

export function record(file, obj) {
  mkdirSync(RESULTS, { recursive: true });
  appendFileSync(join(RESULTS, file), JSON.stringify(obj) + "\n");
}
