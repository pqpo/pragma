# ADR 062: Long-running Mission heartbeats and ownership fencing

Status: Accepted

## Problem

ExpertSession and Mission controller heartbeats use 30-second renewable leases.
The renewal loops previously cancelled work when their local expiry timestamp
passed, before checking whether another owner had actually taken over. Sleep,
event-loop delay and temporary file-lock contention could therefore stop a healthy
task. The Inbox poller also treated three ordinary polling errors as lease loss.

Neither a heartbeat interval nor a wait timeout is a task execution deadline.
Expert and ExpertTeam tasks can outlive many lease intervals, including hours or
days. `wait_experts` timeouts end only the current wait and leave pending work running.

## Decision

- Expiry makes a lease eligible for takeover. The persisted claim identity and,
  for Mission controllers, the fencing token determine the current owner.
- Guard validation, renewal and takeover remain serialized by the same aggregate
  file lock. An unchanged owner can continue and renew after a delayed heartbeat;
  a released, revoked or superseded claim cannot renew or make guarded writes.
- Claiming an unchanged Mission owner preserves its token, including after expiry.
  A new owner still advances the monotonic token. A late old owner never obtains
  its successor's token through the renewal path.
- Renewal retries temporary storage contention with bounded retry intervals,
  without treating elapsed lease duration as a task timeout. Explicit stop/release
  stops retries. A confirmed replacement or a non-retryable renewal error still
  stops the local owner.
- Ordinary Inbox polling failures report diagnostics and continue with bounded
  backoff. Only a fencing failure invokes the poller's lease-loss callback.
- Diagnostics distinguish a delayed heartbeat from lost ownership and include
  the underlying renewal or fencing error.
- Strict steer admission also uses persisted ownership rather than heartbeat
  punctuality. Its target token is captured atomically during append and checked
  again before delivery, so takeover rejects commands for the previous owner.
- Session release closes prompt admission before asynchronous state validation
  and drains already admitted prompts. A failed release precondition reopens
  admission and allows release to be retried after pending work settles.

This partially supersedes ADR 047's rule that repeated polling failures stop an
owner. Its durable command receipts, command application deadlines, event
projection and recovery rules remain in force. A command application deadline
limits command handling, not the Runtime turn accepted by that command.

No persisted Schema, version, field, owner identity or takeover condition changes.
Existing records and journals remain readable without conversion; this repair
changes when the live Host stops a task, and does not rewrite historical execution
facts. Older clients can still stop prematurely and need this code fix.

## Verification

Real file-backed tests cover expiry followed by same-owner renewal, resumed writes
before the heartbeat callback, takeover followed by rejection of old writes and
renewal, and preservation of the fencing token. Core tests keep a turn running
across a simulated three-day clock jump, test renewed ownership and real takeover,
and exercise temporary renewal contention after expiry. Polling tests cover more
than three failures followed by command delivery, and actual ownership loss.
Application-level tests cover strict steer after a three-day heartbeat delay and
takeover between append and delivery. Session tests cover concurrent admission
and release, recovery after a rejected release, and preservation of the root
Context. A separate real-process probe verified 100 two-process claim races and
expiry takeover with rejection of the original process's writes. The environment
does not deliver child-process pipe output reliably; the probe used file-backed
stdout for handshakes without changing production code or the existing test suite.
