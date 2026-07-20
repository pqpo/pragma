# ADR 014: Desktop Home Mission Entry and System Experts

## Status

Accepted

## Context

Desktop previously treated Home as a second execution product. A durable Steward Session, a
Home-specific polling loop, an active-event chat projection, and a settled history projection ran
beside the Mission execution and chat stack. During streaming, the projections could temporarily
disagree and display duplicated or reordered thinking/tool entries before settling.

The Steward also behaved like a special Home-only assistant. A mutable project resource carrying a
`builtin` tag was the only approximation of a built-in Expert, so the tag leaked into authorization
decisions and the Steward could not participate in normal Studio and Mission flows.

## Decision

Home is the single Mission creation entry. It displays a centered task form, defaults to the
configured default workspace and `expert:steward@1.0.0`, and allows Workspace, executor, and tool
permission overrides for that Mission. When no default workspace is configured, Desktop uses
`~/.pragma/workspace`. Expert and ExpertTeam Missions may also persist an explicit model and
thinking-depth override for the Runtime selected by the executor; Home never changes the Runtime.
Flow Missions cannot persist either override. Every submission creates a new Mission, opens its
detail, and starts it. A start failure leaves the Mission intact so the normal detail action can retry it.
The Missions page owns only the list and detail surfaces; its create action navigates Home. Studio
try actions also navigate Home with an executor override.

Desktop owns a System Expert Registry. The Registry reads the versioned Steward DSL and bundle
fingerprint from `@pragma/steward`, projects it as `origin: built-in`, `readOnly: true`, and
`executionProfile: system-default`, and exposes the same ref to Studio and Mission executor
discovery. System Experts do not live in the editable project. Every project write path rejects
reserved system refs, and the Expert API rejects create-by-reserved-ID, update, and delete. Tags are
metadata only and never an authorization boundary.

Mission Runner resolves project and system executors through explicit application composition. The
built-in Steward compiles from its package DSL with the existing project/task managed tools and
uses Mission storage, Execution events, chat projection, approvals, interruption, and recovery.
There is no Steward-specific Session, chat history, event projection, IPC, or preload API.

`@pragma/steward` retains the built-in DSL and Skill, bundle descriptor/compiler, host ports, and
managed tools. It does not own application Session persistence or a product chat protocol.

## Consequences

- Mission Chat is the only Desktop rendering path for assistant, thinking, tool, and human
  interaction output.
- Each Home submit is an independent Mission; Home has no reset-session or conversation state.
- Built-in Experts are ordinary runnable catalog entries but remain immutable through both UI and
  backend APIs.
- Project Experts keep pinned model configuration, while system Experts resolve the application's
  default Runtime and model when compiled. Mission-level model and thinking-depth overrides take
  precedence for the root Expert or ExpertTeam coordinator without changing its Runtime, and remain
  fixed for retries and later turns.
- Existing Mission v3 data remains valid. Obsolete Steward Session files are ignored and are not
  migrated or automatically deleted.
