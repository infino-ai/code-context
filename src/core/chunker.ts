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
  content: string;
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
  startPosition: { row: number };
  endPosition: { row: number };
  namedChildren: TSNode[];
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

/** Break points (0-based rows) at definition starts, or undefined when the
 * language has no grammar or parsing fails. */
async function syntacticBreaks(lang: string, content: string): Promise<number[] | undefined> {
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
    const rows = new Set<number>();
    collect(tree.rootNode, defs, rows, 0);
    return [...rows].sort((a, b) => a - b);
  } catch {
    parseFailures++;
    parser = null; // a failed parser instance is not trusted again
    return undefined;
  }
}

// Depth cap keeps this to module/class/method level, not local closures.
const MAX_DEPTH = 6;

function collect(node: TSNode, defs: Set<string>, rows: Set<number>, depth: number): void {
  if (depth > MAX_DEPTH) return;
  for (const child of node.namedChildren) {
    if (defs.has(child.type)) rows.add(child.startPosition.row);
    collect(child, defs, rows, depth + 1);
  }
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

/** Markdown: break at #/##/### headings, then pack like code segments. */
function markdownBreaks(lines: string[]): number[] {
  const rows: number[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) inFence = !inFence;
    else if (!inFence && /^#{1,3}\s/.test(lines[i])) rows.push(i);
  }
  return rows;
}

export async function chunkFile(path: string, content: string): Promise<Chunk[]> {
  if (!content.trim()) return [];
  const lang = langFor(path);
  const lines = content.split("\n");

  let spans: Array<[number, number]>;
  if (lang === "md") {
    spans = packSegments(lines, markdownBreaks(lines));
  } else {
    const breaks = await syntacticBreaks(lang, content);
    spans = breaks !== undefined && breaks.length > 0
      ? packSegments(lines, breaks)
      : fixedWindows(lines, 1);
  }

  const chunks: Chunk[] = [];
  for (const [startLine, endLine] of spans) {
    const text = lines.slice(startLine - 1, endLine).join("\n");
    if (!text.trim()) continue;
    chunks.push({ path, startLine, endLine, lang, content: text });
  }
  return chunks;
}
