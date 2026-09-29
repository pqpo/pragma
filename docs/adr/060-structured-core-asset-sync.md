# ADR 060: Structured core asset synchronization

Status: Accepted

## Context

The unused core asset synchronization protocol serializes the entire asset collection into one
JSON file. Git diffs are difficult to review, binary Skill files cannot be represented naturally,
and unreferenced non-Skill capabilities are omitted. Automatic backup paths can bypass autoPush.

## Decision

Use an exclusive `pragma-sync/` tree with a small version marker, categorized Interpreter YAML,
native Knowledge and Skill files, and a generated Chinese index. Stable IDs own paths. Metadata
contains no content hash inventory; decode calculates hashes from actual files and Git modes.
Keep logical asset reconciliation and group Flow/layout and Capability/binding/definition choices.
Use shared Desktop internal transfer, readiness and publication primitives in `features/asset-transfer/`
with Bundle, keeping Bundle copy
and installation semantics distinct from sync's identity preservation. Prepare the complete
incoming graph before mutation and persist a replayable, locked restore journal. Retain credentials
locally and report unavailable dependencies using readiness diagnostics. Honor autoPush at the
explicit automatic entry point. Use tested system Git identity and never force push.

## Cutover and compatibility

There are no users of the previous core sync protocol. The authorized cutover introduces new
configuration, state, journal and repository namespaces; it neither reads nor migrates old sync
data. Old repository paths remain intact. This exception is limited to this unused synchronization
protocol. DSL, Bundle, Capability and Knowledge storage retain their existing upgrade policies.
The maintainer explicitly confirmed in the implementation request that the existing giant JSON sync
has no users and authorized a direct switch without compatibility. This follows the experimental
protocol cutover rule in AGENTS.md; no low-usage inference or general domain migration exemption
is intended. A previously initialized new repository with a missing or unsupported marker fails closed.

Interrupted restoration that detects a user edit retires its journal into persistent logical asset
conflicts, advancing only completed stages. Keep-local, keep-Git and explicit restore use the normal
reconciliation path; unrelated changes continue. Removing configuration or selecting another source
cancels unfinished stages, retains all already published local assets, and removes the old operation
under the sync lock. Reconfiguration compares the retained assets against the selected repository.

## Verification

Codec tests cover readable YAML/native files, binary bytes and modes, manual file additions and
removals, stable paths, invalid input and credentials rejection. Real isolated data roots and a
real Git remote cover identity-preserving round trips, idempotence, credential preservation,
automatic upload, interrupted publication replay, local concurrency and incoming restore followed
by failed push. Existing Bundle and individual asset Git tests remain required regression gates.
