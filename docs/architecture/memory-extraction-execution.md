# Memory extraction execution and retry boundaries

## Shared conversation extraction

New tool-contract-2 Curator tasks use prompt version 11. The Curator judges actual task complexity
from read Evidence: simple tasks and trivial interactions are skipped; relatively complex tasks with
substantive work and a meaningful outcome may be retained as concise task history. A generalizable
lesson or membership in a predefined task category is not required. Reasoning, investigation,
coordination, implementation and validation are contextual signals, not a checklist. Task labels,
transcript length, tool-call counts and completion alone do not determine complexity. For example,
a simple tool smoke test usually needs no episode, while substantial testing can merit one.
Complexity and retention are the Curator's model judgment; the Host does not reject episodes by
message length or tool presence. Evidence access and sensitivity guards still apply before model
admission. Existing Episode records are unchanged. Semantic decisions remain independent; a one-time test response or language
choice does not establish a stable preference.

See [ADR 073](../adr/073-shared-conversation-memory-extraction.md). Desktop prepares Episodic and
Semantic deliveries together and admits one Curator Mission for the same conversation/watermark.
New conversations use tool contract 2: the model reads shared evidence and saves independent decisions
with `finish_episodic_extraction`, `finish_semantic_extraction`, or `skip_extraction`. Each validated receipt can be
materialized immediately; the other type continues without regenerating completed work.
Per-type source permissions still restrict candidate citations, and historical Memory discovery
uses the intersection of the participating source scopes. The global admission lock ends before
model execution. Active per-source leases renew without changing their claim fences; another Host
skips a busy admission without degrading the Module.

A terminal missing receipt or explicitly retryable Runtime failure allows up to three repair
prompts, five seconds apart, in the original Mission/ExpertSession/Native Runtime Context. The
Host sends only pending-type/error guidance, preserving read ranges, candidates and completed
receipts. Automatic continuations share a source-sized budget: at least 64 calls and 32,000 delivered
tokens, with room for one complete traversal plus discovery/corrections, capped at 256,000 delivered
tokens and tightened by the Runtime context window. Reopening never resets consumed counters. Reservations,
deterministic command UUIDs, retry generations and pending prompt text survive restart. Only a
reserved idempotent continuation can resume automatically; unknown in-flight work parks for
inspection. The terminal observer follows the continuation's execution id. Runtime loss, cancellation,
budget exhaustion and non-retryable failures never create a new conversation automatically.

The task board aggregates lightweight source-job metadata in SQLite, applies lane/cursor/limit in
the database, and parses full job records only for the selected page. Task details use point reads.

Learning-task cards use content topics as titles, with the source resource name and creation time
as secondary information. Source topics are captured when scheduling; validated plans replace
them with the proposed knowledge/Skill names. The disposable
`cache/memory/task-presentations-v1.sqlite` catalog is keyed by module, job ID and source digest,
holds at most 100 snapshots, and bounds each snapshot to 100 titles of at most 160 UTF-16 units.
It never authorizes execution or recovery. Cache failure, eviction or missing historical metadata
falls back to the localized task kind and immutable creation time, without querying current
Memory to invent a historical title. The card limits titles to two lines and shows one aggregate
result; per-type outcomes remain available in task details.

The UI groups both delivery records into one task, exposes both outcomes and the continuation
count, and distinguishes continuation from an explicit fresh restart. Restart regenerates only
unfinished types and preserves published Memory. Completed-history limits count the logical task,
and do not evict a successful half while its companion remains unfinished. Module delivery
counters are not a count of fresh model conversations. The shared Session owns model admission.

Conversation retry and fresh restart now commit through one bounded
`state/memory/conversation-retry-v1.json` journal under the same lock as conversation admission.
The journal pins the source watermarks, job revisions and pre-retry Session generations. Recovery
runs before the next claim, completes partially written deliveries and does not increment a Session
retry generation twice. New source snapshots and newer delivery transitions supersede old retry
intent, including lifecycle updates and later failure/cancellation; recovery never overwrites them.
Backwards revisions and future journal formats fail closed. This is a new journal namespace; existing Session/job database
formats and their migration chains are unchanged.

