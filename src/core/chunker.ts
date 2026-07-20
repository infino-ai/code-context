// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// File filtering and chunking. Code files are chunked at syntactic
// boundaries (tree-sitter, WASM grammars - no native compiles): definition
// starts become break points, and the segments between them are packed into
// windows of a target size. Markdown splits at headings. Everything else
// falls back to fixed line windows. Every chunk carries a 1-based line range
// so results cite as path:start-end.

import { createRequire } from "node:module";
import { join, dirname } from "node:path";

export interface Chunk {
  path: string;
  startLine: number;
  endLine: number;
  lang: string;
  /** Raw file bytes for this line range - what results return, cited as
   * path:start-end. Never enriched, so the citation stays exact. */
  content: string;
  /** Definition name(s) starting in this chunk (e.g. "parseConfig"); for
   * markdown, the heading text. Absent for fixed-window / unparsed chunks. */
  symbol?: string;
  /** Coarse kind of the primary definition: function/class/method/... */
  kind?: string;
  /** Enclosing breadcrumb of the primary definition (e.g. "ConfigLoader"). */
  scope?: string;
}

/** A definition site found in the AST: where it starts and how to name it. */
interface DefSite {
  row: number; // 0-based
  name: string;
  kind: string;
  scope: string;
}

/** The text we embed / index for a chunk: a compact, deterministic context
 * header (path + breadcrumb + symbol) prepended to the raw content. The header
 * is never returned - it only sharpens the vector, the way Anthropic's
 * contextual retrieval does, but built from the AST instead of an LLM. */
// CX_EMBED_RAW=1 embeds raw content only (no path/symbol header) - an eval lever
// for A/B-ing enrichment, in the spirit of CX_EMBED_MODEL.
const RAW_EMBED = ["1", "true", "yes"].includes((process.env.CX_EMBED_RAW ?? "").toLowerCase());

/** The text we embed / index for a chunk: a compact, deterministic context
 * header (path + breadcrumb + symbol) prepended to the raw content, which
 * sharpens the vector - Anthropic-style contextual retrieval, built from the
 * AST rather than an LLM. The header is never returned; results keep the raw
 * content, so citations stay exact. */
export function embedText(c: Chunk): string {
  if (RAW_EMBED) return c.content;
  const crumb = [c.scope, c.symbol].filter(Boolean).join(" › ");
  return crumb ? `${c.path}\n${crumb}\n${c.content}` : `${c.path}\n${c.content}`;
}

// Window tuning: target is the preferred chunk size; a single syntactic unit
// larger than MAX_LINES is split by fixed windows. The fallback overlap keeps
// context across arbitrary cut points (syntactic cuts don't need it).
const TARGET_LINES = 60;
const MAX_LINES = 120;
const WINDOW_LINES = 60;
const OVERLAP_LINES = 10;

// Files larger than this skip tree-sitter (parse cost) and use fixed windows.
const PARSE_CAP_BYTES = 512 * 1024;

// Extension → language tag. Doubles as the indexing allowlist.
const EXT_LANG: Record<string, string> = {
  md: "md", mdx: "md", rst: "rst", txt: "txt", adoc: "adoc", tex: "tex",
  ts: "ts", tsx: "tsx", js: "js", jsx: "js", mjs: "js", cjs: "js",
  py: "py", pyi: "py", rs: "rs", go: "go", java: "java", rb: "rb",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", hh: "cpp", cs: "cs",
  swift: "swift", kt: "kt", kts: "kt", scala: "scala", php: "php",
  sh: "sh", bash: "sh", zsh: "sh", ps1: "ps1", bat: "bat",
  toml: "toml", yaml: "yaml", yml: "yaml", json: "json", jsonc: "json",
  xml: "xml", ini: "ini", cfg: "ini", gradle: "gradle",
  sql: "sql", proto: "proto", graphql: "graphql",
  css: "css", scss: "css", sass: "css", less: "css", html: "html",
  vue: "vue", svelte: "svelte", astro: "astro",
  dart: "dart", lua: "lua", r: "r", jl: "jl",
  ex: "ex", exs: "ex", erl: "erl", hrl: "erl",
  hs: "hs", ml: "ml", mli: "ml", fs: "fs", fsx: "fs",
  clj: "clj", cljs: "clj", cljc: "clj", elm: "elm",
  zig: "zig", nim: "nim", d: "d", cr: "cr", groovy: "groovy",
  pl: "pl", pm: "pl", m: "m", mm: "mm",
  sol: "sol", cu: "cu", cuh: "cu", tf: "tf", hcl: "hcl",
  cmake: "cmake", mk: "mk", s: "asm", asm: "asm", v: "v", vhd: "vhdl",
};

