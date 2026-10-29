# ADR 077: Mission execution dependency snapshots

## Status

Accepted, 2026-10-23. Superseded in part by [ADR 078](078-expert-native-harness-permissions.md): subsequent requests use current Expert execution profiles while other dependencies remain pinned. The requested scope is new Missions; historical Missions do not need snapshot reconstruction.

## Decision

User-facing Missions with an ExpertSession freeze mutable execution inputs immediately before their first compilation,
before any ExpertSession or native Session is created. The immutable snapshot lives in the Mission
owner directory as `execution-snapshot.json`, with its own `pragma.mission-execution-snapshot/v1`
schema. It records the pinned Project Revision and executor identity, reachable system resources,
system fingerprints, declarative system execution profiles, and resolved Capability revisions.
Profiles capture the underlying defaults, including the selected Node built-in Runtime, before
applying any Mission model override. Each request overlays its current Mission option; clearing
the option restores the pinned base model. Stateless Flow Missions do not create or read these
snapshots and continue to resolve active dependencies on each run.
No credential values, executable closures, compiled Agent instances or native history are serialized.

Subsequent compilation and cold recovery read the snapshot, not the current System Expert Registry
or the Capability's active revision. Host binding resolution and capability contributions must use
the same pinned revision as identity checks. External Agent edits, newly attached Skills and newly
activated Skill revisions therefore apply to new Missions. Existing Project Revision and Runtime
Context identity owners remain authoritative; this adds no parallel execution kernel.

Snapshots are committed under a per-snapshot file lock using atomic replacement before execution.
Failed initial execution reuses that snapshot. Unknown versions, malformed data, identity conflicts,
unavailable historical dependencies and definition mismatches preserve the original Session and
surface an error; they must not silently create a successor using today's configuration.
Explicit Mission option and context-mount changes retain their existing behavior and are outside
external definition freezing. Credentials remain in the current credential store. A Secret/Plugin refresh
with an unchanged execution definition releases the idle runtime handle and restores the same
Session and native identity with refreshed bindings. A busy or unavailable environment reports an
error and preserves its conversation.

Snapshots are strong references during Capability and Plugin deletion checks. Ordinary Skill
publication retains existing immutable revision directories. Mission deletion already owns
the directory and therefore retires its snapshot without introducing another global store.

## Historical data and boundaries

### Memory extraction extension (2026-10-29)

Direct Knowledge/Skill Memory Missions now use the same first-compilation dependency snapshot owner.
Desktop previously limited snapshot creation to user-facing origins, leaving these system-memory
Sessions unable to recover their original definition after Registry changes. Existing Sessions without
a snapshot still follow the historical path; this extension does not reconstruct absent definitions or
scan owners at startup. Existing snapshot formats and their adjacent migrations are unchanged.

For a Memory Session with a snapshot, a stale Host compilation-identity summary can be reconciled only
when the saved Session definition fingerprint and Core's durable execution environment match the current
pinned compilation. Profile, binding or context-mount changes retain their existing rejection policy.

### Existing data

This is a new, independently versioned file namespace. Existing Mission, Execution and ExpertSession
schemas are unchanged. Missions with an existing Session and no snapshot keep their historical
path; no startup scan, inferred old configuration, data deletion or historical migration is performed.
This is the user's explicit new-Mission-only scope, not a claim that historical user data is absent.
The new snapshot's future schema changes require the normal adjacent migration policy.

Controller-only Session execution and recovery use the same Mission snapshot owner, even when there is
no product Mission envelope. Catalog and preview compilation remain live and never create Mission
snapshot directories. Host-supplied system execution ports provide declarative resources and
profiles for freezing; all snapshot-enabled Sessions retain the no-successor guard, including
custom ports whose implementation cannot reproduce their original definition.

This change fixes configuration/Skill publication within the installed application. It does not
guarantee restoration after deletion of native Session files, removal of the Runtime executable,
or incompatible application/compiler upgrades. Those failures preserve stored data and report
the unavailable dependency instead of replacing the conversation.

## Verification

Real Host Skill bindings pass through Interpreter compilation for initial execution, publication,
warm continuation, release and cold continuation. Tests assert the Skill revision and contents,
system definition, ExpertSession ID, root Context ID, native Session identity and retained native
history. New Missions use the newly active revision. Failure tests cover unavailable pinned
resources, invalid snapshot versions and the kernel's refusal to replace a pinned definition.
