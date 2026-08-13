#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// code-context enforcement hook: steer code search to the sql tool without
// trapping the agent.
//
// Grep (the tool, or a standalone grep/rg/git-grep Bash command) is denied
// with a redirect to the sql TVFs ONLY when all of these hold:
//   - the repo's index is fully live: manifest present, vectors "ready",
//     nothing truncated by the file cap, and the table actually on disk
//     (a manifest orphaned by a deleted table fails open);
//   - the index actually contains what the command searches. Coverage is
//     never re-derived from the indexer's skip rules: any drift between the
//     hook's model and the indexer's behaviour denies grep on a file sql
//     cannot answer for either, which costs the agent both paths. The covered
//     file set is read straight out of `.infino/filestate.json`, which every
//     build and sync writes - keys whose entry recorded zero chunk rows are
//     dropped, because that state fingerprints files it could not chunk
//     (binary bytes behind an indexable extension, an empty `__init__.py`) and
//     the table holds no rows for them;
//   - the command does not carry the CX_GREP_FALLBACK=1 marker - with the
//     marker the decision is "ask", the human-approved fallback for when an
//     index search genuinely came up short.
// Pipe-filter grep (cargo test | grep FAILED) never matches; CX_NO_ENFORCE=1
// disables enforcement entirely. Every ambiguity fails open (allow).
//
// The command is read as shell, not as text: heredoc bodies are removed before
// anything is parsed (a script being written must not be read as commands the
// agent is running), segments split on `&&`/`||`/`;`/newline but never on `|`,
// and a launcher's operands end at a `|` or a `#` comment - otherwise the words
// of a pipe filter (`| head -5`) read as targets nothing covers and the whole
// search falls open. Launchers are matched on their basename, behind wrappers
// (`command`, `timeout 5`, `xargs -a file`) and behind git's global flags.
//
// One script serves SessionStart and the PreToolUse matchers, dispatching on
// the payload. The legacy `search` tool (pre-0.2 servers) is denied with a
// redirect to sql.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative, isAbsolute, basename, sep } from "node:path";

/** Index format the hook understands; anything else reads as absent. */
const INDEX_FORMAT_VERSION = 2;

/** The index directory and the two files read out of it (mirrors
 * src/core/config.ts and src/core/filestate.ts). */
const INDEX_DIR_NAME = ".infino";
const MANIFEST_NAME = "codecontext.json";
const FILESTATE_NAME = "filestate.json";

/** Commands that launch a code search. `git` counts only as `git grep`. */
const GREP_LAUNCHERS = new Set(["rg", "grep"]);

/** Wrappers that sit in front of the real command; each one used to hide a
 * launcher from enforcement, so they are stepped over. */
const COMMAND_WRAPPERS = new Set(["env", "sudo", "time", "nice", "command", "xargs", "nohup", "stdbuf"]);

/** A wrapper flag that eats the next token as its value (`xargs -a list`,
 * `nice -n 5`, `env -u VAR`). Without these the scan stops on the value and
 * the launcher behind it escapes. */