// Well-known extensionless files worth indexing.
const KNOWN_BASENAMES = new Set([
  "dockerfile", "makefile", "justfile", "rakefile", "gemfile",
  "procfile", "vagrantfile", "brewfile",
]);

const LOCKFILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "cargo.lock",
  "poetry.lock", "gemfile.lock", "composer.lock", "go.sum", "uv.lock",
]);

export function shouldIndexFile(path: string): boolean {
  const base = path.split("/").pop()!.toLowerCase();
  if (LOCKFILES.has(base)) return false;
  if (/\.min\.(js|css)$/.test(base)) return false;
  if (/\.(map|snap|svg|lock)$/.test(base)) return false;
  if (KNOWN_BASENAMES.has(base)) return true;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false; // no extension (or dotfile) - not indexable
  return base.slice(dot + 1) in EXT_LANG;
}

export function langFor(path: string): string {
  const base = path.split("/").pop()!.toLowerCase();
  if (KNOWN_BASENAMES.has(base)) return base === "dockerfile" ? "docker" : "make";
  return EXT_LANG[base.split(".").pop() ?? ""] ?? "";
}

// NUL byte in the head of the file ⇒ treat as binary.
const BINARY_SNIFF_BYTES = 8192;

export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

// --- tree-sitter -------------------------------------------------------------

// Language tag → grammar WASM basename. Plain C parses fine with the C++
// grammar for boundary detection.
const TS_GRAMMAR: Record<string, string> = {
  ts: "typescript", tsx: "tsx", js: "javascript",
  py: "python", rs: "rust", go: "go", java: "java",
  c: "cpp", cpp: "cpp", rb: "ruby", cs: "c-sharp", php: "php",
  sh: "bash", css: "css", ps1: "powershell",
};

// Node types whose start lines become chunk break points, per grammar.
const DEF_TYPES: Record<string, Set<string>> = {
  typescript: new Set([
    "function_declaration", "generator_function_declaration", "class_declaration",
    "abstract_class_declaration", "method_definition", "interface_declaration",
    "enum_declaration", "type_alias_declaration", "export_statement", "module",
  ]),
  javascript: new Set([
    "function_declaration", "generator_function_declaration", "class_declaration",
    "method_definition", "export_statement",
  ]),
  python: new Set(["function_definition", "class_definition", "decorated_definition"]),
  rust: new Set([
    "function_item", "impl_item", "struct_item", "enum_item", "trait_item",
    "mod_item", "macro_definition",
  ]),
  go: new Set(["function_declaration", "method_declaration", "type_declaration"]),
  java: new Set([
    "class_declaration", "method_declaration", "interface_declaration",
    "enum_declaration", "constructor_declaration",
  ]),
  cpp: new Set([
    "function_definition", "class_specifier", "struct_specifier",
    "enum_specifier", "namespace_definition", "template_declaration",
  ]),
  ruby: new Set(["method", "singleton_method", "class", "module"]),
  "c-sharp": new Set([
    "class_declaration", "method_declaration", "interface_declaration",
    "struct_declaration", "enum_declaration", "constructor_declaration",
    "namespace_declaration",
  ]),
  php: new Set([
    "function_definition", "method_declaration", "class_declaration",
    "interface_declaration", "trait_declaration",
  ]),
  // Shell: break at function definitions (scripts are otherwise flat).
  bash: new Set(["function_definition"]),
  // CSS: break at each rule set and at-rule block; packSegments coalesces
  // small rules into windows, so this doesn't over-fragment.
  css: new Set([
    "rule_set", "media_statement", "keyframes_statement",
    "supports_statement", "at_rule", "import_statement",
  ]),
  // PowerShell: functions (nested under statement_list, found by the recursive
  // collect); class_statement is harmless when the grammar lacks it.
  powershell: new Set(["function_statement", "class_statement"]),
};
DEF_TYPES.tsx = DEF_TYPES.typescript;

// The runtime and grammars ship together in @vscode/tree-sitter-wasm (CJS),
// so the parser ABI always matches the grammar builds.
const require = createRequire(import.meta.url);

