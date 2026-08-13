# Runtime Feature Framework

The Runtime Feature Framework makes integration completeness executable. The authoritative feature
catalog is `packages/core/src/runtime/features.ts`; adapter descriptors no longer maintain a second
set of capability booleans.

## Lifecycle and ownership

```text
defineRuntimeDriver(features, provider methods)
  -> validate every mandatory slot and direct method contract
  -> derive public descriptor capabilities
  -> create Core Runtime Session resource scope
  -> run enabled Session feature hooks in catalog order
  -> create or restore the provider-native Session
  -> transfer resource ownership to the live Session
  -> for each turn:
       create turn resource scope
       run enabled turn feature hooks in catalog order
       call provider startTurn and map provider-native events
       release turn resources in reverse order
  -> stop the provider-native Session/process
  -> release Session feature resources in reverse order
```

Feature hooks receive provider-neutral lifecycle context and may return provider-specific prepared
data. Results are stored by feature name and exposed as immutable snapshots. A concrete adapter reads
only the entries it owns with `readRuntimePreparedFeature()`. Core does not interpret provider argv,
environment fragments, plugin layouts or event protocols.

`RuntimeResourceScope.acquire()` registers disposal at the acquisition boundary. This covers partial
initialization, normal close and disposer failure through one path. `transfer()` closes registration
after preparation so late resources cannot escape ownership. Receipts expose labels, order and final
state for diagnostics without exposing the resource value.

## Declaration and public capabilities

Every catalog slot has exactly one status:

- `supported`: implemented and backed by executed evidence;
- `degraded(reason)`: usable with a stated limitation or awaiting real-Runtime verification;
- `unsupported(reason)`: not implemented or unavailable from the provider;
- `notApplicable(reason)`: irrelevant to this Runtime product shape.

Core treats `supported` and `degraded` as enabled behavior. Placement (`targets` and
`executionLocations`) remains explicit in the driver descriptor. Streaming, MCP, resume, cancellation,
close, context inspection and compaction capabilities are derived from the feature set. Direct method
contracts such as model discovery, cancellation, steering, context inspection and close are checked
at registration and, where TypeScript can express the relationship, at compile time.

## Conformance and evidence

`assertRuntimeConformance()` and `describeRuntimeConformance()` verify declaration and observation
invariants. Enabled text streaming requires a delta before the completed message and exactly one final
run event. Tool calls require one start and one terminal event. Capability projections cannot diverge
from the feature declaration.

The evidence protocol is `pragma.runtime-probe-evidence/v1`. It stores Runtime and probe identity,
version/platform/authentication context, a safe command summary, staged assertions and normalized
observations. Sensitive keys, known credential shapes, registered secrets and workspace/home paths
are replaced before schema validation and atomic archival.

MCP and Skills use three independent stages:

1. Materialized: registration, config or files were created.
2. Discovered: the native Harness exposed or acknowledged the capability.
3. Executed: a harmless real invocation completed and its marker was observed.

Materialized or Discovered evidence alone does not justify `supported`.

## Adding a Runtime

1. Declare every slot with `defineRuntimeFeatures()`; do not copy capability booleans into the
   descriptor.
2. Put reusable leases, registrations, relays and listeners in `ctx.resources`; keep native protocol
   setup in the Runtime package.
3. Add Session or turn hooks for lifecycle-bound features and consume their prepared results from the
   native method.
4. Register declaration and fixture observations with `describeRuntimeConformance()`.
5. Run one feature probe at a time, inspect the redacted evidence, then run `full` as the combined
   smoke. Never commit credentials or unreviewed raw logs.
6. Run `pnpm runtime:features:check`; catalog changes require regenerating the integration checklist.

See [ADR 041](../adr/041-runtime-feature-framework.md) and the
[Runtime Adapter integration checklist](../conventions/runtime-adapter-integration-checklist.md).