const WRAPPER_VALUE_FLAGS = {
  env: new Set(["-u", "-S", "-C", "-P"]),
  sudo: new Set(["-u", "-g", "-p", "-h", "-U", "-r", "-t", "-T", "-C", "-D", "-R"]),
  xargs: new Set(["-a", "-d", "-E", "-I", "-i", "-L", "-l", "-n", "-P", "-s", "-S"]),
  nice: new Set(["-n"]),
  timeout: new Set(["-k", "-s"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  time: new Set([]),
  command: new Set([]),
  nohup: new Set([]),
};

/** Shell control words and group openers that sit in front of the command
 * that actually runs (`if rg -q …; then`, `while rg …; do`, `{ rg …; }`,
 * `! rg …`, `( rg … )`): each one read as the launcher and hid the search. */
const CONTROL_PREFIXES = new Set([
  "if", "then", "else", "elif", "fi",
  "do", "done", "while", "until", "for",
  "!", "{", "}", "(", ")",
]);

/** `timeout` takes a duration operand before the command it runs. Only this
 * shape is stepped over; anything else leaves the scan where it is, which
 * reads as "not a launcher" and allows. */
const TIMEOUT_WRAPPER = "timeout";
const TIMEOUT_DURATION = /^\d+(?:\.\d+)?[smhd]?$/;

/** git's global options that take a separate value (`git -C dir grep ...`);
 * every other global option is a lone flag (`--no-pager`). */
const GIT_LAUNCHER = "git";
const GIT_SUBCOMMAND = "grep";
const GIT_VALUE_FLAGS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--exec-path", "--namespace"]);

/** `VAR=value`, the other prefix a launcher hides behind. */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** The human-approved fallback marker, as a leading assignment. */
const FALLBACK_MARKER = /^CX_GREP_FALLBACK=1$/;

/** A target carrying any of these is a glob, matched against the indexed file
 * set rather than resolved as a path. */
const GLOB_CHARS = /[*?[{]/;

/** An output redirection (`>`, `>>`, `2>`, `&>`), whose operand names a
 * destination file rather than a search target. */
const OUT_REDIRECT = /^(\d*|&)(>>?)$/;

/** Anything that begins a redirection, joined to its operand or not. */
const REDIRECT_START = /^(\d*|&)(>>?|<)/;

/** A heredoc introducer at the scan position: `<<WORD`, `<<'WORD'`,
 * `<<"WORD"`, `<<-WORD`. A here-string (`<<<`) is excluded by the caller. */
const HEREDOC_START = /^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*))/;

/** Leading tabs a `<<-` heredoc strips before matching its terminator. */
const HEREDOC_DASH_INDENT = /^\t+/;

/** Regex metacharacters escaped when a glob's literal text is translated. */
const REGEX_META = /[.+^$()|\\]/;

/** The pipeline operator, emitted as its own token so it can never be read as
 * an operand. */
const PIPE = "|";

/** A `#` at the start of a word begins a shell comment; the rest of the
 * segment is not the launcher's operands. */
const COMMENT_START = "#";

const toPosix = (p) => p.split(sep).join("/");

/** True when a root-relative, "/"-separated path leads out of the repo. */
const outsideRepo = (rel) => rel === ".." || rel.startsWith("../") || isAbsolute(rel);

/** The command a token names: its basename, so an absolute path
 * (`/usr/bin/rg`) counts as the launcher it runs. */
const commandName = (text) => basename(toPosix(text ?? ""));

/** Nearest ancestor of `from` holding an index manifest, or undefined. */
function findIndexRoot(from) {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, INDEX_DIR_NAME, MANIFEST_NAME))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

/** Which tree the index describes. `manifest.root` is the only source when the
 * index was not found by walking up from cwd (a custom CX_INDEX_DIR), where a
 * cwd guess would read the repo's own files as "outside the repo" and allow
 * everything. But it is only trusted while it agrees with where the index was
 * found: a copied checkout (`cp -a repo repo2`), or an index built at a
 * container path and read from the host, carries a manifest pointing at the
 * original tree - trusting that would resolve every target outside the repo
 * and silently stop enforcing while sql answers fine. */
function repoRoot(manifestRoot, walkRoot, foundByWalk, from) {
  if (!foundByWalk) return manifestRoot ?? walkRoot ?? from;
  if (manifestRoot && resolve(manifestRoot) === resolve(walkRoot)) return manifestRoot;
  return walkRoot;
}

/** Locate the index for cwd (CX_INDEX_DIR override, else walk up to .infino)
 * and classify it. Only "ready" enforces; everything else fails open. */
function indexInfo(cwd) {
  const from = cwd || process.cwd();
  const walkRoot = findIndexRoot(from);
  const walkIndexDir = walkRoot ? join(walkRoot, INDEX_DIR_NAME) : undefined;
  const indexDir = process.env.CX_INDEX_DIR ?? walkIndexDir;
  const fallbackRoot = walkRoot ?? from;
  if (!indexDir) return { state: "none", root: fallbackRoot };
  const foundByWalk = walkIndexDir !== undefined && resolve(indexDir) === resolve(walkIndexDir);
  try {
    const m = JSON.parse(readFileSync(join(indexDir, MANIFEST_NAME), "utf8"));
    const manifestRoot = typeof m.root === "string" && m.root ? m.root : undefined;
    const root = repoRoot(manifestRoot, walkRoot, foundByWalk, from);
    if (m.version !== INDEX_FORMAT_VERSION) return { state: "none", root, indexDir };
    if (m.truncatedFiles) return { state: "partial", root, indexDir };
    if (m.vectors !== "ready") return { state: "building", root, indexDir };
    // A "ready" manifest orphaned by a deleted/moved table would deny grep
    // while sql also errors - losing both paths. Confirm the table exists.
    const hasTable = readdirSync(indexDir).some((n) => n.startsWith(`${m.table}-`));
    return { state: hasTable ? "ready" : "none", root, indexDir };
  } catch {
    return { state: "none", root: fallbackRoot, indexDir };
  }
}

/** Did this filestate entry put rows in the table? A recorded count of 0 means
 * the indexer fingerprinted the file but chunked nothing out of it, so sql
 * cannot answer for it and grep must stay allowed. An absent count is older
 * state that never recorded one, which stays covered (back-compatible); any
 * other shape is unreadable and fails open. */
function entryHasChunks(entry) {
  if (typeof entry !== "object" || entry === null) return false;
  const n = entry.chunks;
  if (n === undefined) return true;
  return typeof n === "number" && n > 0;
}

/** The covered file set: repo-root-relative, "/"-separated keys of
 * `.infino/filestate.json` whose entry actually produced chunk rows.
 * undefined when the state is missing, unparseable, or leaves nothing covered
 * - each of which means the hook cannot tell what sql can answer, and so must
 * fail open. */
function indexedFiles(indexDir) {
  try {
    const state = JSON.parse(readFileSync(join(indexDir, FILESTATE_NAME), "utf8"));
    if (state?.version !== 1 || typeof state.files !== "object" || state.files === null) return undefined;
    const entries = Object.values(state.files);
    // A state written before counts existed has no `chunks` field anywhere, so
    // it cannot distinguish a chunk-less file from a covered one - treating it
    // as covered denied greps sql could not answer. Fail open until a rebuild
    // or the first sync stamps counts; a MIXED state (some entries stamped)
    // keeps the back-compatible reading for the unstamped rest.
    if (entries.length > 0 && entries.every((e) => typeof e !== "object" || e === null || e.chunks === undefined)) {
      return undefined;
    }
    const keys = Object.keys(state.files).filter((k) => entryHasChunks(state.files[k]));
    return keys.length > 0 ? keys : undefined;
  } catch {
    return undefined;
  }
}

/** Translate a glob into an anchored RegExp over "/"-separated paths: `*` and
 * `?` stay inside one segment, `**` crosses separators, `{a,b}` alternates,
 * `[...]` is a character class. undefined for a pattern that won't compile,
 * which reads as "matches nothing" and so allows the grep. */
function globRegExp(glob) {
  let re = "";
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // Collapse the whole run: `***…` compiles like `**`. One `.*` per pair
        // stacked into `^.*.*.*…$`, which backtracks - 20 stars took seconds
        // and 24 never answered, wedging the tool call until the hook timeout.
        while (glob[i + 1] === "*") i++;
        // `**/` also matches zero directories, so `**/*.ts` covers `a.ts`.
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      braces++;
      re += "(?:";
    } else if (c === "}" && braces > 0) {
      braces--;
      re += ")";
    } else if (c === "," && braces > 0) {
      re += "|";
    } else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end === -1) {
        re += "\\[";
        continue;
      }
      re += `[${glob.slice(i + 1, end).replace(/^[!^]/, "^")}]`;
      i = end;
    } else {
      re += REGEX_META.test(c) ? `\\${c}` : c;
    }
  }
  try {
    return new RegExp(`^${re}$`);
  } catch {
    return undefined;
  }
}

