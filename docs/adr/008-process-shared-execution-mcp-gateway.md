# ADR 008: Process-shared Execution MCP Gateway

## Status

Accepted

## Context

PI runs inside the Pragma Node.js process and can call managed tools directly. Codex app-server,
Claude Code, Qoder CLI, and Antigravity CLI run as child processes, so Pragma must expose default, managed, and upstream MCP tools
through a transport those processes can consume. Opening one loopback HTTP server per Runtime Session
provided isolation but multiplied listeners, ports, and cleanup responsibilities as concurrency grew.

## Decision

Each Pragma Node.js process owns one lazy loopback Execution MCP Gateway. The first Codex, Claude
Code, Qoder CLI, or Antigravity CLI Runtime Session registration starts a listener on an operating-system-assigned port bound to
`127.0.0.1`. The last registration disposal closes the listener; a later registration starts it again.

Every Runtime Session keeps an independent MCP server, transport, tool set, context, approval handler,
and execution state behind the shared listener. The Gateway routes
`/sessions/<opaque-token>/mcp` to the owning registration. Tokens contain 256 random bits, are not
derived from external or system Session IDs, are not logged, and are revoked when the registration is
disposed. Unknown and revoked routes return 404.

Runtime Session identity remains separate from endpoint authorization. Codex, Claude Code, and Qoder CLI use the stable,
short MCP configuration key `pragma`. Antigravity CLI is intentionally different: it uses a Session-scoped
`pragma<16-hex-namespace>` key so a repository customization cannot shadow the managed Agent, MCP, or Hook entry.
A restored Session receives a new endpoint token and may receive a new listener port. Exposed tool names are deterministically
bounded so the fully qualified `mcp__pragma__<tool>` or `mcp__pragma<namespace>__<tool>` name stays within the Runtime limit.
PI does not use the Gateway.

ADR 028 defines the shared semantic layer above these transports. Core resolves and invokes one
execution tool set; PI projects it to native tools, while this Gateway projects it to MCP. The
Gateway does not independently implement Agent tool policy, approval, hooks, or result semantics.

## Consequences

- Concurrent Codex, Claude Code, Qoder CLI, and Antigravity CLI Sessions share one HTTP listener without sharing tools or state.
- `PragmaApp` does not need a new process-lifecycle or `dispose()` API.
- Session cleanup must always dispose its registration, including partial Runtime initialization.
- The Gateway serializes start, registration, unregistration, and idle shutdown to avoid lifecycle races.
- The loopback HTTP and MCP serialization cost remains, but stdio sidecar processes are not required.
