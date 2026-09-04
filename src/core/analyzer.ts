// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The FTS analyzer, mirrored client-side. The engine tokenizes indexed text
// and every query with the analyzer the table's FTS index was built with, so
// the client never has to tokenize to *query* - but it does have to know
// whether a query holds anything the index can look up (find rejects a
// punctuation-only query instead of returning an empty "no matches"), and
// which analyzer the index has is a property of the table, not of the engine:
// a local table takes the engine default (ascii_lower), a hosted table takes
// the platform default for a bare column (standard). The manifest records it;
// this module mirrors both analyzers so the client's checks agree with the
// index's own splitting.

import type { Manifest } from "./manifest.js";

/** The two analyzers the engine ships, by their stored FTS-config names. */
export type Analyzer = "ascii_lower" | "standard";

/** The analyzer a local table gets when the binding's `IndexSpec.fts(column)`
 * names none: `@infino-ai/infino` 0.5.2 (the pinned engine) builds a bare FTS
 * column with `ascii_lower`. A manifest written before the analyzer was
 * recorded describes such a table, so a missing `analyzer` reads as this. */
export const ENGINE_DEFAULT_ANALYZER: Analyzer = "ascii_lower";

/** The analyzer the platform gives a bare FTS column. A hosted manifest that
 * does not record one (a table created by something other than `cx index
 * --db`) gets this - never the engine's own default, which is what a LOCAL
 * bare column gets. */
export const PLATFORM_DEFAULT_ANALYZER: Analyzer = "standard";

/** The analyzer `cx index --db` asks the platform for when CX_FTS_ANALYZER is
 * unset. Code is not prose: `standard` follows UAX #29, whose word rules keep
 * `self.reconcile_tombstone_seqs` and `inner.reconcile_tombstone_seqs` as one
 * token each, so a find for the identifier alone missed four of its five
 * occurrences in the pinned infino clone (1/1 against the local index's 5/2;
 * `env::var` 137 against 147). `ascii_lower` splits on `.`, `_` and `::`, the
 * AND over its tokens finds every candidate, and the literal check restores
 * exactness. The value is sent on the wire and recorded in the manifest, so
 * nothing here assumes what the table has - it declares it. */
export const HOSTED_DEFAULT_ANALYZER: Analyzer = "ascii_lower";

/** The analyzer a manifest's table was built with. Every reader goes through
 * here so the fallback for an absent value lives in one place, and the
 * fallback follows where the table lives: a hosted table's bare column took
 * the platform default, a local one the engine default. */
export function analyzerOf(manifest: Pick<Manifest, "analyzer" | "origin">): Analyzer {
  if (manifest.analyzer !== undefined) return manifest.analyzer;
  return manifest.origin === "hosted" ? PLATFORM_DEFAULT_ANALYZER : ENGINE_DEFAULT_ANALYZER;
}

/** First code point outside ASCII. `ascii_lower` extends a token run across
 * such characters and then drops the whole run. */
const NON_ASCII_MIN = 0x80;

/** `ascii_lower`'s token alphabet: one ASCII letter or digit. */
const ASCII_TOKEN_CHAR = /[A-Za-z0-9]/;

/** `standard` keeps a UAX #29 word segment only when it holds an alphabetic
 * or numeric character - the engine's `unicode_words` filter, which is
 * `char::is_alphanumeric` (the Alphabetic property, or a Nd/Nl/No digit).
 * This is deliberately not `Intl.Segmenter`'s `isWordLike`: ICU marks a run
 * of underscores word-like and a circled digit not, and the engine does the
 * opposite on both. */
const HAS_ALPHANUMERIC = /[\p{Alphabetic}\p{N}]/u;

/** UAX #29 word segmenter with no locale tailoring, matching the engine's
 * locale-free `unicode_words`. One instance: construction is the expensive
 * part and the segmenter is stateless across calls. */
const WORD_SEGMENTER = new Intl.Segmenter("und", { granularity: "word" });

/** True for a recorded analyzer name; used to validate manifests and
 * platform table configs before trusting the string. */
export function isAnalyzer(value: unknown): value is Analyzer {
  return value === "ascii_lower" || value === "standard";
}

/** The distinct tokens `analyzer` produces for `text`, in first-occurrence
 * order. Duplicates are dropped: every client-side use is set-shaped (is
 * there a token at all, which tokens does a line carry), where a repeat
 * changes nothing. */
export function analyzerTokens(text: string, analyzer: Analyzer): string[] {
  return analyzer === "standard" ? standardTokens(text) : asciiLowerTokens(text);
}

/** Whether `analyzer` yields at least one token for `text` - the test find
 * runs before asking the index for candidates, since a token-less query
 * matches nothing and would read as "no occurrences" rather than "the index
 * cannot look this up". */
export function hasIndexableToken(text: string, analyzer: Analyzer): boolean {
  return analyzerTokens(text, analyzer).length > 0;
}

/** `ascii_lower`: runs of `[A-Za-z0-9]`, lowercased; a run that touches
 * non-ASCII text is dropped whole (`Süd` yields nothing, and the `abc` in
 * `abcédef` goes with the `é`). Mirrors the engine's AsciiLowerTokenizer. */
function asciiLowerTokens(text: string): string[] {
  const out = new Set<string>();
  let run = "";
  let nonAscii = false;
  const flush = () => {
    if (run && !nonAscii) out.add(run.toLowerCase());
    run = "";
    nonAscii = false;
  };
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) >= NON_ASCII_MIN) {
      run += ch;
      nonAscii = true;
    } else if (ASCII_TOKEN_CHAR.test(ch)) {
      run += ch;
    } else {
      flush();
    }
  }
  flush();
  return [...out];
}

/** `standard`: UAX #29 word segments that contain an alphanumeric, lowercased
 * with full Unicode case mapping (context-sensitive, so a word-final Greek
 * sigma folds to ς as the engine's `str::to_lowercase` does) and no
 * normalization. The word rules keep `parse_config` (underscore joins), `3.14`
 * and `1,000` (a separator between digits joins), `don't` and `x.y` (an
 * apostrophe or period between letters joins) as one token each, and split on
 * hyphens and other punctuation; non-ASCII letters are kept (`Süd` → `süd`).
 * Known divergence: ICU segments CJK text by dictionary, so `日本語` is one
 * segment here where the engine emits one token per ideograph - the engine
 * does the authoritative split at query time, so this mirror only decides
 * whether such a query has a token at all, and there both agree. */
function standardTokens(text: string): string[] {
  const out = new Set<string>();
  for (const { segment } of WORD_SEGMENTER.segment(text)) {
    if (HAS_ALPHANUMERIC.test(segment)) out.add(segment.toLowerCase());
  }
  return [...out];
}