Local Host marks first-run readiness/compilation failures with process-local proof that Native
execution has not started. This proof belongs to one Mission and can be consumed only once, so
reusing an Error cannot withdraw another Mission's admission. Curator withdraws its persisted
admission only with this proof, allowing
the repaired task to start in its original Mission. Missing projections, matching error messages
and unknown failures are not proof, and continue to block potentially billable replay.

The existing Session database upgrades lazily through SQLite versions 1 → 2 → 3 to
`pragma.memory-curator-session/v3`; its existing filename is retained. The aggregate records
`toolContractVersion`. Migrated sessions retain contract 1, original tools/DSL and Native conversation;
new sessions and explicitly restarted generations use contract 2. Read ranges, staged candidates,
receipts, original provenance and pending continuation commands survive migration. Desktop run archives upgrade
on access to `pragma.desktop-memory-extraction-run/v2`. Both upgrades preserve backups and reject
future versions. Authority Fact/Episode schemas remain unchanged.

Memory Curator runs as a hidden `system-memory` Mission. The public Mission chat, state and context
window methods reject this origin. Main-process Memory consumers use
`LocalHostMissionApplication.getInternalConversationSnapshot`, which checks the system origin and reuses the same
chat projection without opening public Mission IPC access.

The execution Evidence adapter also excludes unattended Knowledge/Skill revision planning.
Desktop and CLI check the immutable Mission origin in the delivery admission link at their shared
Local Host capture entry, rather than excluding all uses of the revision Agents. Interactive
revision tasks remain eligible for capture. If the link has not arrived or cannot be read, the
adapter preserves a reference in the new `capture-deferred-v1.sqlite` namespace before advancing
its checkpoint. The bounded queue rotates replay pages across restarts and pins canonical retention
until replay succeeds or source-owner deletion removes the event. It never stores a second copy of
the raw transcript or evicts unresolved entries. Other capture and background extraction continue.
Health reports the adapter module as degraded with `memory_execution_origin_unavailable` while
references remain pending; internal work never receives invented user/project subjects.
The existing Curator exclusion remains in place. This changes future capture only; previously
created extraction jobs and published Memory are preserved.

Knowledge/Skill planning is unattended. Before Interpreter compilation, the Host removes revision
capabilities and applies an explicit `askUserQuestion` denial, covering
Core default tools on first execution, corrections and manual retries. Ordinary interactive revision
Agents retain their question tools. The Host also declines native Runtime questions and approvals
through its automatic interaction handler, before entering a durable human-input wait; these native
requests do not pass through managed tool filtering. Planning uses only supplied Memory projections and target lists;
missing evidence yields `skip` without asking for confirmation. Runtime, read and tool failures keep
their failure handling and must not be disguised as insufficient evidence.

Knowledge/Skill planning declares the complete output constraints before admission. Invalid JSON or
plan Schema errors allow at most two correction turns, five seconds apart, in the same Mission,
ExpertSession and owned Native Runtime Context. Each continuation observes its own execution ID;
cancellation and Runtime failures stop correction. Exhausted correction is nonretryable rather than
starting a fresh planning Mission automatically. Successful result reads retry at most four times,
five seconds apart, without admitting another model. Only non-streaming assistant output belonging
to the observed execution is eligible. Unavailable terminal observations, diagnostics or exhausted
result reads are nonretryable; cancellation is checked again after reading and before Skill submission.
Skill planning also validates citations, per-change evidence thresholds, distinct keys and target ownership
inside those same correction turns. Each Skill requires at least one succeeded Episode, regardless
of salience score, with exact distinct citations and current target versions. After business
correction exhaustion, the Host submits only qualifying changes; if none qualify, the job completes
as rejected (no Skill extracted). This is a normal learning outcome and does not enter needs-attention
or start another planning Mission. Final rejected-change diagnostics are passed back to the Memory
module before the planning Mission is removed, and committed atomically with completion to the
existing failure-attempt history, including when other changes are retained. Runtime, cancellation, unreadable output and submission failures
retain their existing failure handling. Description limits remain unchanged. Skill descriptions are discovery summaries: before Schema
validation, the Desktop planner bounds oversized model-authored summaries to 500 UTF-16 units,
preferably at a sentence boundary and without splitting surrogate pairs. This local repair consumes
no additional model turn. Citations, target identity and all other validation remain unchanged;
the revision Agent receives complete cited Memory bodies in its task input. Stored plans
continue to use the existing strict Schema. Historical attention jobs whose complete diagnostics
prove that every issue was an oversized Skill description may resume through normal claims within
the remaining attempt budget. Mixed, truncated or unrelated diagnostics and exhausted jobs remain
parked; recovery preserves failure history and never resets consumed attempts. When historical
records have no failure-attempt entry, recovery saves their last diagnostic and requeues the job
in one SQLite transaction.

