// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The join gate: which hosted tables a statement names, the aliases it
// gives them, whether the platform's predicate is written in it either way
// round, and the verdict - run, or refuse with the keys.

import { describe, expect, it } from "vitest";
import { aliasesOf, joinGate, joinRefusal, predicateHolds, tablesNamed, type PlatformJoin } from "../src/core/join-gate.js";

const TABLES = ["chunks", "swe_issues", "chunks_swelogs"];
const BY_ID: PlatformJoin = { from_table: "chunks_swelogs", to_table: "swe_issues", predicate: "chunks_swelogs.instance_id = swe_issues.instance_id" };
const BY_PREFIX: PlatformJoin = { from_table: "chunks", to_table: "swe_issues", predicate: "split_part(chunks.path, '/', 1) = swe_issues.project" };
const keys = (joins: PlatformJoin[]) => {
  const asked: string[][] = [];
  return { asked, fetch: async (tables: string[]) => { asked.push(tables); return joins; } };
};

describe("tablesNamed and aliasesOf", () => {
  it("names the known tables a statement uses, as identifiers or as a search function's table", () => {
    expect(tablesNamed("SELECT * FROM swe_issues i JOIN chunks_swelogs l ON l.instance_id = i.instance_id", TABLES)).toEqual(["swe_issues", "chunks_swelogs"]);
    expect(tablesNamed("SELECT path FROM hybrid_search('chunks', 'content', 'x', 'embedding', {{q}}, 20) AS c JOIN swe_issues s ON split_part(c.path, '/', 1) = s.project", TABLES)).toEqual(["chunks", "swe_issues"]);
    // `chunks_swelogs` is not a mention of `chunks`.
    expect(tablesNamed("SELECT count(*) FROM chunks_swelogs WHERE resolved = 'false'", TABLES)).toEqual(["chunks_swelogs"]);
  });

  it("reads each table's alias, with or without AS, and never a keyword", () => {
    const aliases = aliasesOf("SELECT i.project FROM swe_issues i JOIN chunks_swelogs AS l ON l.instance_id = i.instance_id WHERE l.resolved = 'false' GROUP BY i.project", TABLES);
    expect([...aliases]).toEqual([["i", "swe_issues"], ["l", "chunks_swelogs"]]);
    const searched = aliasesOf("SELECT c.path FROM hybrid_search('chunks', 'content', 'x', 'embedding', {{q}}, 20) AS c JOIN swe_issues ON split_part(c.path, '/', 1) = swe_issues.project", TABLES);
    expect([...searched]).toEqual([["c", "chunks"]]);
  });
});

describe("predicateHolds", () => {
  it("finds the key either way round, through aliases, blanks and quotes", () => {
    const q = 'SELECT 1 FROM swe_issues i JOIN chunks_swelogs l ON i."instance_id"=l.instance_id';
    expect(predicateHolds(q, BY_ID.predicate, aliasesOf(q, TABLES))).toBe(true);
    const expr = "SELECT 1 FROM hybrid_search('chunks','content','x','embedding',{{q}},20) AS c JOIN swe_issues s ON s.project = split_part( c.path , '/', 1 )";
    expect(predicateHolds(expr, BY_PREFIX.predicate, aliasesOf(expr, TABLES))).toBe(true);
    const other = "SELECT 1 FROM swe_issues i JOIN chunks_swelogs l ON l.project = i.project";
    expect(predicateHolds(other, BY_ID.predicate, aliasesOf(other, TABLES))).toBe(false);
    const subquery = "SELECT 1 FROM swe_issues WHERE instance_id IN (SELECT instance_id FROM chunks_swelogs)";
    expect(predicateHolds(subquery, BY_ID.predicate, aliasesOf(subquery, TABLES))).toBe(false);
  });
});

describe("joinGate", () => {
  it("lets a one-table statement through without asking for keys", async () => {
    const k = keys([BY_ID]);
    const v = await joinGate("SELECT count(*) FROM chunks_swelogs WHERE resolved = 'false'", TABLES, k.fetch);
    expect(v).toEqual({ kind: "run", tables: ["chunks_swelogs"], keysAsked: false });
    expect(k.asked).toEqual([]);
  });

  it("asks for the keys of the tables named and runs a statement written on one of them", async () => {
    const k = keys([BY_ID, BY_PREFIX]);
    const v = await joinGate("SELECT i.project, count(*) FROM swe_issues i JOIN chunks_swelogs l ON l.instance_id = i.instance_id GROUP BY i.project", TABLES, k.fetch);
    expect(v).toEqual({ kind: "run", tables: ["swe_issues", "chunks_swelogs"], keysAsked: true });
    expect(k.asked).toEqual([["swe_issues", "chunks_swelogs"]]);
  });

  it("refuses a statement across tables written on no key, with the keys between those tables only", async () => {
    const k = keys([BY_ID, BY_PREFIX]);
    const v = await joinGate("SELECT i.instance_id FROM swe_issues i WHERE i.instance_id IN (SELECT instance_id FROM chunks_swelogs WHERE resolved = 'false')", TABLES, k.fetch);
    expect(v.kind).toBe("refuse");
    if (v.kind !== "refuse") return;
    expect(v.keys).toEqual([BY_ID]);
    const text = joinRefusal("sql", v);
    expect(text).toContain("spans swe_issues, chunks_swelogs without a key");
    expect(text).toContain("  chunks_swelogs.instance_id = swe_issues.instance_id");
    expect(text).toContain("Rewrite the statement with one of these");
  });

  it("runs a statement across tables the platform found no key between", async () => {
    const k = keys([]);
    const v = await joinGate("SELECT 1 FROM chunks c JOIN chunks_swelogs l ON c.path = l.path", TABLES, k.fetch);
    expect(v).toEqual({ kind: "run", tables: ["chunks", "chunks_swelogs"], keysAsked: true });
  });
});
