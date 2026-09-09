import { describe, expect, it } from "vitest";
import { chunkFile, embedText, langFor, looksBinary, shouldIndexFile } from "../src/core/chunker.js";

describe("shouldIndexFile", () => {
  it("accepts source files and known basenames", () => {
    expect(shouldIndexFile("src/main.rs")).toBe(true);
    expect(shouldIndexFile("a/b/c.tsx")).toBe(true);
    expect(shouldIndexFile("Makefile")).toBe(true);
    expect(shouldIndexFile("docker/Dockerfile")).toBe(true);
  });

  it("rejects lockfiles, minified assets, and unknown extensions", () => {
    expect(shouldIndexFile("package-lock.json")).toBe(false);
    expect(shouldIndexFile("vendor.min.js")).toBe(false);
    expect(shouldIndexFile("photo.png")).toBe(false);
    expect(shouldIndexFile(".env")).toBe(false);
    expect(shouldIndexFile("app.js.map")).toBe(false);
  });
});

describe("langFor", () => {
  it("maps extensions to language tags", () => {
    expect(langFor("src/lib.rs")).toBe("rs");
    expect(langFor("a.spec.TSX")).toBe("tsx");
    expect(langFor("README.md")).toBe("md");
  });
});

describe("looksBinary", () => {
  it("detects NUL bytes in the head", () => {
    expect(looksBinary(Buffer.from([0x68, 0x00, 0x69]))).toBe(true);
    expect(looksBinary(Buffer.from("plain text"))).toBe(false);
  });
});

