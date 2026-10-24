# ADR 078: Expert-owned native Harness permission modes

## Status

Accepted, 2026-10-24. Supersedes ADR 077 only for the selection of Harness, model,
thinking level and native permission mode on subsequent execution requests.

## Decision

Pragma coordinates Harnesses and preserves their native permission boundaries.
Permission modes belong to an Expert's execution profile, next to its Harness and
model. Home, Mission options, Automations and global settings do not select modes.
Each adapter advertises its own mode IDs, default, descriptions and availability;
there is no cross-Harness three-mode enum. The default is native full access.
Plan is not offered. A read-only option requires an actual native sandbox.

The initial catalogs expose the integrations already present:

| Harness     | Default                                | Other available modes                          | Visible but unavailable |
| ----------- | -------------------------------------- | ---------------------------------------------- | ----------------------- |
| Codex       | Full access                            | Ask for approval, Read only                    | Approve for me          |
| Claude Code | Bypass permissions                     | Default, Auto                                  | —                       |
| Qoder CLI   | Bypass permissions                     | Default, Auto                                  | —                       |
| Antigravity | Full access                            | Ask for approval (Host Hook bridge)            | Native Auto             |
| OpenCode    | Full access                            | Ask for approval, Auto-approve workspace edits | —                       |
| Pi          | Full access (host process permissions) | —                                              | —                       |

OpenCode's edit auto-approval continues to deny shell execution. Antigravity's
older compatibility auto-approval implementation remains an adapter implementation
detail and is not presented as native Auto. Classifier modes require a supporting
installed Harness version; native configuration rejection must surface as an error.
Unavailable or unknown mode IDs fail closed. Switching Harness resets mode to that
Harness's default. No permission classifier or general command sandbox is added to
Pragma.

New messages and manual retries overlay the latest reachable Expert execution
profiles on the Mission's pinned resource graph. Instructions, tools, Skills,
knowledge revisions and the Project revision remain pinned. Removing an Expert's
explicit execution profile restores the system default. An execution already
running keeps its compiled profile and binding. A later profile change follows
existing definition/context successor handling; it must not redispatch an accepted
turn. System-default Experts also include the current default Harness in compilation
identity when the Host follows live defaults, so warm and cold continuations follow
default changes. The Node Host retains its existing policy of pinning an implicit
system Runtime in the saved source. Returning to an
earlier profile uses the same succession rules. Mode participates in adapter caches, compilation identity, Expert definition
fingerprints and native Runtime Context identity. Different modes cannot share the
same native Session identity. Delegated Experts bind their own modes independently.

Native read-only describes native filesystem execution. It does not revoke managed
MCP capabilities: explicit tool allowlists, business approvals, credentials and
Host-owned mutation rules remain independently authoritative. The editor explains
this boundary. Full access also does not bypass these business approvals.

## Persistence and recovery

RuntimeProfile config stores an optional opaque `permissionModeId`; omission means
the adapter's native full-access default. Desktop stores it in the Expert's model
configuration. Mode changes publish new resources rather than editing immutable
Project revisions. The DSL API is v6 and compiler version is 10.

Mission v11→v12, Settings v2→v3 and Automation binding v2→v3 retire the old uniform
permission option. System Expert customization v9→v10 preserves model settings;
missing mode uses the native default. Execution snapshot v1→v2 upgrades its embedded
DSL. Existing adjacent migrations remain supported. First-access upgrades retain
backups and journals under owner locks. Replay validates the existing version and
owner before replacing data; a missing snapshot target is recovered from its
prepared journal and retained original backup. Future/corrupt data and conflicting
journals are rejected and preserved.
Real pre-change writer fixtures accompany the Mission and Settings migrations;
the existing v9 System Expert fixture exercises that upgrade as well.

## Verification boundary

On this development host, Codex 0.159.0-alpha.3's native `sandbox -P :read-only`
read a synthetic file successfully and rejected a shell write with
`Read-only file system`; no output file was created. This verifies the local native
sandbox, not an authenticated end-to-end model turn. Other Harness modes use the
existing adapter integrations and their contract tests; no new real-service smoke
is claimed for those Harnesses.