/** Does the index hold at least one file this glob names? A pattern without a
 * separator is matched against basenames too, which is how the Grep tool's
 * `glob` input ("*.rs") is meant to read. */
function coversGlob(pattern, base, root, keys, bareMatchesBasename) {
  let scoped = toPosix(pattern);
  const bare = !scoped.includes("/");
  if (!bare) {
    // Rebase onto the repo root so the pattern lines up with the keys. resolve
    // and relative are pure string math here - the glob chars pass through.
    scoped = toPosix(relative(root, isAbsolute(pattern) ? pattern : resolve(base, pattern)));
    if (outsideRepo(scoped)) return false;
  }
  const re = globRegExp(scoped);
  if (!re) return false;
  return keys.some((k) => re.test(k) || (bare && bareMatchesBasename && re.test(basename(k))));
}

/** Does the index contain this target? A path is covered when it is a covered
 * file, or a directory with at least one covered file under it; a glob when at
 * least one covered key matches. Everything else is NOT covered and grep is
 * allowed, because sql could not answer it either: a path outside the repo,
 * anything the indexer skipped (a lockfile, a `.csv`, `LICENSE`, `vendor/`, a
 * symlink, a file over the byte cap, a binary), and anything it fingerprinted
 * without chunking a single row out of. */
function coversTarget(target, cwd, root, keys) {
  const base = cwd || root;
  // A bare operand glob (`*.ts`) is NOT matched against basenames: the shell
  // expands it in the cwd before rg ever runs, so basename matching read
  // `rg zzz *.ts` as repo-wide and denied a search whose real operands were
  // uncovered. The Grep tool's `glob` input is recursive and keeps basenames.
  if (GLOB_CHARS.test(target)) return coversGlob(target, base, root, keys, false);
  const rel = toPosix(relative(root, isAbsolute(target) ? target : resolve(base, target)));
  if (outsideRepo(rel)) return false;
  if (rel === "") return true; // the repo root itself
  return keys.some((k) => k === rel || k.startsWith(`${rel}/`));
}

