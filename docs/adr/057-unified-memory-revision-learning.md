# ADR 057: Unified Memory revision learning

## Status

Accepted

## Context

Memory previously used Memory Curator to produce Knowledge and Skill candidates, then sent approved candidates through separate promotion services. Knowledge creation followed a different path from Knowledge revision. Skill creation required a candidate editor and replay checks that did not materially improve the retained Skill. These paths duplicated routing, review state, UI, and recovery logic around the managed revision services.

## Decision

Memory Curator produces only Episodic and Semantic Memory. Knowledge and Skill learning use deterministic source gates, then the existing Store Revision Agent and Skill Revision Agent. A read-only planning run of the corresponding Revision Agent selects reusable work from bounded Memory projections. The Host validates source references and target identity, then submits an idempotent managed revision job. The same Revision Agent edits the managed draft; the existing human review and publish path activates the formal Store or Skill. Planning runs have no capabilities or tools. Each planning Mission has a targeted orphan marker.

Knowledge creation and revision share one route. Skill creation and revision share one route, with at most three proposed Skills per learning batch. Skill source eligibility still requires three high-value independent Episodes from two conversations, with two successful or recovered outcomes. Format and safety validation remain synchronous at draft submission. Source replay evaluation and Memory-specific draft tools are removed.

The unified binding file is written under `state/memory-learning-revisions/` with stable Store and Skill identities. Revision services deduplicate submissions by resource identity and source digest. The Host writes a pending binding before submission so a crash cannot allocate a different resource identity on retry. On first access, in-flight approved promotion journals are replayed idempotently, then approved Knowledge and Skill bindings from the two former promotion directories are copied into the unified state. The former directories, including unapproved candidates, are then moved to `archives/memory-learning-v1/`. The migration is owner-local, replayable, and leaves the original bytes as a backup. The old candidate API and UI are removed; archived candidates are never auto-published.

A binding tracks whether its current revision is still pending. New evidence for the same Store or Skill waits in a retryable Memory job until that revision is merged, published, or rejected. Reconciliation wakes deferred jobs after the revision settles, preventing parallel drafts for one identity and preserving evidence that arrived during review.

Skill plans may add a new normalized workflow key to an existing Skill when no other Skill owns that key. If Skill creation conflict recovery supersedes a revision job, reconciliation persists the replacement job and capability identity before waiting for publication. Memory-initiated Skill drafts use Pragma's `workspace/system-memory/` directory instead of the user's selected workspace.

## Consequences

- Knowledge and Skill learning have one revision, review, publication, and binding path each.
- A planning error keeps its durable Memory job retryable; it does not count as generated Memory.
- Pending and archived candidate records are not active work. Users can inspect the archived files manually if needed.
- Existing formal Store/Skill revisions and their review jobs retain their own storage protocols.
