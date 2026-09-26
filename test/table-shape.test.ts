// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The shape of a hosted table and the doors that run over its rows: what a
// schema (and a card) resolve to, how a row becomes a hit, the SQL a row find
// sends, how the caller's embed map folds into the platform's placeholder,
// the tool text built from the shape, and the ledger entries. No network:
// the one client call is against a scripted fetch.

import { describe, expect, it } from "vitest";
import { HostedDb } from "../src/core/hosted.js";
import {
  ENGINE_ID_COLUMN,
  SNIPPET_CHARS,
  rowFact,
  rowHit,
  rowKey,
  snippet,
  sqlLiteral,
  tableShapeFrom,
  type SchemaField,
} from "../src/core/table-shape.js";
import { findRows, findRowsSql, foldEmbeds, searchRows } from "../src/core/searcher.js";
import { rowFindEntry, rowSearchEntry, formatReceipt } from "../src/core/usage.js";
import { rowsFindDescription, rowsInstructions, rowsSearchDescription, rowsSqlDescription } from "../src/mcp/server.js";

/** The chunks table as `POST /v1/schema` describes the one this client loads. */
const CHUNKS_SCHEMA: SchemaField[] = [
  { name: "path", type: "large_utf8" },
  { name: "start_line", type: "int32" },
  { name: "end_line", type: "int32" },
  { name: "lang", type: "large_utf8" },
  { name: "symbol", type: "large_utf8" },
  { name: "content", type: "large_utf8" },
  { name: "embedding", type: "embedding", source: ["content"] },
];

/** The live job-postings table (cxbench.chunks_jobs), as its schema came
 * back on 2026-09-11: hydrate cast the indexed and embedded text columns to
 * large_utf8 and left the rest utf8. */
const JOBS_SCHEMA: SchemaField[] = [
  { name: "id", nullable: true, type: "utf8" },
  { name: "source_slug", nullable: true, type: "utf8" },
  { name: "title", nullable: true, type: "large_utf8" },
  { name: "apply_url", nullable: true, type: "utf8" },
  { name: "description_html", nullable: true, type: "large_utf8" },
  { name: "employment_type", nullable: true, type: "utf8" },
  { name: "department", nullable: true, type: "utf8" },
  { item: "utf8", name: "locations", nullable: true, type: "list" },
  { name: "remote", nullable: true, type: "bool" },
  { name: "posted_at", nullable: true, type: "utf8" },
  { name: "updated_at", nullable: true, type: "utf8" },
  { name: "salary_min", nullable: true, type: "f64" },
  { name: "salary_max", nullable: true, type: "f64" },
  { name: "salary_currency", nullable: true, type: "utf8" },
  { name: "salary_period", nullable: true, type: "utf8" },
  { name: "emb", nullable: false, source: ["title"], type: "embedding" },
];

const JOBS = tableShapeFrom("chunks_jobs", JOBS_SCHEMA);