The Skill learning database upgrades lazily from version 4 to 5 with a locked, backed-up SQLite
transaction. Historical pending/needs-attention jobs whose last error is exactly
`skill_learning_plan_invalid` or `skill_learning_plan_duplicate_key` complete as rejected without
model replay. Consumed attempts and failure-attempt diagnostics remain available; unrelated failures
and running claims are unchanged. When an older job has no failure-attempt entry, migration preserves
its last structured diagnostic (or legacy error text) there before clearing active error fields.
Interrupted settlement rolls back and replays on the next open.

Source admission now separates evidence from value: one succeeded Episode can support a Skill
proposal regardless of salience score. Knowledge plans explicitly select supplied target IDs and
source revisions, explain the delta, and use stricter maturity gates for creation. Existing targets
include ordinary editable assets and outstanding Memory drafts, with mounted assets preferred.
Read-only JSON inspection continuations page/search catalogs and read complete selected documents
in the same planning Mission (128 requests, 8 MiB of delivered bytes); they are distinct from the two
invalid-output correction turns. Exhaustion is nonretryable, not a skip. Revision descriptions retain
their existing length limits.

Checking existing assets, preferring reuse, reading complete cited sources and understanding target
content before revision are prompt requirements. The prompt requires verification, outcomes,
limitations and contradictory evidence to be read before citation; titles and partial excerpts are
insufficient. Plan acceptance does not require source/target inspection records, catalog traversal
or document/file read coverage. Source authorization and exact source revisions remain mandatory,
as do target identity/version, pending-review and submission conflict checks. Inspection request
and delivery budgets still bound resource usage.

Knowledge and Skill sinks check outstanding work for the selected targets after planning and again
under the submission lock. Validated plans waiting on a revision are cached against effective input
and target versions, so dependency wakes need not admit the planner again.
Skill occupancy is checked only for the selected plan targets, after planning and again when submitting;
an unrelated pending Skill must not block independent work for the same expert.
A same-process preflight wait refunds only its current, unadmitted claim; earlier model attempts remain counted.
The task board classifies `memory_revision_pending` as a dependency, including historical records
marked as configuration failures. Dependency copy covers both missing context and outstanding
revision review. A settled revision wakes only `memory_revision_pending` dependency waits, including historical waits
marked nonretryable. This targeted wake preserves consumed attempts and cannot revive exhausted jobs,
Runtime failures or cancellations. General configuration wakeups keep their existing retry guards.
Settlement wakes are awaited before clearing durable revision-pending bindings, including when
the same reconciliation also follows superseded Skill revisions. A failed wake or
interrupted binding write therefore replays on reconciliation. The first reconciliation callback in
each process also recovers historical missed wakes once, including when settlement already committed.

Knowledge and Skill revision jobs allow three automatic retries after the initial attempt (four total execution
attempts), with a fixed five-second delay after each retryable failure. Their job stores
persist the attempt counter and retry deadline. Claiming, configuration wakeups, conversation
lifecycle refreshes and process restarts cannot reset or bypass an exhausted budget. The explicit
manual retry action resets the budget; genuinely new Evidence can create new eligible work.
Cancelled executions never automatically replay, including when Runtime diagnostics mark an error
retryable. Runtime-provided non-retryable failures and configuration/capacity failures still require inspection
or a configuration change rather than repeatedly executing an unchanged request.

