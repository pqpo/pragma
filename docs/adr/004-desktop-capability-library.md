# ADR 004: Desktop Capability Library

## Status

Accepted.

## Context

Desktop Studio previously stored Skill and MCP configuration directly inside each Expert revision and exposed a placeholder Tools page. That made capabilities difficult to reuse, rotate, validate, or version independently. HTTP APIs also had no standard path into Runtime tools.

## Decision

Desktop owns a device-local, versioned Capability Library under `~/.pragma/capabilities`. A capability is one of:

- an uploaded Skill package;
- an MCP server using stdio, Streamable HTTP, or SSE;
- a manually described JSON HTTP service exposed through an in-process MCP adapter.
- a single-tool JavaScript Code Service exposed through an in-process MCP adapter.

Capability definitions are immutable revisions. Health is mutable operational state, and credentials are encrypted separately with Electron `safeStorage`. Expert schema `pragma.expert/v2` stores pinned capability revision references and explicit tool allowlists instead of embedding Skill and MCP definitions.

`@pragma/core` owns runtime-neutral MCP configuration, MCP discovery/calls, SSE transport support, and the HTTP-to-MCP adapter. Desktop owns file selection, persistence, encrypted credentials, health reporting, and resolving Expert references before `defineExpert()`.

HTTP v1 intentionally supports only GET/POST JSON APIs with scalar path/query parameters and optional POST JSON object bodies. It does not import OpenAPI or support file, multipart, form, cookie, custom-header, or streaming operations.

Code Service v1 is a pure-computation boundary. The author defines recursive object/array input and
output contracts, then implements a synchronous `function main(input)` that receives and returns
JSON. Core validates both contracts and executes each call in a fresh, resource-limited QuickJS WASM
runtime. No filesystem, network, environment, process, timer, host object, package import, or module
loader is exposed. Calls are limited to 16 MiB of VM heap, 512 KiB of stack, 1 MiB serialized input
and output, and a configurable 100–10,000 ms deadline with a 2,000 ms default.

Each invocation runs in a disposable Node Worker with an independent host-side deadline. Timeout or
cancellation terminates the Worker instead of relying only on the guest VM interrupt handler, so
runaway guest code cannot block the Desktop main process. Worker concurrency and queued executions
are bounded to prevent parallel calls from exhausting host threads or memory.

The QuickJS boundary is application-level isolation for locally authored code, not an OS or microVM
security boundary. Remote callers and Agents can invoke saved Code Service tools, but cannot create
or replace their source through the tool call itself.

## Consequences

- Updating a capability does not silently change existing Experts; they must explicitly upgrade revisions.
- MCP tools are discovered and schema-hashed. Runtime startup fails closed when a pinned tool is missing or its input schema drifted.
- Failed MCP verification may be saved as `needs_attention`, but unavailable capabilities cannot be newly selected.
- HTTP services do not open a port per service. PI consumes managed tools directly; Codex and Claude Code receive them through the process-shared loopback Execution MCP Gateway defined by ADR 008.
- Code Services use the same managed-tool and Execution MCP Gateway path, publish both MCP input and
  output schemas, and return validated structured content.
- `pragma.expert/v1` Desktop definitions are not read through a compatibility adapter.
