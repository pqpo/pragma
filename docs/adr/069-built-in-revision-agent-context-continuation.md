# ADR 069: Built-in Revision Agent Context Continuation

- Status: Accepted
- Date: 2026-10-13
- Issue: #388

## Context

Pragma used separate `pragma.tool.call@v1` tools for Store and Skill Revision. Each call creates a
fresh Runtime Context even though the instructions request continuation of the original conversation.
Knowledge draft ownership follows the first Invocation's provenance, so a new child Context cannot
reclaim a draft returned for changes. Returning a review sets both job and draft to `editing`; a
Context write additionally requires a running job, which `knowledge_revision_start` restores.

## Decision

Pragma declares one `pragma.tool.delegate@v1` binding with both Revision Experts as targets. It uses
Core's existing lifecycle tools, also used by ExpertTeam: spawn for new work, continue by exact
contextId for related work, and wait by each returned invocationId. Expert and ExpertTeam keep their
separate DSL entry points and permission scopes while sharing execution, FIFO, cancellation, Context
recovery and tool implementations. Multiple Experts belong to one launcher, not one tool per Expert.
Pragma's spawn and continue approvals remain `ask` through the existing toolApprovals contract.
Studio resolves both single-target and grouped target bindings for names, counts and selection;
reselection preserves the grouped binding and its policy instead of expanding it into call tools.
New Expert selections join that launcher (with spawn/continue approval defaults of `ask`); Flow and
Team resource calls stay separate. Explicit approval overrides remain intact, and removing an Expert
also removes its Runtime override so compilation cannot reference a deselected target.

On every returned review, the Revision Agent continues in its original Context and original Mission.
Store Revision explicitly starts with the original draftId, uses the returned writableNamespace,
reads fresh file content and etag/revision, and submits the current draft revision. Skill Revision
remounts the original draft before native file editing. Draft Context isolation, published-resource
read-only access, pending-review freezing, rejection termination and CAS remain unchanged.

## Existing data and authorization

During the #388 plan review, the maintainer explicitly instructed: “既有call创建的mission不需要做兼容”.
This authorizes excluding old call-created Missions from Context continuation compatibility. Their
Mission, Invocation, draft and Runtime data are retained; no eager scan, conversion, synthetic Agent
record or automatic deletion is introduced. The new path uses the existing delegate configuration and
current storage namespace, with no new Schema or version discriminator. Closed, inaccessible or
non-resumable Contexts report diagnostics instead of spawning replacements to bypass ownership.

The `pragma.tool.call@v1` parser and other resource-call uses remain available. User-authored DSL and
historical Project Revisions are not rewritten; explicit customized resource tools remain user-owned.
No persistent or DSL Schema changes, protocol version bumps or storage migrations are required.

## Verification

Compile the real built-in Pragma DSL and exercise its child Store Revision through the Desktop Mission
adapter, including two rework rounds and reopening the runner. Assert the same draft, job, Mission,
ExpertSession and child Context, retained files, unchanged published knowledge and denied parent
access. Validate lifecycle approvals at the execution tool boundary, and retain the independent
Store/Skill status, CAS, rejection and Context-lifecycle tests. Run `pnpm test:revision` and focused
Local Host/system-expert checks; use isolated real Runtime smoke data for end-to-end evidence.

### Recorded Runtime smoke

On 2026-10-13 the real Codex Runtime passed the built-in Pragma Mission case (169 seconds):

```sh
PRAGMA_REVISION_REAL_SMOKE=1 PRAGMA_REVISION_REAL_RUNTIME=codex \
  pnpm --filter @pragma/desktop exec vitest run \
  src/main/features/missions/desktop-mission-adapter.test.ts \
  -t 'unmounted target.*expert:0000000000pragma.*cold=false'
```

The fixture uses a temporary, isolated Knowledge Store and Mission. Assertions verify the actual
`items/tracking.md` content and both `items/rework-1.md`/`items/rework-2.md` writes, three pending-review
submissions, one draft/job/Mission, the same persisted Store Revision Context and ExpertSession, and
an unchanged published snapshot. Host approvals are explicitly accepted by the isolated smoke harness;
approval refusal and acceptance are tested separately through the real MCP execution boundary.
The earlier attempt ended without creating a revision; the smoke fails on that outcome rather than
accepting a successful Runtime turn as proof of a submitted draft. Real Runtime cold recovery and
Skill delegation are not claimed by this run; the deterministic integration cases cover both.