type TSParser = {
  setLanguage(lang: unknown): void;
  parse(
    input: string,
    oldTree?: unknown,
    options?: { progressCallback?: (state: unknown) => boolean },
  ): { rootNode: TSNode } | null;
};
type TSNode = {
  type: string;
  text: string;
  startPosition: { row: number };
  endPosition: { row: number };
  namedChildren: TSNode[];
  childForFieldName(name: string): TSNode | null;
};

let runtime: Promise<{ Parser: new () => TSParser; Language: { load(path: string): Promise<unknown> } }> | null = null;
const languages = new Map<string, Promise<unknown | null>>();
let parser: TSParser | null = null;

// Adversarial inputs (parser stress fixtures, generated code) can abort the
// WASM runtime, and a post-abort runtime is undefined behavior - sometimes
// every later call throws fast, sometimes it busy-loops. Count failures and
// permanently fall back to fixed windows once the runtime looks unhealthy;
// losing syntactic cuts on the tail of a hostile corpus is fine, hanging
// an index run is not.
let parseFailures = 0;
const MAX_PARSE_FAILURES = 20;

function getRuntime() {
  if (!runtime) {
    runtime = (async () => {
      const mod = require("@vscode/tree-sitter-wasm");
      await mod.Parser.init();
      return mod;
    })();
  }
  return runtime;
}

function getLanguage(grammar: string): Promise<unknown | null> {
  let lang = languages.get(grammar);
  if (!lang) {
    lang = (async () => {
      try {
        const { Language } = await getRuntime();
        const wasmDir = dirname(require.resolve("@vscode/tree-sitter-wasm"));
        return await Language.load(join(wasmDir, `tree-sitter-${grammar}.wasm`));
      } catch {
        return null; // grammar unavailable - callers fall back to fixed windows
      }
    })();
    languages.set(grammar, lang);
  }
  return lang;
}

/** Definition sites (0-based start row + name/kind/scope), or undefined when
 * the language has no grammar or parsing fails. The rows drive chunk break
 * points; the names/scope enrich the embed text. */
async function syntacticDefs(lang: string, content: string): Promise<DefSite[] | undefined> {
  const grammar = TS_GRAMMAR[lang];
  if (!grammar || content.length > PARSE_CAP_BYTES) return undefined;
  if (parseFailures >= MAX_PARSE_FAILURES) return undefined;
  const language = await getLanguage(grammar);
  if (!language) return undefined;
  try {
    const { Parser } = await getRuntime();
    if (!parser) parser = new Parser();
    parser.setLanguage(language);
    // Per-file parse budget, enforced through the parser's progress callback
    // (returning true cancels the parse): a single pathological file
    // (generated code, parser stress fixtures) must never stall the run.
    // A cancelled parse returns null → fixed-window fallback.
    const deadline = performance.now() + 200;
    const tree = parser.parse(content, undefined, {
      progressCallback: () => performance.now() > deadline,
    });
    if (!tree) return undefined;
    const defs = DEF_TYPES[grammar];
    const sites: DefSite[] = [];
    collectDefs(tree.rootNode, defs, [], sites, 0);
    return sites.sort((a, b) => a.row - b.row);
  } catch {
    parseFailures++;
    parser = null; // a failed parser instance is not trusted again
    return undefined;
  }
}

// Depth cap keeps this to module/class/method level, not local closures.
const MAX_DEPTH = 6;

function collectDefs(node: TSNode, defs: Set<string>, scope: string[], sites: DefSite[], depth: number): void {
  if (depth > MAX_DEPTH) return;
  for (const child of node.namedChildren) {
    if (defs.has(child.type)) {
      const name = nameOf(child);
      sites.push({ row: child.startPosition.row, name, kind: kindOf(child.type), scope: scope.join(" › ") });
      collectDefs(child, defs, name ? [...scope, name] : scope, sites, depth + 1);
    } else {
      collectDefs(child, defs, scope, sites, depth + 1);
    }
  }
}

/** Best-effort definition name: the grammar's `name` field, else the first
 * identifier-ish named child (covers declarator-wrapped names like C++). */
function nameOf(node: TSNode): string {
  const clip = (s: string) => s.split("\n")[0].trim().slice(0, 80);
  const named = node.childForFieldName?.("name");
  if (named?.text) return clip(named.text);
  for (const c of node.namedChildren) {
    if (/identifier|name|selectors/.test(c.type)) return clip(c.text);
  }
  return "";
}

/** Coarse kind from a grammar node type - only used to flavour the embed
 * header, so a loose match is fine. */
