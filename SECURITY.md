# Security Policy

## Reporting a vulnerability

Please report security issues **privately** - do not open a public issue for a
suspected vulnerability.

Use GitHub's private vulnerability reporting: open the repository's **Security**
tab and click **"Report a vulnerability."** We aim to acknowledge reports within
a few business days and will keep you updated on the fix.

## Data handling

code-context is designed to keep your code on your machine:

- Everything runs **locally**: indexing, storage (`.infino/` in your repo),
  and search. The MCP server is a local subprocess over stdio - no network
  listener, no remote service, no telemetry.
- Embedding is **always local**: a small model downloaded once, then no
  network at all. Your code is never sent to any API, and there is no key
  to provision.
- The SQL surface is **read-only** (single SELECT/WITH statement); the index
  is only ever rebuilt from your working tree, never mutated through queries.
- `.gitignore` is respected at every directory level, so ignored files
  (secrets, envs, build output) stay out of the index; `cx install` also
  gitignores the index itself.

## Supported versions

Security fixes are released against the latest published version on npm
([`@infino-ai/code-context`](https://www.npmjs.com/package/@infino-ai/code-context)).
