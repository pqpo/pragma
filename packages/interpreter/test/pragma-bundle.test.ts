import { PRAGMA_DSL_WRITE_API_VERSION, PragmaBundleV1ManifestSchema } from "../src/ast/index.ts";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  createStaticRuntimeResolver,
  snapshotRuntimeFeatures,
  StaticContextStore,
  type Expert,
} from "@pragma/core";
import { createRuntimeTestFeatures } from "@pragma/core/testing";
import { strFromU8, strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  PragmaBundleFormatError,
  decodePragmaBundle,
  DefinitionSerializerRegistry,
  applyPragmaEnvironmentBindingOverlay,
  createEmptyPragmaEnvironmentBindingOverlay,
  exportPragmaBundle,
  encodePragmaBundle,
  formatPragmaYaml,
  localizePragmaBundleResources,
  loadPragmaProject,
  PragmaBundleRequirementSchema,
  PragmaResourceSchema,
  type PragmaBindingRecord,
  type PragmaBundleBindingHost,
} from "../src/index.ts";
import { sha256, stableStringify } from "../src/compiler/compiler-hash.ts";
import { PragmaCompilerV6ResourceSchema } from "../src/compiler-migrations/schemas/v6.ts";

describe("portable .pragma bundles", () => {
  it("verifies a real v1 fingerprint before upgrading the manifest to v2", async () => {
    const fixtureRoot = join(import.meta.dirname, "fixtures", "pragma-bundle-v1");
    const legacy = JSON.parse(await readFile(join(fixtureRoot, "bundle.json"), "utf8"));
    const decoded = await decodePragmaBundle({
      kind: "bytes",
      bytes: zipSync({
        "bundle.json": strToU8(`${JSON.stringify(legacy, undefined, 2)}\n`),
        "project/pragma.yaml": new Uint8Array(
          await readFile(join(fixtureRoot, "project", "pragma.yaml")),
        ),
      }),
    });
    expect(decoded.manifest).toMatchObject({
      schemaVersion: "pragma.bundle/v2",
      bundleFingerprint: legacy.bundleFingerprint,
    });

    const tampered = { ...legacy, bundleFingerprint: "0".repeat(64) };
    await expect(
      decodePragmaBundle({
        kind: "bytes",
        bytes: zipSync({
          "bundle.json": strToU8(`${JSON.stringify(tampered, undefined, 2)}\n`),
          "project/pragma.yaml": new Uint8Array(
            await readFile(join(fixtureRoot, "project", "pragma.yaml")),
          ),
        }),
      }),
    ).rejects.toMatchObject({ code: "manifest.fingerprint_invalid" });
  });

  it("applies complete manifest invariants before migrating v1 bundles", async () => {
    const fixtureRoot = join(import.meta.dirname, "fixtures", "pragma-bundle-v1");
    const legacy = JSON.parse(await readFile(join(fixtureRoot, "bundle.json"), "utf8"));

    expect(
      PragmaBundleV1ManifestSchema.safeParse({
        ...legacy,
        roots: [legacy.roots[0], legacy.roots[0]],
      }).success,
    ).toBe(false);
    expect(
      PragmaBundleV1ManifestSchema.safeParse({
        ...legacy,
        project: { ...legacy.project, entry: "project/missing.yaml" },
      }).success,
    ).toBe(false);
  });

  it("round-trips a ContextStore as a v2 Bundle root", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-context-bundle-"));
    const entry = join(root, "pragma.yaml");
    await writeFile(join(root, "handbook.md"), "# Team handbook\n");
    await writeFile(
      entry,
      formatPragmaYaml({
        apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
        kind: "Bundle",
        resources: [
          {
            apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
            kind: "ContextStore",
            metadata: {
              id: "w01fppfxrn31gf7v",
              name: "Team handbook",
              description: "Shared knowledge",
              tags: ["handbook"],
            },
            spec: {
              adapter: "pragma.context.file@v1",
              config: { source: { type: "project", path: "handbook.md" } },
            },
          },
        ],
      }),
    );
    const project = await loadPragmaProject(entry);
    const exported = await project.exportBundle({ roots: ["context-store:w01fppfxrn31gf7v"] });
    const decoded = await decodePragmaBundle({ kind: "bytes", bytes: exported.bytes });
    expect(decoded.manifest).toMatchObject({
      schemaVersion: "pragma.bundle/v2",
      roots: ["context-store:w01fppfxrn31gf7v"],
    });
    const loaded = await loadPragmaProject({ kind: "decoded-bundle", bundle: decoded });
    expect(loaded.listResources()).toEqual([
      expect.objectContaining({
        kind: "ContextStore",
        metadata: expect.objectContaining({ name: "Team handbook" }),
      }),
    ]);
    await loaded.dispose();
    await project.dispose();
  });

  it("preserves the Host file Context factory through a binding overlay", () => {
    const store = new StaticContextStore([]);
    const host = applyPragmaEnvironmentBindingOverlay(
      {
        workspace: "/workspace",
        adapterHost: {
          environmentId: "test",
          projectRoot: "/project",
          async resolveBinding() {
            return undefined;
          },
          async resolveArtifact(source) {
            throw new Error(`Unexpected artifact: ${JSON.stringify(source)}`);
          },
          async resolveSecret() {
            return undefined;
          },
          openFileContextStore() {
            return store;
          },
        },
      },
      createEmptyPragmaEnvironmentBindingOverlay(),
    );

    expect(host.adapterHost?.openFileContextStore?.({ rootDir: "/contexts" })).toBe(store);
  });

  it("exports a target dependency closure and loads it directly through the Interpreter", async () => {
    const source = await createProject();
    const project = await loadPragmaProject(source.entry);

    const exported = await project.exportBundle({
      roots: ["expert:1xddvess309a6gme"],
      createdAt: "2026-08-02T00:00:00.000Z",
    });

    expect(exported.manifest).toMatchObject({
      schemaVersion: "pragma.bundle/v2",
      roots: ["expert:1xddvess309a6gme"],
      project: { entry: "project/pragma.yaml" },
    });
    const decoded = await decodePragmaBundle({ kind: "bytes", bytes: exported.bytes });
    expect(strFromU8(decoded.files.get("project/pragma.yaml")!)).toContain(
      "- ./experts/1xddvess309a6gme.pragma.yaml",
    );
    expect(strFromU8(decoded.files.get("project/pragma.yaml")!)).not.toContain("kind: Expert");
    expect(strFromU8(decoded.files.get("project/pragma.yaml")!)).not.toContain("resources:");
    expect(strFromU8(decoded.files.get("project/experts/1xddvess309a6gme.pragma.yaml")!)).toContain(
      "kind: Expert",
    );
    expect(
      strFromU8(decoded.files.get("project/runtime-profiles/knr7p5b7qc55wv92.pragma.yaml")!),
    ).toContain("kind: RuntimeProfile");
    expect(exported.manifest.requirements).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "runtime" })]),
    );
    expect(
      PragmaBundleRequirementSchema.safeParse({
        ...exported.manifest.requirements[0],
        path: [],
      }).success,
    ).toBe(false);

    const loaded = await loadPragmaProject({
      kind: "bundle",
      source: { kind: "bytes", bytes: exported.bytes },
    });
    await expect(access(join(dirname(dirname(loaded.entryFile)), "assets"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await loaded.validate()).toEqual([]);
    expect(loaded.listResources().map((resource) => resource.kind)).toEqual([
      "Expert",
      "RuntimeProfile",
    ]);
    expect(
      await loaded.prepareCompile("expert:1xddvess309a6gme", { workspace: source.root }),
    ).toMatchObject({ status: "needs_binding" });

    const ready = await loaded.prepareCompile<Expert>("expert:1xddvess309a6gme", {
      workspace: source.root,
      runtimes: runtimeResolver(),
    });
    expect(ready.status).toBe("ready");
    if (ready.status === "ready") expect(ready.compiled.value.name).toBe("Writer");
    await loaded.dispose();
  });

  it("validates and migrates a portable project written by an older compiler", async () => {
    const resources = [
      PragmaCompilerV6ResourceSchema.parse({ ...runtimeResource(), apiVersion: "pragma/v4" }),
      PragmaCompilerV6ResourceSchema.parse({ ...expertResource(false), apiVersion: "pragma/v4" }),
    ];
    const lockedResources = resources
      .map((resource) => ({
        ref:
          resource.kind === "RuntimeProfile"
            ? `runtime-profile:${resource.metadata.id}`
            : `expert:${resource.metadata.id}`,
        contentHash: sha256(stableStringify(resource)),
        source: "pragma.yaml",
      }))
      .toSorted((left, right) => left.ref.localeCompare(right.ref));
    const projectFingerprint = sha256(
      stableStringify({
        resources: lockedResources.map(({ ref, contentHash }) => ({ ref, contentHash })),
        artifacts: [],
      }),
    );
    const historical = await encodePragmaBundle({
      manifest: {
        schemaVersion: "pragma.bundle/v2",
        createdAt: "2026-08-11T00:00:00.000Z",
        roots: ["expert:1xddvess309a6gme"],
        project: {
          entry: "project/pragma.yaml",
          compilerVersion: "pragma.dsl/v6",
          projectFingerprint,
        },
        requirements: [
          {
            id: "req-runtime",
            kind: "runtime",
            ownerRef: "runtime-profile:knr7p5b7qc55wv92",
            path: ["spec", "config", "runtimeId"],
            contract: "pragma.runtime@v1",
            required: true,
            name: "Runtime",
            hints: { runtimeId: "codex" },
          },
        ],
        extensions: [],
      },
      files: new Map([
        [
          "project/pragma.yaml",
          strToU8(
            formatPragmaYaml({
              apiVersion: "pragma/v4",
              kind: "Bundle",
              imports: [],
              resources,
            }),
          ),
        ],
        [
          "project/pragma.lock.yaml",
          strToU8(
            formatPragmaYaml({
              apiVersion: "pragma/v4",
              kind: "Lock",
              compilerVersion: "pragma.dsl/v6",
              projectFingerprint,
              resources: lockedResources,
              artifacts: [],
            }),
          ),
        ],
      ]),
    });

    const loaded = await loadPragmaProject({
      kind: "bundle",
      source: { kind: "bytes", bytes: historical.bytes },
    });

    expect(loaded.bundle?.manifest.project).toMatchObject({
      compilerVersion: "pragma.dsl/v6",
      projectFingerprint,
    });
    expect(loaded.listResources().map((resource) => resource.kind)).toEqual([
      "Expert",
      "RuntimeProfile",
    ]);
    expect(await loaded.validate()).toEqual([]);
    await loaded.dispose();
  });

  it("loads a decoded bundle and localizes a target graph without mutating portable resources", async () => {
    const source = await createProject(true);
    const project = await loadPragmaProject(source.entry);
    const exported = await project.exportBundle({ roots: ["expert:1xddvess309a6gme"] });
    const decoded = await decodePragmaBundle({ kind: "bytes", bytes: exported.bytes });
    const loaded = await loadPragmaProject({ kind: "decoded-bundle", bundle: decoded });
    const portable = loaded.listResourceClosure("expert:1xddvess309a6gme");
    const binding = exported.manifest.requirements.find(
      (requirement) => requirement.kind === "binding",
    )!;
    const runtime = exported.manifest.requirements.find(
      (requirement) => requirement.kind === "runtime",
    )!;

    const localized = localizePragmaBundleResources({
      resources: portable,
      manifest: exported.manifest,
      identities: [
        {
          sourceRef: "expert:1xddvess309a6gme",
          targetId: "2222222222222222",
          targetName: "Writer copy",
        },
      ],
      requirements: [
        {
          requirementId: binding.id,
          kind: "binding",
          replacement: "binding:desktop.capability.1",
        },
        {
          requirementId: runtime.id,
          kind: "runtime",
          config: { runtimeId: "pi", providerId: "openai", model: "gpt-test" },
        },
      ],
    });

    const portableExpert = portable.find((resource) => resource.kind === "Expert");
    const localizedExpert = localized.resources.find((resource) => resource.kind === "Expert");
    const localizedCapability = localized.resources.find(
      (resource) => resource.kind === "Capability",
    );
    const localizedRuntime = localized.resources.find(
      (resource) => resource.kind === "RuntimeProfile",
    );
    expect(portableExpert?.metadata.id).toBe("1xddvess309a6gme");
    expect(localizedExpert?.metadata).toMatchObject({
      id: "2222222222222222",
      name: "Writer copy",
    });
    expect(localizedCapability?.kind === "Capability" ? localizedCapability.spec.binding : "").toBe(
      "binding:desktop.capability.1",
    );
    expect(localizedRuntime?.kind === "RuntimeProfile" ? localizedRuntime.spec.config : {}).toEqual(
      {
        runtimeId: "pi",
        providerId: "openai",
        model: "gpt-test",
      },
    );
    expect(localized.unresolvedRequirements).toEqual([]);
    await loaded.dispose();
    await project.dispose();
  });

  it("keeps Host bindings out of portable resources and applies an immutable binding overlay", async () => {
    const source = await createProject(true);
    const project = await loadPragmaProject(source.entry);
    const exported = await project.exportBundle({
      roots: ["expert:1xddvess309a6gme"],
      host: {
        async exportPayload({ requirement }) {
          return requirement.kind === "binding"
            ? { codec: "test.capability@v1", files: new Map([["descriptor.json", strToU8("{}")]]) }
            : undefined;
        },
      },
    });
    const bindingRequirement = exported.manifest.requirements.find(
      (requirement) => requirement.kind === "binding",
    );
    expect(bindingRequirement?.payload).toMatchObject({ codec: "test.capability@v1" });

    const loaded = await loadPragmaProject({
      kind: "bundle",
      source: { kind: "bytes", bytes: exported.bytes },
    });
    const capability = loaded.listResources().find((resource) => resource.kind === "Capability");
    expect(capability?.kind === "Capability" ? capability.spec.binding : undefined).toBe(
      `binding:pragma.bundle.${bindingRequirement!.id}`,
    );

    let persisted = false;
    const bindingHost: PragmaBundleBindingHost = {
      async inspect({ requirement, payload }) {
        if (requirement.kind === "binding")
          expect([...payload.keys()]).toEqual(["descriptor.json"]);
        return {
          requirementId: requirement.id,
          status: persisted ? "ready" : "needs_binding",
        };
      },
      async bind({ requirement }) {
        persisted = true;
        if (requirement.kind !== "binding") return {};
        const record: PragmaBindingRecord = {
          ref: `binding:pragma.bundle.${requirement.id}`,
          revision: "host-revision-1",
          fingerprint: "a".repeat(64),
          value: { contribution: {} },
        };
        return { bindings: [record] };
      },
    };
    expect(await loaded.inspectBundleBindings("expert:1xddvess309a6gme", bindingHost)).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "needs_binding" })]),
    );
    const bound = await loaded.bindEnvironment("expert:1xddvess309a6gme", bindingHost);
    expect(bound.requirements.every((requirement) => requirement.status === "ready")).toBe(true);
    const prepared = await loaded.prepareCompile<Expert>(
      "expert:1xddvess309a6gme",
      { workspace: source.root, runtimes: runtimeResolver() },
      bound.overlay,
    );
    expect(prepared.status).toBe("ready");
    await loaded.dispose();
  });

  it("ignores unknown optional Host extensions and blocks unknown required extensions", async () => {
    const source = await createProject();
    const project = await loadPragmaProject(source.entry);
    const optional = await project.exportBundle({
      roots: ["expert:1xddvess309a6gme"],
      extensions: [
        { id: "desktop.layout", version: "v1", files: new Map([["layout.json", strToU8("{}")]]) },
      ],
    });
    const optionalProject = await loadPragmaProject({
      kind: "bundle",
      source: { kind: "bytes", bytes: optional.bytes },
    });
    await optionalProject.dispose();

    const required = await project.exportBundle({
      roots: ["expert:1xddvess309a6gme"],
      extensions: [
        {
          id: "desktop.layout",
          version: "v1",
          required: true,
          files: new Map([["layout.json", strToU8("{}")]]),
        },
      ],
    });
    await expect(
      loadPragmaProject({
        kind: "bundle",
        source: { kind: "bytes", bytes: required.bytes },
      }),
    ).rejects.toMatchObject({ code: "manifest.invalid" });
    const supported = await loadPragmaProject(
      { kind: "bundle", source: { kind: "bytes", bytes: required.bytes } },
      { supportedBundleExtensions: new Set(["desktop.layout@v1"]) },
    );
    await supported.dispose();
  });

  it("rejects legacy Desktop archives instead of guessing their semantics", async () => {
    const bytes = zipSync({
      "bundle.json": strToU8(JSON.stringify({ schemaVersion: "pragma.desktop-bundle/v1" })),
    });
    await expect(decodePragmaBundle({ kind: "bytes", bytes })).rejects.toEqual(
      expect.objectContaining<Partial<PragmaBundleFormatError>>({
        code: "manifest.version_unsupported",
      }),
    );
  });

  it("rejects unsafe archive paths and semantically incomplete manifests", async () => {
    const unsafe = zipSync({ "../outside.txt": strToU8("unsafe") });
    await expect(decodePragmaBundle({ kind: "bytes", bytes: unsafe })).rejects.toMatchObject({
      code: "archive.path_unsafe",
    });

    const source = await createProject();
    const project = await loadPragmaProject(source.entry);
    const exported = await project.exportBundle({ roots: ["expert:1xddvess309a6gme"] });
    const decoded = await decodePragmaBundle({ kind: "bytes", bytes: exported.bytes });
    const forged = await encodePragmaBundle({
      manifest: {
        schemaVersion: decoded.manifest.schemaVersion,
        createdAt: decoded.manifest.createdAt,
        roots: decoded.manifest.roots,
        project: decoded.manifest.project,
        requirements: [],
        extensions: decoded.manifest.extensions,
      },
      files: new Map([...decoded.files].filter(([path]) => path !== "bundle.json")),
    });
    await expect(
      encodePragmaBundle({
        manifest: {
          schemaVersion: decoded.manifest.schemaVersion,
          createdAt: decoded.manifest.createdAt,
          roots: decoded.manifest.roots,
          project: decoded.manifest.project,
          requirements: decoded.manifest.requirements,
          extensions: decoded.manifest.extensions,
        },
        files: new Map([...decoded.files].filter(([path]) => path !== "bundle.json")),
        limits: { maxFiles: 1 },
      }),
    ).rejects.toMatchObject({ code: "archive.limit_exceeded" });
    await expect(
      loadPragmaProject({
        kind: "bundle",
        source: { kind: "bytes", bytes: forged.bytes },
      }),
    ).rejects.toMatchObject({ code: "manifest.invalid" });
  });

  it("exports programmatic definitions through named versioned serializers", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-programmatic-bundle-"));
    const runtimeValue = { definitionType: "runtime" };
    const expertValue = { definitionType: "expert" };
    let runtimeSerializations = 0;
    let expertSerializations = 0;
    const serializers = new DefinitionSerializerRegistry()
      .register({
        id: "test.runtime",
        version: "v1",
        kind: "RuntimeProfile",
        canSerialize: (value) => value === runtimeValue,
        serialize: () => {
          runtimeSerializations += 1;
          return PragmaResourceSchema.parse(runtimeResource());
        },
      })
      .register({
        id: "test.expert",
        version: "v1",
        kind: "Expert",
        canSerialize: (value) => value === expertValue,
        serialize: () => {
          expertSerializations += 1;
          return PragmaResourceSchema.parse(expertResource(false));
        },
      });

    const exported = await exportPragmaBundle({
      roots: [expertValue],
      include: [runtimeValue],
      additionalRoots: [runtimeValue],
      serializers,
      projectRoot: root,
    });
    expect(runtimeSerializations).toBe(1);
    expect(expertSerializations).toBe(1);
    expect(exported.manifest.roots).toEqual(["expert:1xddvess309a6gme"]);
    const loaded = await loadPragmaProject({
      kind: "bundle",
      source: { kind: "bytes", bytes: exported.bytes },
    });
    expect(await loaded.validate()).toEqual([]);
    await loaded.dispose();
  });

  it("rejects project artifacts that collide with generated bundle metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-bundle-collision-"));
    const entry = join(root, "pragma.yaml");
    await writeFile(
      entry,
      formatPragmaYaml({
        apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
        kind: "Bundle",
        resources: [
          runtimeResource(),
          {
            apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
            kind: "ContextStore",
            metadata: {
              id: "w01fppfxrn31gf7v",
              name: "Project source",
              description: "References the generated entry name",
              tags: [],
            },
            spec: {
              adapter: "pragma.context.file@v1",
              config: { source: { type: "project", path: "pragma.yaml" } },
            },
          },
          {
            ...expertResource(false),
            spec: {
              ...expertResource(false).spec,
              contextStores: [
                {
                  ref: "context-store:w01fppfxrn31gf7v",
                  namespace: "project-source",
                  required: true,
                },
              ],
            },
          },
        ],
      }),
    );
    const project = await loadPragmaProject(entry);
    await expect(project.exportBundle({ roots: ["expert:1xddvess309a6gme"] })).rejects.toThrow(
      "Project artifact collides with a generated bundle file: pragma.yaml.",
    );
  });
});

