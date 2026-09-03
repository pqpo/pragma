# ADR 014: Desktop Home Mission Entry and System Experts

## Status

Accepted. The default general-purpose System Expert is defined by
[ADR 015](./015-pragma-default-general-purpose-agent.md).

## Context

Home, Studio and the Mission directory need one execution and catalog model. A separate Home chat/session stack would
duplicate Mission persistence, event projection, approvals and recovery, while metadata tags are not a sufficient
authorization boundary for built-in resources.

## Decision

Home is the primary Mission creation entry. It accepts a goal, workspace, executor and allowed execution options,
creates a Mission, opens its detail and starts it. The default executor is Pragma, the read-only general-purpose System
Expert. Studio actions use the same entry with an executor override.

Desktop owns a System Expert Registry. It reads versioned built-in DSL and bundle fingerprints from
`@pragma/built-in-agents`, compiles them through `@pragma/interpreter`, and exposes the resulting immutable catalog
entries to Studio and Mission executor discovery. System resources use reserved semantic IDs; every Project mutation
path rejects writes to those IDs. Tags remain descriptive metadata and never grant authority.

Mission execution resolves Project and System executors through explicit Host composition. Both use the same Mission,
Execution, chat/output projection, approvals, interruption, Usage and recovery services. System Experts obtain their
runtime, model and Host ports from Desktop composition; the package does not own application Session persistence or a
second chat protocol.

Mission-level model, thinking and permission choices are immutable during an active Execution and may be changed for a
subsequent turn according to executor policy. The default workspace is the Desktop workspace managed under the Pragma
storage root.

## Consequences

- Mission Chat is the single Desktop rendering path for assistant, thinking, tool and HumanTask output.
- Each Home submission creates an independently addressable Mission.
- System Experts appear as ordinary runnable catalog entries while remaining immutable.
- Home, Studio and CLI-facing Mission behavior share the same Local Host and Core execution semantics.