describe("tableShapeFrom", () => {
  it("recognizes the chunks table by its place columns and content", () => {
    const shape = tableShapeFrom("chunks", CHUNKS_SCHEMA);
    expect(shape.isChunks).toBe(true);
    expect(shape.vectorColumn).toBe("embedding");
    expect(shape.primaryText).toBe("content");
  });

  it("reads the jobs table from its schema alone: the embedded column, the LargeUtf8 text, the key", () => {
    expect(JOBS.isChunks).toBe(false);
    expect(JOBS.vectorColumn).toBe("emb");
    expect(JOBS.vectorSource).toEqual(["title"]);
    expect(JOBS.textColumns).toEqual(["title", "description_html"]);
    // No card named the roles: the LargeUtf8 types stood in, and the shape says so.
    expect(JOBS.textColumnsInferred).toBe(true);
    // Named like the text, so preferred over the embedding's source.
    expect(JOBS.primaryText).toBe("description_html");
    expect(JOBS.keyColumn).toBe("id");
    expect(JOBS.listColumns).toEqual(["locations"]);
    expect(JOBS.scalarColumns).not.toContain("title");
    expect(JOBS.scalarColumns).not.toContain("locations");
    expect(JOBS.scalarColumns).toContain("source_slug");
  });

  it("projects every column but the vector, with score, and the types as the tool text shows them", () => {
    expect(JOBS.projection).not.toContain("emb");
    expect(JOBS.projection).not.toContain(ENGINE_ID_COLUMN);
    expect(JOBS.projection[JOBS.projection.length - 1]).toBe("score");
    expect(JOBS.projection).toContain("locations");
    expect(JOBS.columns.find((c) => c.name === "locations")?.type).toBe("list<utf8>");
    expect(JOBS.columns.find((c) => c.name === "emb")?.type).toBe("embedding");
  });

  it("takes the card's roles over the types when a card names them", () => {
    const card = {
      table: "chunks_jobs",
      rows: 10,
      schema: [
        { name: "title", type: "LargeUtf8", index: "scalar" },
        { name: "description_html", type: "LargeUtf8", index: "fts" },
        { name: "emb", type: "FixedSizeList(768 x non-null Float32)", index: "vector" },
        { name: "source_slug", type: "Utf8", index: "key" },
      ],
    };
    const shape = tableShapeFrom("chunks_jobs", JOBS_SCHEMA, card);
    expect(shape.textColumns).toEqual(["description_html"]);
    expect(shape.textColumnsInferred).toBe(false);
    expect(shape.keyColumn).toBe("source_slug");
    expect(shape.card).toBe(card);
  });

  it("searches an indexed column, never the embedding's source when that is not indexed", () => {
    // The jobs pattern - a column embedded but not indexed - under names the
    // hint misses: the card indexes `notes` and marks `subject`, the
    // embedding's source, scalar. A hybrid search or token match over
    // `subject` is refused by the engine, which has no full-text index there.
    const fields: SchemaField[] = [
      { name: "ticket", type: "utf8" },
      { name: "notes", type: "large_utf8" },
      { name: "subject", type: "large_utf8" },
      { name: "vec", type: "embedding", source: ["subject"] },
    ];
    const card = {
      table: "tickets",
      schema: [
        { name: "notes", type: "LargeUtf8", index: "fts" },
        { name: "subject", type: "LargeUtf8", index: "scalar" },
        { name: "vec", type: "FixedSizeList(768 x non-null Float32)", index: "vector" },
      ],
    };
    const shape = tableShapeFrom("tickets", fields, card);
    expect(shape.textColumns).toEqual(["notes"]);
    expect(shape.primaryText).toBe("notes");
    // Without the card both columns are LargeUtf8 and so taken as indexed,
    // and the embedding's source is the pick among them, as before.
    expect(tableShapeFrom("tickets", fields).primaryText).toBe("subject");
  });

  it("believes a card that names no full-text column: nothing is searched, and nothing is called inferred", () => {
    // The optimizer probed every text column; a card with no fts role is a
    // table with no full-text index, not a table with no card. The embedded
    // column and the key must not stand in for one - the engine would refuse
    // a hybrid_search or token_match over either.
    const fields: SchemaField[] = [
      { name: "ticket", type: "utf8" },
      { name: "subject", type: "large_utf8" },
      { name: "vec", type: "embedding", source: ["subject"] },
    ];
    const card = {
      table: "tickets",
      schema: [
        { name: "ticket", type: "Utf8", index: "key" },
        { name: "subject", type: "LargeUtf8", index: "scalar" },
        { name: "vec", type: "FixedSizeList(768 x non-null Float32)", index: "vector" },
      ],
    };
    const shape = tableShapeFrom("tickets", fields, card);
    expect(shape.textColumns).toEqual([]);
    expect(shape.textColumnsInferred).toBe(false);
    expect(shape.primaryText).toBe("");
    expect(shape.keyColumn).toBe("ticket");
    // Nor does a plain text column become the searched one when a card exists.
    const plain = tableShapeFrom("tickets", [{ name: "ticket", type: "utf8" }, { name: "subject", type: "utf8" }], card);
    expect(plain.primaryText).toBe("");
    // Only with no card at all do the types, then any text column, stand in.
    expect(tableShapeFrom("tickets", [{ name: "ticket", type: "utf8" }, { name: "subject", type: "utf8" }]).primaryText).toBe("ticket");
  });

  it("falls back to the embedding's source, then the engine id, on a table with neither hint", () => {
    const shape = tableShapeFrom("t", [
      { name: "headline", type: "large_utf8" },
      { name: "n", type: "i64" },
      { name: "vec", type: "embedding", source: ["headline"] },
    ]);
    expect(shape.primaryText).toBe("headline");
    expect(shape.keyColumn).toBe(ENGINE_ID_COLUMN);
    // With nothing of the table's to key a row, the engine's id is asked for.
    expect(shape.projection[0]).toBe(ENGINE_ID_COLUMN);
  });

  it("has no vector column for a table that only carries a client-filled vector", () => {
    // Text cannot be sent against such a column: the platform did not embed
    // it, so it has no model to embed the query with.
    const shape = tableShapeFrom("t", [
      { name: "body", type: "large_utf8" },
      { name: "v", type: "vector", dim: 16 },
    ]);
    expect(shape.vectorColumn).toBeNull();
    expect(shape.projection).not.toContain("v");
    expect(shape.columns.find((c) => c.name === "v")?.type).toBe("vector<16>");
  });
});