/** Remove heredoc bodies from a command line. `cat > run.sh <<'SH' … SH`
 * writes a file: its body is data, and reading the search line inside it as a
 * command the agent runs denies the agent its own script (with an irrelevant
 * "use sql" message). The redirection operator and delimiter go too - what
 * stays is the command they belong to. Quotes are respected so a `<<` inside a
 * string is not mistaken for one; a mistake here can only drop text, which
 * fails open. */
function stripHeredocs(command) {
  let out = "";
  let quote = "";
  const pending = [];
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    if (quote) {
      out += c;
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"' && i + 1 < command.length) out += command[++i];
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      out += c + command[i + 1];
      i += 2;
      continue;
    }
    if (c === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      const m = HEREDOC_START.exec(command.slice(i));
      if (m) {
        pending.push({ word: m[2] ?? m[3] ?? m[4], dashed: m[1] === "-" });
        i += m[0].length;
        continue;
      }
    }
    if (c === "\n" && pending.length > 0) {
      out += c;
      i++;
      // The bodies follow in the order their delimiters appeared, each ending
      // on its own terminator line (`<<-` allows leading tabs on it).
      while (pending.length > 0) {
        const { word, dashed } = pending.shift();
        while (i < command.length) {
          const nl = command.indexOf("\n", i);
          const end = nl === -1 ? command.length : nl;
          const line = command.slice(i, end);
          i = nl === -1 ? command.length : nl + 1;
          if ((dashed ? line.replace(HEREDOC_DASH_INDENT, "") : line) === word) break;
        }
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Split a command line into independently-launched segments on `&&`, `||`,
 * `;` and newlines - and NEVER on `|`: a pipe filter (`cargo test | grep
 * FAILED`) stays one segment whose launcher is `cargo`, which is exactly why
 * it keeps working. Quotes are respected, so a separator inside a pattern
 * stays literal. */
function segments(command) {
  const out = [];
  let cur = "";
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"' && i + 1 < command.length) cur += command[++i];
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "\\" && i + 1 < command.length) {
      cur += c + command[++i];
      continue;
    }
    if (c === ";" || c === "\n") {
      out.push(cur);
      cur = "";
      continue;
    }
    // `&&` and `||` split; so does a lone `&` (backgrounding: `rg pat src &`
    // launched a search that was never inspected). `>&` (2>&1, >&2) is a
    // redirection, not a control operator, and `|` is never a split.
    if (c === "&") {
      if (command[i + 1] === "&") {
        out.push(cur);
        cur = "";
        i++;
        continue;
      }
      if (cur.endsWith(">")) {
        cur += c;
        continue;
      }
      out.push(cur);
      cur = "";
      continue;
    }
    if (c === "|" && command[i + 1] === "|") {
      out.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.filter((s) => s.trim() !== "");
}

/** Split a segment into `{ text, quoted }` tokens, keeping quoted phrases
 * whole: the pattern of `grep -rn "let auth" src/` is one token, so `src/`
 * reads as the target it is. Splitting on bare whitespace made `auth"` a bogus
 * target that fell open - which is how multi-word patterns, the normal way
 * agents grep, escaped. An unquoted `|` is emitted as its own token: glued to
 * a neighbour (`src|head`) it would have made a target no key matches, and the
 * search would have fallen open. `quoted` records that some of the token was
 * quoted or escaped, i.e. that it is text rather than shell syntax: `grep
 * "> TODO" notes.log` searches for a literal `>`, and reading that as a
 * redirection would drop the pattern and turn an unindexed file into a
 * repo-wide deny. */
function tokenize(segment) {
  const toks = [];
  let cur = "";
  let started = false;
  let quoted = false;
  let quote = "";
  const push = () => {
    if (started) toks.push({ text: cur, quoted });
    cur = "";
    started = false;
    quoted = false;
  };
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"' && i + 1 < segment.length) cur += segment[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      quoted = true;
      continue;
    }
    if (c === "\\" && i + 1 < segment.length) {
      cur += segment[++i];
      started = true;
      quoted = true;
      continue;
    }
    if (/\s/.test(c)) {
      push();
      continue;
    }
    if (c === PIPE) {
      push();
      toks.push({ text: PIPE, quoted: false });
      continue;
    }
    cur += c;
    started = true;
  }
  push();
  return toks;
}

/** Step past a wrapper's own flags, and past the value any of them takes (never
 * past a `|`, which is syntax and not anybody's operand). Returns the index of
 * the last token consumed. */
function skipWrapperFlags(toks, i, wrapper) {
  const valueFlags = WRAPPER_VALUE_FLAGS[wrapper] ?? new Set();
  while (toks[i + 1]?.text.startsWith("-")) {
    const flag = toks[++i].text;
    const value = toks[i + 1];
    if (valueFlags.has(flag) && value && value.text !== PIPE && !value.text.startsWith("-")) i++;
  }
  return i;
}

/** Read one segment as a grep launch, or undefined when it isn't one (a
 * pipeline starting with another command included). `isSearch` is false for
 * pattern-less invocations like `grep --version`; `targets` are the explicit
 * path/glob operands, and `chdir` is git's `-C` directory, which moves the
 * root those operands resolve against. Misparses fail open downstream. */
function grepLaunch(segment) {
  const toks = tokenize(segment);
  let i = 0;
  let fallback = false;
  // Step over `VAR=1` prefixes and wrapper commands (with their own flags and
  // operands) to reach the command that actually runs.
  for (; i < toks.length; i++) {
    const { text } = toks[i];
    if (ENV_ASSIGNMENT.test(text)) {
      if (FALLBACK_MARKER.test(text)) fallback = true;
      continue;
    }
    if (CONTROL_PREFIXES.has(text)) continue;
    // A group opener glued to the command (`(rg`, `{rg`, `!rg`) is shell
    // syntax, not part of the name: strip it and re-read the token.
    const opened = text.replace(/^[({!]+/, "");
    if (opened !== text) {
      if (opened === "") continue;
      toks[i] = { ...toks[i], text: opened };
      i--;
      continue;
    }
    const wrapper = commandName(text);
    if (COMMAND_WRAPPERS.has(wrapper)) {
      i = skipWrapperFlags(toks, i, wrapper);
      continue;
    }
    if (wrapper === TIMEOUT_WRAPPER) {
      i = skipWrapperFlags(toks, i, TIMEOUT_WRAPPER);
      if (toks[i + 1] && TIMEOUT_DURATION.test(toks[i + 1].text)) i++;
      continue;
    }
    break;
  }
  const name = commandName(toks[i]?.text);
  let chdir;
  if (name === GIT_LAUNCHER) {
    // git's global options sit before the subcommand. `-C dir` also moves the
    // search root, so it is carried out: `git -C . grep auth` searches this
    // repo, `git -C ../other grep auth` does not.
    let j = i + 1;
    while (toks[j]?.text.startsWith("-")) {
      const flag = toks[j].text;
      const joined = flag.includes("=");
      if (flag === "-C") chdir = toks[j + 1]?.text;
      j += GIT_VALUE_FLAGS.has(flag) && !joined ? 2 : 1;
    }
    if (toks[j]?.text !== GIT_SUBCOMMAND) return undefined;
    i = j + 1;
  } else if (GREP_LAUNCHERS.has(name)) i += 1;
  else return undefined;

  // First bare operand is the pattern; the rest are targets. A flag that eats
  // a separate value shifts this by one, which yields a target no key matches
  // - i.e. it fails open, never into a wrong deny.
  const targets = [];
  let sawPattern = false;
  for (; i < toks.length; i++) {
    const { text, quoted } = toks[i];
    // The operands end at a pipeline boundary or a comment: `| head -5` and
    // `# note` are not paths this search reads.
    if (!quoted && (text === PIPE || text.startsWith(COMMENT_START))) break;
    if (!quoted && (text === "--" || text.startsWith("-"))) continue;
    if (!quoted && REDIRECT_START.test(text)) {
      // `rg foo > hits.txt` used to read `hits.txt` as a target that failed
      // open. The destination is not a search target, so it is dropped; an
      // input redirection (`grep foo < notes.log`) means the search reads a
      // stream whose coverage the index cannot speak to, so it is allowed.
      if (text.includes("<")) return undefined;
      if (OUT_REDIRECT.test(text)) i++; // operator and operand are separate tokens
      continue;
    }
    if (!sawPattern) {
      sawPattern = true;
      continue;
    }
    // An unquoted trailing `)` / `}` is group syntax (`( rg auth src )`,
    // `{ rg auth src; }`), not part of a filename - a real parenthesised name
    // arrives quoted. Left in place it made an uncovered "target" out of thin
    // air and flipped the decision open.
    const target = quoted ? text : text.replace(/[)}]+$/, "");
    if (target === "") continue;
    targets.push(target);
  }
  return { fallback, targets, isSearch: sawPattern, chdir };
}

const decision = (permissionDecision, permissionDecisionReason) =>
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason },
    }),
  );

