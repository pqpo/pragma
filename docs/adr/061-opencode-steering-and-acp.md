# ADR 061: OpenCode steering and ACP decision

## Status

Accepted

## Context

Pragma sends Mission messages into its FIFO queue before offering Steer. A failed
steer must preserve that item when non-delivery is known. Unknown delivery cannot
be retried automatically because the native agent may already have consumed it.
OpenCode 2.0.16 exposes native synthetic steering through its SDK, whereas stock
ACP does not provide active injection or equivalent native question/form bridging.

## Decision

Keep the existing versioned SDK/private `opencode serve` adapter. Expose steering
only after a 2.x availability probe; 1.x retains normal prompt and queue execution.
Declare 2.x steering Degraded pending authenticated provider-backed acceptance.
Do not introduce an ACP and SDK hybrid transport or switch to ACP in this change.

Bind steering to the open Pragma Execution. Native model-step completion does not
close the Pragma admission window. Use `session.synthetic` with `delivery: steer`
and `resume: true`; wait for in-flight admissions and awakened native steps before
closing that window. Once closed, reject before native admission. Sum reported
usage over all new native assistant steps, with Core's shared token counter for
missing reports.

Derive the native message ID from Session, target Execution, queue request and
attempt. Attach a strict version-one provenance marker. Preserve the queued item
and its order on explicit non-delivery. Pause the entire queue on uncertain
admission, and stop the private server before any subsequent prompt. Strict steer
fallback also requires explicit non-delivery; a generic error cannot trigger it.

Checking delivery restores the original owned native Session. Matching history
confirms delivery. Cancelling a matching pending item and confirming that it did
not enter history permits default queued execution. Mere absence does not prove
non-delivery after Host death, since an orphaned server may still finish admission.
Unknown marker versions and failed reads remain uncertain. Resume and take-back
cannot bypass this check; checks never submit another native steer.

## Persistence

Reuse the existing durable PromptRequest deliveryAttempt and aggregate transaction
journal. No storage version, owner identity or native Session reference changes,
and no historical data conversion is needed. Native metadata is a new namespaced
marker validated with a Runtime-local Schema; future marker versions fail closed.

## Verification and consequences

Real OpenCode 1.18.33 and 2.0.16 adapter tests use isolated homes and a local
simulated model. They cover active admission, admission during native settlement,
a dropped successful HTTP acknowledgement, restored receipt lookup, pending
cancellation, end-target rejection, no next-prompt replay, and multi-step reported
usage. Core tests cover queue rollback, scheduler fencing, uncertain-delivery
reconciliation and crash recovery; Host/UI tests cover paused state and action
availability. See the [Runtime record](../architecture/opencode-runtime.md).

An absent receipt after a crash may keep a queue paused indefinitely; this is
preferable to replaying a possibly executed instruction. Stronger orphan-process
ownership and native cancellation tombstones would be needed to prove absence
safe in every crash window. ACP migration can be reconsidered after equivalent
active injection and native interaction support are verifiably available.
