# Historical fixture provenance

- `capability-revision-propagation-v1.json` is a persisted journal emitted by the v1 writer introduced in commit `f96a25185bd02e01f225b91cb261b6a7cd35c09b`.
- `capability-credentials-v2.json` captures the aggregate emitted by the v2 Secret Store writer from commit `8602be02`. Its UUIDs are deterministic test identities; its structure is unchanged from that writer's output.
- `skill-revision-job-v1.json` captures a record emitted by the original Skill revision writer introduced in commit `a480ed5d13add7a665d16309386c6472924296b1`.
- `skill-revision-job-v2.json` and `skill-revision-draft-v1.json` capture records emitted by the managed raw-directory Skill revision writer introduced in commit `04b6d96d0357c2cebc5780db4e64a85e373546d7`. Fixture UUIDs and timestamps are deterministic test identities; persisted structures are unchanged from those writers' output.

These fixtures are intentionally static. Tests must migrate them through the registered adjacent migration steps rather than reconstructing an old value with the current schema.
