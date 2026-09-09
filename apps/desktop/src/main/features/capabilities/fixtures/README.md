# Historical fixture provenance

- `capability-revision-propagation-v1.json` is a persisted journal emitted by the v1 writer introduced in commit `f96a25185bd02e01f225b91cb261b6a7cd35c09b`.
- `capability-credentials-v2.json` captures the aggregate emitted by the v2 Secret Store writer from commit `8602be02`. Its UUIDs are deterministic test identities; its structure is unchanged from that writer's output.

These fixtures are intentionally static. Tests must migrate them through the registered adjacent migration steps rather than reconstructing an old value with the current schema.
