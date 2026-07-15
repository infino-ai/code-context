# Benchmark harness

Real agent runs (Claude Agent SDK) comparing **stock file tools** against the
same agent with the **code-context MCP added** - same model, same turn budget,
hermetic lanes. The only variable is whether the agent has the index.

Needs: Node ≥ 20 and `ANTHROPIC_API_KEY` in the environment. Everything writes
under `bench/.work/` (gitignored).

```bash
cd bench && npm install    # installs @anthropic-ai/claude-agent-sdk

# Index the repo under test once, then run the two lanes over the suite:
cx index /path/to/repo
node run-questions.mjs /path/to/repo                        # default questions
node run-questions.mjs /path/to/repo files,combo questions/mine.json
```

Nothing is hardcoded - the repo, lanes, and question set are all arguments.
Question sets live in [`questions/`](questions/) as a JSON array of
`{ "cat": "aggregation"|"comprehension", "q": "..." }`; `cat` splits the summary
into **aggregation** (ranking/counting across the repo) vs **comprehension**
(how/where something works). Add your own file there and pass its path (or set
`CX_BENCH_QUESTIONS`). Shipped sets:

- `questions/infino.json` (default) - targets the
  [infino](https://github.com/infino-ai/infino) engine repo.
- `questions/swe-qa-django.json` - the comprehension slice from the
  [SWE-QA](https://github.com/peng-weihan/SWE-QA-Bench) dataset; run it against
  Django checked out at commit `14fc2e9`:
  ```
  git clone https://github.com/django/django && git -C django checkout 14fc2e9
  cx index django && node run-questions.mjs django files,combo questions/swe-qa-django.json
  ```

The win is largest on a codebase the model does not already know from training
(a private repo), where the file-tools baseline has to explore rather than
recall; on a well-known open-source repo the baseline can shortcut from memory.

Lane design notes (they matter for fairness):

- `settingSources: []` + `strictMcpConfig: true` keep your user-level plugins,
  MCP servers, and CLAUDE.md out of both lanes.
- `tools: [...]` pins the built-in set exactly (both lanes include Bash, since
  real Claude Code has it); the MCP server is registered with `alwaysLoad: true`
  so its tools are present in the turn-1 prompt, not deferred behind tool search.
- Both lanes get the same minimal system prompt; neither is taught which tool to
  prefer.
- Token totals count input + cache writes + cache reads + output; cost uses the
  API's per-run accounting.
- Model is set in `lanes.mjs` (`BENCH_MODEL`, default `claude-sonnet-4-6`).
