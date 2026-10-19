# Historical Curator Session fixture

`v1.sqlite` was written using the compiled Session writer from commit
`de7aa331350e2439e5f5e23adfeef4559c33ecd1`, before rebuilding the changed package. It contains two
synthetic Semantic snapshots created with `test/support/extraction.ts`: `staged` has a submitted
fact and `completed` also has a successful finish receipt. Both have an original Mission link.
The fixed writer clock is 2026-10-15. No current-schema object was relabelled with an older version.

The upgrade tests copy the original database before invoking the current writer. Failure-injection
triggers are added only to the test copy to verify transaction rollback and repeatable recovery.

`v2.sqlite` was written by the unmodified Session writer at commit
`f509a8a4da91a00b6bbd1ca6d40362305c5ee929` using synthetic
`test/support/extraction.ts` input and a fixed 2026-10-19 clock. It contains a shared
conversation with a saved Semantic receipt, a staged Episodic goal, an original Mission
link and an unacknowledged continuation reservation. It was generated before the v3
implementation; no current state was relabelled.
