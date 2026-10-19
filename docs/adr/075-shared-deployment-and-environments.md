# ADR 075: Shared deployment and environment services

## Status

Accepted for Issue #399 stage 1 and shared configuration closeout (2026-10-19).

## Decision

`@pragma/local-host/deployment` owns Project publication, Capability mutation and activation,
managed ContextStore writes, Plugin installation/configuration, Bundle installation/export,
model connections, immutable Runtime Environments, dependency readiness and installation repair.
Desktop calls these implementations directly. Its dialogs, IPC, platform SecretStore setup,
concrete Runtime factories and editor/default-resource/system-expert identity policy remain adapters.
A Capability consumer catalog supplies only product-owned resource and tool-reference data;
it does not implement activation or recovery. Generation model directories and connection probes
are narrow injected runtime capabilities, not complete application services.

Interpreter remains the sole owner of Bundle and DSL syntax, archive integrity, closure analysis,
typed reference rewriting and compilation. Its decoded result exposes the verified source bytes,
so Host recovery archives exactly what Interpreter validated, even if the source file changes.
This change introduces no Bundle or DSL version.
Mission application, compilation, ownership, durable delivery and recovery remain the existing
shared implementation. No second execution kernel, CLI deployment commands, Memory worker or
Linux support is introduced.

The browser-safe `@pragma/local-host/deployment-contracts` entry owns the Host DTOs that compose
Interpreter AST schemas with Shared resource schemas. It imports only `zod`, Shared,
`@pragma/interpreter/ast` and `@pragma/built-in-agents/contracts`; it must never reach the Node entry. Desktop shared/preload/renderer may
consume this one entry, with ESLint and browser-bundle verification enforcing the distinction.
Shared retains runtime-neutral resource and execution protocols; Interpreter does not acquire
Host installation protocols to work around a browser boundary.

## Installation identity and recovery

Installation records/catalogs advance from v8 to v9 through the existing static adjacent migration
chain. v8 records preserve every existing field; migration does not invent request identity or
reconstruct missing historical write intents. Existing namespace and historical migration chains
remain supported, with locked atomic migration, backups and stable migration journals.

A caller supplies a stable request UUID for retries. An omitted UUID means a new operation for
legacy callers. Request identity is distinct from archive/content fingerprints and from an explicit
copy import. The request fingerprint excludes source path and credential values. A completed
request returns its recorded installation; different deployment decisions under the same UUID fail.
Changing credentials is an explicit repair operation rather than a changed installation retry.

Before asset writes, the installation owns an archive, typed resource mapping and allocated asset
IDs/names. Replay reuses these allocations and verifies existing content instead of generating
another asset. Project publication uses a stable publication UUID so a lost completion response
cannot publish twice. Target conflicts stop recovery; newer edits are not rolled back. Copy cleanup
checks resource revisions, other installations' resource references, DSL references and retained
physical asset bindings before deletion.
For transaction-backed installations, readiness rechecks preserve the last owned publication
revision; a lost publication receipt is recovered by its stable UUID before cleanup comparisons.
Updates are never automatically discarded.

Recovery runs on access to the selected installation. Construction and initialization do not scan
and take over all installations. Legacy interrupted knowledge-base operations retain their existing
recovery algorithm; unsupported legacy interruptions remain visible with explicit retry/cleanup.
Fresh request UUIDs cannot bypass an unfinished legacy owner. Desktop routes such owners through
recheck and offers confirmed safe cleanup; unrecoverable journals retain their data and explain
backup recovery rather than silently creating another installation.
Binding repair has a separate `pragma.bundle-binding-repair/v1` journal, recording validated upserts,
installation mappings and the publication UUID before publication. It contains no plaintext secrets.

## Environment and product behavior

Automatic selection requires one exact candidate. Names can identify conflicts for a human decision;
they never select a Runtime, model or asset. Installation completion and readiness are separate.
Missing dependencies stay persisted and can be repaired without importing again. Diagnosis preserves
Harness, model-catalog, credential and transport failures as distinct causes.

An installation-scoped rebind copies shared dependencies and shared ancestors, delegates reference
rewriting to Interpreter, and updates only that installation's mapping. Shared connection updates
are explicitly shared operations and expose the current consumer impact/fingerprint. Immutable
Runtime Environment revisions and existing Execution/Session bindings are retained; rebinding does
not hot-migrate a running or recoverable Runtime Context. Updating a Runtime Environment head
affects future resolutions of that runtime ID across resources; the previous immutable revision
remains resolvable for existing Execution/Session bindings. Store mutations use revision CAS.

Stored `binding:desktop-*` prefixes and `desktop-managed` markers remain compatible wire values;
they do not give Desktop ownership of the shared installation identity algorithm. Desktop continues
to own its canonical editor identities and default/system-resource selection rules.

The baseline explicitly rejects Bundle Plugin dependencies, despite older documentation claiming
otherwise. The user confirmed retaining that restriction for this stage. Plugin package installation
and configuration writes are shared, but Plugin Bundle import/export is not enabled implicitly.

## CLI configuration closeout

Desktop and CLI construct model-provider and Runtime Environment stores through
`createLocalHostRuntimeConfiguration`. Desktop injects its existing SecretStore and historical
Electron decryptor; CLI uses the same home-scoped SecretStore with the existing native OS keychain.
CLI does not decrypt historical Electron ciphertext or introduce a credential backend. Concrete
adapter factories remain in each app, reading the same saved process-environment policy; PI receives
the shared model-provider registry. CLI binds new contexts through the Environment service and
resolves persisted bindings by exact revision and fingerprint. Mission permission modes select the
adapter permissions without changing Runtime identity. Missing configuration remains an explicit
failure, including model-catalog diagnostics, rather than a fallback to the former fixed adapter list.

A newly allocated run with no prior events can pin its resolved project revision even when CLI
project options were omitted. Existing reservations, attached historical Missions and retries still
require their existing proof rules; resolving the latest project cannot repair a historical binding.
Older CLI Contexts used `createLocalHostRuntimeResolver` static fingerprints (including the original
`codex` → `codex-local` alias). A resolve-only reader retains that exact authority: it is attempted
only for revision 1 after the saved Environment binding is unavailable, and succeeds only when the
historical descriptor/model-catalog fingerprint matches. New bindings always use the Environment
service. Current model/authentication errors, future revisions and unproven fingerprints never use
this reader. No Session identity is rewritten, and there is no hot migration to another Harness.
The historical binding fixture was written by the `eb458180` resolver and concrete adapter with a
deterministic catalog port, rather than by changing a current Environment's version or fingerprint.

No persistent or wire schema changes are introduced by this closeout.

## Verification

Shared service tests exercise real temporary persistence and injected credential/runtime capabilities.
Desktop tests exercise production composition and IPC adapters. Migration evidence must include
historical writer output, current no-op, adjacent/chained upgrade, interrupted-journal replay and
future-version rejection. Engineering tests do not establish real model, native keychain or platform
acceptance; the stage report records those separately.
