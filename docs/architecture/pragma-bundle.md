# Portable `.pragma` bundles

The `.pragma` contract belongs to `@pragma/interpreter`, not to a particular Host. A Host supplies
storage and environment adapters; it does not define a different archive with the same version.

```text
Host objects / compiled objects
  -> Interpreter selects the root dependency closure
  -> canonical portable YAML + lock + project artifacts
  -> typed asset requirements + optional Host payloads
  -> pragma.bundle/v2 ZIP
  -> Interpreter verifies and loads
  -> Host explicitly binds requirements into an overlay
  -> target-scoped validate + compile
  -> Core Expert / ExpertTeam / Flow or a managed ContextStore
```

## API example

```ts
import {
  exportPragmaBundle,
  loadPragmaProject,
  type PragmaBundleBindingHost,
} from "@pragma/interpreter";

// A compiled object carries Interpreter provenance. Only the root and its transitive
// dependencies are exported. A versioned serializer registry is required instead when
// the object was created programmatically.
const exported = await exportPragmaBundle({
  roots: [compiledExpert.value],
  host: {
    async exportPayload({ requirement }) {
      if (requirement.kind !== "plugin") return undefined;
      return await pluginStore.exportPortablePayload(requirement.contract);
    },
  },
});

// `source` can also be { kind: "file", path: "/absolute/example.pragma" }.
const project = await loadPragmaProject({
  kind: "bundle",
  source: { kind: "bytes", bytes: exported.bytes },
});

const root = project.bundle!.manifest.roots[0]!;
const before = await project.prepareCompile(root, compileHost);
if (before.status === "needs_binding") {
  renderDiagnostics(before.requirements, before.diagnostics);
}

const binder: PragmaBundleBindingHost = {
  inspect: async ({ requirement, payload }) => assetStore.inspectCandidates(requirement, payload),
  bind: async ({ requirement, candidateId, payload }) =>
    // This explicit call is allowed to install a payload or persist a selected binding.
    await assetStore.bind(requirement, candidateId, payload),
};

const selected = {
  "req-1234": "local-runtime:codex",
  "req-5678": "local-plugin:example",
};
const binding = await project.bindEnvironment(root, binder, selected);
const prepared = await project.prepareCompile(root, compileHost, binding.overlay);
if (prepared.status !== "ready") throw new Error("Bundle is not executable in this environment");

await run(prepared.compiled.value);
await project.dispose();
```

`validate()` is a full portable-project health check. `validateFor()`, `inspectEnvironmentFor()`, and
`prepareCompile()` operate on one root and its dependency closure, so an unrelated unavailable
resource cannot block an otherwise independent executor. Compiler compatibility, lock integrity,
source topology, resource identity ambiguity, and bundle integrity remain fail-closed boundaries.

## Host boundary

Interpreter-owned:

- manifest Schema, version declaration, ZIP codec, safety limits and fingerprints;
- dependency-closure selection, normalized DSL and lock generation;
- requirement descriptions and deterministic portable binding slots;
- payload byte transport, extension required/optional policy;
- binding overlay application, target-scoped validation and compilation.

Host-owned:

- filesystem/database/object-store persistence and conflict decisions;
- candidate discovery, permission prompts, payload installation and credentials;
- mapping local assets into binding records, Runtime resolvers and plugin resolvers;
- UI, transaction journals, backups, rollback, retention and audit.

The bundle never makes the Host's storage identifier authoritative. The portable requirement is the
contract; each Host decides how it satisfies that contract.

Bundle roots are limited to `Expert`, `ExpertTeam`, `Flow`, and `ContextStore`. Version 2 adds the
fourth root kind. The decoder preserves the historical v1 schema, verifies a v1 archive against its
original fingerprint, and then upgrades the manifest in memory. Unknown future versions fail
closed.

## Exported project layout

The Bundle entry file remains small. `project/pragma.yaml` contains only the Bundle metadata and
relative `imports`; each selected resource is emitted separately below its resource-kind directory.
For example:

```text
project/pragma.yaml
project/experts/1h2j3k4m5n6p7q8r.pragma.yaml
project/flows/3h4j5k6m7n8p9q0r.pragma.yaml
project/runtime-profiles/7h8j9k0m1n2p3q4r.pragma.yaml
project/pragma.lock.yaml
```

This keeps large Expert instructions and definitions out of the entry file while preserving a
portable, directly loadable Pragma project.
