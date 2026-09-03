# ADR 023: Semantic Resource Identity and Project Revisions

## Status

Accepted. Defines the authoritative resource-identity model. External
package and adapter versioning remains unchanged.

## Context

Pragma previously combined a user-editable semantic resource version with a project revision and a
content fingerprint. Missions already pin an immutable project revision, so editing a resource did
not mutate existing Missions. The extra version produced duplicate names, ambiguous edit versus
copy behavior, and references that looked stable while their actual reproducibility came from the
pinned revision.

## Decision

- Expert, ExpertTeam, Flow, Automation, Capability, ContextStore, and RuntimeProfile have one opaque
  identity and no individual version.
- The Host allocates a globally unique 16-character lowercase Crockford Base32 ID with 80 bits of
  randomness. Creation retries on collision. IDs are immutable and hidden from ordinary forms.
- Names are unique within a resource kind after NFKC normalization, trimming, whitespace collapse,
  and lowercase comparison.
- Canonical refs are `<kind>:<id>`. Resource filenames are `<id>.pragma.yaml`.
- A Mission pins the project ID and immutable project revision. The revision contains the complete
  source snapshot and Merkle fingerprint needed for recovery and audit.
- Editing updates the same resource ID and creates a new project revision. Existing Missions remain
  pinned; new Missions see the current head.
- “Create new version” and “copy as new object” are not product operations.
- Plugins, Runtime adapters, tool adapters, Context policies, and other independently shipped
  extensions retain explicit versions such as `plugin:example@1.0.0` and
  `pragma.tool.call@v1`.
- Reserved and built-in semantic IDs follow the same Crockford Base32 grammar as Host-allocated
  IDs. Their canonical refs are runtime-Schema-validated where declared and covered at the first
  persisted or cross-process consumer boundary; human-readable mnemonics do not bypass identity
  validation.

## Migration

`pragma/v2` projects migrate once to `pragma/v3`. As refined by ADR 024, the Interpreter owns the
pure DSL transform and returns the semantic identity mapping; each Host owns its transactional
persistence, backup, and dependent-record updates. IDs are derived deterministically from
`projectId`, resource kind, and legacy ID using the first 80 bits of SHA-256. Semantic refs,
Missions, Automation bindings, workflow layouts, revision manifests, and fingerprints are rewritten.
The migration fails before replacement when multiple legacy versions of one kind and ID coexist or
normalized names conflict. The original project metadata is retained as a migration backup.

This identity-changing cutover establishes the current immutable Revision baseline. It is not a
normal edit and cannot be modeled as an independent per-Revision compiler view because Mission and
Automation references must move through one consistent Project identity map. Once a Project is on
the current DSL identity model, its authoritative Revision manifests and snapshots are never
rewritten by compiler compatibility upgrades.

## Consequences

- Users edit names and behavior, not database identity or an ineffective version field.
- Project revision and fingerprint are the single reproducibility boundary.
- Two same-kind resources cannot share a normalized name.
- Import and migration code must detect identity conflicts rather than preserving duplicate legacy
  versions.
- TypeScript string types alone cannot prove the lexical validity of a built-in identity. Runtime
  Schema validation and boundary integration tests are required for every built-in semantic ref.
