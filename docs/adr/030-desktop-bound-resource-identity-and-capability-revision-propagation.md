# ADR 030: Desktop-bound resource identity and Capability activation

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

Capability revisions were separately pinned by every current Expert and Project binding. Updating
one Capability therefore required rewriting unrelated owners and made a logical dependency look
like immutable historical data.

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
- Capability bindings contain only the local Capability ID. Project resources, System Expert
  customizations, and ordinary Expert definitions never pin a Capability revision.
- The Capability manifest owns `activeRevision`. Runtime consumers resolve that revision at the
  start of an execution. A ready revision may advance it only after current Project and System
  Expert tool selections pass compatibility checks. A `needs_attention` revision is retained as
  `latestRevision` but does not become active until a successful retry.
- Activation uses one per-Capability mutation boundary and a stable v3 journal. It writes the
  Capability revision and commits staged credentials; it does not publish Project revisions or
  rewrite System Expert customizations. Historical v1 and v2 journals are upgraded through adjacent
  migrations when recovered after Desktop window and IPC initialization.
- Capability credentials are runtime state rather than revision payload. Candidate credentials are
  verified through an overlay before activation. The credential aggregate maps logical names to
  immutable secret generations; its journal contains SecretRef metadata only, never plaintext, and
  either retains the old active mapping or finishes the new mapping after recovery. Capability
  creation, Bundle identity creation, credential rotation, and deletion use staged generations.
  Every credential rotation creates a Capability candidate revision even when its definition is
  unchanged, so candidate health and the active definition/credential generation cannot alias the
  same revision. A rejected or incomplete Capability write cannot switch the active credential
  mapping. Runtime resolution fails closed while an activation journal is pending. Credential
  aggregate v2 is upgraded to v3 through a source-bound migration journal and retained backup;
  future versions fail closed.
- Capability deletion is also a coordinator mutation. The coordinator-root journal records the
  durable delete intent, while an owner-local deletion marker makes credential, customization, and
  Capability-directory cleanup idempotent. Recovery therefore does not depend on a full Capability
  scan and cannot leave a successfully deleted owner with active credential generations.
- Existing immutable Project revisions that contain revision-pinned bindings remain readable, but
  the legacy suffix is migration metadata rather than an execution pin: resumed or continued
  Missions resolve the Capability's current active revision. On first access to the current Project
  head, Desktop atomically publishes one successor revision whose Capability bindings are ID-only.
  Capability manifest v1-v3 data is lazily upgraded to v4. A ready latest revision becomes active;
  when the latest revision needs attention, the old format cannot prove which earlier revision was
  active, so migration leaves the Capability inactive until a successful retry establishes it.
- Execution records persist the actual resolved Capability revision and fingerprint. Session and
  compilation cache identity includes the resolved environment, so an activation cannot silently
  reuse a session compiled against older Capability content.

## Consequences

Current consumers, including Missions created from historical Project revisions, converge
automatically on the active ready revision without rewriting dependent owners. Historical Project
data stays immutable, while each persisted Execution records the revision that actually ran.
The mutation journal is narrowed to the Capability and credential aggregates and does not introduce
a global readiness or migration coordinator.