An observation timeout (`memory_curator_timeout`, including historical
`memory_curator_result_unavailable` records whose message is exactly that timeout) returns a
conversation delivery to the waiting queue. Its persisted, admitted shared Session must still
identify the original Mission; missing ownership proof never authorizes a fresh model call.
After five seconds, the scheduler reads that same Mission once and returns still-running work to
the queue, without re-entering the ten-minute terminal wait. This read does not require the current
Runtime configuration or a newly published project. It observes the Mission without incrementing delivery
attempts, resetting continuation budgets or reserving a continuation while the original turn is
running. The original tool binding remains usable between observations. Late receipts settle
locally and terminal reconciliation archives and releases the retained binding. A successful turn
with missing receipts may continue only its unfinished types in the original Session under the
existing three-continuation limit. Cancellation and nonretryable terminal failures stop recovery.
Historical attention tasks with this exact timeout and ownership proof are checked through normal
claims; this recovery does not bulk rewrite data or reset exhausted model budgets. The task board
shows automatic recovery and the next observation time. Retirement and confirmed deletion revoke
retained bindings. Reconciliation checks durable Session ownership, isolates failures per Mission,
and participates in the coordinator’s shared in-flight promise. Startup orphan recovery can also
archive late durable receipts without another model call. Standalone legacy per-type executions
retain their nonretryable timeout handling because they lack shared-session observation ownership.

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
Active conversation notifications defer pending work until six hours of inactivity while preserving
attempts. Completing a conversation schedules both Episodic and Semantic extraction after a separate
ten-minute grace period, measured from the later of completion and source Evidence time. The two
thresholds are defined independently in `conversation-extraction-schedule.ts`; they are currently
code policy, not user-editable settings. Repeated completion/reconciliation preserves the durable
deadline, including across restart. Existing stored deadlines are not rewritten at startup. Completion
cannot bypass the five-second failure backoff. Deleting a Mission during the grace period removes
its pending extraction and Evidence through the existing owner cleanup; replay cannot recreate it.
An explicit expedite action remains available to bypass the wait. Activity that cancels an admitted
extraction parks its existing claim. Same-process cancellation
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

## Incremental learning state

[ADR 075](../adr/075-incremental-memory-learning.md) replaces per-Expert knowledge sinks and
repeated-Episode Skill admission. Episodic data upgrades 5 → 6 with a transactional, coalesced root
notification outbox and monotonic generations. It preserves captured learning denial and replays
failed delivery after restart; Semantic projection notifications and Episodic notifications wake both
learning consumers. Governance and provenance changes participate in the source fingerprints.

`state/memory-learning-revisions/bindings.json` upgrades v1 → v2 under its aggregate lock with an
atomic migration journal and retained original backup. Existing pending revisions and mounted assets
survive; knowledge bindings now permit multiple targets per Expert and multiple Experts per target.
Each learning Module owns `learning-decisions-v1.sqlite` under its module state root, recording
versioned decisions and validated pending plans. Effective-content fingerprints suppress duplicate
model work and proposals independently of the prunable task history. These records are not published
knowledge and cannot bypass revision review or target-version checks.

## Tool-driven extraction

See [ADR 072](../adr/072-tool-driven-memory-extraction.md). Curator Missions receive a short task and dedicated tools, not an inline Evidence JSON dump. Evidence is listed and read using task-scoped handles and bounded plain-text pages. Candidates are submitted individually; each finish/skip tool persists a validated receipt before returning success. Assistant chat text is only a transcript.

Argument validation and correctable evidence/reference errors include explicit correction guidance.
The Curator repairs those calls within the same execution and its existing call/context budgets;
successful staged parts remain available, and corrections reuse candidate handles. A failed
finish/skip call must be repaired before the Agent claims completion. Permission, stale-claim,
capacity and budget failures do not invite repeated tool calls. Correction/error text also consumes
and respects the delivered-token budget. When no correction response fits, tools throw the stable
budget error and the Host requests Native interruption once, preserving completed type receipts.

