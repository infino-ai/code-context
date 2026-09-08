// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// `find --defines` exists because of a measured failure: answers that cite
// the place a symbol is *used* rather than the place it is *declared*, which
// a text search cannot tell apart - a call, a doc comment and a definition
// are all just lines holding the word. The chunker already records which
// definitions start in each chunk, so the filter is a predicate over data the
// index carries; these tests pin what the predicate means, including the two
// things it deliberately cannot see.
import { describe, expect, it } from "vitest";
import { definesName } from "../src/core/searcher.js";

describe("definesName", () => {
  it("is true when the chunk declares exactly that name", () => {
    expect(definesName("parseConfig", "parseConfig")).toBe(true);
  });

  it("finds the name among several declared in one chunk", () => {
    expect(definesName("readManifest, writeManifest, MANIFEST_NAME", "writeManifest")).toBe(true);
  });

  it("is false for a chunk that declares nothing", () => {
    expect(definesName(undefined, "parseConfig")).toBe(false);
    expect(definesName("", "parseConfig")).toBe(false);
  });

  it("compares whole names, so a prefix does not count as a declaration", () => {
    // The failure this guards: `select` must not be answered by a chunk that
    // declares `selection`, which is exactly the confusion a substring match
    // introduces and the reason the column is split on commas first.
    expect(definesName("selection", "select")).toBe(false);
    expect(definesName("write_pointer", "pointer")).toBe(false);
    expect(definesName("stale_seal_timeout_ms", "stale_seal_timeout")).toBe(false);
  });

  it("does not match a name that merely appears inside another declaration", () => {
    expect(definesName("applyEmbeds, embedsFor", "Embeds")).toBe(false);
  });

  it("tolerates the chunker's comma-space joining and stray whitespace", () => {
    expect(definesName("a,b , c", "b")).toBe(true);
    expect(definesName("  spaced  ", "spaced")).toBe(true);
    expect(definesName("a, b", " b ")).toBe(true);
  });

  it("respects case by default and folds when asked", () => {
    expect(definesName("ParseConfig", "parseconfig")).toBe(false);
    expect(definesName("ParseConfig", "parseconfig", true)).toBe(true);
  });

  it("is false for an empty query rather than matching everything", () => {
    expect(definesName("a, b", "")).toBe(false);
    expect(definesName("a, b", "   ")).toBe(false);
  });

  it("distinguishes the two symbols that produced the original wrong answer", () => {
    // A local `Duration` binding and the settable config field share a stem.
    // An answer that named the binding as a configuration knob is the fault
    // this filter is meant to make avoidable: asking for the declaration of
    // the field must not be satisfied by the chunk declaring the binding.
    const bindingChunk = "stale_seal_timeout";
    const configChunk = "stale_seal_timeout_ms";
    expect(definesName(configChunk, "stale_seal_timeout_ms")).toBe(true);
    expect(definesName(bindingChunk, "stale_seal_timeout_ms")).toBe(false);
    expect(definesName(configChunk, "stale_seal_timeout")).toBe(false);
  });
});
