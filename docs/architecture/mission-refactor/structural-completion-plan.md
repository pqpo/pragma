# Mission Phase 5 Structural Completion

## Goal

Complete MRF-501 and MRF-503 without changing Mission IPC, storage v10, historical v3-v10
compatibility, request identity, command receipts, or user-visible behavior.

## Runner boundaries

- `MissionSessionService` owns Execution Context, ExpertSession, compilation identity, successor
  Session, and Context binding state.
- `MissionChatService` owns live chat, history paging, patches, Context window state, compaction,
  revisions, and subscriptions.
- `MissionWorkService` owns Work projection, live Work output, paging, caches, revisions, and
  subscriptions.
- `MissionLifecycleService` owns active Execution, in-flight runs, restoration, interruption,
  deletion, human interaction, and Usage reconciliation.
- `MissionCommandService` owns send, steer, queue mutation, Local Host command adaptation, fencing,
  and command outcomes.
- `mission-runner.ts` retains the stable facade contract, composition, and delegation only.

Every mutable Map or Set has one service owner. Services communicate through narrow ports and must
not share a mutable context bag or import the facade back into a leaf module.

## Renderer boundaries

- `useMissionConversation` owns chat cache, pagination, live patches, subscriptions, optimistic
  reconciliation, and thinking state.
- `useMissionComposer` owns drafts, attachments, send/retry, queue actions, and the synchronous
  client-operation lock.
- `useMissionWork`, `useMissionHumanInteraction`, and `useMissionOptions` own their corresponding
  state and asynchronous effects.
- Rail, detail, conversation, Work, human composer, and message presentation are separate
  components. Presentation components do not call Desktop IPC directly.
- Mission switching and unmount cancel subscriptions, reject stale asynchronous results, discard
  attachment drafts, and reset hook-owned state.

## Verification

- Move tests to the owning domains instead of copying assertions.
- Run focused tests and Desktop lint/typecheck after each extraction boundary.
- Run Mission storage migration regression tests, Desktop full tests, `pnpm check`, `pnpm build`,
  and `git diff --check` before completing the parent tasks.
- Mark MRF-501 and MRF-503 complete only after the facade and page entry contain no extracted
  domain algorithms and the final validation passes.
