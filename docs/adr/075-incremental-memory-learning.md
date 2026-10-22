# ADR 075: Incremental Memory learning

- Status: Accepted
- Date: 2026-10-22
- Supersedes: ADR 057's per-Expert knowledge target and repeated high-score Episode admission, within Memory learning.

## Problem

A verified Fact or support across two Executions establishes provenance, not the value of a new
knowledge base. Per-Expert Memory-only target bindings miss existing manually created assets and
fragment knowledge. Requiring three high-score Episodes across conversations prevents a single
complete verified workflow from becoming a Skill. Execution-terminal scheduling can precede Episode
materialization and miss its useful results.

## Decision

Treat Memory as accumulation and published assets as reviewed, incrementally maintained knowledge.
Discover ordinary local editable targets as well as Memory bindings. Prefer mounted related assets,
then other related editable assets. Require explicit target versions, selected source revisions and a
specific supported delta. Creation is exceptional: the topic must be independently useful and durable,
with no suitable existing target, supported across two conversations or a validated complete successful
artifact. Source reliability never replaces topic maturity. A single verified Fact is insufficient.

Skill planning accepts one successfully completed workflow, without a salience-score requirement,
and can combine repeated experiences. The model assesses completeness, reuse and actual validation;
Host validates exact source membership, successful Episode support, target ownership and versions.
Recovery text alone does not prove success. Each change cites 1–8 distinct sources; at most three
workflows are proposed. Existing Skills are preferred over new assets.

Task-scoped read-only inspection uses the existing owned Mission continuation path, with source and
target catalogs, keyword search and character pages. Only fully read supplied documents may be cited;
selected target contents must be read before revision. Limits are 128 inspections and 8 MiB of delivered
bytes, independent of the two JSON correction turns. Full draft sources are preserved rather than
cut to 1,500 characters. No new execution kernel or general-purpose tool binding is introduced.

Episode data 5 → 6 adds transactional root notifications with monotonic CAS generations; captured
learning denial is preserved. Both projection Modules wake both learning Modules. Source updates
coalesce rather than depending on the timing of Execution completion. Skill notification scheduling
uses six-hour idle debounce capped at twenty-four hours. Failed notifications survive restart.

Persist decisions and validated pending plans in a new Module-owned v1 SQLite namespace under
the Module data root; durable assessment and deduplication history is authority, not a display cache. Effective
content and target-version fingerprints suppress repeated evaluations and proposals, including after
completed job pruning. A related pending asset is visible in discovery; planners can wait for that
target. Settlement wakes only dependency waits and does not reset model attempt budgets. Failed
Runtime admissions retain existing bounded retry behavior.

Upgrade learning bindings v1 → v2 through Core's adjacent migration chain, stable journal, backup and
aggregate lock. Preserve old pending revisions, source digests and mounts; add target/topic identity
without relabeling or deleting published assets. Frozen v1 Schema and fixtures written by the original
v1 service and v5 Episodic store accompany migration tests. Future versions are rejected.

Memory proposals always require human review before publication and new mounting. Ordinary user
revision jobs retain their configured approval behavior. Formal assets remain independent of Memory
retention. Existing small knowledge bases are preserved; historical consolidation is separate work.

## Validation

Regression coverage includes ordinary unmounted targets, stale target versions, cross-Expert target
occupancy, single low-score successful workflows, failed recovery text, old sources beyond 100 rows,
incremental duplicate suppression, debounce, real historical fixtures, rollback, notification replay and
CAS acknowledgement. Inspection coverage includes missing middle pages and lazy target loading.
Real-model quality requires a configured Runtime and separate scenario verification; model judgments
about usefulness are not proved by deterministic contract tests.

Semantic data upgrades 6 → 7 to distinguish governance/source invalidation from captured-learning denial in durable projection notifications. Existing denial flags remain unchanged; invalidation, forgetting, conflict and expiry changes can now wake learning to reconsider the remaining eligible projections. The historical v6 writer fixture verifies upgrade and delivery without changing Fact revisions.

Review hardening keeps terminal delivery on the same debounced projection path as notifications.
Source readers enforce captured learning permission for every cited Evidence record, independently
of notification eligibility; missing provenance cannot authorize learning. Complete valid Episode
projections retain attempt results and long workflows, while inspection catalogs use small metadata
entries so evidence arrays cannot stall pagination. Creation requires all unfiltered target catalog
pages; multiple changes to one existing Skill must be combined into one revision.

Learning task digests include the policy version, allowing existing sources to be reassessed after
a rule upgrade while preserving historical completed jobs. Submission identities include selected
evidence and the selected target version, so retries remain
idempotent without suppressing a later supported revision. Knowledge digests include outcome and
conversation support, interrupted claims are checked after target availability, and stale queued work
is replaced when valid sources remain. Skill identity keys stay scoped to the requesting Expert while
pending target occupancy remains shared. Reading task decisions never initializes authority; malformed
or future decision databases are rejected without recreating missing tables.

PR review follow-up separates learning delivery from Episode and Semantic extraction using the existing Memory
scheduler's independent maintenance lane. A delivery failure reports a stable degraded diagnostic,
retains the durable notification, and backs off without delaying extraction or the conversation
coordinator. Episode data 6 → 7 records source changes separately from captured learning permission;
legacy pending roots are rescanned with a new CAS generation without granting permission to any
source. A real v6 writer fixture covers migration, rollback, deletion, and stale acknowledgement.

Fact conversation provenance comes from retained Semantic Evidence rather than Episode retention.
When captured Evidence lacks that optional identity, the Semantic writer preserves its extraction
job's conversation reference before job cleanup. Unknown historical conversation identities are not
invented or counted as independent conversations.

A shared 8 MiB budget covers inspection delivery and revision source prompts, with 32,768-character
pages and 128 requests. A maximum-sized 410,000-character source has a complete read/submit path,
including Unicode and JSON-escaped content. Revision request parsing admits the larger internal
Memory prompts while ordinary requests retain their 50,000-character limit. This only expands an
accepted bound: existing persisted requests retain their structure and meaning and remain valid.
Large requests use existing Mission file attachments, outside publishable draft payloads, so the
100,000-character Mission goal/message limit does not reject accepted source prompts. Input files
remain with the temporary revision workspace for subsequent Mission turns; they are task inputs,
not another authoritative store. Configured Runtime context-window limits still apply and real-model
quality is a separate check.

Skill target inspection exposes the pinned SKILL.md and package file catalog, then reads selected
scripts/references lazily by path. Plans declare the files they use in targetFiles; declared files
must have complete inspection coverage before revision. The complete package is never loaded by
default, and unrelated files remain available for the Revision Agent to preserve.