const DENY_REASON =
  "code-context: the index fully covers this repo, so grep/rg for code search is disabled. " +
  "Use the sql MCP tool - hybrid_search('chunks','content','<terms>','embedding', {{q}}, k) for " +
  "ranked retrieval, GROUP BY over it for counts/rankings. Piping other command output through " +
  "grep is still allowed. If an index search genuinely came up short, re-run this command " +
  "prefixed with CX_GREP_FALLBACK=1 to request it; CX_NO_ENFORCE=1 in the environment disables " +
  "enforcement entirely.";

const ASK_REASON =
  "code-context fallback: the agent signals an index search came up short and asks to grep " +
  "directly. Allow this grep?";

let data = "";
process.stdin.on("data", (c) => (data += c));
process.stdin.on("end", () => {
  let input = {};
  try {
    input = JSON.parse(data);
  } catch {
    return; // unparseable payload: do nothing rather than break the call
  }

  // SessionStart only describes the index; the note itself adapts to the kill
  // switch, and every enforcing branch sits below it.
  if (input.hook_event_name === "SessionStart") {
    const note =
      process.env.CX_NO_ENFORCE === "1"
        ? "code-context is available: search the code with the sql MCP tool via table-valued functions - hybrid_search('chunks','content','<terms>','embedding', {{q}}, k) for ranked retrieval, bm25_search for keyword-only, GROUP BY for counts/rankings."
        : indexInfo(input.cwd).state === "ready"
          ? "code-context is active and the index fully covers this repo: all code search goes through the sql MCP tool via table-valued functions - hybrid_search('chunks','content','<terms>','embedding', {{q}}, k) for ranked retrieval (embed map {\"q\":...}), bm25_search for keyword-only, GROUP BY over either for counts/rankings. The Grep tool and standalone grep/rg commands are disabled (grep as a pipe filter on other command output still works; if an index search genuinely came up short, prefix the grep with CX_GREP_FALLBACK=1 to request it)."
          : "code-context is available: search the code with the sql MCP tool via table-valued functions - hybrid_search('chunks','content','<terms>','embedding', {{q}}, k) for ranked retrieval, bm25_search for keyword-only, GROUP BY for counts/rankings (the index builds as the server starts). grep stays enabled until the index fully covers the repo.";
    console.log(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: note },
      }),
    );
    return;
  }

  // The kill switch, above every enforcement branch - including the legacy
  // `search` deny, which used to run in front of it.
  if (process.env.CX_NO_ENFORCE === "1") return;

  const toolName = input.tool_name ?? "";

  // Legacy `search` tool (pre-0.2 servers): sql is the search surface.
  if (/code[-_]context.*__search$/.test(toolName)) {
    decision(
      "deny",
      'code-context: search goes through the sql tool. Ranked retrieval: SELECT path, start_line, end_line, symbol, content FROM hybrid_search(\'chunks\',\'content\',\'<terms>\',\'embedding\', {{q}}, 10) with embed {"q":"<your question>"} - or bm25_search(\'chunks\',\'content\',\'<terms>\', 10) while vectors are backfilling. Rank + aggregate composes via GROUP BY.',
    );
    return;
  }

  if (toolName === "Grep") {
    const info = indexInfo(input.cwd);
    if (info.state !== "ready") return;
    const keys = indexedFiles(info.indexDir);
    if (!keys) return;
    const path = input.tool_input?.path;
    const glob = input.tool_input?.glob;
    if (path && !coversTarget(path, input.cwd, info.root, keys)) return;
    if (glob) {
      // The tool's glob is relative to `path` when one is given.
      const base = path
        ? isAbsolute(path)
          ? path
          : resolve(input.cwd || info.root, path)
        : input.cwd || info.root;
      if (!coversGlob(glob, base, info.root, keys, true)) return;
    }
    decision("deny", DENY_REASON);
    return;
  }

  if (toolName === "Bash") {
    const command = input.tool_input?.command ?? "";
    const launches = segments(stripHeredocs(command))
      .map(grepLaunch)
      .filter((l) => l !== undefined && l.isSearch);
    if (launches.length === 0) return;
    const info = indexInfo(input.cwd);
    if (info.state !== "ready") return;
    const keys = indexedFiles(info.indexDir);
    if (!keys) return;
    for (const launch of launches) {
      // `git -C dir` moves the directory relative targets resolve against, and
      // with no target of its own it IS the scope of the search - so `git -C .
      // grep auth` reads as this repo and `git -C ../other grep auth` as a tree
      // the index does not speak for. Any other launch with no explicit target
      // is a repo-wide search, which the index covers.
      const chdir = launch.chdir
        ? isAbsolute(launch.chdir)
          ? launch.chdir
          : resolve(input.cwd || info.root, launch.chdir)
        : undefined;
      const targets = launch.targets.length > 0 ? launch.targets : chdir ? [chdir] : [];
      if (!targets.every((t) => coversTarget(t, chdir ?? input.cwd, info.root, keys))) continue;
      if (launch.fallback) decision("ask", ASK_REASON);
      else decision("deny", DENY_REASON);
      return;
    }
  }
});