function kindOf(type: string): string {
  if (/class/.test(type)) return "class";
  if (/interface/.test(type)) return "interface";
  if (/struct/.test(type)) return "struct";
  if (/enum/.test(type)) return "enum";
  if (/trait/.test(type)) return "trait";
  if (/impl/.test(type)) return "impl";
  if (/namespace|module|mod_item/.test(type)) return "module";
  if (/method/.test(type)) return "method";
  if (/function/.test(type)) return "function";
  if (/rule_set|keyframes|media/.test(type)) return "rule";
  return "def";
}

// --- chunk assembly ----------------------------------------------------------

function fixedWindows(lines: string[], firstLine: number): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const step = WINDOW_LINES - OVERLAP_LINES;
  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + WINDOW_LINES, lines.length);
    spans.push([firstLine + start, firstLine + end - 1]);
    if (end === lines.length) break;
  }
  return spans;
}

/** Pack the segments between break rows into chunks of ~TARGET_LINES,
 * splitting any single oversized segment by fixed windows. Rows are 0-based;
 * returned spans are 1-based inclusive line ranges. */
function packSegments(lines: string[], breakRows: number[]): Array<[number, number]> {
  const bounds = [...new Set([0, ...breakRows.filter((r) => r > 0 && r < lines.length)])].sort(
    (a, b) => a - b,
  );
  bounds.push(lines.length);

  const spans: Array<[number, number]> = [];
  let curStart = -1;
  let curLines = 0;
  const flush = (endRow: number) => {
    if (curStart >= 0 && curLines > 0) spans.push([curStart + 1, endRow]);
    curStart = -1;
    curLines = 0;
  };

  for (let i = 0; i < bounds.length - 1; i++) {
    const segStart = bounds[i];
    const segEnd = bounds[i + 1]; // exclusive row
    const segLen = segEnd - segStart;
    if (segLen > MAX_LINES) {
      flush(segStart);
      spans.push(...fixedWindows(lines.slice(segStart, segEnd), segStart + 1));
      continue;
    }
    if (curLines > 0 && curLines + segLen > TARGET_LINES) flush(segStart);
    if (curStart < 0) curStart = segStart;
    curLines += segLen;
  }
  flush(bounds[bounds.length - 1]);
  return spans;
}

/** Markdown: break at #/##/### headings; each heading becomes a def site whose
 * name is the heading text and scope is the ancestor-heading breadcrumb. */
function markdownDefs(lines: string[]): DefSite[] {
  const sites: DefSite[] = [];
  const stack: Array<{ level: number; name: string }> = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = lines[i].match(/^(#{1,3})\s+(.*)/);
    if (!m) continue;
    const level = m[1].length;
    const name = m[2].trim().slice(0, 80);
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    sites.push({ row: i, name, kind: "section", scope: stack.map((s) => s.name).join(" › ") });
    stack.push({ level, name });
  }
  return sites;
}

/** The primary symbol/kind/scope for a chunk: the definition sites that *start*
 * within the chunk's line range. A continuation window of a large definition
 * has none, and that's fine - it just carries no symbol. */
function spanMeta(defs: DefSite[], startLine: number, endLine: number): Partial<Chunk> | undefined {
  const inSpan = defs.filter((d) => d.row + 1 >= startLine && d.row + 1 <= endLine);
  if (inSpan.length === 0) return undefined;
  const names = [...new Set(inSpan.map((d) => d.name).filter(Boolean))];
  return {
    symbol: names.join(", ").slice(0, 120) || undefined,
    kind: inSpan[0].kind,
    scope: inSpan[0].scope || undefined,
  };
}

export async function chunkFile(path: string, content: string): Promise<Chunk[]> {
  if (!content.trim()) return [];
  const lang = langFor(path);
  const lines = content.split("\n");

  let defs: DefSite[] | undefined;
  let spans: Array<[number, number]>;
  if (lang === "md") {
    defs = markdownDefs(lines);
    spans = packSegments(lines, defs.map((d) => d.row));
  } else {
    defs = await syntacticDefs(lang, content);
    spans = defs && defs.length > 0 ? packSegments(lines, defs.map((d) => d.row)) : fixedWindows(lines, 1);
  }

  const chunks: Chunk[] = [];
  for (const [startLine, endLine] of spans) {
    const text = lines.slice(startLine - 1, endLine).join("\n");
    if (!text.trim()) continue;
    const meta = defs ? spanMeta(defs, startLine, endLine) : undefined;
    chunks.push({ path, startLine, endLine, lang, content: text, ...meta });
  }
  return chunks;
}