describe("chunkFile", () => {
  it("returns nothing for empty content", async () => {
    expect(await chunkFile("a.ts", "   \n  ")).toEqual([]);
  });

  it("cuts code at definition boundaries (tree-sitter)", async () => {
    const fns = Array.from(
      { length: 6 },
      (_, i) => `export function f${i}() {\n${"  // body\n".repeat(15)}  return ${i};\n}`,
    ).join("\n");
    const chunks = await chunkFile("mod.ts", fns);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk starts exactly at a function boundary.
    for (const c of chunks) {
      const firstLine = c.content.split("\n")[0];
      expect(firstLine).toMatch(/^export function f\d/);
    }
    // Line ranges tile the file without gaps.
    expect(chunks[0].startLine).toBe(1);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startLine).toBe(chunks[i - 1].endLine + 1);
    }
  });

  it("keeps a definition's doc comment in the chunk that holds its signature", async () => {
    // Breaking at the signature line put the doc block in the PREVIOUS chunk.
    // Measured over five of the engine's own source files, that split 318 of
    // 568 documented definitions (56%) - including one whose doc block reads
    // "Currently a test-only helper" four lines above a signature that started
    // a new chunk, so a hit on the body could not show the warning and an
    // answer built on it called the helper a live path. Doc blocks are also
    // where defaults are stated, which is the other thing those answers got
    // wrong. Each function here is ~18 lines against TARGET_LINES 60, so the
    // packer must break between them.
    const fns = Array.from(
      { length: 8 },
      (_, i) =>
        `/** What f${i} does.\n *  The default is ${i * 10}.\n */\nexport function f${i}() {\n${"  // body\n".repeat(14)}  return ${i};\n}`,
    ).join("\n");
    const chunks = await chunkFile("mod.ts", fns);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < 8; i++) {
      const holding = chunks.find((c) => c.content.includes(`export function f${i}()`));
      expect(holding, `f${i} lands in a chunk`).toBeDefined();
      expect(holding!.content, `f${i} carries its own doc block`).toContain(`What f${i} does.`);
      expect(holding!.content, `f${i} carries the default from its doc block`).toContain(
        `The default is ${i * 10}.`,
      );
    }
    // Only the break moved: the definition's own row is unchanged, so the
    // symbol is still attributed to the chunk holding its signature.
    expect(chunks.some((c) => c.symbol)).toBe(true);
    // Line ranges still tile the file without gaps or overlap.
    expect(chunks[0].startLine).toBe(1);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startLine).toBe(chunks[i - 1].endLine + 1);
    }
  });

  it("names a continuation chunk by the definition that encloses it", async () => {
    // A definition over MAX_LINES is split into fixed windows, and those
    // windows used to carry no symbol at all - 17% of chunks and 20% of the
    // indexed characters on the engine's own source. A model handed an
    // anonymous window reports the only line numbers it has, the window's,
    // which is the judge's "misplaces probe_pointer's range (218-251 vs the
    // real 252-283)". Every chunk now names what it is part of, and carries
    // the definition's true span - which is what a reassembly query needs.
    const body = Array.from({ length: 200 }, (_, i) => `  const step${i} = ${i};`).join("\n");
    const src = `export function hugeMechanism() {\n${body}\n}\n`;
    const chunks = await chunkFile("big.ts", src);
    expect(chunks.length).toBeGreaterThan(2);
    // The definition ends on the file's last brace, so every chunk is either
    // its opening or a part of it, and none is anonymous.
    const anonymous = chunks.filter((c) => !c.symbol);
    expect(anonymous, "no chunk of a split definition is anonymous").toEqual([]);
    // Continuations say they are parts, and give the whole definition's span.
    const parts = chunks.filter((c) => c.symbol?.includes(", part)"));
    expect(parts.length).toBeGreaterThan(0);
    const defEnd = src.trimEnd().split("\n").length;
    const span = `(1-${defEnd}, part)`;
    for (const p of parts) {
      expect(p.symbol, "a part names the definition and its true extent").toContain("hugeMechanism");
      expect(p.symbol, `the span is the definition's, not the window's: ${p.symbol}`).toContain(span);
    }
    // The point of it: at least one part ends well before the definition does
    // and still reports the definition's end, which is the number a citation
    // needs and the window could never supply.
    const early = parts.filter((p) => p.endLine < defEnd);
    expect(early.length, "some part ends before the definition").toBeGreaterThan(0);
    for (const p of early) {
      expect(p.symbol).toContain(`-${defEnd},`);
      expect(p.symbol).not.toContain(`-${p.endLine},`);
    }
  });

  it("cuts bash, css, and powershell at definition boundaries", async () => {
    const cases = [
      { path: "script.sh", re: /^f\d\(\) \{/, code: Array.from({ length: 6 }, (_, i) => `f${i}() {\n${"  echo body\n".repeat(15)}}`).join("\n") },
      { path: "styles.css", re: /^\.cls\d/, code: Array.from({ length: 8 }, (_, i) => `.cls${i} {\n${"  color: red;\n".repeat(8)}}`).join("\n") },
      { path: "mod.ps1", re: /^function Get-Thing\d/, code: Array.from({ length: 5 }, (_, i) => `function Get-Thing${i} {\n${"  Write-Output 1\n".repeat(15)}}`).join("\n") },
    ];
    for (const { path, re, code } of cases) {
      const chunks = await chunkFile(path, code);
      expect(chunks.length).toBeGreaterThan(1);
      // Every chunk begins exactly on a definition line (fixed-window fallback
      // would start mid-block on the overlapping windows).
      for (const c of chunks) expect(c.content.split("\n")[0]).toMatch(re);
    }
  });

  it("splits markdown at headings", async () => {
    const md = ["# Title", ...Array(70).fill("text"), "## Second", ...Array(10).fill("more")].join("\n");
    const chunks = await chunkFile("doc.md", md);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.at(-1)!.content.startsWith("## Second")).toBe(true);
  });

  it("ignores headings inside fenced code blocks", async () => {
    const md = ["# Title", "```", "# not a heading", "```", "text"].join("\n");
    const chunks = await chunkFile("doc.md", md);
    expect(chunks).toHaveLength(1);
  });

  it("falls back to fixed windows for unknown languages", async () => {
    const content = Array.from({ length: 150 }, (_, i) => `line ${i}`).join("\n");
    const chunks = await chunkFile("data.toml", content);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(60);
    // Fixed windows overlap by 10 lines.
    expect(chunks[1].startLine).toBe(51);
  });

  it("ends the last chunk at the file's last line, not one past it", async () => {
    // Nearly every file ends with "\n". The empty string split() leaves behind
    // that final newline is not a line, so MAX(end_line) must equal `wc -l`
    // through every span builder: fixed windows, tree-sitter, markdown.
    const fn = (i: number) => `export function f${i}() {\n${"  // body\n".repeat(15)}  return ${i};\n}\n`;
    const cases: Array<{ path: string; content: string; lines: number }> = [
      { path: "notes.txt", content: "a\nb\nc\n", lines: 3 },
      { path: "notes.txt", content: "a\r\nb\r\nc\r\n", lines: 3 },
      { path: "notes.txt", content: "a\nb\nc", lines: 3 }, // no trailing newline: nothing to drop
      { path: "notes.txt", content: "a\n\n\n", lines: 3 }, // blank last lines are still lines
      { path: "notes.txt", content: Array.from({ length: 150 }, (_, i) => `line ${i}`).join("\n") + "\n", lines: 150 },
      { path: "mod.ts", content: "export function a() {\n  return 1;\n}\n\nexport function b() {\n  return 2;\n}\n", lines: 7 },
      { path: "mod.ts", content: Array.from({ length: 6 }, (_, i) => fn(i)).join(""), lines: 6 * 18 },
      { path: "doc.md", content: "# Title\ntext\n## Second\nmore\n", lines: 4 },
    ];
    for (const { path, content, lines } of cases) {
      const chunks = await chunkFile(path, content);
      expect(chunks[0].startLine).toBe(1);
      // No gaps between consecutive chunks (fixed windows overlap, so <=).
      for (let i = 1; i < chunks.length; i++) {
        expect(chunks[i].startLine).toBeLessThanOrEqual(chunks[i - 1].endLine + 1);
      }
      expect(Math.max(...chunks.map((c) => c.endLine))).toBe(lines);
    }
  });

  it("carries the path and language on every chunk", async () => {
    const chunks = await chunkFile("src/x.py", "def f():\n    return 1\n");
    expect(chunks[0]).toMatchObject({ path: "src/x.py", lang: "py", startLine: 1 });
  });

  it("attaches symbol names and enclosing scope from the AST", async () => {
    const method = (n: number) => `  m${n}() {\n${"    doThing();\n".repeat(40)}  }`;
    const src = `class C {\n${[0, 1, 2].map(method).join("\n")}\n}`;
    const chunks = await chunkFile("cfg.ts", src);
    // A chunk holding a method (but not the class opener) is scoped to the class.
    const scoped = chunks.find((c) => c.scope === "C" && /m\d/.test(c.symbol ?? ""));
    expect(scoped).toBeDefined();
  });

  it("carries the markdown heading as symbol, nested under its parent", async () => {
    const md = ["# Title", ...Array(70).fill("text"), "## Second", ...Array(10).fill("more")].join("\n");
    const chunks = await chunkFile("doc.md", md);
    expect(chunks.some((c) => c.symbol === "Title")).toBe(true);
    const second = chunks.find((c) => c.content.startsWith("## Second"));
    expect(second?.symbol).toBe("Second");
    expect(second?.scope).toBe("Title");
  });

  it("leaves symbol unset for fixed-window (unparsed) chunks", async () => {
    const content = Array.from({ length: 150 }, (_, i) => `line ${i}`).join("\n");
    const chunks = await chunkFile("data.toml", content);
    expect(chunks.every((c) => c.symbol === undefined)).toBe(true);
  });

  it("keeps a log record and the stack trace under it in one chunk", async () => {
    // The case fixed windows get wrong: the query names the exception and the
    // answer needs the frames, so a cut between them costs the answer.
    const trace = (n: number) =>
      [
        `2026-09-08T14:${String(n).padStart(2, "0")}:00.123Z ERROR api.gateway request failed`,
        "java.lang.IllegalStateException: pool exhausted",
        ...Array.from({ length: 24 }, (_, f) => `\tat com.infino.Pool.acquire(Pool.java:${f + 1})`),
        "Caused by: java.net.SocketTimeoutException: connect timed out",
      ].join("\n");
    const log = [0, 1, 2, 3].map(trace).join("\n") + "\n";

    const chunks = await chunkFile("var/log/api.log", log);
    // Every chunk that holds the exception line also holds frames from it, and
    // no chunk starts mid-trace.
    const holding = chunks.filter((c) => c.content.includes("pool exhausted"));
    expect(holding.length).toBeGreaterThan(0);
    for (const c of holding) {
      expect(c.content).toContain("at com.infino.Pool.acquire");
      expect(c.content).toContain("Caused by:");
    }
    for (const c of chunks) {
      expect(c.content.trimStart().startsWith("at com.infino")).toBe(false);
    }
  });

  it("carries the log level as the chunk's symbol", async () => {
    const log = [
      "2026-09-08T14:00:00Z INFO api.gateway listening on 9110",
      "2026-09-08T14:00:01Z ERROR api.gateway mint failed",
      "  dispatch failure",
    ].join("\n");
    const chunks = await chunkFile("api.log", log);
    expect(chunks[0].lang).toBe("log");
    // Both records land in one chunk at this size, so the symbol names both
    // levels found in it - what a reader filters on.
    expect(chunks[0].symbol).toContain("ERROR");
  });

  it("never splits a jsonl record across chunks", async () => {
    // One record per line and no continuations, so every line is a boundary
    // and a chunk is always a whole number of records.
    const rows = Array.from(
      { length: 200 },
      (_, i) => JSON.stringify({ ts: `2026-09-08T14:00:${String(i % 60).padStart(2, "0")}Z`, level: "info", seq: i }),
    );
    const chunks = await chunkFile("events.ndjson", rows.join("\n") + "\n");
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      for (const line of c.content.split("\n")) {
        if (line.trim() === "") continue;
        expect(() => JSON.parse(line)).not.toThrow();
      }
    }
  });

  it("falls back to fixed windows for a log with no recognisable records", async () => {
    const content = Array.from({ length: 150 }, (_, i) => `unstructured blather ${i}`).join("\n");
    const chunks = await chunkFile("weird.log", content);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.symbol === undefined)).toBe(true);
  });
});

describe("embedText", () => {
  it("prepends path + breadcrumb, leaving content raw", () => {
    const c = { path: "src/x.ts", startLine: 5, endLine: 9, lang: "ts", content: "function f() {}", symbol: "f", scope: "Mod" };
    const t = embedText(c);
    expect(t.startsWith("src/x.ts\nMod › f\n")).toBe(true);
    expect(t.endsWith("function f() {}")).toBe(true);
    expect(c.content).toBe("function f() {}"); // content itself untouched
  });

  it("falls back to just the path header when there is no symbol/scope", () => {
    const t = embedText({ path: "a.txt", startLine: 1, endLine: 1, lang: "txt", content: "hi" });
    expect(t).toBe("a.txt\nhi");
  });
});
