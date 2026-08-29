# ADR 043: Mission controller lease, fencing, and durable command inbox

## Status

Accepted

## Context

Desktop and a one-shot CLI can access the same local Mission. Process-local maps and ExpertSession
leases cannot protect Mission creation, queue, interaction, event, and execution-link writes as one
aggregate, nor can they safely carry a strict steer request from a non-owner process.

## Decision

Each Mission has a durable `MissionControllerLease` held under its aggregate lock. A successful
claim assigns a monotonically increasing decimal-string `fencingToken`; every execution-semantic
Mission write checks the current `claimId` and token in that same lock. Expired owners may be taken
over, and all late writes from an old token fail with `MISSION_FENCING_REJECTED`. Reads and Board
reads do not require a lease. ExpertSession leases, Flow recovery claims, and Runtime Session
ownership remain separate lower-level invariants.

Cross-process mutations are persisted in `MissionCommandInbox`; producers never acquire a second
controller lease. Version one supports `send`, `steer`, `respond`, `interrupt`, `queue.remove`,
`queue.resume`, and `queue.steer`. The active owner polls the inbox with a bounded interval, records
`pending -> accepted -> applied|rejected|expired`, and uses a stable transaction journal where a
command acknowledgement and Mission durable event must commit together. `requestId` and
`payloadHash` provide idempotency; a command id remains a separate durable delivery identity.

`steer` and `queue.steer` are strict same-turn operations: they require the expected execution/turn
and owner fencing target. A changed, inactive, unsupported, or unavailable target is rejected and
never converted into a send or queue operation. Different Missions may execute concurrently; a
second controller for the same Mission receives `MISSION_LEASE_HELD`.

## Consequences

- Controller state, inboxes, durable event logs, and request registries are versioned Local Host
  persistence families and follow lock, journal, backup, atomic replacement, and lazy migration
  rules from ADR 019 and ADR 020.
- Long Runtime work and user input never hold a Mission file lock; the lease covers the long-lived
  ownership interval.
- This decision does not introduce a global owner, daemon, UDS proxy, or sub-second live attach.
