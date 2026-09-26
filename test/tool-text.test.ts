// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// Guards on the tool text that a measurement put there.
//
// The server's header says it: every sentence in a tool description is paid
// for on every turn and was measured to steer selection, so it changes with
// the bench and not by taste. The risk this file covers is narrower than that
// and more mundane - an edit that reads better and quietly removes the half of
// a clause doing the work. Each assertion below names the measurement it
// stands for, so a future reader can weigh the sentence against its evidence
// instead of guessing why it is phrased that way.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SQL_DESCRIPTION } from "../src/mcp/server.js";
import { TABLE } from "../src/core/config.js";

describe("the sql tool's description keeps the clauses a measurement put there", () => {
  it("names hybrid_search before bm25_search everywhere both appear", () => {
    // A tool named second was measured taken 0 times in 1,103 queries, so
    // order in this text decides the choice more than the wording does.
    const hybrid = SQL_DESCRIPTION.indexOf("hybrid_search");
    const bm25 = SQL_DESCRIPTION.indexOf("bm25_search");
    expect(hybrid).toBeGreaterThan(-1);
    expect(bm25).toBeGreaterThan(-1);
    expect(hybrid).toBeLessThan(bm25);

    // And in the worked examples, not only in the prose: the ranking example
    // is the hybrid one and the bm25 form is the gated alternative after it.
    const example = SQL_DESCRIPTION.indexOf("SELECT path, SUM(end_line - start_line + 1)");
    expect(example).toBeGreaterThan(-1);
    const hybridInExample = SQL_DESCRIPTION.indexOf(`hybrid_search('${TABLE}','content','merge small superfiles'`);
    expect(hybridInExample).toBeGreaterThan(example);
    expect(SQL_DESCRIPTION.indexOf(`bm25_search('${TABLE}','content','compaction'`)).toBeGreaterThan(hybridInExample);
  });

  it("marks the example's placeholders as the caller's to fill in", () => {
    // Measured: a model copied an example's placeholder as its literal search
    // keyword in 8 of 8 calls. The imperative form carries 'terms', which is
    // valid SQL and so fails silently when copied.
    expect(SQL_DESCRIPTION).toMatch(/'terms' and \{\{q\}\} are yours to fill in, not literals to copy/);
  });

  it("calls a total over a search relation ranked, never matched", () => {
    // hybrid_search unions its keyword and meaning arms rather than
    // intersecting them, so a row can place in the top k without containing
    // the terms. A column called matched_lines asserts what its rows do not
    // carry, and the judge scores such a number unsupported.
    expect(SQL_DESCRIPTION).toContain("AS ranked_lines");
    expect(SQL_DESCRIPTION).not.toContain("matched_lines");
    expect(SQL_DESCRIPTION).toContain("lines ranked in the top 300 for <topic>");
    // The bound itself has to survive: a total is a share of the top k and is
    // never a file length or a repository-wide count.
    expect(SQL_DESCRIPTION).toMatch(/holds only the top k chunks/);
    expect(SQL_DESCRIPTION).toMatch(/never the file's length or the repository's count/);
  });

  it("keeps both halves of the path clause, since one half alone licenses the fault", () => {
    // Measured: every aggregation statement in the bench that aggregated at
    // all filtered on a path prefix guessed from the subject's name and
    // measured file lengths. A clause permitting a path filter without
    // denying it as the topic is the permission for that fault; a clause
    // denying path filters outright would break the legitimate narrowing use,
    // which the ranking example itself relies on.
    expect(SQL_DESCRIPTION).toContain("A path prefix is not a topic");
    expect(SQL_DESCRIPTION).toContain("path LIKE 'src/%'"); // the narrowing use, beside a search relation
    expect(SQL_DESCRIPTION).toMatch(/guesses the answer from a directory name instead of retrieving it/);
  });

  it("discourages a scan by whichever predicate reaches for it", () => {
    // The drift measured was toward plain scans, not toward ILIKE in
    // particular, so a clause naming only ILIKE leaves the others undescribed.
    for (const predicate of ["ILIKE", "LIKE", "regexp_like"]) {
      expect(SQL_DESCRIPTION).toContain(predicate);
    }
    expect(SQL_DESCRIPTION).toMatch(/a scan has no relevance ranking/);
  });
});

describe("the skill teaches what prose alone was measured not to teach", () => {
  // Measured: across 820 recorded statements the loop wrote, 467 select from a
  // search function and none compose one with a WHERE, GROUP BY, JOIN or
  // aggregate. The capability had been named in one sentence of prose the
  // whole time, so the worked example is the thing under test here.
  const skill = readFileSync(new URL("../skills/code-context/SKILL.md", import.meta.url), "utf8");

  it("shows two relations composed in one statement", () => {
    expect(skill).toContain("JOIN about USING (path)");
    expect(skill).toMatch(/WITH about AS \(/);
    expect(skill).toMatch(/FROM hybrid_search\(/);
    expect(skill).toMatch(/FROM token_match\(/);
  });

  it("names the unranked function as the one to count with", () => {
    // token_match has no top-k, so a count over it is complete rather than a
    // share of a candidate set - which is what makes an aggregation answer
    // checkable at the line it cites.
    expect(skill).toMatch(/unranked and\s+\*\*complete\*\*|\*\*unranked and\s+complete\*\*/);
    expect(skill).toContain("token_match('chunks','content','<term>','and')");
  });

  it("leads with hybrid and keeps the ranked/matched distinction", () => {
    expect(skill.indexOf("hybrid_search")).toBeLessThan(skill.indexOf("bm25_search"));
    expect(skill).toContain("ranked_lines");
    expect(skill).toMatch(/without containing your terms/);
  });
});
