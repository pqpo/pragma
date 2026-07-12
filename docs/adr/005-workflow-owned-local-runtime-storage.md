# ADR 005: Workflow-owned local runtime storage

## Status

Accepted.

## Decision

Pragma-managed Runtime sessions are owned by exactly one Workflow and are stored outside Agent
workspaces. `@pragma/core` owns local path resolution through `PragmaPaths`, using this precedence:

1. Explicit `pragmaHome`.
2. `PRAGMA_HOME`.
3. `~/.pragma`.

External identifiers are encoded as unpadded UTF-8 Base64URL directory segments. Runtime state is
stored at:

```text
~/.pragma/state/workflows/<workflow-run-id>/sessions/<system-session-id>/
```

The directory contains `session.json` and a runtime-private subtree. Plugin source copies are cached
at `~/.pragma/cache/agents/<agent-id>/plugins/<plugin-id>/` and are not installed into workspaces.

Before creating a fresh Session, Core atomically claims its `systemSessionId` with an exclusive
ownership record under `state/workflows/.system-session-owners/`. The claim maps the raw system
Session ID to its one Workflow owner and is not the deferred `RuntimeSessionRef → systemSessionId`
index. An existing claim always rejects another fresh creation, including a duplicate request from
the same Workflow; restoration must use the existing Session record instead.

Runtime Session creation is private to the Pragma execution chain. Core derives `RuntimeSessionOwner`
from the active `DirectiveExecutionContext`; callers cannot provide owner strings or open Sessions
through a Runtime Adapter. Restoring a native session additionally requires its original
`systemSessionId` and `RuntimeSessionRef`. Core validates Workflow, task, system session, Agent,
runtime descriptor, and native reference before a concrete runtime validates its native session file.
Restoration never falls back to a new session.

## Consequences

- Workspaces contain task-required files only.
- Moving a session to another workspace updates `currentWorkspace` and `workspaceHistory` without
  changing its physical storage directory.
- `ExpertAgent.createSession()` and public `RuntimeAdapter.createSession()` are removed. Applications
  execute Agents through `PragmaApp.start()` or `PragmaApp.run()`.
- Multi-turn and process-level restoration use
  `PragmaApp.resume(rootDefinition, { workflowRunId })`; no public partial Child resume API is
  provided.
- A global native-session index remains future work.
- A crash can leave an ownership claim or an empty Session directory before `session.json` is fully
  created. These artifacts remain reserved and harmless; future storage GC should report and clean
  them explicitly rather than allowing another Workflow to reuse the ID.
- Plugin installation uses a per-Agent/per-plugin installation lock and a staging directory before
  publishing the cache entry, preventing concurrent copies from mixing files. A process crash may
  leave a stale cache lock; cache maintenance may remove it, but normal loading must not bypass a
  live lock.
- Codex `auth.json` intentionally remains a link to the user's Codex authentication file, as required
  by the local credential bridge. Runtime Session files and configuration remain Workflow-private;
  only authentication is shared. Copying auth would create stale, independently mutable credentials
  and is not part of this storage isolation decision.

## Durable `reuse_by_agent`

`launch_agent` exposes `sessionPolicy: "reuse_by_agent"` with the following semantics:

1. Persist the delegated Agent's child `workflowRunId`, `systemSessionId`, and `RuntimeSessionRef` as
   one resumable reference.
2. A later `reuse_by_agent` launch continues that original child Workflow by appending a TaskRun;
   completed TaskRuns remain terminal and are not executed again.
3. Validate Agent, Runtime descriptor, Workflow owner, system Session, workspace transition, and
   native Session file using the same rules as direct Runtime restoration.
4. Add tests proving repeated delegation keeps the same child `workflowRunId` and
   `systemSessionId`, while `fresh` continues to create both anew.
5. `fresh` remains the explicit way to create a new Child Workflow and Runtime Session.

Workflow state, TaskRuns, Human Interactions, results, definition identity, and the Root tree event
log are stored beneath `state/workflows/<workflowRunId>/`. Definitions persist only stable
`id`/`version` metadata; functions, closures, and Zod schemas are supplied again by the Root
Definition passed to `PragmaApp.resume()`.
