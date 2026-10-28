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

The All Memory attention alert uses the same grouped attention lane as the task board, counting
Knowledge and Skill jobs independently. Per-module health counters continue to count deliveries.

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

## Direct Knowledge/Skill Revision extraction

New learning work uses the Revision Agent directly: source reads, target discovery, value judgment,
editing and draft submission share one Mission and Native context. Knowledge/Skill retain their
independent scheduling; Curator Episode/Fact extraction is unchanged. See [ADR 080](../adr/080-direct-memory-revision-extraction.md).
Observation ownership is checked for each Expert/source admission against the complete durable job
index. Finishing one observed Expert permits the next Expert's first admission; an incomplete index
does not authorize replay. Legacy Planner source identities are retained separately from historical
empty markers so a missing owner can be isolated. Anonymous deleted owners conservatively block only
potentially affected historical attempts; task creation time and first-claim history distinguish new work.
There is no new-task Planner, JSON inspection conversation, intermediate plan, correction loop,
plan cache or plan-to-prompt conversion. Necessary source qualifications and deterministic checks
run at the reading and draft boundaries; source/target completeness remains an Agent instruction.

Task-scoped tools page authorized Memory, search existing assets, and read pinned Knowledge/Skill
contents and related package files. They validate identity, current policy and source revisions on
every call. Managed inspection/draft calls share 128 requests and 8 MiB of delivered response bytes;
submission and final no-change receipts have a control reserve. Consumed counters survive reopening.
A target must be read before starting an incremental revision; changed versions require rereading.
Skill citations still need a succeeded Episode; new Knowledge needs cross-conversation support or a
successful artifact. Missing evidence means accumulating, while tool/runtime/budget failures remain failures.

Revision instructions have two parts. The built-in Knowledge/Skill DSL owns each Agent's shared
professional requirements (organization/applicability/metadata or complete reusable workflows and
validation, plus draft ownership, conflicts, submission and recovery). Default registration and
materialization append interactive instructions: clarify uncertain requirements/sensitivity and
confirm Skill conflict resolutions with the user. An explicit user revision is not optional learning.
For a single unattended execution, `unattendedMemoryRevisionResource` assembles the same professional
requirements with Memory learning instructions instead; it does not concatenate the interactive
instructions or rewrite the global Agent/customized definition. The direct executor explicitly opts into
learning-tool instructions with `learningTools: true` after assembling the task-scoped binding. Retained
historical draft executions use the default brief without `select_learning_sources`, `finish_memory_learning`
or `waitForTarget`, since their ordinary Revision binding does not provide that protocol. Both retain
the same quality policy and noninteractive constraints. Unknown revision identities are rejected.
Task-mode instructions and the composed resource participate in existing bundle fingerprints;
no persisted Schema, migration chain or execution engine changes.

Background learning optimizes review value, not output count or extraction coverage. Compare actual
existing assets first; prefer a few meaningful incremental edits and combine related improvements.
One-time reports, scattered advice, cosmetic changes and already-covered content warrant no draft.
New assets need a clear independent use and greater value than incremental revision. Knowledge adds
stable definitions, constraints, reference knowledge or corrections with scope and historical/current
status. Skills need complete reusable methods, actual validation, failure handling and limitations;
a succeeded task does not validate every step or recovery. Complete verified new-domain outcomes can
still justify creation. Source minimums and deterministic guards remain unchanged.

Before submission, the existing revision summary explains the concrete delta, future use/error or
repeated work avoided, evidence support and unverified limitations; creation also explains why related
assets cannot serve the purpose and why an independent asset is valuable. Formal content excludes
raw Evidence, internal source IDs and sensitive paths. No extra plan or approval protocol is introduced.

Learning target discovery returns two distinct identities: `read_learning_target` takes the exact
unqualified `id`, while revision start takes `targetRef`. Read current target content before start,
and read/select supporting source handles before each start. Known learning precondition errors
return `invalid_input` with the original cause and a recovery tool in the existing management-error
contract, allowing correction in the same Mission. Unresolved unread-target, denied-target and
missing-source-selection start errors remain diagnostic blockers in the existing failure map;
Successful source selection clears the missing-selection blocker; successful target reads clear
unread/denied-target blockers. Successful start also clears its blocker. Corrected prerequisites
can finish without creating a draft. Insufficient evidence can still finish as accumulate/unsupported.
Terminal diagnostics retain a stable underlying failure code when available instead of replacing it
with a missing-receipt or generic read error. Unknown exceptions remain internal errors.

