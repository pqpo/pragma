---
name: manage-pragma
description: Find and read managed Skills and knowledge bases, revise them through Revision Agents, and manage Pragma Experts, Teams, Flows, Evaluations, Missions and Automations through authorized CLI commands.
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
- [Skills](references/skills.md): find Skills (Capabilities), read their current SKILL.md and package files, diagnose or delegate revisions.
- [Knowledge](references/knowledge.md): find formal knowledge bases, list/search/read their documents, or delegate revisions.
- [Resources](references/resources.md): discover workspaces, home task presets and ready knowledge stores.
- [Missions](references/missions.md): create persistent tasks, query work, send follow-ups or interrupt them.
- [Automations](references/automations.md): save schedules and Host bindings, enable/disable, delete or reset continuity.

Read Resources before choosing Host bindings for a Mission or Automation. Use `pragma manage dsl
resources list|read` for canonical DSL refs; Host store IDs and home presets are separate identities.
Flow and Evaluation are independent transactions. Create tests only when requested. Persistent
Missions are separate tasks and do not replace current Execution subagent lifecycle tools.

## Command and approval rules

Use the examples in the relevant reference first. Read a subcommand's `--help` or `--describe`
only when a required field, default or response is unclear; do not prefetch help for every command.
Pass bounded JSON using `--input FILE`
or `--input -`, with request files in the authorized workspace. Use `--format json`, bounded
pagination, and the exact draft or Project revision returned by the Host.
Use `--describe --format json` when input/output schemas or defaults are needed; it works without
a Host connection. Default views are summaries. Request content only when needed. Copy returned
`continuation.command` and `continuation.input` verbatim into the next CLI call. Do not compute offsets.
Fresh queries use a new request ID (omitting the option generates one); reuse an ID only to replay
the identical request after uncertain transport completion. Read-only query receipts also replay old results.
Inspect `error.code` and `error.details.recovery`; an empty successful list only means no matches.
Never scan `.pragma`, Runtime caches or historical revision drafts to locate formal content.

Shell permission does not approve publication or other managed mutations. Preserve Host approval;
`input_required` returns control to the owning Execution, and the CLI cannot approve for the user.
Reuse a stable `--request-id` UUID only with identical command and input to retrieve its original
receipt. After uncertain completion inspect the receipt/state before issuing another mutation.
On conflicts reread and explicitly reapply intended changes. Cancellation does not undo publication
or accepted work. Explicit recovery preserves data, requires separate approval, and cannot take
over a known foreign owner; subsequent publication still requires its own approval.
