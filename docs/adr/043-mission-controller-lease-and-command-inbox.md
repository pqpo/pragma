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

Version two adds durable prompt attachment metadata and `queue.try-steer`. The latter is a
best-effort queue promotion addressed only by the stable queue request id; it returns `steered` or
`retained` and never requires a moving execution/turn fencing target. Historical v1 command
inboxes are upgraded lazily under the Mission aggregate lock, with the original inbox retained as
a v1 backup before atomic replacement. A stable command-Inbox migration journal contains both the
validated source and target arrays, so crashes after backup or replacement replay idempotently on
the next access before business reads continue.

`steer` and `queue.steer` are strict same-turn operations: they require the expected execution/turn
and owner fencing target. A changed, inactive, unsupported, or unavailable target is rejected and
never converted into a send or queue operation. Different Missions may execute concurrently; a
second controller for the same Mission receives `MISSION_LEASE_HELD`.

`respond` is a distinct interaction-addressed operation. It requires `interactionId`, persists the
human response against that interaction, and resumes the execution that owns it; it is never
interpreted as `send`, `steer`, or a queue mutation. An ExpertSession may internally re-queue the
owning prompt while a human-input checkpoint releases its Runtime owner for crash recovery. That
recovery prompt is control-plane state, not a user-authored queue item. Core persists its explicit
`purpose: human_checkpoint_recovery`; Core and Mission queue projections select only
`purpose: user` prompts. Hosts must not reconstruct this distinction by scanning event text or
pending interaction state. User-authored follow-up prompts queued during the same wait remain
visible and independently actionable.

Mission semantic projection writes use a durable replay journal. If the Host mutation or its event
commit becomes uncertain after a command is accepted, the Inbox command remains `accepted` and the
operation remains `applying`; the owner replays the journal before the next semantic write. It must
not publish a rejected command while the lower-level Core side effect may already be live.

Runtime steering is an external side effect and is not assumed replayable. A persisted delivery
attempt that cannot be reconciled after a crash becomes `delivery_uncertain`; queue execution is
paused until an explicit operator action, rather than risking duplicate instructions.
Because an older Host ignoring this field could duplicate an external steer, ExpertSession state
advances from v5 to v6 and its transaction journal from v9 to v10 with registered adjacent
migrations; the version change is safety-driven rather than an attachment-format change.

## Consequences

- Controller state, inboxes, durable event logs, and request registries are versioned Local Host
  persistence families and follow lock, journal, backup, atomic replacement, and lazy migration
  rules from ADR 019 and ADR 020.
- Long Runtime work and user input never hold a Mission file lock; the lease covers the long-lived
  ownership interval.
- This decision does not introduce a global owner, daemon, UDS proxy, or sub-second live attach.