The Session layer can still validate already staged work locally, but it does not deliver unlimited
stop guidance or authorize another model turn. Unread evidence or an incomplete result requires
attention with the budget failure, not rejection of the source as low-value. Shared conversation
continuation follows the bounded rules above; Knowledge/Skill outer retries retain their own policy.

Tool contract 2 has twelve tools: `list_evidence`, `read_evidence`, `find_existing_memory`,
`read_existing_memory`, `list_existing_memory`, `get_extraction_status`, `read_staged_candidate`,
`submit_fact`, `submit_episode_part`, `finish_semantic_extraction`,
`finish_episodic_extraction`, and `skip_extraction`. Only mutation tools for requested types are exposed.

`read_evidence({})` resumes the first unread character and batches adjacent passages. Directory
navigation is optional. Every response includes a model-visible `Feedback:` JSON header validated
by `MemoryExtractionFeedbackSchema`, followed by readable text. The header provides status,
authoritative progress, and an executable `nextCall` only when its arguments are known. Responses
including errors, staging acknowledgements and final receipts consume the delivered-token budget.
The total reserves 1,024 tokens for correction/staging/finalization; each pending type owns 256
tokens within it for its bounded finish acknowledgement. Staging, error feedback and duplicate
finishes cannot consume another pending type's allocation. Each saved receipt releases only its
own allocation, including after reopening the Session. Every response is at most 2,000 tokens.
When a pending type has complete read coverage and staged work, budget feedback permits
finishing it within that reserve (`nextCall` is supplied for Semantic finish). Incomplete source or
staged work remains blocked. Exhaustion never produces a skip decision.

`submit_fact` requires separate scalar `predicate` and `conflictMode`; contract 2 has no `property`
argument. Subjects advertise the exact task alias enum. `submit_episode_part` remains one tool with
five branches: goal/summary require `text`, attempt requires `description`, recovery requires
`failure`, and outcome requires `status` plus `summary`. Provider-facing schemas have object roots;
authoritative branch validation remains in Memory. Error feedback includes required fields and
branch examples, never invented source facts. `get_extraction_status` enumerates all pending
candidates, and `read_staged_candidate` returns complete editable arguments over bounded pages.
Fact/attempt/recovery edits reuse the candidate handle; goal/summary/outcome overwrite that part.
Semantic finish takes `{}`, Episodic finish takes `language` and `valueScore`. `skip_extraction`
uses type-independent reasons: `no-supported-memory`, `insufficient-evidence`, or `sensitive`.
The adapter maps those to existing per-module authority outputs.

The snapshot and receipts live in `state/memory/curator-sessions-v1.sqlite` (database version 3).
Module recovery reads receipts before admitting a model. Retained outputs still go through existing
Module transactions and applied-job markers. Transcript failure cannot invalidate a durable receipt
or authorize another model call. Historical contract 1 keeps its original vocabulary and budget
semantics until explicitly restarted; it is a supported recovery boundary, not a new-session option.

### Existing Memory discovery and reconciliation

`find_existing_memory` accepts a natural-language `query`, `mode` (`hybrid` by default,
`keyword`, or `vector`), `type` (`all` by default, `semantic`, or `episodic`), and `limit`
(default 10, maximum 20). Hybrid search uses the same Host embedding service, index generation,
query cache and limiter as Context Store search; both paths share reciprocal-rank fusion.
Keyword matching uses Memory projection text rather than internal record JSON. Authority stores
apply all participating scopes and subject restrictions before the bounded candidate limit. Vector
search receives filtered identity/revision sets and point-reads only ranked candidates; search does
not enumerate and parse the full Memory catalog. Explicit enumeration remains a separate API. Responses name
the actual retrieval mode, match sources and any vector-unavailability reason. Hybrid mode can
continue with keywords; explicit vector mode reports a stable error instead of claiming a
successful empty search. Results are ranked candidates, never an exhaustive conflict check.

Pass a returned `memory` handle and optional character `cursor` to `read_existing_memory` for
complete Memory text. Semantic handles can also be used as `submit_fact.replaces`. They contain the Memory
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
delivery. Enumeration and new handles do not populate the legacy 100-fact Session cache. Contract 1 recovery retains
`fN`/`pN` aliases and its overloaded empty-query/full-read operations. Contract 2 requires a nonempty
search query and separates full Memory reads from staged candidate reads. Evidence and authority
Memory schemas remain unchanged.

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

