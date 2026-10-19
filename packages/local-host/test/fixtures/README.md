# Historical storage fixture provenance

These fixtures are inputs written by real historical implementations. Tests do not create
old formats by changing a current object's version string.

- `execution-file-v12.json`: captured by executing the unmodified pre-closure Core
  FileExecutionStore writer saved from this worktree before extraction; create plus one
  idempotent commit produced the Execution, records, event and receipt. It is the source
  for JSON-to-SQLite conversion and chunk/publish interruption tests. Benchmark expansion
  is explicitly synthetic and is not a new historical fixture.
- `local-host-usage-v1.json`: captured by running `packages/local-host/src/usage.ts` from
  commit `a5054c388e46dd5419b929fcb865b08e7c3e4f9a` and recording an observation.
- `execution-storage-conversion-v1.json`: captured from the actual pre-v2 worker's
  conversion journal on an interrupted first access. The static v1-to-v2 migration is
  tested independently of current database creation.
- Execution v9/v10, transaction/handoff v10, and string-prompt fixtures were moved from
  Core's existing persistent migration suites without rewriting their serialized data.
  Their original historical writer provenance remains in those fixture contents and
  migration test comments. Core retains fixture copies needed by neutral migration tests.

Current-version no-op, future-format rejection, chained domain migration, conversion
interruption, authority publication and post-upgrade execution are covered by Host tests.
Preserve original bytes when extending the supported migration chain.

- `packages/core/test/fixtures/bundle-installations-v8.json` was captured on 2026-10-19 by
  executing the unmodified Desktop Bundle/Project/ContextStore writers at
  `e1b6d427e923c3f1b001a471e0aaba0e1e97b7cd`. A real knowledge-base `.pragma` was exported,
  inspected and imported into an empty temporary owner. The catalog bytes were copied unchanged;
  this is not a current record with a substituted version string. The v8→v9 step preserves
  the record and does not invent a request UUID or an interrupted transaction plan.

- `bundle-installation-v8-owner.json` captures the complete `data/` and `state/` file
  bytes from that same historical import. Base64 is only the fixture envelope; restored
  files are unchanged writer output. Host integration restores it into a clean temporary
  home, performs the adjacent catalog upgrade, rechecks readiness and reads the original
  knowledge snapshot while preserving its Project revision. This standalone ContextStore
  Bundle has no executable root; it does not establish real Runtime acceptance.
