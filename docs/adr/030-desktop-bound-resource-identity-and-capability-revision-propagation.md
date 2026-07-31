# ADR 030: Desktop-bound resource identity and Capability revision propagation

## Status

Accepted.

## Context

Desktop projects contain portable DSL resources and Host bindings for local Capability,
ContextStore, and RuntimeProfile instances. Expert editing, the built-in Pragma catalog, System
Expert customization, and Bundle import previously constructed those resources independently.
Their similar but non-identical ID, metadata, and lookup rules allowed a migrated resource and a
newly derived resource to represent the same Host object. A later Project validation then failed on
duplicate semantic names. Reconstructing a resource during an edit also discarded imported or
migrated identity and metadata.

Capability revisions were separately pinned by every current Expert. Updating one Capability could
therefore leave current Experts on different revisions and required a manual per-Expert upgrade.

## Decision

- Desktop main owns a single pure policy module for local Capability, ContextStore, and
  RuntimeProfile resource classification, canonical ID derivation, creation, and rebinding.
- Feature modules pass an explicit owner (`project-expert`, `system-expert-customization`,
  `default-agent-option`, or `imported-resource`). They do not construct these three resource
  schemas directly.
- An edit first preserves the exact resource reference already owned by that Expert. Shared Default
  Agent options and canonical project resources use explicit precedence; source array order never
  chooses identity. Imported resources retain ID, name, description, tags, and portable fields when
  a Desktop binding is added.
- This policy remains in `apps/desktop`: its tags, binding adapters, and owner categories are Host
  policy, not portable DSL semantics. It may move to a reusable package only after a second Host has
  the same proven contract.
- A ready Capability revision is activated through a Desktop coordinator. Before writing the new
  revision it checks all current Project and System Expert tool selections. Removing a selected tool
  blocks the update.
- Activation uses a per-Capability lock and a stable v1 journal. It writes the Capability revision,
  publishes one new current Project revision updating all bindings, then updates System Expert
  customizations. Interrupted work is replayed from the journal after the Desktop window and IPC are
  ready. Recovery scans only the journal root.
- A `needs_attention` revision may be stored but is not activated. A successful retry activates it.
- Existing Project revisions, Missions, Executions, and old Capability revision payloads remain
  immutable and pinned. Propagation changes only the current Project head and current System Expert
  customization.

## Consequences

Current consumers converge automatically on one ready Capability revision without rewriting
history. Identity rules become directly testable and lint-enforced. Capability update is a
multi-owner Host transaction with replay rather than an eventually consistent collection of UI
edits. The journal is intentionally narrow and does not introduce a global readiness or migration
coordinator.
