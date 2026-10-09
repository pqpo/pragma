# ADR 066: Unified Local Host Mission application

## Status

Accepted (2026-10-04). Product acceptance is tracked separately in the R4 report.

## Context

Issue #348 R1–R3 centralized Mission control, compilation, persistence and execution. Desktop still
exposed a Runner facade to internal callers, and Node composition accepted a surface-provided
execution/control service. That contract could restore a second application kernel.

## Decision

Local Host constructs the Mission execution service, command application and integration run port
through one application factory. Both Node/CLI and Desktop use that factory. Hosts inject actual
resource readers/resolvers, stores, RuntimeResolver, human interaction and product projection ports;
they cannot replace the complete command consumer, execution service or run application.

Automation, Pragma, Memory Curator, revision agents, Evaluation and IPC mutations depend on shared
Mission use cases. Their product protocols, approval policy, private Context, budget and scheduler
remain with their owning subsystem. Sharing execution never implies automatic approval.

Desktop keeps warm owners with the existing five minute idle policy. CLI request lifetime releases
Native resources and fenced Mission lease after the required settlement. Live output, durable
terminal and Session release remain distinct. History/Usage/Memory observers do not enter the
foreground success barrier. Shared durable delivery retains receipt idempotency, history custody,
claim/retry ordering, bounded background work and owner-specific failure isolation.

Construction does not launch global recovery or maintenance. Desktop initializes storage and IPC,
creates the window, then starts background services. Local Host does not import Electron, apps or
concrete Runtime packages. Core and Interpreter remain independent of Local Host.

This refactor changes internal composition APIs, not persisted schemas, DSL versions or wire
semantics. Existing historical migration chains, paths, journals, locks, WAL/FULL and fencing remain.
No storage cutover or data deletion is authorized by this ADR.

## Consequences

The CLI test entry runs the complete shared Local Host business gate before CLI adapter tests.
Desktop retains IPC/Electron/UI/platform resource and packaging verification. Real model, OS
credential and full product performance acceptance cannot be inferred from fixture gates.

The [R4 report](../architecture/local-host-kernel-r4-implementation.md) records exact results,
P01–P17 protections and remaining acceptance gaps; issue #348 stays incomplete while applicable
acceptance remains outstanding.
