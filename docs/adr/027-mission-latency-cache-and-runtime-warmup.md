# ADR 027: Mission latency cache and Runtime warmup boundaries

- Status: Accepted
- Date: 2026-07-29

## Context

Desktop Mission traces showed that projection into the UI takes only 0–2 ms, while a new Mission
spent roughly 1 second checking storage, 4–5.5 seconds compiling, 2–5 seconds initializing a
Runtime, and 7–8 seconds waiting for the model's first token. Follow-up turns repeated about four
seconds of compilation even though an `ExpertSession` already pinned the compiled execution
definition.

The compiler also repeated source parsing, artifact hashing, resource resolution, and environment
work. Runtime adapters reconstructed MCP tool registries for sessions with identical immutable MCP
configuration.

## Decision

### Follow-up Session fast path

A live Mission `ExpertSession` is authoritative for follow-up turns while its compilation identity
matches the Mission. The identity includes the immutable Project revision, executor reference,
system Expert fingerprint, tool permission mode, and model override.

Follow-up skips compilation on an identity hit. A miss recompiles. If the resulting execution
definition fingerprint differs from the live Session fingerprint, Desktop closes the old Session
and creates a successor rather than mutating a running `ExpertSession`.

### Compiler-owned Blueprint cache

`@pragma/interpreter` owns:

- the cache key and compiler version;
- the serializable Blueprint schema and validation;
- L1 memory eviction and concurrent-load coalescing;
- reconstruction, corruption handling, and fail-open behavior.

The Host implements only `PragmaBlueprintCacheStore` byte `read`, `write`, and optional `remove`.
Desktop stores L2 entries below `~/.pragma/cache/compiler-blueprints/sha256/`. Other Hosts may use
memory, a directory, a database, or object storage without changing compiler semantics.

The Blueprint contains normalized immutable DSL resources, relative provenance, artifact hashes,
and diagnostics. It never contains an `ExpertSession`, Runtime session, resolved secret, mutable
plugin instance, or other execution state. The source identity must name immutable content, such as
a Project `snapshotHash`. Compiler-version changes produce a new key.

Open immutable projects have a bounded service-level LRU. Validation is single-flight per project.
Resource, plugin, and declarative dependency resolution is promise-memoized during one compile.
Independent plugin, Runtime, Capability, and Context Store resolution starts concurrently after a
cache miss. Artifact hashes from the loader are passed to adapters as verified values instead of
being recalculated.

### Storage admission

Desktop creates one `StorageCapacityGuard` from the startup maintenance result. A fresh, below-soft
limit snapshot admits writes without rescanning the Pragma home. The guard refreshes in the
background, coalesces concurrent refreshes, synchronously refreshes stale or pressured snapshots,
and preserves the hard-limit cleanup behavior.

### Runtime reuse

Superseded in detail by ADR 028. Desktop owns one reference-counted MCP connection pool shared by
compiler live checks, Capability workflows, and all four Runtime adapters. Pooling is per server
connection so consumer-specific server IDs, tool projections, and approval policies do not prevent
reuse. External connections use a stable, redacted fingerprint; in-process connections use object
identity because functions must not be merged by serialization. Idle connections are bounded and
expire.

Sharing one Codex app-server process across Missions is not adopted. ADR 026 and the storage rules
require each Runtime Context to have a private `CODEX_HOME`, `CODEX_SQLITE_HOME`, session tree,
configuration, and logs. A single process has process-wide environment and configuration and would
therefore weaken isolation, complicate ownership and cancellation, and risk cross-Context state.
Each Mission continues to own an independent Codex thread and private process. Only explicitly
rebuildable caches and upstream MCP connections are shared. A future multiplexed Runtime protocol may
revisit this if it can bind home, credentials, tools, cancellation, and accounting per thread.

### Latency observations

The diagnostic timeline distinguishes:

1. `mission.message_accepted`;
2. `mission.prepare_phase` for storage, compile/cache, binding, Session open, and prompt;
3. `runtime.model_request_dispatched`;
4. adapter ACK (`runtime.codex_request_acknowledged` or
   `runtime.qodercli_request_acknowledged`);
5. `runtime.first_protocol_event`;
6. `runtime.first_reasoning_delta`;
7. `runtime.first_text_delta`;
8. `mission.first_ui_projection`;
9. Renderer `mission.first_ui_token_received` and `mission.first_ui_token_painted`;
10. `mission.final_result`.

No prompt, model output, token, credential, or raw MCP configuration is logged.

## Performance gates

Deterministic tests enforce the local overhead gates:

- warm live-Session follow-up admission below 250 ms;
- warm serialized Blueprint load below 200 ms;
- fresh storage admission snapshot below 50 ms.

These gates cover Pragma-controlled overhead and deliberately exclude provider/model TTFT. Release
profiling must group traces by Runtime, model, thinking level, tool count, context length bucket,
Prompt Cache status, and cache-hit tier before changing model defaults or thinking policy.

## Consequences

Warm follow-ups avoid compilation entirely. New Missions and changed definitions still validate
against an immutable cached Blueprint, then create fresh Core objects and mutable Sessions.
Compiler cache corruption degrades to a cache miss. Cache entries remain rebuildable and are pruned
by normal storage maintenance.

Model TTFT remains an external and workload-sensitive component. The new milestones make model,
thinking level, tool count, context length, and Prompt Cache experiments comparable without
misattributing Runtime or UI time to the provider.
