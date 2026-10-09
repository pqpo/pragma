# Manage Pragma Missions

Use `pragma manage mission` for persistent Missions. These are separate tasks; they are not the
current Execution's subagents. Read only the needed subcommand `--help`. This version requires
the current Execution's authorized command channel; a Skill does not grant permissions.

For workspaces, home task presets or knowledge IDs, read [Resources](resources.md).
Find exact Expert/Team/Flow refs through `pragma manage dsl resources list`; inspect Flow input
requirements before creating a Flow Mission. Read [Mission operations](missions/commands.md)
for creation, work queries, follow-up and interruption.

Pass bounded JSON using `--input request.json` or `--input -`. Keep request files in the authorized
workspace. Mutations retain Host approval; shell approval does not approve creating a task or
sending instructions. Reuse `--request-id` only for an identical request. `input_required` returns
control to the owning Execution. Cancellation does not undo accepted work.
