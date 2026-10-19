# ADR 073: Shared conversation Memory extraction and continuation

- Status: Accepted
- Date: 2026-10-16
- Partially supersedes: ADR 072 (separate Curator admissions and per-admission retry budgets)

Tool interface and Session storage upgrades for new conversations are specified by
[ADR 074](./074-memory-curator-tool-contract-v2.md); historical conversations preserve this vocabulary.

## Context

The Desktop admitted an Episodic Mission and a Semantic Mission for the same source conversation.
Each model read the source independently. Retrying a failed extraction admitted a new Mission,
even when the existing conversation contained useful evidence reads and staged candidates.

## Decision

Memory owns a shared conversation extraction coordinator. It prepares the two Module deliveries
without dispatching a model, pairs only matching conversation/watermark snapshots, and invokes one
Built-in Curator with both submission tools. The existing per-Module durable jobs remain the
independent projection delivery acknowledgements; they are not separate model execution owners.
Their existing materializers retain authority over permission checks, CAS, applied-job markers and
learning notifications. This avoids introducing a transaction spanning both Memory authorities.
The shared Session is the durable authority for the source snapshot, Mission attachment, staged
work, read coverage, completed type receipts and model continuation budget. A cross-process
coordinator lock covers only selection and claim preparation. Contending Hosts skip a busy admission
without reporting a Module failure; no global lock is held during model execution. Per-source leases
renew during an active extraction without changing claim fences, preventing another Host from
recovering a healthy long-running conversation.
Both unfinished deliveries must be due and successfully prepared before model admission. A delayed
or attention-blocked companion does not block unrelated conversations. If preparation fails after
the other claim was reserved, that unadmitted claim is released without consuming an attempt.

The Desktop presents one logical task per source conversation and watermark, including historical
jobs. Both types decide independently whether to retain or skip. Each successful `finish_extraction`
names its type and commits that type's immutable receipt before the Host materializes it. A failed
other type cannot discard completed Memory. Completed receipts can be settled without a model.
Whole-task completion requires all requested types to have a durable decision. Completed-history
retention counts the pair as one task; a completed half of unfinished work is protected from pruning.

Evidence has one stable handle directory. Per-type capture/consent restrictions remain attached to
each passage and are enforced on candidate references. Shared existing-Memory discovery uses the
intersection of the participating source scopes, never the system Curator identity. Existing fact
replacement, revision, recall and direct-user-evidence requirements remain authoritative.

Correctable tool errors are repaired through their tool responses. If a terminal turn omits a
receipt or reports an explicitly retryable Runtime failure, the Host appends a short repair prompt
to the original Mission. The shared Local Host application admits it into the original ExpertSession
and owned Native Runtime Context; it refuses environment changes requiring a successor Session.
An explicit Native snapshot is required before continuing. The completion observer follows the
new command's execution id, rather than mistaking the previous terminal execution for its result.

At most three automatic continuation prompts are reserved, five seconds apart. Reservations,
prompt text, deterministic UUID request ids and acknowledgement state are durable. An uncertain
submission reuses the same command id. Manual retry increments a durable generation before
resetting the three-prompt allowance, so it cannot replay the previous generation's commands.
An uncertain pending command keeps its original reservation across manual continuation until its
receipt is reconciled. Cached Native tools resolve the current claim and permission guards on each
call rather than retaining closures from the preceding admission.
Source-sized call and delivery budgets (at least 64 calls / 32,000 tokens, capped at 256,000 delivered
tokens and constrained by the Runtime context window) are shared across automatic continuations and are
not reset by reopening the Session. Correction/error responses consume the same delivered-token
budget and are bounded by its remaining allowance. Exhaustion requests Native interruption once
and parks unfinished types with a stable budget code. Already committed results remain valid.
Already staged work and source-read coverage remain available.

Cancellation, exhausted budgets, missing Native state, an unknown billing outcome and non-retryable
failures require attention. They never authorize a fresh model conversation. A pending idempotent
continuation reservation can be recovered after restart; an unconfirmed in-flight turn cannot.
Manual continuation preserves the original conversation. It can follow a cancelled or non-retryable
terminal turn once the user explicitly continues it, but
still requires the original owned Native snapshot. Automatic continuation never revives these turns.
The separate explicit restart action
clears unfinished receipts/staging, read progress and the Mission attachment, while preserving
completed published Memory. Knowledge and Skill revision retry policies are unchanged.
Restart and abandonment first archive the old transcript and retire its Mission through the shared
deletion owner graph; uncertain Native teardown blocks a new admission. Restart creates a fresh
snapshot containing only unfinished types, so completed private evidence is not reintroduced.

## Storage upgrade

The existing `curator-sessions-v1.sqlite` path is retained. SQLite user version and row schema become
2, using a static adjacent v1-to-v2 migration under the existing aggregate file lock. An immutable
SQLite backup precedes the atomic migration transaction. The migration preserves staged candidates,
read ranges, original snapshots, completed receipts and Mission links. A bound historical Session
without a receipt is treated as previously admitted, not as permission to create another Mission.
Legacy unfinished admissions require explicit inspection/restart before entering the shared path.

Desktop run archives upgrade from v1 to v2 on access, adding the continuation count and the
conversation task kind. Reads use a file lock, immutable v1 backup and atomic replacement; an
interrupted replacement can be replayed from the unchanged original. Future versions fail closed.
No Project/Revision scan or startup-wide storage maintenance is introduced. Episode and Fact
authority record schemas and their existing upgrade chains are unchanged.

## Verification

Historical fixtures were written by the pre-change writers at
`de7aa331350e2439e5f5e23adfeef4559c33ecd1`; all fixture content is synthetic. Tests cover independent
decisions, partial delivery, duplicate continuation admission, budget persistence, source-scope
restrictions, migration rollback/replay, current-version no-op and future-version refusal.
The Host kernel test releases and restores a real Core Session with a test Runtime driver, checks
Native identity, and verifies that duplicate requests do not dispatch another turn. A real
two-turn Codex provider smoke also passed after Runtime refresh: the Native Context, system Session
and provider Session identities remained unchanged, and the second prompt recalled a marker supplied
only in the first turn. This validates Native continuation, not the full Curator provider tool flow.
A measured Usage comparison remains release validation; these tests do not establish provider billing
savings. Native continuation can still charge for earlier context.

## Local Host convergence follow-up

Move the Desktop `runCuratorMission` continuation loop, Runtime selection, transcript/archive
lifecycle and Mission cleanup behind Local Host built-in executor ports. Desktop should supply
platform resources and UI adapters; CLI and Linux headless execution should reuse the same Mission
application and execution owner, without another consumer or retry implementation. This follow-up
requires shared-kernel tests covering continuation, cancellation, archive failure and restart from
both Host compositions. It is not required for the current retrieval and admission fixes.
