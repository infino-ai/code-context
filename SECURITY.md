# Security Policy

## Reporting a vulnerability

Please report security issues **privately** - do not open a public issue for a
suspected vulnerability.

Use GitHub's private vulnerability reporting: open the repository's **Security**
tab and click **"Report a vulnerability."** We aim to acknowledge reports within
a few business days and will keep you updated on the fix.

## Data handling

SuperGrep has two modes, and they have different data-handling properties.
Which one you are in is your own choice, made explicitly by passing `--db`
or not.

**Without `--db` (what the published npm package and Claude Code plugin ship
today):** everything runs **locally** - indexing, storage (`.infino/` in your
repo), search, and embedding. The MCP server is a local subprocess over
stdio - no network listener, no remote service, no telemetry. The embedding
model (~25 MB) is downloaded once from huggingface.co on first use; after
that there is no network at query or index time. Your code is never sent to
any API, and there is no key to provision. (Running the server via `npx`
also contacts the npm registry; install the package for fully offline use.)

**With `--db <url>` (`find`/`search`/`sql` still local; `explore`/`ask` run
in the cloud):** the chunks your index holds - `path`, `start_line`,
`end_line`, `lang`, and the code `content` itself - are loaded into a
platform database you name, over HTTPS (plain `http://` is accepted for a
loopback host only). A bearer key authenticates every request; it is never
passed as a command-line argument (arguments are visible to every process on
the machine) - it comes from a file (`--api-key-file`) or the
`INFINO_API_KEY` environment variable. By default the platform's own model
embeds that copy server-side (`--embed-provider local` keeps embedding on
this machine and ships the vectors instead). `explore` and `ask` send your
question to that platform and answer from what it retrieves; `find`,
`search` and `sql` never leave the local index. If you need the first mode's
guarantees, do not pass `--db`.

- Mutating SQL is rejected by client-side statement filtering (a single
  SELECT/WITH statement is allowed) on both the local and the platform
  table. The local index is a derived artifact: it is rebuilt from your
  working tree by `cx index --full` at any time, so it is never the only
  copy of anything.
- Per-directory `.gitignore` files are respected at every level, so files
  ignored there (secrets, envs, build output) stay out of the index, local
  or platform. Global git excludes and `.git/info/exclude` are NOT read -
  keep secrets ignored in-repo if you rely on this. Add `.infino/` to your
  `.gitignore` to keep the local index out of commits.

## Supported versions

Security fixes are released against the latest published version on npm
([`@infino-ai/code-context`](https://www.npmjs.com/package/@infino-ai/code-context)).
