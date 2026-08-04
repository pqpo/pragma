# ADR 018: Execution-owned handoff through Context System

## Status

Accepted.

## Context

Expert delegation and Flow Expert steps previously persisted arbitrary Invocation output and copied
the complete value into `wait_experts` results and coordinator continuation prompts. Large textual
results therefore consumed the parent model's context window and were duplicated in Execution
state, events, and message history. Requiring every Expert definition to describe a file handoff in
its prompt would make a runtime invariant optional and inconsistent.

## Decision

Pragma represents Expert output as an `inline` or `context` Invocation handoff. Values at or below
32 KiB remain inline. Larger UTF-8 text or JSON values are written beneath the owning Execution's
state directory and exposed as read-only items in the reserved `pragma.handoff` Context namespace.
The coordinator receives only a bounded summary and Context references.

Core owns this behavior as an internal Execution module. Cross-process handoff schemas live in
`@pragma/shared`; it is not an optional plugin or a separately installed package. Every
Execution-scoped Expert receives the Handoff Context Store, an always-on policy Context, and the
`register_handoff_file` managed tool.

Each handoff remains physically owned by the Execution that produced it, but Context visibility is
owner-scoped. Core federates all persisted Execution ids of an ExpertSession, so later turns and a
reconstructed Session can read earlier handoffs. A Host may extend that visible set through a
`HandoffContextVisibilityResolver`. Desktop uses the persistent Mission timeline for this purpose,
which keeps handoffs visible after an incompatible Expert revision creates a successor
ExpertSession and after the application restarts. Flow execution visibility remains limited to its
own Execution unless the Host supplies a wider owner scope.

Federation does not copy or rewrite handoff files. Duplicate Context ids in the visible Execution
set fail with `context_conflict` instead of selecting one by iteration order. Writes and attempt
cleanup always target the currently active Execution.

`register_handoff_file` registers an existing UTF-8 regular file under the producing Expert's
workspace without copying it. Registration validates the real path against the workspace root.
Automatically externalized output is stored at
`state/executions/<executionId>/handoffs/generated/`. Handoff manifests and generated files follow
the Execution and Mission deletion lifecycle.

Handoff registrations are bound to one Invocation attempt. Starting a replacement attempt removes
the incomplete attempt's registrations and managed files before the Invocation runs again, so
recovery cannot attach stale output to a new result. Registration idempotency compares the complete
logical source identity; the same idempotency key cannot silently change a workspace path, media
type, or managed content.

Context listing reads file metadata only. Range reads open the referenced regular file and read only
the requested byte window; workspace root identity and final-component symlinks are checked again
on every access.

Flow Task and HumanTask structured values retain their existing semantics. Expert and ExpertTeam
steps expose inline values normally and expose a Context handoff when their output is externalized.
Top-level ExpertTurn and FlowExecution results use the same normalization.

Live output remains a transient stream. Oversized terminal assistant messages are replaced by the
bounded summary and Context references before entering canonical message history, and raw
`message.completed` runtime payloads are not duplicated in the durable event log.

## Consequences

- Small Expert results preserve their current SDK behavior.
- Large results remain searchable and range-readable without entering the parent prompt.
- Workspace-backed handoffs are mutable references; revision and etag changes reveal later edits.
- Handoffs are Execution-owned, owner-visible collaboration data, not durable published Artifacts.
- The persisted ExpertSession execution list and Desktop Mission timeline reconstruct visibility;
  no Context contents or Runtime-session closures are the source of truth.
- Binary files, directories, cross-Mission sharing, CAS publication, and DSL Artifact contracts
  remain outside this decision.