For shared extraction, terminal provenance is collected for the types completed by each Native
turn, including a successful type in a failed turn. Updating the Session also updates those types'
receipts and supplements the exact Memory revisions already materialized by their Module.
Earlier completed types keep their original turn's model/time; late diagnostics cannot overwrite
newer or governed revisions. This supplements provenance metadata in the current/history copy of
the same revision, without revising Memory content. Authority records update before typed receipts;
failed or uncertain writes retry with the original compare-and-set source. Supplementary update
failures are diagnosed and do not invalidate durable receipts or authorize another model call.

### Real Runtime acceptance

The reproducible Desktop composition probe is `apps/desktop/scripts/verify-memory-curator.mjs`.
It runs the default PI Runtime with real credentials, the built-in tools, conversation coordinator,
authority materialization and receipt recovery in a fresh temporary home per run. It accepts only
explicit Evidence snapshots and optional read-only seed homes; it never writes to production homes.
It does not exercise Electron UI or the complete Mission application entry. Reports distinguish
those limits and positive vector search from the keyword/embedding-disabled cases actually run.

Build the workspace dependencies first. Set `PRAGMA_MODEL_PROVIDER`, `PRAGMA_MODEL_NAME`,
`PRAGMA_MODEL_BASE_API`, `PRAGMA_MODEL_API_KEY` and optional `PRAGMA_MODEL_API` through the
environment or an external env file. A case manifest outside the repository contains:

```json
[
  {
    "name": "short",
    "evidence": "/private/snapshots/short.json",
    "subjects": [{ "type": "pragma.user", "id": "the-source-user" }],
    "exercise": true,
    "injectInvalidEvidence": true
  }
]
```

`evidence` is a JSON array of captured `MemoryEvidenceEnvelope` records. `seedHome` optionally
points to previously materialized Memory; SQLite backup reads it without modifying it. Exercise
mode asks the real Agent to discover/read Memory and inspect/edit staged work; absent branches
remain uncovered. `reserveAfterStaging=true` deliberately leaves only 1,024 tokens after status
inspection, testing control-reserve finalization with the real Agent. Invalid-evidence injection alters only one tool argument, never source content.

```sh
node apps/desktop/scripts/verify-memory-curator.mjs --cases /private/cases.json --env-file /private/model.env --repeat 3
```

The probe writes private call traces and a coverage report under a printed temporary directory.
Do not commit source text, credentials or traces. A successful run requires completed Module jobs,
durable recoverable receipts and one model admission. Injected errors must recover within two
resubmissions; coverage is recorded separately from success.

Acceptance on 2026-10-19 used default PI (`cloud-pi-agent`) and DeepSeek v4 Flash with
embedding disabled. Captured local Evidence was replayed into disposable homes; private source
files and call traces remain outside the repository.

| Case                                                                    | Captured / selected Evidence | Runs completed | Calls per run | Tool errors                              |
| ----------------------------------------------------------------------- | ---------------------------- | -------------- | ------------- | ---------------------------------------- |
| Short conversation                                                      | 56 / 45                      | 3 / 3          | 14, 14, 12    | 0, 0, 0                                  |
| Long conversation                                                       | 570 / 397                    | 3 / 3          | 49, 59, 53    | 0, 2, 0                                  |
| Existing Memory, candidate inspection/edit, invalid-reference injection | 56 / 45                      | 1 / 1          | 26            | 1 injected; repaired by one resubmission |
| Transient request with no lasting information                           | 2 / 2                        | 3 / 3          | 3, 3, 2       | 0; no Memory created                     |

Together these runs exercised all twelve tools and all five episode branches. All observed visible
responses were below 1,400 tokens (the enforced ceiling is 2,000). The long run's two errors were unread citation and premature finish;
the Agent resumed reading and completed both receipts in the same admission. Existing Memory
full reads, staged candidate full reads and correction with the same candidate handle completed.
Completed receipts were reopened without another model admission. Eligibility may reject a type
locally before admission; such a decision correctly has no model receipt and must not be counted
as model-generated Memory. The probe checks recovered receipts for admitted types only.

