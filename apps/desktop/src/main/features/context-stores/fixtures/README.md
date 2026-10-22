# Context Store fixtures

- `context-store-v4.json` was captured from the preserved v3-to-v4 migration writer using
  `context-store-v3/`. Its content hash and timestamps were not altered.
- `context-store-revision-job-v3.json` was emitted by the preserved v1-to-v2 and v2-to-v3
  migration writers using `context-store-revision-job-v1.json` and a fixed draft UUID.
  Tests substitute only owner IDs to attach this historical record to temporary storage.
