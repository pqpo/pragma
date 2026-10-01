# Memory extraction execution and retry boundaries

Memory Curator runs as a hidden `system-memory` Mission. The public Mission chat, state and context
window methods reject this origin. Main-process Memory consumers use
`MissionRunner.getInternalConversationSnapshot`, which checks the system origin and reuses the same
chat projection without opening public Mission IPC access.

Extraction jobs allow three automatic retries after the initial attempt (four total execution
attempts), with a fixed five-second delay after each retryable failure. All four Memory job stores
persist the attempt counter and retry deadline. Claiming, configuration wakeups, conversation
lifecycle refreshes and process restarts cannot reset or bypass an exhausted budget. The explicit
manual retry action resets the budget; genuinely new Evidence can create new eligible work.
Cancelled executions never automatically replay, including when Runtime diagnostics mark an error
retryable. Runtime-provided non-retryable failures and configuration/capacity failures still require inspection
or a configuration change rather than repeatedly executing an unchanged request.

A completed Curator execution is read at most four times, with five seconds between failures.
Transient transcript failures, missing output and diagnostic-read failures retry the same Mission;
they never rerun a successful model, even if the local exception carries `retryable=true`. Successful reads are reused during archiving, so archive
collection does not add an extra read after exhaustion. If reads remain unavailable, the job enters
`needs_attention` and retains the original Mission. A terminal retryable model failure or invalid
structured output can start another extraction within the persisted job budget.

An expired running lease remains an unknown billing outcome. Recovery parks it for inspection
unless existing durable Episodic/Semantic results prove it can settle locally without another model
call. This local recovery remains available at the attempt limit and does not consume another model
attempt. The returned claim carries a same-process `localRecoveryOnly` admission constraint,
separated from the persisted job before store mutations. If the durable result is no longer readable
when settling, the module parks the job rather than falling back to model execution. It must not start concurrent or duplicate model work while the previous outcome is unknown.
With multiple revision targets, configuration failure after any planner admission remains guarded
against automatic configuration wakeup; other transient failures share the same bounded job budget.

Conversation completion notifications preserve in-flight work and completed/rejected jobs.
Active conversation notifications still defer failed pending work until the normal idle deadline,
while preserving its attempts. Completion can release that idle wait but cannot bypass the five-second
failure backoff. Activity that cancels an admitted extraction parks its existing claim. Same-process cancellation
before extractor admission may safely reschedule local preflight; this proof is never persisted or
assumed during restart recovery.

Curator archives the original transcript before deleting a successful temporary Mission. Failed
reads, missing output, archive failures and uncertain executions retain their Mission for
inspection within the existing 30-day job retention window. Reading that retained transcript never
starts a model. Failed-run inspection prefers the retained live transcript when available, with the
archived transcript as a fallback. Structured-output parse failures retain the raw transcript in the run archive.

Cache hits, model-catalog validation and routine chat reads are debug diagnostics. Failures and
meaningful execution lifecycle transitions remain visible at normal logging levels.
