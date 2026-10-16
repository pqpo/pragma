# Memory extraction execution and retry boundaries

## Shared conversation extraction

See [ADR 073](../adr/073-shared-conversation-memory-extraction.md). Desktop prepares Episodic and
Semantic deliveries together and admits one Curator Mission for the same conversation/watermark.
The model reads a shared evidence directory and calls `finish_extraction` separately with
`type=episodic` and `type=semantic`. Either type can retain or skip. Each validated receipt can be
materialized immediately; the other type continues without regenerating completed work.
Per-type source permissions still restrict candidate citations, and historical Memory discovery
uses the intersection of the participating source scopes.

A terminal missing receipt or explicitly retryable Runtime failure allows up to three repair
prompts, five seconds apart, in the original Mission/ExpertSession/Native Runtime Context. The
Host sends only pending-type/error guidance, preserving read ranges, candidates and completed
receipts. Automatic continuations share the 64-call and 32,000-delivered-token limits. Reservations,
deterministic command UUIDs, retry generations and pending prompt text survive restart. Only a
reserved idempotent continuation can resume automatically; unknown in-flight work parks for
inspection. The terminal observer follows the continuation's execution id. Runtime loss, cancellation,
budget exhaustion and non-retryable failures never create a new conversation automatically.

The UI groups both delivery records into one task, exposes both outcomes and the continuation
count, and distinguishes continuation from an explicit fresh restart. Restart regenerates only
unfinished types and preserves published Memory. Completed-history limits count the logical task,
and do not evict a successful half while its companion remains unfinished. Module delivery
counters are not a count of fresh model conversations. The shared Session owns model admission.

The existing Session database upgrades lazily to SQLite version 2 and
`pragma.memory-curator-session/v2`; its existing filename is retained. Desktop run archives upgrade
on access to `pragma.desktop-memory-extraction-run/v2`. Both upgrades preserve backups and reject
future versions. Authority Fact/Episode schemas remain unchanged.

Memory Curator runs as a hidden `system-memory` Mission. The public Mission chat, state and context
window methods reject this origin. Main-process Memory consumers use
`LocalHostMissionApplication.getInternalConversationSnapshot`, which checks the system origin and reuses the same
chat projection without opening public Mission IPC access.

Knowledge and Skill revision jobs allow three automatic retries after the initial attempt (four total execution
attempts), with a fixed five-second delay after each retryable failure. Their job stores
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
`needs_attention` and retains the original Mission. A terminal retryable model failure can start another extraction within the persisted job budget. Candidate validation errors are returned through tools for same-execution repair.

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
before extractor admission withdraws only the current claim reservation from `attempts` and
`totalAttempts`, preserving all earlier model admissions. Exhaustion is checked against the refunded
count, so an unadmitted fourth claim can return to waiting without exhausting the budget. This proof
is tracked by the current process using the claim’s controller, excluded from local-only durable
result recovery, and removed at model admission or completion. It is never persisted or assumed
during restart recovery.

Curator archives the original transcript before deleting a successful temporary Mission. Failed
reads, missing output, archive failures and uncertain executions retain their Mission for
inspection within the existing 30-day job retention window. Reading that retained transcript never
starts a model. Failed-run inspection prefers the retained live transcript when available, with the
archived transcript as a fallback. Candidate submission failures remain visible in the tool transcript.

Completed extraction task history retains the newest 50 jobs across Episodic, Semantic, Knowledge
and Skill modules combined, ordered by update time and a stable module/job tie breaker. Completed
jobs have no age-based expiry. The Host applies this limit after delivery and background extraction,
and during storage maintenance. Pruning removes only completed job records and their failure
diagnostics; published memories, knowledge and skills remain unchanged. Pending, running and
needs-attention work does not count toward the limit.

Cache hits, model-catalog validation and routine chat reads are debug diagnostics. Failures and
meaningful execution lifecycle transitions remain visible at normal logging levels.

## Tool-driven extraction

See [ADR 072](../adr/072-tool-driven-memory-extraction.md). Curator Missions receive a short task and dedicated tools, not an inline Evidence JSON dump. Evidence is listed and read using task-scoped handles and bounded plain-text pages. Candidates are submitted individually; `finish_extraction` persists a validated receipt before returning success. Assistant chat text is only a transcript.

