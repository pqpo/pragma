# ADR 039: Promoted Knowledge Stores

## Status

Accepted. Agent-driven editing and review use the sparse draft protocol in
[ADR 044](./044-sparse-context-store-revision-drafts.md).

## Context

Episodic and Semantic Memory are dynamic projections derived from Evidence. Knowledge approved for long-term use
needs a stable authority that can be managed, mounted, revised and shared independently of Memory Module checkpoints
or source events.

Desktop already provides Host-managed Markdown Context Stores in Studio. Using that same resource as the authority
keeps Knowledge content, revision history, bindings and bundle behavior in one product model.

## Decision

Memory Plane may create a Knowledge promotion candidate from eligible Episode, Fact or other governed sources. After
user approval, the Host materializes it as a managed Context Store and displays it in Studio. From that transaction:

- the Context Store is the sole authority for content, structure, current revision, mounts and sharing;
- recall, export and later revision read the Store rather than the originating Memory projection;
- Store content excludes raw Evidence, Curator prompts and source-local paths;
- Memory retains only a content-free promotion binding from producer Expert to Store plus the latest source digest;
- later relevant Memory changes create a revision request for the same Store rather than another Knowledge object.

Each Expert may bind one promoted Knowledge Store. ExpertTeam and Flow results route to the actual producer Expert.
Generated Stores use progressive disclosure:

```text
guide.md                         # bounded usage rules
overview.md or summary.md        # bounded topic overview
index.md / indexes/**            # bounded or paginated pointers
items/**                         # individual knowledge entries
```

Overview and index files are rebuildable projections; item files are the content authority. Growth in `items/**`
does not make always-on Context grow without bound.

Knowledge updates use the generic Store revision service. A request pins the current Store revision and snapshot;
the Store Revision Agent edits a sparse draft through standard Context tools. Submission, review, rebase and atomic
publication follow ADR 044. Approval uses revision/hash CAS, creates an immutable revision and preserves prior
revisions for recovery and audit.

Promotion is idempotent by producer binding and source digest. A Semantic replacement updates the existing normalized
knowledge entry; unchanged semantics do not create duplicate revision work. Ambiguous target matches require an
explicit Store selection.

Bundle export treats promoted Knowledge as an ordinary Host-managed Context Store. Export uses the selected immutable
revision and its normal binding/visibility checks; raw Evidence and Memory-internal state are never included.

## Consequences

- Published Knowledge has one authority and one revision model.
- Dynamic Memory can propose durable improvements without owning published content.
- Human and Agent edits use the same sparse draft, CAS, review and recovery mechanisms.
- Knowledge can be mounted and shared through normal Context Store and bundle contracts.
