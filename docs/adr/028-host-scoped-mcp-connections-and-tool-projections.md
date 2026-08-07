# ADR 028: Host-scoped MCP connections and Runtime tool projections

- Status: Accepted
- Date: 2026-07-30

## Context

Pragma has five Runtime adapters with two delivery mechanisms. PI runs in the Host process and
accepts native `ToolDefinition` objects. Codex, Claude Code, Qoder CLI, and Antigravity CLI run in child processes
and discover the same execution tools through the process-shared Execution MCP Gateway from ADR 008.

The delivery mechanisms are necessarily different, but their implementation had also duplicated
tool resolution, approval, hooks, result conversion, logging, and upstream MCP connection setup.
Compiler live validation and Capability checks opened another short-lived MCP connection before a
Runtime immediately opened the same server again. This increased new-Mission initialization time
and made behavioral drift likely.

## Decision

### One semantic execution tool set

Core resolves default tools, managed tools, and upstream MCP tools into
`ResolvedExecutionToolSet`. Core also owns invocation behavior: approval, lifecycle hooks, logging,
event emission, and normalized results.

Runtime adapters only project that semantic set:

- PI converts each resolved tool to a native PI `ToolDefinition`.
- Codex, Claude Code, Qoder CLI, and Antigravity CLI register the resolved tools on the Execution MCP Gateway.

The Gateway remains a transport boundary, not a second tool semantics implementation. Its
runtime-permission prompt remains Gateway-specific because it mediates child-process permission
requests rather than an Agent-declared execution tool.

### One Host-scoped connection pool

Each application Host creates one `McpToolRegistryPool` and injects it into compilation and
validation workflows and all Runtime factories. A lease is acquired per consumer and released
when validation or the Runtime Session ends. Host shutdown closes the pool.

Pooling occurs per upstream MCP server connection, not per complete Agent MCP configuration:

- external transports use a stable fingerprint of connection-relevant configuration and a hashed
  credential;
- in-process servers use object identity;
- server IDs, tool allow/deny projections, and approval policies are excluded from connection
  identity and applied independently to every lease.

Concurrent opens for the same connection are single-flight. Idle connections have a bounded count
and TTL. A failed open is evicted so retries do not inherit a rejected promise.

`McpToolRegistryPool.close()` is a final Host-shutdown operation, not a graceful per-lease drain.
It rejects new acquisitions and hard-stops every pooled connection even if a lease remains active.
Hosts must stop normal execution dispatch before closing the pool; a late lease release is a safe
no-op. Runtime Session cleanup continues to use lease release rather than pool close.

### Initialization and UI observations

Runtime preparation logs distinguish opened, reused, and coalesced MCP connections. The renderer
flushes the first visible streaming patch immediately when a current chat snapshot exists; later
patches retain frame batching. `mission.first_ui_token_painted` is emitted only after React commits
a matching execution element and two animation frames confirm an opportunity to paint. Hidden
documents do not emit the paint milestone.

## Consequences

- Compiler live checks and Runtime startup can reuse one authenticated upstream connection.
- Five Runtime adapters share tool policy and invocation semantics without pretending that their
  delivery transports are identical.
- A lease may expose a different server ID, tool subset, or approval policy while sharing the same
  physical connection.
- Host construction and shutdown must explicitly own the pool.
- Connection keys must never log or persist raw credentials.
- PI avoids loopback MCP serialization, while child-process Runtimes retain the isolation and
  discoverability guarantees of ADR 008.
