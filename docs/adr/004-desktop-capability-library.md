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

Capability definitions are immutable revisions. Health is mutable operational state, and credentials are encrypted separately with Electron `safeStorage`. Expert schema `pragma.expert/v2` stores pinned capability revision references and explicit tool allowlists instead of embedding Skill and MCP definitions.

`@pragma/core` owns runtime-neutral MCP configuration, MCP discovery/calls, SSE transport support, and the HTTP-to-MCP adapter. Desktop owns file selection, persistence, encrypted credentials, health reporting, and resolving Expert references before `defineExpert()`.

HTTP v1 intentionally supports only GET/POST JSON APIs with scalar path/query parameters and optional POST JSON object bodies. It does not import OpenAPI or support file, multipart, form, cookie, custom-header, or streaming operations.

## Consequences

- Updating a capability does not silently change existing Experts; they must explicitly upgrade revisions.
- MCP tools are discovered and schema-hashed. Runtime startup fails closed when a pinned tool is missing or its input schema drifted.
- Failed MCP verification may be saved as `needs_attention`, but unavailable capabilities cannot be newly selected.
- HTTP services do not open a port per service. PI consumes managed tools directly; Codex and Claude Code receive them through the process-shared loopback Execution MCP Gateway defined by ADR 008.
- `pragma.expert/v1` Desktop definitions are not read through a compatibility adapter.
