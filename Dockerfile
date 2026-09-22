# Build target for MCP directories (e.g. Glama) that deploy a server in a
# sandbox and introspect its tools. Regular users do NOT need this image:
# code-context runs locally over stdio via the CLI or an MCP client (see the
# README). A directory's auto-inferred build runs the bare package, which starts
# the CLI rather than the server, so this pins the `mcp` entrypoint that speaks
# the MCP handshake.
FROM node:20-slim

# The engine binding ships prebuilt for linux-x64 (glibc); node:20-slim is
# Debian, so it loads with no build toolchain.
RUN npm install -g @infino-ai/code-context

# tools/list needs no embedding model, so start keyword-only: skip the one-time
# model download and answer introspection immediately.
ENV CX_NO_EMBED=1

# The MCP server speaks over stdio; run the container with -i.
ENTRYPOINT ["cx", "mcp"]