async function createProject(withCapability = false): Promise<{ root: string; entry: string }> {
  const root = await mkdtemp(join(tmpdir(), "pragma-bundle-test-"));
  const entry = join(root, "pragma.yaml");
  const resources: unknown[] = [runtimeResource()];
  if (withCapability) {
    resources.push({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Capability",
      metadata: {
        id: "j35188zs37g69g0n",
        name: "Host tools",
        description: "Host-provided tools",
        tags: [],
      },
      spec: {
        adapter: "pragma.capability.host@v1",
        binding: "binding:desktop.local-tools",
        config: { key: "local-tools" },
      },
    });
  }
  resources.push(expertResource(withCapability));
  await writeFile(
    entry,
    formatPragmaYaml({ apiVersion: PRAGMA_DSL_WRITE_API_VERSION, kind: "Bundle", resources }),
  );
  return { root, entry };
}

function runtimeResource() {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "RuntimeProfile" as const,
    metadata: {
      id: "knr7p5b7qc55wv92",
      name: "Runtime",
      description: "Test runtime",
      tags: [],
    },
    spec: { adapter: "pragma.runtime.profile@v1", config: { runtimeId: "codex" } },
  };
}

function expertResource(withCapability: boolean) {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Expert",
    metadata: {
      id: "1xddvess309a6gme",
      name: "Writer",
      description: "Writes concise text",
      tags: [],
    },
    spec: {
      scope: "writing",
      instructions: "Write concise text.",
      runtime: { ref: "runtime-profile:knr7p5b7qc55wv92" },
      capabilities: withCapability ? [{ ref: "capability:j35188zs37g69g0n", kind: "tools" }] : [],
      toolApprovals: {},
      contextStores: [],
      plugins: [],
      tools: [],
    },
  } as const;
}

function runtimeResolver() {
  return createStaticRuntimeResolver({
    defaultRuntimeId: "codex",
    runtimes: [
      {
        features: snapshotRuntimeFeatures(createRuntimeTestFeatures()),
        descriptor: { id: "codex", kind: "test", displayName: "Codex" },
        canUse: () => ({ usable: true }),
      },
    ],
  });
}
