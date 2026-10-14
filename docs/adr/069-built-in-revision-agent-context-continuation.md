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
current Mission storage namespace, with no new Mission Schema or version discriminator. Closed, inaccessible or
non-resumable Contexts report diagnostics instead of spawning replacements to bypass ownership.

The `pragma.tool.call@v1` parser and other resource-call uses remain available. User-authored DSL and
historical Project Revisions are not rewritten; explicit customized resource tools remain user-owned.
This authorization does not cover active System Expert customizations. The historical v8 writer
persists the complete default tool array even when only the name or additional instructions change;
that array would override the new built-in delegate defaults. The customization configuration advances
from v8 to v9 with a registered adjacent migration and a frozen v8 aggregate Schema snapshot.
Only the exact former default pair on Pragma is converted to the delegate binding. Modified bindings,
other experts, metadata, model, capabilities, Context mounts, plugins and instructions are preserved.
For converted defaults, the two obsolete call approval keys become spawn/continue overrides using
the strongest effective old mode and any existing lifecycle override. This prevents weakening a
`required` approval; unrelated approval keys stay intact.

Upgrade runs on first configuration access inside the existing aggregate file lock. It writes a stable
migration journal before writing the backup into a unique temporary file in the same directory.
The complete temporary file is flushed, then installed by a hard link: the final backup appears
atomically and an existing backup cannot be overwritten. An interrupted temporary write cannot
publish a partial backup; reopening retries with a fresh temporary file. Retries verify the existing
backup rather than overwriting it. An unreadable or conflicting final backup reports a stable error
code and its path, preserving both files for verified manual recovery. Completed writes can be recovered without
rewriting the v9 target or deleting the backup. Older registered upgrade paths chain into v8-to-v9;
current v9 is a no-op and future versions fail closed. No DSL apiVersion change is needed.

Clearing Studio's Tools category removes only approval keys belonging to the removed mutable
Capability tools. Lifecycle approvals, explicit overrides, fixed Capability tools and other categories
remain intact. The browser-safe selection function is shared with the save/reopen regression test.

## Verification

Compile the real built-in Pragma DSL and exercise its child Store Revision through the Desktop Mission
adapter, including two rework rounds and reopening the runner. Assert the same draft, job, Mission,
ExpertSession and child Context, retained files, unchanged published knowledge and denied parent
access. Validate lifecycle approvals at the execution tool boundary, and retain the independent
Store/Skill status, CAS, rejection and Context-lifecycle tests. Run `pnpm test:revision` and focused
Local Host/system-expert checks; use isolated real Runtime smoke data for end-to-end evidence.
Historical fixtures come from the actual v8 writer at `b4b3cc1ca537046e5324138efcbacbaf47a3fa3d`;
tests compare the complete upgraded fixture, preserve a truly modified binding and all other settings,
exercise existing chained upgrades, journal replay at each crash stage, interrupted backup writes,
leftover partial temporary files, interruption after atomic backup installation, repeated initialization,
invalid/conflicting final backup diagnostics, an injected atomic replacement failure, current-version
no-op and future-version rejection. Actual MCP calls validate denied and
accepted spawn/continue after both persisted migration and Studio clear/save/reopen.

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

## Mission publication ordering

A delegated revision can mount its managed draft before the Host publishes the parent Execution.
The accepted parent resource snapshot then contains an older Context mount fingerprint. Publishing
that fingerprint later used to overwrite the draft mount's Session acknowledgement (or miss it when
no Execution had been linked yet), so the next prompt created a successor Session. The previous
child Context disappeared from the new Session's directory and Work projection despite completing
successfully.

Execution publication now carries its accepted mount snapshot into the existing Mission atomic
write. The repository retains an already-acknowledged fingerprint for the same Session, or accepts
only additions of managed Knowledge/Skill draft mounts to the exact accepted baseline. Removal,
replacement, ordinary Knowledge mounts and unmanaged drafts are not acknowledged by this path;
normal environment changes still require a successor. Core ownership and closed-Context rules are
unchanged. The new parameter is an internal publication input; no persisted state Schema changes.

A controlled-order test delays parent Execution publication until the delegated draft has mounted.
It fails on the original code with an empty child directory on the next prompt. The repaired test
asserts the same Session and child Context, successful continuation and two review returns, and
retention of the child in the Work tab in both warm and cold runner recovery. Repository tests cover
first publication, replay and later Execution publication, plus refusal to acknowledge ordinary or unmanaged draft changes.

Cold recovery must also agree with the compilation identity, which includes the Context mount
fingerprint. At parent publication and terminal projection, Local Host re-evaluates the accepted
mount baseline using current permission, model, dependency and Capability inputs. Only when that
identity still matches the accepted compilation may the repository atomically rebase the environment
identity onto the acknowledged managed additions. The write checks the exact Execution, Session,
previous environment identity and current mount fingerprint, and changes only the environment field;
a stale reconciliation cannot overwrite status or a newer execution. Environment checks during cold
recovery remain unchanged. No persisted Schema or ownership rules change.

The cold regression now restarts the runner immediately after the first delegated turn, before any
warm continuation can refresh compilation metadata. Both ordinary and delayed publication restore
the original Session, discover and continue the original child Context, and complete subsequent
review returns. This immediate-cold case failed before environment reconciliation; the prior cold
case restarted only after a warm continuation and did not cover this boundary.
A concurrent permission-update case verifies the opposite result: the environment is not rebased,
cold recovery creates a successor Session, and the original child is not reassigned to it.

On 2026-10-14, the ordinary real Codex Pragma smoke also passed (232 seconds) after this repair:

```sh
PRAGMA_REVISION_REAL_SMOKE=1 PRAGMA_REVISION_REAL_RUNTIME=codex \
  pnpm --filter @pragma/desktop exec vitest run \
  src/main/features/missions/desktop-mission-adapter.test.ts \
  -t 'unmounted target.*expert:0000000000pragma.*cold=false, delayedPublication=undefined'
```

This run verifies actual writes, initial submission and two returned-review continuations in the same
persisted child Context/Session. The publication ordering and Work-record assertions are covered by
the deterministic `delayedPublication=true` regression, not claimed as part of this native run.
An earlier forced-order native attempt was interrupted without a complete assertion result.

On 2026-10-14, the real Codex cold-runner smoke passed after compilation reconciliation
(256 seconds):

```sh
PRAGMA_REVISION_REAL_SMOKE=1 PRAGMA_REVISION_REAL_RUNTIME=codex \
  pnpm --filter @pragma/desktop exec vitest run \
  src/main/features/missions/desktop-mission-adapter.test.ts \
  -t 'unmounted target.*expert:0000000000pragma.*cold=true, delayedPublication=undefined'
```

This run restarts the runner after the initial submission and again for the next review return.
Both continuations retain the original persisted Session and Store Revision Context, actually edit
the same draft, and submit for review. Controlled late publication remains covered by the deterministic
integration case; this native run uses ordinary publication.
