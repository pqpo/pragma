# ADR 056: First-class Skill Bundles

## Status

Accepted

## Decision

User-managed Skills are first-class portable and publishable assets. `pragma.bundle/v3` permits a
Skill's `Capability` resource as a root. Such a root is valid only when Desktop exports the current
active, ready revision through the shared `pragma.skill@v1` payload codec. The payload contains an
archive-local asset key, normalized Skill metadata, `SKILL.md`, the complete current file tree, the
content hash, an archive file-tree fingerprint, and the definition fingerprint. It excludes
history, drafts, revision jobs, credentials, sync configuration, and local paths.

Import uses the existing asset conflict policy. Update preserves the selected local Capability ID
and appends a local revision under CAS; keep-local preserves the local asset; copy allocates a new
Capability and DSL identity at local revision 1. Archive asset keys and source revision numbers never
become authoritative local identity.

Bundle Source manifest and item protocols advance to v3 and add the `skill` kind at
`skills/<category>/<item>/`. Source upgrades remain explicit and journaled. Desktop installation
state advances to v8; its Source snapshot advances to v4 as a disposable cache. Source settings and
the DSL `apiVersion` do not change.

Desktop owns Skill-to-Project binding through `ensurePragmaSkillBinding`; renderer code may request
a binding but may not derive the semantic Capability ID itself.

## Consequences

- Skill export, import, marketplace installation, and multi-source publication use the same Bundle
  integrity and conflict machinery as other roots.
- The Skill codec carries a canonical file manifest, including executable bits, so every consumer
  can verify the revision content hash instead of trusting definition metadata alone.
- Legacy Bundle v1/v2 and Source v1/v2 data remain readable through static migrations, while future
  versions and malformed or incomplete Skill payloads fail closed.
- System capabilities and non-Skill connectors cannot be Skill roots.