These are workflow/materialization results, not an extraction-quality benchmark: the short case
retained facts in two runs and skipped facts in one. Positive vector retrieval, other models and
runtimes, the remote machine, Electron UI and the full Mission application entry were not covered
by these real-model runs. Separate automated Desktop/Local Host tests cover their changed wiring.

### Follow-up code review

The implementation review reproduced and corrected six issue classes:

- V2 cursor/candidate metadata was inferred from untrusted body text. Internal operations now
  return structured cursor/candidate fields; v2 never parses presentation text for control data.
  The historical adapter keeps its original footers. Evidence/Memory labels remain intact.
- Reopening a dedicated Semantic/Episodic v2 session reset consumed counters and diagnostics.
  The original reset behavior is now limited to legacy contract 1; v2 resumes retain the budget.
- The legacy advertised property Schema rejected the original object branch. Migrated Native
  conversations again accept that branch through provider-facing validation; v2 keeps flat fields.
- Inherited object names could be mistaken for staged handles or branch examples. Candidate
  membership uses own properties, and malformed `part` values cannot throw during error formatting.
- Snapshot scope comparison treated JSON object-key order as a data change. Resume/recovery compare
  JSON values while preserving array order and rejecting real evidence/subject changes.
- Acceptance counted unrelated or already-parallel submissions as injected-error recovery. It now
  requires the intended invalid-reference failure, matching fact/candidate identity, and a retry
  started after the error returned. Requested injection must actually trigger to pass.

Regression tests cover those reproductions, including the actual historical writer fixture and
provider-facing Schema, raw source labels, authority Memory pagination, persisted counters and
unchanged-versus-changed snapshots. `pnpm --filter @pragma/desktop test:memory-curator-acceptance`
runs the acceptance-verdict tests without a model. The full Desktop test command includes them.
Private real-model verification artifacts remain outside the repository.

PR review additionally reproduced submissions/error feedback consuming the final receipt budget.
Combined Semantic/Episodic regression cases set the limit before staging multiple facts and episode
parts, exhaust submission/correction space, reopen, and save both receipts in either order.
Duplicate finish calls cannot consume the companion receipt allocation. Frozen v1/v2 migration
dependencies are copied from their actual writer commits; historical fixture validation is tested
with the live Shared and omission-statistics modules unavailable.

Semantic data upgrades 6 → 7 to distinguish governance/source invalidation from captured-learning denial in durable projection notifications. Existing denial flags remain unchanged; invalidation, forgetting, conflict and expiry changes can now wake learning to reconsider the remaining eligible projections. The historical v6 writer fixture verifies upgrade and delivery without changing Fact revisions.

Learning notification delivery runs in the Memory scheduler maintenance lane, independently of
Episode/Semantic extraction and the conversation coordinator. Delivery failure keeps its durable outbox row,
uses a bounded backoff, and reports memory_learning_notification_delivery_failed as degraded;
it cannot prevent claiming an Episode job. Episode data 6 → 7 separates source_changed from captured
permission so delete, invalidate, forget, and maintenance changes wake a rescan of remaining permitted
sources. V6 pending notifications receive a fresh CAS generation during upgrade.

Knowledge source conversation identities are retained with Semantic Evidence, using the extraction
job's conversation identity when capture has not yet been bound. They survive Episode rejection and
extraction job cleanup. Skill inspection may discover package files and read related scripts or
references by pinned path; targetFiles records the relevant files without enforcing inspection coverage. The same shared
8 MiB budget applies through Memory revision request validation; ordinary prompt limits are unchanged.

Large Revision prompts are staged temporarily and copied into Mission-owned file attachments during
atomic Mission creation. The durable manifest references the owned copy, which survives temporary
storage maintenance and Runtime retries and is reclaimed by Mission deletion. Branches own independent
copies. This opt-in snapshot behavior leaves ordinary external file attachment references unchanged.
