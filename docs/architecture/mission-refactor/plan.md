# Mission Architecture Refactor

## Goal

Remove the Desktop command acknowledgement timeout failure and make Mission command execution,
ownership, projection, and migration behavior deterministic across Desktop and CLI. Historical
Mission storage versions v3 through v10 remain supported and migrate forward without data loss.

## Architectural decisions

1. Desktop message submission returns immediately after the command is persisted and owner startup
   is scheduled. Completion is delivered through operation updates; control mutations that require
   an immediate result may still explicitly wait for command application, never Runtime completion.
2. A Mission lease may be renewed only while the same owner has an active Inbox consumer. Owner,
   renewal, and polling form one lifecycle.
3. `@pragma/local-host` owns the single command dispatcher. Desktop and CLI supply Host execution
   ports but do not implement separate command switches or result semantics.
4. Core Execution events are the execution-status and result authority. The Mission event feed is
   a cursor-bearing projection of those events; Mission metadata and the user timeline do not own
   an independent execution truth.
5. Historical Mission schemas live only in a static adjacent migration chain. Current business
   code parses only the current storage schema.

## Delivery phases

### Phase 1: command receipt and recovery

- Replace Desktop submit-and-wait with an immediate, versioned command receipt.
- Separate acceptance waiting from terminal-result waiting in Local Host.
- Preserve IntegrationError retryability and details through Desktop IPC.
- Reconcile optimistic messages by stable request id and never create a replacement id for an
  uncertain delivery.

### Phase 2: owner and poller lifecycle

- Introduce one owner coordinator that guarantees lease plus poller as an invariant.
- Remove raw Desktop lease acquisition paths.
- Add bounded backoff, degraded reporting, lease relinquishment, and recovery for poll failures.
- Make lease-expiry takeover explicit instead of ending the client wait at the takeover boundary.

### Phase 3: command and projection authority

- Replace the Desktop and Core command switches with one Local Host dispatcher.
- Normalize command results and errors for every command kind.
- Project initial and follow-up executions through the same Core-event projector.
- Make Desktop and CLI summary, result, and watch views consume the same projection semantics.

### Phase 4: protocol and storage cleanup

- Delete the unused Shared Mission operation protocol.
- Isolate Mission v3-v10 schemas and adjacent migrations from current contracts and Store logic.
- Add real historical fixtures, backup, journal replay, chain, no-op, and future-version tests.

### Phase 5: structural cleanup

- Reduce MissionRunner to a composition facade and extract execution, command-port, chat, work,
  and lifecycle services.
- Separate current Mission storage, timeline transactions, projection caches, and migrations.
- Extract Mission composer/queue/conversation state from the renderer page.
- Delete duplicate helpers, compatibility branches, schemas, and tests made obsolete by the new
  authority boundaries.

## Acceptance criteria

- A command whose Runtime application exceeds 30 seconds returns a Desktop receipt promptly and
  applies exactly once without an acknowledgement timeout.
- Retrying an uncertain request with the same request id cannot duplicate a user message or turn.
- No renewable Mission lease exists without a functioning Inbox poller.
- Poller and outcome callback failures are observable and recoverable.
- There is one command dispatch switch and one operation receipt protocol.
- Desktop and CLI agree after initial, follow-up, recovered, interrupted, and human-input turns.
- Historical Mission v3-v10 fixtures migrate to the current version with backup and crash replay.
- Focused tests, lint, typecheck, package tests, and build pass at every delivery boundary.
