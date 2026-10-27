# Runtime Session v3 Pi writer fixture

`runtime-session-v3-pi.json` and `runtime-session-catalog-v1-pi.sqlite` were written by the actual
`createRuntimeSessionRecord` / `updateRuntimeSessionRecord` implementation at commit `7c3a02d6`,
using its compiled Core module before the v4 changes. The SQLite catalog was checkpointed and closed
before copying. These are synthetic local records, not private user data.

The writer created an ExpertSession-owned `cloud-pi-agent` record and updated it to `running`.
No schema version was edited. The fixture reproduces the missing Host identity in the historical writer.
