# Contributing

Thanks for your interest in code-context!

## Getting started

```
npm ci
npm run build     # tsc → dist/
npm test          # vitest - unit + engine-integration tests, no network needed
```

`node dist/cli.js --help` runs your local build; `npm link` puts local
`code-context`/`cx` bins on your PATH.

## Before you open a PR

- **Open an issue first** for anything beyond a small fix, so we can agree on
  the approach before you invest in it.
- Add or update tests for what you change - the suite runs against a real
  engine catalog in a temp directory and is fast; there is no excuse to skip
  it.
- Keep the surface small. New tools, flags, and options need to justify
  themselves against the tool-selection cost they impose on agents; "neutral
  names, few tools, descriptions do the steering" is a design rule here, not
  a preference.
- Run `npm test` and make sure CI is green on your branch.

## What runs where

- `src/core/` - indexing, chunking, file-state sync, search; shared by both
  surfaces. Pure logic lives here and is unit-tested directly.
- `src/commands/` + `src/cli.ts` - the CLI surface.
- `src/mcp/` - the MCP server surface.
- `assets/` - agent-steering templates installed by `cx install`.

## Releases

Publishing is release-driven and automated. Maintainers:

1. Bump `version` in `package.json` on `main`.
2. Create a GitHub release with tag `vX.Y.Z` matching that version.
3. CI publishes to npm (with provenance) and the MCP Registry. A tag that
   does not match `package.json` fails fast.

The publish workflow can also be dispatched manually as a dry run to
validate the pipeline without publishing.
