---
name: manage-pragma
description: Manage Pragma Experts, Teams, Flows, Evaluations, Missions and Automations, and discover their Host resources through authorized pragma manage CLI commands.
---

# Manage Pragma

Use `pragma manage` through the Runtime's process tool. This version requires the current
Execution's authorized command channel; loading this Skill does not grant access. If the command
or endpoint is missing or revoked, report its diagnostic. Never edit authoritative Pragma storage.

## Choose the relevant workflow

Read only the references needed for the user's task:

- [DSL](references/dsl.md): create or update Experts, ExpertTeams and their dependencies using file drafts.
- [Flow](references/flow.md): build or repair graphs through incremental typed draft operations.
- [Evaluation](references/evaluation.md): test an exact committed Flow and save an independent Evaluation.
- [Resources](references/resources.md): discover workspaces, home task presets and ready knowledge stores.
- [Missions](references/missions.md): create persistent tasks, query work, send follow-ups or interrupt them.
- [Automations](references/automations.md): save schedules and Host bindings, enable/disable, delete or reset continuity.

Read Resources before choosing Host bindings for a Mission or Automation. Use `pragma manage dsl
resources list|read` for canonical DSL refs; Host store IDs and home presets are separate identities.
Flow and Evaluation are independent transactions. Create tests only when requested. Persistent
Missions are separate tasks and do not replace current Execution subagent lifecycle tools.

## Command and approval rules

Read the relevant subcommand's `--help` for current fields. Pass bounded JSON using `--input FILE`
or `--input -`, with request files in the authorized workspace. Use `--format json`, bounded
pagination, and the exact draft or Project revision returned by the Host.

Shell permission does not approve publication or other managed mutations. Preserve Host approval;
`input_required` returns control to the owning Execution, and the CLI cannot approve for the user.
Reuse a stable `--request-id` UUID only with identical command and input to retrieve its original
receipt. After uncertain completion inspect the receipt/state before issuing another mutation.
On conflicts reread and explicitly reapply intended changes. Cancellation does not undo publication
or accepted work. Explicit recovery preserves data, requires separate approval, and cannot take
over a known foreign owner; subsequent publication still requires its own approval.
