# ADR 074: Explicit Memory Curator tool contract and resumable feedback

- Status: Accepted
- Date: 2026-10-19
- Supersedes: tool interface portions of ADR 072/073 for new sessions

## Context

Real remote extractions repeatedly exhausted read budgets or submitted JSON-encoded property
objects. The overloaded search/full-read/staged-work tool and polymorphic finish call forced the
model to infer operations and completion requirements. Persisted Native conversations already
contain the old tool vocabulary, so switching all sessions in place would break recovery.

## Decision

Memory owns a versioned tool contract, independent of authority Fact/Episode schemas and Runtime
adapters. New sessions use contract 2 with twelve explicit tools. Search requires a query; full
Memory reads, extraction status and complete staged-candidate reads have their own tools.
`submit_fact` requires predicate/conflictMode scalar fields. The unified episode-part tool retains
five authoritative branches, with provider-compatible object-root advertising and branch-specific
correction feedback. Semantic finish, Episodic finish and skipping are separate calls.

Every visible v2 response has a Zod-validated Feedback header in its text, not only Runtime details.
It reports fresh progress and known next-call arguments; errors report stable codes, correction
fields and examples. Full candidate reads preserve every editable field and evidence alias over
bounded pages. Permission failures omit progress and source-derived fields. All visible responses
are token-counted through Core; a 1,024-token control reserve is inside the source-sized budget.
Within that reserve, each pending type owns 256 tokens for its bounded finish acknowledgement.
Submissions, error feedback and duplicate finishes cannot consume another type's allocation;
successful completion releases only the allocation for the type whose receipt was saved.
When source coverage and staged work are complete, budget feedback permits finishing that type
within the reserve, including an executable Semantic finish call. Incomplete work stays blocked.
No tool error or capacity limit authorizes a skip decision or a new model admission.

Internal operation results carry candidate handles and pagination cursors as structured fields.
The historical adapter renders its original footers; contract 2 uses the structured fields in
Feedback without parsing presentation text or interpreting source text as control metadata.

## Upgrade and recovery

The Session aggregate and SQLite database become version 3 with required toolContractVersion.
Frozen v1/v2 schemas and statically registered adjacent migrations upgrade lazily under the existing
file lock and atomic SQLite transactions, retaining pre-upgrade backups. Version 2 data becomes
version 3 with contract 1; pending continuation commands, read coverage, staged work, receipts,
mission links and original provenance remain intact. Read-only admission proofs validate the
matching historical schema before normal aggregate migration. Future database/aggregate/contract
versions fail closed. Version 1 upgrades through both steps.
Nested Evidence, subject, visibility, sensitivity, policy, binding and omission-statistics schemas
are frozen from the actual historical commits too; historical validation imports no live domain schemas.

Contract 1's original DSL/tool adapter and budget semantics remain available solely for historical
conversations. A new session or explicit new retry generation uses contract 2. No authority Memory,
Evidence, Runtime Session, or Desktop run-archive protocol changes. The existing database path is
retained. The current prompt version is v9; historical provenance is not rewritten as v9.

## Verification

Historical fixtures are written by actual v1/v2 writers at the commits recorded beside the files,
not fabricated by changing current version fields. Tests cover first use, current no-op, adjacent
and chained upgrade, transaction failure/replay, future rejection and resumed historical tools.
Contract tests cover bounded complete reads, progress, corrections, source-scope revocation and
budget accounting. A reproducible default-PI probe consumes external real Evidence snapshots,
materializes authority Memory, recovers receipts without another admission, and reports actual
coverage. Positive vector search, other Runtime adapters/models and remote UI need their own
acceptance evidence; successful mocks or keyword fallback do not establish those capabilities.

## Consequences

New conversations have clearer operations and explicit completion requirements. Historical
recovery requires retaining one frozen tool adapter/DSL until a separately governed cutover.
Provider schemas still cannot express every discriminated branch uniformly; authoritative Memory
validation and actionable correction feedback remain required. Real source coverage and model
quality continue to matter; the contract does not manufacture evidence or guarantee extraction
quality solely from a successful receipt.
