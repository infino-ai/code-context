// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright The Infino Authors
//
// The charts the README shows, drawn from the bench's own results so every
// bar traces to a recorded run: per-pass cost and main-agent tokens of the
// three arms (Sonnet with file tools, Sonnet with its Explore subagents,
// Sonnet with Infino Subagent), the blind judge's verdicts per category, and
// the fan-out probe (from docs/subagent/fanout.json, the probe's summary
// numbers, since the probe runs outside the lanes). Plain SVG, no
// dependencies, so GitHub renders them inline.
// Usage: node readme-charts.mjs [outDir=../docs/subagent]
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { RESULTS, BENCH } from "./lanes.mjs";

const outDir = resolve(process.argv[2] ?? join(BENCH, "..", "docs", "subagent"));
mkdirSync(outDir, { recursive: true });

/** The arms the README compares: a build label as recorded on the rows, the
 * lane it ran in, and the words the chart uses for it. */
const ARMS = [
  { build: "FILES", lane: "files", label: "Sonnet, file tools", color: "#8b949e" },
  { build: "SE1", lane: "stock-explore", label: "Sonnet + its Explore subagents", color: "#d29922" },
  { build: "FX5", lane: "find-explore", label: "Sonnet + Infino Subagent", color: "#2f81f7" },
];
/** The judge comparison drawn per category: pure Sonnet against the Subagent arm. */
const JUDGE = { baseline: "FILES", candidate: "FX5", rule: "checkout" };
const CATEGORIES = ["aggregation", "comprehension", "pinpoint", "known-file", "by-meaning"];
const CATEGORY_LABEL = {
  aggregation: "aggregation - which files have the most X",
  comprehension: "comprehension - how does X work",
  pinpoint: "pinpoint - where is this symbol",
  "known-file": "known file - what does this file do",
  "by-meaning": "by meaning - where is X handled",
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length === 0 ? 0 : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const readJsonl = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// --- per-pass figures: for each arm, the sum over questions of the median over repeats ---
const rows = readJsonl(join(RESULTS, "questions.jsonl"));
function perPass(arm) {
  const byQ = new Map();
  for (const r of rows) {
    if (r.build !== arm.build || r.lane !== arm.lane || r.error) continue;
    const key = `${r.cat} ${r.q}`;
    (byQ.get(key) ?? byQ.set(key, []).get(key)).push(r);
  }
  const sum = (f) => [...byQ.values()].reduce((a, runs) => a + median(runs.map(f)), 0);
  return { questions: byQ.size, tokens: sum((r) => r.tokens), cost: sum((r) => r.costUsd ?? 0), calls: sum((r) => r.calls) };
}
const passes = ARMS.map((arm) => ({ ...arm, ...perPass(arm) }));

// --- the judge: latest verdict per pair under the rule, wins per category ---
const verdicts = new Map();
for (const v of readJsonl(join(RESULTS, "judge.jsonl"))) {
  if (v.baseline !== JUDGE.baseline || v.candidate !== JUDGE.candidate || (v.rule ?? "checkout") !== JUDGE.rule || !v.winner) continue;
  verdicts.set(`${v.cat} ${v.q} ${v.rep}`, v);
}
const judgeByCat = CATEGORIES.map((cat) => {
  const vs = [...verdicts.values()].filter((v) => v.cat === cat);
  const n = (w) => vs.filter((v) => v.winner === w).length;
  return { cat, wins: n("candidate"), ties: n("tie"), losses: n("baseline"), pairs: vs.length };
});

// --- SVG helpers ---
const FONT = "font-family='-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif'";
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#39;");
const svgOpen = (w, h) => `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}' ${FONT}>\n<rect width='${w}' height='${h}' fill='#ffffff'/>\n`;
const text = (x, y, s, opts = "", fill = "#24292f") => `<text x='${Math.round(x)}' y='${Math.round(y)}' fill='${fill}' ${opts}>${esc(s)}</text>\n`;

/** A subtitle longer than one line of the chart's width wraps at a space
 * (about 105 characters of 12 px text fit in 760 px). Returns the lines. */
const SUBTITLE_CHARS = 105;
function wrap(s) {
  const lines = [];
  let rest = s.trim();
  while (rest.length > SUBTITLE_CHARS) {
    const cut = rest.lastIndexOf(" ", SUBTITLE_CHARS);
    const at = cut > 40 ? cut : SUBTITLE_CHARS;
    lines.push(rest.slice(0, at));
    rest = rest.slice(at).trim();
  }
  lines.push(rest);
  return lines;
}
const LINE_H = 15;
/** Title and wrapped subtitle; returns the markup and the y where content starts. */
function header(title, subtitle) {
  let s = text(20, 30, title, "font-size='18' font-weight='600'");
  const lines = wrap(subtitle);
  lines.forEach((line, i) => (s += text(20, 50 + i * LINE_H, line, "font-size='12'", "#57606a")));
  return { markup: s, top: 64 + (lines.length - 1) * LINE_H };
}

/** Horizontal bars, one per arm: label on the left, bar, value on the right. */
function barChart({ title, subtitle, items, format, file, labelW = 250 }) {
  const w = 760;
  const rowH = 44;
  const head = header(title, subtitle);
  const top = head.top;
  const valueW = 90;
  const h = top + items.length * rowH + 40;
  const max = Math.max(...items.map((i) => i.value));
  const barMax = w - labelW - valueW - 30;
  let s = svgOpen(w, h) + head.markup;
  items.forEach((it, i) => {
    const y = top + i * rowH;
    const len = Math.max(2, Math.round((it.value / max) * barMax));
    s += text(20, y + 26, it.label, "font-size='13'");
    s += `<rect x='${labelW}' y='${y + 10}' width='${len}' height='24' rx='4' fill='${it.color}'/>\n`;
    s += text(labelW + len + 10, y + 27, format(it.value), "font-size='13' font-weight='600'");
  });
  writeFileSync(join(outDir, file), s + "</svg>\n");
  return file;
}

/** One stacked bar per category: wins, ties, losses for the candidate. */
function judgeChart({ title, subtitle, cats, file }) {
  const w = 760;
  const rowH = 44;
  const head = header(title, subtitle);
  const top = head.top;
  const labelW = 290;
  const h = top + cats.length * rowH + 70;
  const barMax = w - labelW - 40;
  const colors = { wins: "#2da44e", ties: "#8b949e", losses: "#cf222e" };
  let s = svgOpen(w, h) + head.markup;
  cats.forEach((c, i) => {
    const y = top + i * rowH;
    s += text(20, y + 26, CATEGORY_LABEL[c.cat] ?? c.cat, "font-size='13'");
    let x = labelW;
    for (const part of ["wins", "ties", "losses"]) {
      const len = c.pairs ? Math.round((c[part] / c.pairs) * barMax) : 0;
      if (len > 0) {
        s += `<rect x='${x}' y='${y + 10}' width='${len}' height='24' fill='${colors[part]}'/>\n`;
        if (len > 18) s += text(x + len / 2 - 4, y + 27, c[part], "font-size='12' font-weight='600'", "#ffffff");
      }
      x += len;
    }
  });
  const ly = top + cats.length * rowH + 30;
  let lx = labelW;
  for (const [part, label] of [["wins", "Infino Subagent arm wins"], ["ties", "tie"], ["losses", "file-tools arm wins"]]) {
    s += `<rect x='${Math.round(lx)}' y='${ly - 11}' width='14' height='14' fill='${colors[part]}'/>\n`;
    s += text(lx + 20, ly, label, "font-size='12'", "#57606a");
    lx += 20 + label.length * 6.6 + 24;
  }
  writeFileSync(join(outDir, file), s + "</svg>\n");
  return file;
}

const passOf = (b) => passes.find((p) => p.build === b);
const passSubtitle = `Per pass over the same ${passOf("FILES").questions} questions, claude-sonnet-4-6, infino repo; median of 3 repeats per question, summed. 2026-09-05.`;
const written = [
  barChart({
    title: "Cost per pass - every Sonnet call, subagents included",
    subtitle: passSubtitle,
    items: passes.map((p) => ({ label: p.label, value: p.cost, color: p.color })),
    format: (v) => `$${v.toFixed(2)}`,
    file: "cost-per-pass.svg",
  }),
  barChart({
    title: "Main-agent tokens per pass",
    subtitle: passSubtitle,
    items: passes.map((p) => ({ label: p.label, value: p.tokens, color: p.color })),
    format: (v) => `${Math.round(v / 1000).toLocaleString()}k`,
    file: "tokens-per-pass.svg",
  }),
  barChart({
    title: "Tool calls per pass - the main agent's round trips",
    subtitle: passSubtitle,
    items: passes.map((p) => ({ label: p.label, value: p.calls, color: p.color })),
    format: (v) => `${Math.round(v)}`,
    file: "calls-per-pass.svg",
  }),
  judgeChart({
    title: "Blind judge, per category: Infino Subagent arm vs Sonnet with file tools",
    subtitle: `claude-opus-5 judging ${[...verdicts.values()].length} answer pairs blind, in random order, with the repository to verify against. 2026-09-05.`,
    cats: judgeByCat,
    file: "judge-vs-file-tools.svg",
  }),
];

// --- the fan-out probe, from its summary file ---
const fanoutFile = join(outDir, "fanout.json");
if (existsSync(fanoutFile)) {
  const fan = JSON.parse(readFileSync(fanoutFile, "utf8"));
  const items = fan.runs.map((r) => ({
    label: `${r.label} - ${r.answered} of ${r.of} answered`,
    value: r.lastSecs,
    color: r.arm === "sonnet" ? "#d29922" : "#2f81f7",
  }));
  written.push(
    barChart({
      title: "Parallel exploration: seconds to the last answer",
      subtitle: fan.subtitle,
      items,
      format: (v) => `${v} s`,
      file: "fanout.svg",
      labelW: 470,
    }),
  );
}

console.log(`wrote ${written.join(", ")} to ${outDir}`);
for (const p of passes) console.log(`${p.build.padEnd(6)} ${p.questions} questions  tokens ${Math.round(p.tokens / 1000)}k  cost $${p.cost.toFixed(2)}  calls ${Math.round(p.calls)}`);
for (const c of judgeByCat) console.log(`${c.cat.padEnd(14)} wins ${c.wins} ties ${c.ties} losses ${c.losses} of ${c.pairs}`);
