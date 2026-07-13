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
- Embedding is **always local**. The model (~25 MB) is downloaded once
  from huggingface.co on first use; after that there is no network at query
  or index time. Your code is never sent to any API, and there is no key to
  provision. (Running the server via `npx` also contacts the npm registry;
  install the package for fully offline use.)
- Mutating SQL is rejected by client-side statement filtering (a single
  SELECT/WITH statement is allowed). The index is a derived artifact: it is
  rebuilt from your working tree by `cx index --full` at any time, so it is
  never the only copy of anything.
- Per-directory `.gitignore` files are respected at every level, so files
  ignored there (secrets, envs, build output) stay out of the index. Global
  git excludes and `.git/info/exclude` are NOT read - keep secrets ignored
  in-repo if you rely on this. `cx install` also gitignores the index
  itself.

## Supported versions

Security fixes are released against the latest published version on npm
([`@infino-ai/code-context`](https://www.npmjs.com/package/@infino-ai/code-context)).
