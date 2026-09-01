# Mission Refactor Process Log

This file is append-only. Each checkpoint records decisions, material deletions, validation, and
remaining risks so the work can resume safely after interruption.

## 2026-09-01 — Baseline and audit confirmation

- Confirmed all eight findings against current source: false acknowledgement timeout, separable
  lease/poller lifecycle, swallowed poll errors, duplicate command handlers, divergent execution
  projections, duplicate operation schemas, non-compliant historical migrations, and Mission God
  Objects.
- Confirmed historical Mission v3-v10 data remains in the support window.
- Selected repository-tracked planning records and phased, continuously usable delivery.
- The previous human-interaction Runtime fix is present in commit `bb11cb60`; it is a protected
  regression baseline rather than part of the command timeout root cause.
- Baseline Local Host verification passed: 5 files and 58 tests covering controller store, owner
  scope, query, Core control adapter, and run application.
- Initial working tree was clean.

## 2026-09-01 — Durable command and owner boundary

- Desktop message IPC now returns `pragma.desktop-mission-command-receipt/v1` after the Inbox write;
  owner acquisition is scheduled and no longer delays the receipt. Applied/rejected outcomes use a
  separate versioned notification.
- Split the old acknowledgement timeout into acceptance and result timeouts with different recovery
  semantics. Structured category, retryability, details, and cause ID survive Desktop IPC.
- The renderer correlates messages, queued items, outcomes, and retries by request ID. Uncertain
  submission retries reuse the ID; a durable rejection creates a new ID. Attachment drafts are
  discarded only after applied.
- Owner acquisition starts its bound poller automatically. The public manual poller-start path was
  deleted. Three consecutive polling failures stop the unhealthy owner, report diagnostics, and
  schedule lease-expiry recovery while durable work remains.
- Desktop and CLI both log owner-start, poll, and lease-loss failures with stable events.

## 2026-09-01 — Authority and storage cleanup

- Added the Local Host command dispatcher and removed both command-kind switches. Desktop and Core
  now return aligned turn, queue, and changed-state fields.
- Follow-up send/steer executions are projected as canonical `run.started` and terminal events. The
  projector and execution observer are standalone services with focused tests.
- Deleted the unused Shared operation state/schema/transition family; the Local Host aggregate is
  the sole durable operation protocol.
- Historical Mission schemas moved out of current renderer contracts into frozen
  `migrations/schemas/vN` modules with a statically registered adjacent v3-to-v10 chain. v3-v5 now
  receive backups and a replayable journal, matching later versions.
- Rechecked whether storage should become v11. It should not: valid v10 semantics did not change, and
  an empty version bump would violate protocol governance. The current writer remains v10.
- Extracted Mission timeline storage, execution observation, command execution projection, and
  renderer delivery/retry rules from their former large modules. Remaining low-risk decomposition is
  kept visible in the task ledger instead of being hidden as completed.

## 2026-09-01 — Verification checkpoint

- Shared: 9 files, 47 tests passed.
- Local Host: 32 files, 204 passed and 1 skipped, including multi-process, lease recovery, and the
  non-blocking durable receipt test.
- Desktop: 155 files and 1005 tests passed, including Mission Store, Runner, renderer, projection,
  and delivery behavior.
- CLI: 12 files and 103 tests passed after updating the split wait API.
- Desktop, CLI, Local Host, and Shared lint/typecheck passed.
- Desktop production build passed, including renderer style ownership, bundled-main dependency,
  and self-contained preload Bridge verification.

## 2026-09-01 — Renderer delivery-state extraction

- Moved optimistic messages, queued-message placeholders, awaiting-request state, submitted-message
  correlation, and command-outcome subscription into `useMissionCommandDelivery`.
- Removed the renderer page's duplicate awaiting-request state and private submitted-message map.
  New-request retries replace the rejected request identity; uncertain-delivery retries retain it.
- Re-ran Desktop Web typecheck, Desktop lint, and the Mission page plus delivery suites: 2 files and
  93 tests passed.
- Re-ran the high-risk Mission Store, Runner, and execution-projector suites after the final
  renderer extraction: 3 files and 83 tests passed. `git diff --check` is clean.
