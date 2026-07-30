# ADR 026: Portable Desktop bundles

- Status: Accepted
- Date: 2026-07-29

## Context

Pragma desktop app users need to move a designed Expert, ExpertTeam, or Flow between computers without
copying the whole `~/.pragma` directory. A useful transfer must preserve the selected object,
recursively referenced DSL resources, and safe optional assets while respecting machine-local
bindings and credentials.

Project revisions, Runtime state, Missions, and credentials have different ownership and lifecycle
rules. Treating a home-directory backup as an import format would bypass those boundaries and make
conflict handling, schema validation, and recovery unsafe.

## Decision

Desktop exports a standard ZIP archive with the `.pragma` extension. Version 1 contains:

```text
bundle.json
pragma.yaml
pragma.lock.yaml
experts/*.pragma.yaml
teams/*.pragma.yaml
flows/*.pragma.yaml
capabilities/*.pragma.yaml
context-stores/*.pragma.yaml
runtime-profiles/*.pragma.yaml
payloads/capabilities/*
payloads/context-stores/*
payloads/plugins/*
layouts/flows/*.json
```

Only files required by the selected root's recursive resource closure are included. DSL rendering
and lock generation remain owned by `@pragma/interpreter`; Desktop does not implement a second YAML
serializer.

`bundle.json` records the root, selected modules, dependencies, a SHA-256 index for every payload,
and a semantic bundle fingerprint. The fingerprint excludes export time and source project identity,
so identical portable content has the same identity.

The export dialog enables capabilities, user plugins, and Flow layouts by default. Knowledge-base
content is disabled by default. The following are never bundled:

- credentials, API keys, plugin secret values, and OAuth state;
- Runtime sessions, ExpertSessions, Executions, Missions, usage records, and memory state;
- workspace files or arbitrary absolute filesystem paths;
- machine-level Runtime installations or provider accounts.

A capability definition containing a local absolute path is represented as a dependency but its
definition and payload are not exported. Host Capability and ContextStore bindings are stripped
from the rendered DSL, and RuntimeProfile config is reduced to Runtime, provider, model, and
thinking-level identity. Plugin config containing a machine-local path is rejected.

Import is an installation transaction with a durable
`pragma.bundle-installation/v2` record. Its state is one of `installing`, `needs_setup`, `ready`, or
`failed`. Version 2 records every per-resource conflict decision and the source-to-local resource
mapping. Version 1 catalogs are upgraded through the adjacent Core migration chain and the atomic
state-migration journal. The source archive is retained while setup or recovery is required and
removed after the installation becomes ready. Installation records and retained archives are
recoverable state under `~/.pragma/state/bundle-installations/`; bundle payloads are not
authoritative application data.

Import performs these steps:

1. Validate extension, archive and expanded size limits, path safety, manifest schema, file hashes,
   canonical DSL, lock, root identity, and resource count.
2. Require an explicit `update` or `copy` decision independently for every resource whose identity
   or normalized name conflicts.
3. Auto-reuse exact local dependencies by semantic fingerprint.
4. Install included portable capabilities, knowledge bases, and user plugins where possible.
5. Rewrite DSL bindings to the selected or installed local objects.
6. Publish one immutable project revision and restore optional Flow layouts.
7. Persist unresolved Runtime/model, capability, knowledge-base, plugin, and secret dependencies as
   `needs_setup`.

`copy` allocates a new ID only for each resource assigned that action. `update` retains the matching
local identity for each resource assigned that action, including name matches. One imported graph
may mix both actions; Desktop builds one complete source-to-local map and rewrites typed DSL
identity and reference fields before publishing. Opaque plugin config, Flow input values, prompts,
and JSON Schema content are never searched and replaced.

The user-facing import and export dialogs are separate. Import first validates a selected or
dragged file, then resolves conflicts, then presents one unresolved binding per screen, and finally
shows a review step before starting the installation transaction. Runtime and model are separate
selections. Runtime availability is refreshed when a Runtime binding screen opens, can be refreshed
manually, and is updated again when a Runtime model-catalog notification arrives.

Imported resources in an installation that is not `ready` are not executable. Desktop enforces this
when creating a Mission and again immediately before running or continuing one. Interrupted
`installing` records become `failed` on startup. Retrying a copy import first rolls back only the
resources owned by that installation; retrying an update import requires update mode and reapplies
the same local identities. Automatic rollback is refused if it could overwrite existing resources
or remove files referenced by retained resources.

## Consequences

- A bundle is a portable, validated artifact rather than a storage backup.
- Safe resources require little or no setup on the target computer.
- Users must explicitly rebind machine-local resources and re-enter secrets.
- Future bundle formats require a new manifest schema and an explicit migration or offline upgrade
  path; bundle versions are independent from DSL `apiVersion` and host-state `schemaVersion`.
- The import catalog is authoritative for execution gating and must remain consistent with project
  revisions.
