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

`RuntimeAdapter.createSession()` requires a `RuntimeSessionOwner` with `workflowRunId`. Restoring a
native session additionally requires its original `systemSessionId` and `RuntimeSessionRef`. Core
validates Workflow, system session, Agent, runtime descriptor, and native reference before a concrete
runtime validates its native session file. Restoration never falls back to a new session.

## Consequences

- Workspaces contain task-required files only.
- Moving a session to another workspace updates `currentWorkspace` and `workspaceHistory` without
  changing its physical storage directory.
- `ExpertAgent.createSession()` remains temporarily available but is deprecated and requires an
  explicit owner.
- `PragmaApp.resume()` and a global native-session index remain future work.
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

## Deferred: restore `reuse_by_agent`

`launch_agent` previously exposed `sessionPolicy: "reuse_by_agent"`. It was removed in this phase
because every delegation creates a new child Workflow, while a Runtime Session may belong to only
one Workflow. It must not be restored by passing a previous child Workflow's native Session ref to a
new child Workflow.

Restore this capability after `PragmaApp.resume()` exists, with the following semantics:

1. Persist the delegated Agent's child `workflowRunId`, `systemSessionId`, and `RuntimeSessionRef` as
   one resumable reference.
2. A later `reuse_by_agent` launch resumes that original child Workflow through
   `PragmaApp.resume()`; it does not create a new Workflow around the old Session.
3. Validate Agent, Runtime descriptor, Workflow owner, system Session, workspace transition, and
   native Session file using the same rules as direct Runtime restoration.
4. Add tests proving repeated delegation keeps the same child `workflowRunId` and
   `systemSessionId`, while `fresh` continues to create both anew.
5. Reintroduce `reuse_by_agent` in `AgentLaunchSessionPolicy`, the tool schema, examples, and usage
   documentation only after those tests pass.
