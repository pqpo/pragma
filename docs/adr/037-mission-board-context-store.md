# ADR 037: Mission Board as a Host-bound Context Store

## Status

Accepted.

## Context

Plans, TODO lists, progress, decisions, cross-Expert handoffs, and process notes need the same
persistent, Mission-scoped collaboration surface. Treating each usage pattern as a separate model or
managed-tool API duplicates the Context System and couples Core to one Host's persistence mechanism.

## Decision

Mission Board is a reusable capability exported by `@pragma/local-host`. It exposes Context Store
bindings: `mission-board` for Mission-shared content and `mission-board-private` for content isolated
by the trusted Runtime `contextId`. `GUIDE.md` describes plan, TODO, progress, decision, handoff, and
large-output conventions. They are usage patterns, not distinct domain objects or tools. Keeping it
inside Local Host avoids a package whose only consumers are the two local Host compositions.

Agents use the existing Context System list, read, search, add, edit, and delete operations. Mission
Board adds no board-specific CRUD or handoff methods. Mutations retain Context revision/etag CAS.

The Host creates the physical stores and passes the bindings through `createPragma`. Core mounts the
bindings on every executed Expert and knows only generic registration metadata: mutation approval
policy and the single large-output overflow target. Core does not import Mission Board and neither
Core nor Memory chooses a filesystem layout. Desktop uses `@pragma/context-filesystem` at its
composition root; another Host may supply database, object-store, or in-memory adapters.

Large Expert output remains inline up to the Core limit. Above the limit, Core writes a deterministic
`system/outputs/...` item through the registered overflow Context Store and persists a bounded
summary plus a generic Context reference. Workspace artifacts remain controlled relative-path
references recorded on the board and are not copied automatically.

Shared mutations may be published as visibility-preserving Evidence. Private board content never
becomes shared through handoff, Memory refinement, or export without an explicit visibility change.
Mission Board follows the Mission owner lifecycle and survives Host restarts.

## Consequences

- Plan, TODO, progress, process, and handoff semantics evolve in `GUIDE.md`, not in Core APIs.
- Desktop Main and CLI reuse Local Host and provide only persistence and authorization adapters.
- The old `register_handoff_file`, handoff visibility resolver, and Execution handoff store are
  removed from active execution paths.
- Historical `pragma.handoff` records remain valid v8 migration input. Desktop mounts a bounded,
  Mission-authorized, read-only compatibility Context Store from `@pragma/context-filesystem` so
  their existing payloads remain readable; it exposes no legacy write or registration API. New v9
  records use generic Context references and write only through the Host-selected overflow target.