A normal no-draft outcome calls `finish_memory_learning` with a concrete accumulate/duplicate/unsupported
reason. `accumulate` means defer extraction and retain underlying Episode/Fact under existing retention
and permission rules. Future relevant effective changes may trigger reevaluation with old and new
sources; there is no promise of later extraction, scheduled rechecks or permanent topic tracking.
Identical effective inputs retain existing deduplication/recovery behavior. Reading, permission,
Runtime and budget failures remain failures, not no-value judgments.

The Agent uses existing Revision and Context tools in this same Mission. Selected pending targets
produce a dependency wait, never a duplicate asset; unrelated pending targets do not block work.
Submitted drafts, no-change decisions, waits and execution failures remain distinct. Tool validation
feedback can be repaired within the current execution. Submission uses existing ownership, version/CAS
and validation checks, and always leaves automatic Knowledge/Skill drafts for human approval.

Automatic drafting carries immutable `system-memory` origin throughout execution and writing, so it
cannot become user Evidence. Managed questions are denied before compilation and native Runtime
questions/approvals are rejected before a durable human-input wait. Interactive Revision keeps its
question tools and capture behavior. Historical draft-owning Missions use their persisted Revision
job source to recover the same unattended execution and Evidence exclusion constraints. Missing,
invalid or unsupported historical authority records defer capture rather than inventing user evidence.

The new `state/memory-direct-revisions-v1/` namespace stores bounded admission/owner metadata,
consumed budgets, exact source handles, per-draft receipts, results and continuation commands. It does
not copy source bodies or change existing job, binding, Memory or draft Schemas. Existing migration
chains remain supported. Unknown creation/dispatch outcomes never authorize a new model conversation.
Only Local Host's single-use unstarted-preparation proof may withdraw an admission.

Timeout observes the original execution again after five seconds. An expired job lease can recover
observation only with durable ownership proof; missing proof stays parked. Observation does not reset
the model budget. Explicit retries, bounded explicitly retryable terminal Runtime failures, and settled target dependencies use persisted idempotent commands
in the original Native context. Submitted work survives partial failure and is not resubmitted.
Authority submissions are reconciled after an uncertain tool response. Results precede cleanup;
draft-owning Missions remain available for approval/rework. Deleting failed input revokes its tools;
idle maintenance reclaims orphan no-draft state/workspaces without startup owner scans.

Cold stop reconstructs system Experts from the admitted Mission execution snapshot, including
the task-mode resource, additional resources, Runtime, model and permission overrides. It does
not reopen the direct Revision source binding or require live learning inputs: retirement revokes
those inputs before cancellation. The stop definition must retain the original Session definition
fingerprint. Failed cancellation preserves the retired record and job index so idle maintenance
can replay cancellation and deletion after restart without admitting another model turn.

Legacy task compatibility is a drain, not another new-task path. Existing cached plans finish their
old handoff, and registered Planner Missions are only observed/read. No new Planner or correction is
admitted. A durable business decision precedes the legacy settlement marker and cleanup. Missing owner,
invalid output or unknown execution cannot silently start over. Legacy plan types/cache and resource
recognition retire only after the support window and all legacy execution/handoff/review dependencies
settle; historical data migrations are retained.

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

The snapshot and receipts live in `state/memory/curator-sessions-v1.sqlite` (database version 4).
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

Historical PI/DeepSeek runs with embedding disabled exercised tool workflows, receipt recovery,
transient-task skipping and correction after injected errors. They did not establish extraction
quality, positive vector retrieval, other models/runtimes, Electron UI or full Mission acceptance.

### Recovery constraints

- V2 control data uses structured cursor/candidate fields, never parsed presentation text; legacy
  contract 1 retains its historical footers and provider-facing object Schema.
- V2 resume retains consumed counters and receipt reserves. Duplicate finish calls cannot consume
  the companion receipt allocation. Candidate handles require own-property membership.
- Snapshot recovery compares JSON values independent of object-key order, preserves array order,
  and rejects changed Evidence or subjects. Historical dependencies/fixtures remain frozen.
- Injected-error acceptance requires the intended failure and a matching retry started after it;
  unrelated submissions do not count. Verdict regressions run via
  `pnpm --filter @pragma/desktop test:memory-curator-acceptance` without a model.

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

Curator Session storage upgrades 3 → 4 on first access with a retained SQLite backup and
transactional rollback/replay. New continuation reservations use UUID v4 and persist the ID before
delivery. The migration changes only the version nibble of pending IDs emitted by the historical
v8 writer: Mission rejected these before operation persistence, so no accepted command identity
exists to remap. It preserves the Mission link, previous execution, retry deadline, continuation
count, budgets, staged work and completed receipts. Read-only admission proofs support historical
versions without mutating storage; unknown or corrupt IDs fail closed.
