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
