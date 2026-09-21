# ADR 054: Localized Bundle asset identity

## Status

Accepted.

## Context

Portable Bundles carry Skill and knowledge-base payloads between installations. Treating Bundle
logical IDs, source revisions, or content fingerprints as durable local identity created a second
identity system beside Capability IDs and ContextStore IDs. It also made import conflicts depend on
the current Project instead of the complete Studio asset library.

## Decision

- A Bundle is a transport format. After import, a Skill is identified only by its local Capability
  ID and a knowledge base only by its local ContextStore ID.
- Import conflict discovery compares same-type, normalized names against every formal local asset,
  including assets not referenced by the current Project. Content fingerprints never suppress this
  user decision.
- Replacing an asset preserves its local ID and appends an ordinary local revision. Keeping local
  writes no asset content. Copying creates a new local ID at revision 1.
- Bundle source revisions and logical IDs remain archive-local metadata. The importer consumes the
  selected current snapshot and does not align source revision numbers with local history.
- Capability manifest v3 removes the legacy Bundle origin identity through a lazy, journaled v2 to
  v3 migration. Existing Capability IDs, revisions, bindings, and references remain unchanged.
- Skill synchronization uses only `capability/<localId>`. Legacy `bundle/<logicalId>` repositories
  are an intentional compatibility cutover. No released installation contains this protocol, so the
  reader rejects it with an instruction to initialize a new empty branch or repository instead of
  carrying a migration and permanent dual-identity complexity. Runtime reconciliation does not
  retain a dual-identity mapping.

## Consequences

Bundle import and synchronization have one explainable local identity model. Project Resource
localization remains separate from asset identity, and Skill and ContextStore implementations keep
their domain-specific validation, revision, and persistence services.