describe("snippet", () => {
  it("decodes entity-escaped HTML, strips the tags, collapses whitespace", () => {
    // The shape a stored job description has: HTML, itself entity-escaped.
    const stored = "&lt;div class=&quot;intro&quot;&gt;&lt;p&gt;&lt;strong&gt;About&lt;/strong&gt; us&amp;nbsp;&amp;mdash; we\n\n  build&lt;/p&gt;&lt;/div&gt;";
    expect(snippet(stored)).toBe("About us — we build");
  });

  it("strips plain HTML and decodes numeric references too", () => {
    expect(snippet("<p>That&#39;s <em>fine</em> &amp; done</p>")).toBe("That's fine & done");
  });

  it("caps the text at SNIPPET_CHARS and marks the cut", () => {
    const long = "word ".repeat(400);
    const out = snippet(long);
    expect(out.length).toBe(SNIPPET_CHARS + "...".length);
    expect(out.endsWith("...")).toBe(true);
    expect(snippet("short")).toBe("short");
  });

  it("keeps plain text verbatim, angle brackets and entities included: only HTML is stripped", () => {
    // Prose that holds a `<` is not markup, and a tag stripper that does not
    // ask first turns "a < b and c > d" into "a d".
    expect(snippet("retry while a < b and c > d")).toBe("retry while a < b and c > d");
    expect(snippet("returns a Vec<T> of rows", "title")).toBe("returns a Vec<T> of rows");
    expect(snippet("Tom &amp; Jerry", "title")).toBe("Tom &amp; Jerry");
    // Two tags make it HTML, and so does a column whose name says so - the
    // one `<T>` above is neither.
    expect(snippet("<p>Vec<T></p>")).toBe("Vec");
    expect(snippet("Vec<T>", "description_html")).toBe("Vec");
  });
});

describe("rowHit", () => {
  const row = {
    id: "greenhouse:acme:1",
    source_slug: "acme",
    title: "Rust Engineer",
    apply_url: "https://acme.test/1",
    description_html: "&lt;p&gt;Build &lt;b&gt;fast&lt;/b&gt; things&lt;/p&gt;",
    locations: ["Remote"],
    remote: true,
    score: 0.5,
  };

  it("orders a hit score, key, scalars, then the text columns as snippets, and drops omitted cells", () => {
    const hit = rowHit(row, JOBS);
    expect(Object.keys(hit)).toEqual(["score", "id", "source_slug", "apply_url", "locations", "remote", "title", "description_html"]);
    expect(hit.description_html).toBe("Build fast things");
    expect(hit.title).toBe("Rust Engineer");
    expect(hit).not.toHaveProperty("salary_min");
    expect(rowKey(row, JOBS)).toBe("greenhouse:acme:1");
  });

  it("renders a fact of the loop the same way, keeping the statement's own aliases and leaving the vector out", () => {
    // A loop's statement is not a projection of the table: an aggregate's
    // count travels under an alias no schema carries, and a hit of the
    // table's columns alone would drop the answer.
    const fact = rowFact({ ...row, n: 7, ranked_rows: 3, emb: [0.1, 0.2] }, JOBS);
    expect(Object.keys(fact)).toEqual(["score", "id", "source_slug", "apply_url", "locations", "remote", "title", "description_html", "n", "ranked_rows"]);
    expect(fact.description_html).toBe("Build fast things");
    expect(fact.locations).toEqual(["Remote"]);
    expect(fact).not.toHaveProperty("emb");
    expect(rowFact({ department: "Eng", n: 42 }, JOBS)).toEqual({ department: "Eng", n: 42 });
  });
});