- The remaining broad Runner, Store, and renderer decomposition stays explicitly `In progress` in
  the task ledger. It is structural follow-up, not a hidden condition of the durable receipt fix.

## 2026-09-01 — Projection storage extraction

- Moved current projection reads, cursor paging, bounded writes, legacy v1 JSON conversion, and
  legacy cleanup into `mission-projection-storage.ts`.
- MissionStore now owns aggregate locking and Mission existence checks, while projection file
  representation and compatibility are isolated behind one storage interface.
- Desktop Node typecheck passed; Mission Store coverage passed with 41 tests.

## 2026-09-01 — Phase 5 structural completion started

- Re-audited MRF-501 and MRF-503 after commit `ec3fea79`. MissionRunner still owns roughly twenty
  mutable registries, while MissionDetail owns more than forty state/ref groups and direct IPC.
- Recorded `structural-completion-plan.md` and expanded both parent tasks into independently
  verifiable service, hook, facade, component, and test boundaries.
- Historical Mission storage, durable command receipts, request identity, and IPC wire shapes are
  explicitly frozen for this phase.

## 2026-09-01 — Phase 5 structural completion finished

- Reduced `mission-runner.ts` to a stable 22-line facade. Desktop wiring remains in the composition
  module; contracts, adapter host, and Chat, Work, Session, Lifecycle, and Command state owners are
  separate modules. Mutable listeners, revisions, caches, active runs, Session identities, command
  outcomes, and coalesced operations each have one owner.
- Reduced `MissionsPage.tsx` to a stable page entry. Extracted the pure conversation model, live
  conversation subscription/cache/paging hook, draft and attachment state, client-operation lock,
  Work, human interaction, model options, Context compaction, and message presentation.
- Removed duplicate page-size literals and moved conversation-model assertions into their owning
  test file without copying tests. Added five service-boundary tests for coalescing, invalidation,
  listener isolation, and state ownership.
- Preserved Mission storage v10, every v3-v10 historical schema/fixture/migration, IPC contracts,
  request IDs, command receipts, and visible behavior.
- Focused Mission Store/fencing/service regression: 3 files and 48 tests passed. Renderer Mission
  regression: 3 files and 93 tests passed. Desktop full regression: 157 files and 1010 tests passed.
- Repository lint and typecheck passed. The first all-core run had one unrelated Interpreter cache
  test exceed its 5-second timeout by 31 ms under concurrent load; the test passed alone (3 tests)
  and the complete `pnpm test:core` rerun passed (10 tasks). `pnpm build` passed all 24 tasks,
  including Desktop style, main bundle, and preload verification. `git diff --check` is clean.

## 2026-09-01 — Shared Node Host composition

- CLI production composition was reduced to Runtime factories, process environment, client identity,
  and filesystem ports. Mission controller, owner lifecycle, query/watch, Project catalog, Board,
  Core stores, Usage sink, and command/run wiring now live in
  `@pragma/local-host/node-application`.
- Desktop Main now reuses the same Node composition entry and injects its richer Mission/Runtime/
  Board adapters. Mission control/run applications are assembled by Local Host from the injected
  MissionRunner ports. Its Electron IPC, permission, window, credential, and product-specific
  services remain application-owned.
- Added `createLocalHostMissionController` so controller, owner lease/poller, query, and watch are
  composed as one lifecycle in both hosts. Removed the unused `@pragma/local-host/wire` forwarding
  subpath and the `missionCommands` compatibility alias; cross-process schemas come directly from
  `@pragma/shared/integration`.
- Detached CLI mutations now return after durable Inbox submit. A queued operation is a successful
  durable receipt and is observed later through query/watch; the CLI does not become a resident
  daemon, so a queued item without a live Host owner is consumed by a later Host or attached/resume
  call. Acceptance and terminal waits remain available for attached calls.
- Verification: Local Host full suite 206 passed/1 skipped; CLI focused mutation/composition/watch
  suite 30 passed; Desktop full suite 157 files/1010 tests passed. Repository lint and typecheck,
  runtime feature and DSL-version checks passed; Desktop production build passed main/preload/style
  verification; `git diff --check` is clean.