Argument validation and correctable evidence/reference errors include explicit correction guidance.
The Curator repairs those calls within the same execution and its existing call/context budgets;
successful staged parts remain available, and corrections reuse candidate handles. A failed
`finish_extraction` must be repaired before the Agent claims completion. Permission, stale-claim,
capacity and budget failures do not invite repeated tool calls. After evidence-delivery budget
exhaustion, already read Evidence may still support staging missing candidates and finishing once;
call-budget exhaustion permits only finishing already staged work. Unread evidence or an incomplete
result instead requires reporting the budget failure, not rejecting the source as low-value. No additional execution retry loop
is introduced: outer job retries remain for retryable execution failures, and an execution that ends
without a durable receipt remains non-retryable automatically.

The receipt and snapshot live in `state/memory/curator-sessions-v1.sqlite` (database version 2). Module recovery reads receipts before admitting any model execution. Retained outputs still go through the existing Module transaction and applied-job marker. Transcript reads are archive operations; an unreadable transcript cannot invalidate a durable extraction receipt or authorize another model call. The original Mission remains available when its transcript could not be archived.

### Existing Memory discovery and reconciliation

`find_existing_memory` accepts a natural-language `query`, `mode` (`hybrid` by default,
`keyword`, or `vector`), `type` (`all` by default, `semantic`, or `episodic`), and `limit`
(default 10, maximum 20). Hybrid search uses the same Host embedding service, index generation,
query cache and limiter as Context Store search; both paths share reciprocal-rank fusion.
Keyword matching uses Memory projection text rather than internal record JSON. Responses name
the actual retrieval mode, match sources and any vector-unavailability reason. Hybrid mode can
continue with keywords; explicit vector mode reports a stable error instead of claiming a
successful empty search. Results are ranked candidates, never an exhaustive conflict check.

Pass a returned `memory` handle and optional character `cursor` to read complete Memory text.
Semantic handles can also be used as `submit_fact.property` or `replaces`. They contain the Memory
type, identity and revision and are checked against current authority on every read and replacement;
they never grant access. Historical Episodes are untrusted background, not new Evidence or authority
for a fact replacement. Source-task subject restrictions, recall policy snapshots and live policies
apply to discovery as well as reading. Revoked, expired, invalidated, deleted or revised records cannot
be recovered from vector excerpts or old handles. Records with `sensitivity=restricted` are excluded
from search, enumeration and handle reads, matching the Context Store projection boundary.

`list_existing_memory` provides complete scoped enumeration, independent of relevance scores and
hot-memory selection. `directory=properties` lists open predicates, subject aliases, fact counts,
conflict modes and illustrative statements; `facts` accepts an exact `property` name and optional
`subject` alias; `episodes` accepts an optional `conversation` ID. Follow `pageCursor` until `end`.
Pages contain at most 20 entries and respect the 2,000-token response budget, advancing only past
emitted entries. Cursors bind the extraction, scope, filters and record-revision snapshot; changed
snapshots return `memory_curator_cursor_stale`, requiring a new enumeration rather than a new
extraction. Property discovery encourages reuse but does not invent definitions, merge synonyms or
rewrite existing facts. Before delivery, each emitted entry and every fact contributing to an emitted
property aggregate is checked again against current authority; stale entries require restarting the listing.

The Curator searches first, discovers existing properties when needed, then lists all facts for the
same subjects and exact property before submitting a new or replacement fact. Existing duplicate,
conflict and authoritative replacement rules remain unchanged. Vector requests reserve the existing
call budget before network I/O, run outside the shared Session lock, and revalidate results before
delivery. Enumeration and new handles do not populate the legacy 100-fact Session cache. Existing
`fN`/`pN` aliases, empty-query previous-Episode/staged-work reads and character cursors remain
supported; persisted Session, Evidence and Memory schemas are unchanged.

Fact lookup, merge and replacement use the source task's authorization, including restricted principals and expiry. Every tool call checks the claim and cancellation signal. Budget failures and incomplete retained evidence park the job with a stable code; they are never reported as generated Memory or a completed low-value rejection.

Tool content is never inlined into Mission goals, even for small snapshots. Session authorization is
checked before `startRun`, again when resolving the Curator capability source, on each tool call,
and before materialization. `read_evidence` batches adjacent passages within the 2,000-token response
budget, with both a next-evidence handle and a character cursor. Property handles revalidate their
Fact before use. Terminal diagnostic reads share the bounded same-Mission read retry; the receipt
is updated with `responseModel` when supplied and completion time before the Module consumes it.
Runtime diagnostics are supplementary: after bounded read retries, failure records a warning,
retains the existing provenance fields, and still applies the Mission completion time. It cannot
invalidate a durable receipt, fail the extraction job, or authorize another model admission.
Cancellation remains effective during diagnostic reads.
