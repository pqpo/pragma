# Resource reader historical fixtures

Copied unchanged from the R2 baseline `origin/main` (`a2741325ab106b3cbc8f472d4feec98b1367ae55`):

- `capability-manifest-v2.json`: `apps/desktop/src/main/features/capabilities/test-fixtures/capability-manifest-v2.json`.
- `context-store-v3/`: `apps/desktop/src/main/features/context-stores/fixtures/context-store-v3/` (manifest and the historical Markdown file).

These are existing historical storage fixtures, rather than current objects with a replaced version number. The new resource reader test supplies separate current definition/health files for the historical Capability manifest; it does not describe those added files as historical writer output. Historical migration and journal replay tests remain in the existing Desktop resource suites and now execute the shared Local Host authority helpers.
