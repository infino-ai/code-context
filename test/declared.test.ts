// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// `find --declared` exists because of a measured failure: answers that cite
// the place a symbol is *used* rather than the place it is *declared*, which
// a text search cannot tell apart - a call, a doc comment and a definition
// are all just lines holding the word. The chunker already records which
// definitions start in each chunk, so the filter is a predicate over data the
// index carries; these tests pin what the predicate means, including the two
// things it deliberately cannot see.
import { describe, expect, it } from "vitest";
import { declaresName } from "../src/core/searcher.js";

describe("declaresName", () => {
  it("is true when the chunk declares exactly that name", () => {
    expect(declaresName("parseConfig", "parseConfig")).toBe(true);
  });

  it("finds the name among several declared in one chunk", () => {
    expect(declaresName("readManifest, writeManifest, MANIFEST_NAME", "writeManifest")).toBe(true);
  });

  it("is false for a chunk that declares nothing", () => {
    expect(declaresName(undefined, "parseConfig")).toBe(false);
    expect(declaresName("", "parseConfig")).toBe(false);
  });

  it("compares whole names, so a prefix does not count as a declaration", () => {
    // The failure this guards: `select` must not be answered by a chunk that
    // declares `selection`, which is exactly the confusion a substring match
    // introduces and the reason the column is split on commas first.
    expect(declaresName("selection", "select")).toBe(false);
    expect(declaresName("write_pointer", "pointer")).toBe(false);
    expect(declaresName("stale_seal_timeout_ms", "stale_seal_timeout")).toBe(false);
  });

  it("does not match a name that merely appears inside another declaration", () => {
    expect(declaresName("applyEmbeds, embedsFor", "Embeds")).toBe(false);
  });

  it("tolerates the chunker's comma-space joining and stray whitespace", () => {
    expect(declaresName("a,b , c", "b")).toBe(true);
    expect(declaresName("  spaced  ", "spaced")).toBe(true);
    expect(declaresName("a, b", " b ")).toBe(true);
  });

  it("respects case by default and folds when asked", () => {
    expect(declaresName("ParseConfig", "parseconfig")).toBe(false);
    expect(declaresName("ParseConfig", "parseconfig", true)).toBe(true);
  });

  it("is false for an empty query rather than matching everything", () => {
    expect(declaresName("a, b", "")).toBe(false);
    expect(declaresName("a, b", "   ")).toBe(false);
  });

  it("distinguishes the two symbols that produced the original wrong answer", () => {
    // A local `Duration` binding and the settable config field share a stem.
    // An answer that named the binding as a configuration knob is the fault
    // this filter is meant to make avoidable: asking for the declaration of
    // the field must not be satisfied by the chunk declaring the binding.
    const bindingChunk = "stale_seal_timeout";
    const configChunk = "stale_seal_timeout_ms";
    expect(declaresName(configChunk, "stale_seal_timeout_ms")).toBe(true);
    expect(declaresName(bindingChunk, "stale_seal_timeout_ms")).toBe(false);
    expect(declaresName(configChunk, "stale_seal_timeout")).toBe(false);
  });
});
