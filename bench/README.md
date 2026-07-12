# Benchmark harness

Reproduces the numbers in [docs/benchmark.md](../docs/benchmark.md): real
agent runs (Claude Agent SDK) comparing stock file tools against the
code-context MCP tools — same model, same turn budget, hermetic lanes.

Needs: Node ≥ 20, `git`, `python3`, and `ANTHROPIC_API_KEY` in the
environment. Everything writes under `bench/.work/` (gitignored).

```bash
cd bench && npm install    # installs @anthropic-ai/claude-agent-sdk

# 1. Question suite (aggregation + comprehension) on any repo you have:
node run-questions.mjs both /path/to/repo

# 2. SWE-bench_Verified localization (downloads dataset, clones repos,
#    builds an index per instance — the vector stage takes a while):
./prep-swebench.sh
node index-instances.mjs 3          # 3 concurrent indexers
node run-swebench.mjs both          # lanes over every ready instance

# Results land as JSONL in bench/.work/results/
```

Lane design notes (they matter for fairness):

- `settingSources: []` + `strictMcpConfig: true` keep your user-level
  plugins, MCP servers, and CLAUDE.md out of both lanes.
- `tools: [...]` pins the built-in set exactly; the MCP server is
  registered with `alwaysLoad: true` so its tools are present in the
  turn-1 prompt rather than deferred behind tool search.
- Both lanes get the same minimal system prompt; neither is taught which
  tool to prefer.
- Token totals count input + cache writes + cache reads + output; cost
  uses the API's per-run accounting.
