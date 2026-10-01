# ADR 063: Idle Mission resource release

Status: Accepted

Date: 2026-10-01

## Problem

Desktop owns a Mission across turns so its retained ExpertSession and Runtime never use a released
Mission guard. That lifetime also retains the Inbox poller. At a 500 ms maximum interval, unbounded
retention turns 100 idle Missions into roughly 200 polls per second, in addition to Session leases
and native Runtime resources. Returning to per-turn owner release would reintroduce stale guards.

## Decision

- Retain the Mission owner during active execution, queued prompts, human waiting, preparation,
  compaction and deletion. Retain recent idle Sessions for reuse.
- Desktop opts into idle release with a default five-minute TTL. The existing Inbox poller checks
  eligibility after its initial idle window, then at most once per minute. A retained Session must
  have no active Execution or queued/running prompt, and its durable updatedAt must be older than
  the TTL. Consequently successful cleanup normally starts within TTL plus one check interval;
  native cleanup and contention add their own time. This is not a task deadline.
- The Host reserves the same per-Mission admission used by sends, rechecks the durable state, and
  calls releaseAfterTerminal rather than close. Durable Session status, Contexts and RuntimeSessionRef
  remain recoverable. No running task is cancelled to meet the TTL.
- Only after lower-level release succeeds does the Host forget its cached Session/app and release
  the Mission owner. Admission stays reserved through both steps. A racing send resumes the same
  durable Session using a freshly acquired guard and a fresh app binding.
- Perform idle release from the poller's asynchronous scope. Its self-stop must not await itself.
  After owner release, schedule one targeted pending-Inbox recovery check, so a command appended
  while native cleanup was pending is not stranded by the stopped poller. An empty owner remains
  released; the check does not recreate an idle polling loop.
- If validation or native release fails, do not release the Mission owner or silently delete the
  Session/app. Report MISSION_IDLE_RELEASE_FAILED through the idle-release diagnostic hook; retry eligibility
  later. Takeover, fencing and uncertain-release rules from ADR 062 continue to apply.
- CLI does not opt into this Host idle policy. Its one-shot release semantics are unchanged.

Owner-scope diagnostics expose activeMissionOwnerCount, activeInboxPollerCount, inboxPollCount and
inboxPollRate. The rate is the average since this scope was created, not an instantaneous rate.
Desktop includes warmSessionCount (all retained Session objects, including active ones) and the
release outcome in the periodic eligibility diagnostic. These counters do not read the filesystem.

## Verification and limits

Integration tests cover retained first use and follow-ups, rejection of eviction while running or
waiting for human input, idle cleanup, a send arriving during native close, restoration with the
same Session ID, old-guard rejection, and an Inbox command appended during owner release. Owner and
poller counts return to zero when no work remains.

There is no persisted Schema change or migration. A user returning after idle release pays Runtime
restoration latency. Recent/active Mission costs still grow with their actual concurrency; this
policy bounds historical idle retention by time, not by a hard maximum count. A count-based warm
cache budget and active-interval tuning may be added only with separate workload measurements and
the same admission, recovery and fencing guarantees.
