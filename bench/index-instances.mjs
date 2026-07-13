// Index every instance checkout with the shipped default config, N at a
// time, smallest repos first. Skips instances already vectors-ready.
// Usage: node index-instances.mjs [concurrency]
import { execFile } from "node:child_process";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { WORK, CX } from "./lanes.mjs";

const CONC = Number(process.argv[2] ?? 3);
const instances = JSON.parse(readFileSync(join(WORK, "instances.json"), "utf8"));

const sizeOf = (id) => {
  try {
    return readdirSync(join(WORK, "instances", id, "repo"), { recursive: true }).length;
  } catch {
    return Infinity;
  }
};
const jobs = instances
  .map((c) => ({ id: c.id, size: sizeOf(c.id) }))
  .filter((j) => {
    const m = join(WORK, "instances", j.id, "index", "codecontext.json");
    if (!existsSync(m)) return true;
    try {
      return JSON.parse(readFileSync(m, "utf8")).vectors !== "ready";
    } catch {
      return true;
    }
  })
  .sort((a, b) => a.size - b.size);

console.log(`${jobs.length} instances to index (concurrency ${CONC})`);
let active = 0;
let i = 0;
let done = 0;
const t0 = Date.now();

function next() {
  while (active < CONC && i < jobs.length) {
    const job = jobs[i++];
    active++;
    const dir = join(WORK, "instances", job.id);
    execFile(
      "node",
      [CX, "index", join(dir, "repo"), "--json"],
      { env: { ...process.env, CX_INDEX_DIR: join(dir, "index") }, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        active--;
        done++;
        let note = err ? `ERROR ${err.message.slice(0, 120)}` : "";
        if (!err) {
          try {
            const s = JSON.parse(stdout);
            note = `${s.chunks} chunks, vectors ${s.vectors}, embed ${((s.embedMs ?? 0) / 60000).toFixed(1)}m`;
          } catch {
            note = "parse-fail";
          }
        }
        console.log(`[${done}/${jobs.length}] ${job.id} - ${note} (elapsed ${((Date.now() - t0) / 60000).toFixed(0)}m)`);
        next();
      },
    );
  }
  if (active === 0 && i >= jobs.length) console.log("ALL INDEXES DONE");
}
next();