describe("the doors over rows", () => {
  it("search asks the platform for the table's own text and embedding columns with its projection", async () => {
    const calls: unknown[][] = [];
    const hosted = {
      hybridSearch: async (...args: unknown[]) => {
        calls.push(args);
        return [{ id: "a", title: "T", description_html: "&lt;p&gt;x&lt;/p&gt;", score: 1 }];
      },
      bm25Search: async () => {
        throw new Error("not the keyword route: the table has an embedding column");
      },
    };
    const result = await searchRows(hosted, JOBS, "rust jobs", 3);
    expect(calls).toEqual([["chunks_jobs", "description_html", "emb", "rust jobs", 3, JOBS.projection]]);
    expect(result).toMatchObject({ ranking: "hybrid", table: "chunks_jobs", key: "id" });
    expect(result.hits).toEqual([{ score: 1, id: "a", title: "T", description_html: "x" }]);
  });

  it("search falls back to the keyword route when the table has no embedding column", async () => {
    const shape = tableShapeFrom("t", [{ name: "body", type: "large_utf8" }, { name: "n", type: "i64" }]);
    const calls: unknown[][] = [];
    const hosted = {
      hybridSearch: async () => {
        throw new Error("no vector to fuse");
      },
      bm25Search: async (...args: unknown[]) => {
        calls.push(args);
        return [];
      },
    };
    const result = await searchRows(hosted, shape, "q", 5);
    expect(calls).toEqual([["t", "body", "q", 5, shape.projection]]);
    expect(result.ranking).toBe("keyword");
  });

  it("find spells the token_match statement with quotes doubled and the total beside each row under a name no schema carries", () => {
    const sql = findRowsSql(JOBS, "o'reilly rust", 40);
    expect(sql).toBe(
      'SELECT COUNT(*) OVER () AS __cx_total, "id", "source_slug", "title", "apply_url", "description_html", ' +
        '"employment_type", "department", "locations", "remote", "posted_at", "updated_at", "salary_min", ' +
        '"salary_max", "salary_currency", "salary_period" ' +
        "FROM token_match('chunks_jobs', 'description_html', 'o''reilly rust', 'and') LIMIT 40",
    );
    expect(sqlLiteral("it's")).toBe("'it''s'");
  });

  it("find blanks the query grammar, reads the total off the rows, and marks a cut", async () => {
    const sent: string[] = [];
    const hosted = {
      querySql: async (sql: string) => {
        sent.push(sql);
        return [
          { __cx_total: 7, id: "a", title: "A" },
          { __cx_total: 7, id: "b", title: "B" },
        ];
      },
    };
    const result = await findRows(hosted, JOBS, 'senior -rust "engineer"', { limit: 2 });
    expect(sent[0]).toContain("'senior  rust  engineer '");
    expect(sent[0]).toContain("LIMIT 2");
    expect(result).toMatchObject({ table: "chunks_jobs", column: "description_html", key: "id", total: 7, truncated: true });
    expect(result.matches).toEqual([
      { id: "a", title: "A" },
      { id: "b", title: "B" },
    ]);
  });

  it("keeps a table's own total and score columns: the count alias collides with neither, and score is named once", async () => {
    const shape = tableShapeFrom("t", [
      { name: "id", type: "utf8" },
      { name: "total", type: "i64" },
      { name: "score", type: "f64" },
      { name: "body", type: "large_utf8" },
    ]);
    expect(shape.rowColumns).toEqual(["id", "total", "score", "body"]);
    expect(shape.projection).toEqual(["id", "total", "score", "body"]);
    expect(shape.projection.filter((name) => name === "score")).toHaveLength(1);
    expect(findRowsSql(shape, "x", 5)).toBe(
      'SELECT COUNT(*) OVER () AS __cx_total, "id", "total", "score", "body" FROM token_match(\'t\', \'body\', \'x\', \'and\') LIMIT 5',
    );
    const hosted = { querySql: async () => [{ __cx_total: 2, id: "a", total: 9, score: 0.5, body: "x" }] };
    const result = await findRows(hosted, shape, "x");
    expect(result.total).toBe(2);
    expect(result.matches).toEqual([{ score: 0.5, id: "a", total: 9, body: "x" }]);
  });

  it("find refuses what the chunks find refuses, and reports no rows as zero", async () => {
    const hosted = { querySql: async () => [] };
    await expect(findRows(hosted, JOBS, "")).rejects.toThrow(/non-empty/);
    await expect(findRows(hosted, JOBS, "a\nb")).rejects.toThrow(/newline/);
    await expect(findRows(hosted, JOBS, "->")).rejects.toThrow(/regexp_like\(description_html/);
    await expect(findRows(hosted, JOBS, "x", { limit: 0 })).rejects.toThrow(/positive integer/);
    expect(await findRows(hosted, JOBS, "nothing")).toMatchObject({ total: 0, matches: [] });
  });

  it("foldEmbeds turns {{q}} with an embed map into the platform's inline form and leaves that form alone", () => {
    expect(foldEmbeds("SELECT * FROM hybrid_search('t','b','x','e', {{q}}, 5)", { q: "rust jobs" })).toBe(
      'SELECT * FROM hybrid_search(\'t\',\'b\',\'x\',\'e\', {{q:"rust jobs"}}, 5)',
    );
    const inline = 'SELECT * FROM vector_search(\'t\',\'e\', {{q:"already inline"}}, 5)';
    expect(foldEmbeds(inline, undefined)).toBe(inline);
    expect(foldEmbeds("SELECT 1", undefined)).toBe("SELECT 1");
    expect(() => foldEmbeds("SELECT {{q}}", undefined)).toThrow(/no 'embed' map/);
    expect(() => foldEmbeds("SELECT {{q}}", {})).toThrow(/no 'embed' text/);
    expect(() => foldEmbeds("SELECT {{q}}", { q: 'a"}}b' })).toThrow(/ends the platform's placeholder/);
  });
});

describe("the tool text for a table of another shape", () => {
  it("names the table's real columns, types, indexes and search functions in the sql description", () => {
    const text = rowsSqlDescription(JOBS);
    expect(text).toContain("chunks_jobs(id utf8, source_slug utf8, title large_utf8");
    expect(text).toContain("locations list<utf8>");
    expect(text).toContain("Full-text indexed: title, description_html");
    expect(text).toContain("Vector column: emb, the platform's embedding of title");
    expect(text).toContain("hybrid_search('chunks_jobs','description_html','terms','emb', {{q:\"...\"}}, k)");
    expect(text).toContain("bm25_search('chunks_jobs','description_html','terms', k)");
    expect(text).toContain("vector_search('chunks_jobs','emb', {{q:\"...\"}}, k)");
    expect(text).toContain("token_match('chunks_jobs','description_html','terms','and')");
    expect(text).toContain("returns _id, the table's scalar columns and score");
    expect(text).toContain("array_has(locations, '...')");
    // The measured clauses, transposed: hybrid before bm25, the placeholder
    // the caller's, a ranked total never the table's count, the scan named.
    expect(text.indexOf("hybrid_search")).toBeLessThan(text.indexOf("bm25_search"));
    expect(text).toMatch(/are yours to fill in, not literals to copy/);
    expect(text).toContain("never the table's count");
    for (const predicate of ["ILIKE", "LIKE", "regexp_like"]) expect(text).toContain(predicate);
    // Nothing of the chunks table leaks into it.
    expect(text).not.toContain("start_line");
    expect(text).not.toContain("'content'");
  });

  it("says terms alone when the table has no embedding column", () => {
    const shape = tableShapeFrom("t", [{ name: "body", type: "large_utf8" }, { name: "n", type: "i64" }]);
    const text = rowsSqlDescription(shape);
    expect(text).toContain("No vector column");
    expect(text).not.toContain("hybrid_search");
    expect(text).toContain("bm25_search('t','body','terms', 300)");
  });

  it("says the full-text columns are inferred from the schema when no card named them, and states them when one did", () => {
    // Without a card the LargeUtf8 types stand in for the fts role, and
    // hydrate casts an embedded-only column to LargeUtf8 too - so the jobs
    // table's `title` is listed although only `description_html` is indexed.
    // The text must not state that list as the table's own.
    const inferred = rowsSqlDescription(JOBS);
    expect(inferred).toContain("Full-text indexed: title, description_html (inferred from the schema - the table has no card naming its indexes yet");
    expect(inferred).toContain("one the platform only embeds may be among them). ");
    const carded = rowsSqlDescription(
      tableShapeFrom("chunks_jobs", JOBS_SCHEMA, { schema: [{ name: "description_html", index: "fts" }, { name: "title", index: "scalar" }] }),
    );
    expect(carded).toContain("Full-text indexed: description_html. ");
    expect(carded).not.toContain("inferred from the schema");
  });

  it("says table and row and names the key where the chunks text says repository and path:line", () => {
    for (const text of [rowsInstructions(JOBS, true), rowsSearchDescription(JOBS), rowsFindDescription(JOBS)]) {
      expect(text).toContain("chunks_jobs");
      expect(text).toMatch(/\brow/);
      expect(text).not.toContain("path:line");
      expect(text).not.toContain("repository index");
    }
    expect(rowsSearchDescription(JOBS)).toContain("cite a row by its id");
    expect(rowsFindDescription(JOBS)).toContain("ignoreCase, defines and under describe a code index and do nothing here");
    expect(rowsInstructions(JOBS, true)).toContain("- ask -");
    expect(rowsInstructions(JOBS, false)).not.toContain("- ask -");
  });
});

describe("the ledger over rows", () => {
  it("records each row by its key, the table, and prices the hits as returned", () => {
    const search = rowSearchEntry({
      query: "q",
      ranking: "hybrid",
      table: "chunks_jobs",
      key: "id",
      hits: [{ score: 1, id: "a", title: "T" }],
    });
    expect(search).toMatchObject({ tool: "search", table: "chunks_jobs", ranking: "hybrid", hits: [{ path: "a", startLine: 0, endLine: 0 }] });
    expect(search.wholeFileTokens).toBeUndefined();
    expect(formatReceipt(search)).toMatch(/^returned ~\d+ tokens \| 1 row$/);

    const find = rowFindEntry({
      query: "q",
      table: "chunks_jobs",
      column: "description_html",
      key: "id",
      matches: [{ id: "a" }, { id: "b" }],
      total: 12,
      truncated: true,
    });
    expect(find).toMatchObject({ tool: "find", table: "chunks_jobs", matches: 12, hits: [{ path: "a" }, { path: "b" }] });
    expect(formatReceipt(find)).toMatch(/^returned ~\d+ tokens \| 12 rows$/);
  });
});

describe("HostedDb.bm25Search", () => {
  it("posts the platform's Bm25SearchRequest shape and decodes the rows", async () => {
    let seen: { url: string; body: unknown } | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      seen = { url: String(input), body: JSON.parse(init?.body as string) };
      return new Response(JSON.stringify([{ id: "a", score: 2 }]), { status: 200, headers: { "content-type": "application/json" } });
    };
    const db = new HostedDb({ baseUrl: "https://api.example.test", database: "cx", apiKey: "inf_test_key_do_not_log" }, { fetch: fetchImpl });
    expect(await db.bm25Search("chunks_jobs", "description_html", "rust engineer", 3, ["id", "title", "score"])).toEqual([{ id: "a", score: 2 }]);
    expect(seen?.url).toBe("https://api.example.test/v1/bm25_search/cx");
    expect(seen?.body).toEqual({
      table_name: "chunks_jobs",
      field_name: "description_html",
      query: "rust engineer",
      k: 3,
      mode: "Or",
      projection: ["id", "title", "score"],
    });
  });
});
