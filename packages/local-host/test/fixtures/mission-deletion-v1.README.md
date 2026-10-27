# Mission deletion v1 retry fixtures

The JSON fixtures were generated with the actual `createMissionDeletionService` from
`packages/local-host/src/missions/deletion.ts` at commit `7c3a02d6`, loaded unchanged through tsx.
The writer prepared and committed a synthetic Mission, then ran a failing Usage callback.
Only Date.now was advanced between attempts to exercise the writer's actual retry path.

`mission-deletion-v1-retried.json` captures two failed calls (one initial call and one retry).
`mission-deletion-v1-exhausted.json` captures eleven failed calls (one initial call and ten retries).
The files contain no user data and their schema versions/counters were not edited after writing.
