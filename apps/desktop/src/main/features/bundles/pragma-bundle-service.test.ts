import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PragmaPaths } from "@pragma/core";
import { pragmaManagementCapabilityResource } from "@pragma/built-in-agents";
import { resolvePragmaAvatarId } from "@pragma/shared";
import {
  canonicalPragmaResourceRef,
  type PragmaCapabilityResource,
  type PragmaContextStoreResource,
  type PragmaExpertResource,
  type PragmaExpertTeamResource,
  type PragmaFlowResource,
  type PragmaRuntimeProfileResource,
} from "@pragma/interpreter/ast";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";

import type { CapabilityStore } from "../capabilities/capability-store.ts";
import type {
  Capability,
  DesktopRuntimeAvailability,
  PragmaBundleInstallation,
} from "../../../shared/contracts/index.ts";
import type { ContextStoreStore } from "../context-stores/context-store-store.ts";
import type { PluginStore } from "../plugins/plugin-store.ts";
import { createPragmaProjectStore } from "../projects/pragma-project-store.ts";
import { createWorkflowLayoutStore } from "../projects/workflow-layout-store.ts";
import {
  desktopCapabilityBindingRef,
  desktopContextBindingRef,
} from "../../platform/bindings/desktop-binding-ref.ts";
import { inspectBundleReadiness, mergePendingMetadata } from "./pragma-bundle-dependencies.ts";
import { createPragmaBundleService } from "./pragma-bundle-service.ts";
import { resolveBundleIdentities } from "./pragma-bundle-resources.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map(async (directory) => await rm(directory, { recursive: true, force: true })),
  );
});

describe("PragmaBundleService", () => {
  it("recognizes the built-in Pragma management Capability without an installed payload", async () => {
    await expect(
      inspectBundleReadiness([pragmaManagementCapabilityResource()], {
        capabilities: {} as CapabilityStore,
        contextStores: {} as ContextStoreStore,
        plugins: {} as PluginStore,
        runtimes: [],
      }),
    ).resolves.toMatchObject([{ kind: "capability", status: "ready" }]);
  });

  it("reuses the canonical Pragma management Capability without an import conflict", async () => {
    const source = await createFixture("management-source");
    const target = await createFixture("management-target");
    const management = pragmaManagementCapabilityResource();
    const attachManagement = async (fixture: Awaited<ReturnType<typeof createFixture>>) =>
      await fixture.project.apply({
        baseRevision: fixture.projectRevision,
        upserts: [
          management,
          {
            ...expert("Write verified release notes."),
            spec: {
              ...expert("Write verified release notes.").spec,
              capabilities: [
                {
                  ref: canonicalPragmaResourceRef(management),
                  kind: "tools" as const,
                  tools: ["list_knowledge_revision_targets", "submit_knowledge_revision"],
                },
              ],
            },
          },
        ],
      });
    const sourceProject = await attachManagement(source);
    await attachManagement(target);
    const path = join(source.root, "management.pragma");
    await source.service.exportTo(exportInput(sourceProject.revision), path);

    const inspection = await target.service.inspect(path, "expert:1xddvess309a6gme");

    expect(inspection.conflicts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: canonicalPragmaResourceRef(management) }),
      ]),
    );
  });

  it("preserves requirement ids for multiple pending plugins owned by one Expert", () => {
    const previous: PragmaBundleInstallation["pending"] = [
      {
        id: "req-memory",
        kind: "plugin",
        resourceRef: "expert:1xddvess309a6gme",
        name: "plugin:example@1.0.0",
        message: "Install memory.",
      },
      {
        id: "req-review",
        kind: "plugin",
        resourceRef: "expert:1xddvess309a6gme",
        name: "plugin:review@1.0.0",
        message: "Install review.",
      },
    ];
    const inspected: PragmaBundleInstallation["pending"] = previous.map((dependency) => ({
      ...dependency,
      id: `plugin:${dependency.name}`,
      message: "Plugin needs attention.",
    }));

    expect(mergePendingMetadata(inspected, previous).map((dependency) => dependency.id)).toEqual([
      "req-memory",
      "req-review",
    ]);
  });

  it("upgrades its catalog lazily on first Bundle use", async () => {
    const fixture = await createFixture("lazy-catalog-upgrade");
    await mkdir(fixture.paths.bundleInstallationsStateRoot(), {
      recursive: true,
      mode: 0o700,
    });
    await writeFile(
      fixture.paths.bundleInstallationsCatalog(),
      `${JSON.stringify({
        schemaVersion: "pragma.bundle-installations/v1",
        installations: [],
      })}\n`,
    );

    expect(await readFile(fixture.paths.bundleInstallationsCatalog(), "utf8")).toContain(
      "pragma.bundle-installations/v1",
    );
    await expect(fixture.service.listInstallations()).resolves.toEqual([]);
    expect(await readFile(fixture.paths.bundleInstallationsCatalog(), "utf8")).toContain(
      "pragma.bundle-installations/v4",
    );
  });

  it("keeps a failed lazy initialization retryable without replacing future data", async () => {
    const fixture = await createFixture("lazy-catalog-retry");
    await mkdir(fixture.paths.bundleInstallationsStateRoot(), {
      recursive: true,
      mode: 0o700,
    });
    const catalogPath = fixture.paths.bundleInstallationsCatalog();
    const futureCatalog = {
      schemaVersion: "pragma.bundle-installations/v5",
      installations: [],
    };
    await writeFile(catalogPath, `${JSON.stringify(futureCatalog)}\n`);

    await expect(fixture.service.listInstallations()).rejects.toThrow();
    await expect(readFile(catalogPath, "utf8")).resolves.toBe(`${JSON.stringify(futureCatalog)}\n`);

    await writeFile(
      catalogPath,
      `${JSON.stringify({
        schemaVersion: "pragma.bundle-installations/v2",
        installations: [],
      })}\n`,
    );
    await expect(fixture.service.listInstallations()).resolves.toEqual([]);
  });

  it("exports a verifiable ZIP with a stable semantic fingerprint", async () => {
    const fixture = await createFixture("source");
    const firstPath = join(fixture.root, "first.pragma");
    const secondPath = join(fixture.root, "second.pragma");

    const first = await fixture.service.exportTo(exportInput(fixture.projectRevision), firstPath);
    const second = await fixture.service.exportTo(exportInput(fixture.projectRevision), secondPath);
    const archive = unzipSync(new Uint8Array(await readFile(firstPath)));

    expect(first.bundleFingerprint).not.toBe(second.bundleFingerprint);
    expect(first.projectFingerprint).toBe(second.projectFingerprint);
    expect(Object.keys(archive)).toContain("bundle.json");
    expect(Object.keys(archive)).toContain("project/pragma.yaml");
    expect(strFromU8(archive["project/pragma.yaml"]!)).toContain(
      "- ./experts/1xddvess309a6gme.pragma.yaml",
    );
    expect(Object.keys(archive)).toContain("project/experts/1xddvess309a6gme.pragma.yaml");
    await expect(fixture.service.inspect(firstPath)).resolves.toMatchObject({
      bundleFingerprint: first.bundleFingerprint,
      root: { ref: "expert:1xddvess309a6gme", name: "Writer" },
      resources: 2,
    });
  });

  it("allows an omitted knowledge-base payload to be bound after import", async () => {
    const storeId = "00000000-0000-4000-8000-000000000191";
    const source = await createFixture("optional-context-source", {
      contextStores: {
        list: async () => [
          {
            id: storeId,
            name: "Release handbook",
            description: "Friendly knowledge-base metadata.",
          },
        ],
        fingerprint: async () => "f".repeat(64),
      } as unknown as ContextStoreStore,
    });
    const sourceSnapshot = await source.project.get();
    const context = contextStore();
    const sourceExpert = sourceSnapshot.resources.find(
      (resource): resource is PragmaExpertResource => resource.kind === "Expert",
    )!;
    const published = await source.project.publish({
      expectedRevision: sourceSnapshot.revision,
      resources: [
        ...sourceSnapshot.resources.filter((resource) => resource.kind !== "Expert"),
        context,
        {
          ...sourceExpert,
          spec: {
            ...sourceExpert.spec,
            contextStores: [
              {
                ref: `context-store:${context.metadata.id}`,
                namespace: "release-notes",
                required: true,
              },
            ],
          },
        },
      ],
    });
    const path = join(source.root, "without-knowledge-content.pragma");
    const exported = await source.service.exportTo(exportInput(published.revision), path);

    const target = await createFixture("optional-context-target");
    const inspection = await target.service.inspect(path);
    expect(inspection.requirements).toContainEqual(
      expect.objectContaining({
        kind: "context-store",
        name: "Release handbook",
        required: false,
      }),
    );
    expect(inspection.dependencies).toContainEqual(
      expect.objectContaining({
        kind: "context-store",
        name: "Release handbook",
        included: false,
      }),
    );

    const installation = await target.service.startImport({
      ...importInput(
        path,
        exported.bundleFingerprint,
        exported.projectFingerprint,
        inspection.projectRevision,
      ),
      conflicts: inspection.conflicts.map((conflict) => ({
        resourceRef: conflict.ref,
        action: "copy" as const,
      })),
    });
    expect(installation.status).toBe("needs_setup");
    expect(installation.pending).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "context-store" })]),
    );
  });

  it("shares only the avatar ID and preserves an unknown ID while resolving the default", async () => {
    const requestedAvatarId = "pragma.avatar.expert.future-reviewer";
    const source = await createFixture("avatar-source", { avatarId: requestedAvatarId });
    const path = join(source.root, "avatar.pragma");
    const exported = await source.service.exportTo(exportInput(source.projectRevision), path);
    const archive = unzipSync(new Uint8Array(await readFile(path)));
    const projectSource = strFromU8(archive["project/experts/1xddvess309a6gme.pragma.yaml"]!);

    expect(projectSource).toContain(`avatarId: ${requestedAvatarId}`);
    expect(Object.keys(archive).some((entry) => entry.startsWith("assets/avatar"))).toBe(false);

    const target = await createFixture("avatar-target", {
      expertId: "3sfd30h5017wd17d",
      runtimeResourceId: "4sfd30h5017wd17d",
    });
    const inspection = await target.service.inspect(path);
    const installation = await target.service.startImport({
      ...importInput(
        path,
        exported.bundleFingerprint,
        exported.projectFingerprint,
        inspection.projectRevision,
      ),
      conflicts: inspection.conflicts.map((conflict) => ({
        resourceRef: conflict.ref,
        action: "copy" as const,
      })),
    });
    const imported = (await target.project.get()).resources.find(
      (resource): resource is PragmaExpertResource =>
        resource.kind === "Expert" && canonicalPragmaResourceRef(resource) === installation.rootRef,
    );

    expect(imported?.metadata.avatarId).toBe(requestedAvatarId);
    expect(resolvePragmaAvatarId("expert", imported?.metadata.avatarId)).toBe(
      "pragma.avatar.expert.11",
    );
  });

  it("inspects one explicitly selected root from a multi-root Interpreter Bundle", async () => {
    const fixture = await createFixture("multi-root");
    const snapshot = await fixture.project.get();
    const published = await fixture.project.publish({
      expectedRevision: snapshot.revision,
      resources: [...snapshot.resources, expertTeam()],
    });
    const project = await fixture.project.openRevision(published.revision);
    const path = join(fixture.root, "multi-root.pragma");
    try {
      const exported = await project.exportBundle({
        roots: ["expert:1xddvess309a6gme", "team:p8cbn3cg2avyksn4"],
      });
      await writeFile(path, exported.bytes);
    } finally {
      await project.dispose();
    }

    await expect(fixture.service.inspect(path, "team:p8cbn3cg2avyksn4")).resolves.toMatchObject({
      root: { ref: "team:p8cbn3cg2avyksn4", kind: "ExpertTeam" },
      roots: [{ ref: "expert:1xddvess309a6gme" }, { ref: "team:p8cbn3cg2avyksn4" }],
      resources: 3,
    });
  });

  it("hard-cuts the legacy Desktop wire format with an offline upgrade instruction", async () => {
    const fixture = await createFixture("legacy-wire");
    const path = join(fixture.root, "legacy.pragma");
    await writeFile(
      path,
      zipSync({
        "bundle.json": strToU8(JSON.stringify({ schemaVersion: "pragma.desktop-bundle/v1" })),
      }),
    );

    await expect(fixture.service.inspect(path)).rejects.toThrow("Pragma Desktop v0.1.0");
  });

  it("reports matching portable content as an advisory without merging installations", async () => {
    const source = await createFixture("same-content-source");
    const firstPath = join(source.root, "first.pragma");
    const secondPath = join(source.root, "second.pragma");
    const firstExport = await source.service.exportTo(
      exportInput(source.projectRevision),
      firstPath,
    );
    await source.service.exportTo(exportInput(source.projectRevision), secondPath);
    const target = await createFixture("same-content-target", {
      instructions: "Existing local expert.",
    });
    const inspection = await target.service.inspect(firstPath);
    const installation = await target.service.startImport({
      ...importInput(
        firstPath,
        firstExport.bundleFingerprint,
        firstExport.projectFingerprint,
        inspection.projectRevision,
      ),
      conflicts: inspection.conflicts.map((conflict) => ({
        resourceRef: conflict.ref,
        action: "copy" as const,
      })),
    });

    expect(installation.status).toBe("ready");
    const advisory = await target.service.inspect(secondPath);
    expect(advisory.sameContentInstallationIds).toEqual([installation.id]);
    expect(advisory.alreadyInstalledId).toBeUndefined();
  });

  it("keeps mission readiness checks read-only", async () => {
    const source = await createFixture("read-only-source");
    const path = join(source.root, "workflow.pragma");
    const exported = await source.service.exportTo(exportInput(source.projectRevision), path);
    const target = await createFixture("read-only-target", {
      instructions: "Existing local expert.",
    });
    const inspection = await target.service.inspect(path);
    const installation = await target.service.startImport({
      ...importInput(
        path,
        exported.bundleFingerprint,
        exported.projectFingerprint,
        inspection.projectRevision,
      ),
      conflicts: inspection.conflicts.map((conflict) => ({
        resourceRef: conflict.ref,
        action: "copy" as const,
      })),
    });
    const catalogPath = target.paths.bundleInstallationsCatalog();
    const before = await readFile(catalogPath, "utf8");
    const snapshot = await target.project.get();
    await target.project.publish({
      expectedRevision: snapshot.revision,
      resources: [...snapshot.resources, flowCalling(installation.rootRef)],
    });

    await expect(target.service.getReadinessForRef(installation.rootRef)).resolves.toEqual([]);
    await expect(readFile(catalogPath, "utf8")).resolves.toBe(before);
  });

  it("does not recheck a failed installation or delete its retry archive", async () => {
    const source = await createFixture("failed-recheck-source");
    const path = join(source.root, "workflow.pragma");
    const exported = await source.service.exportTo(exportInput(source.projectRevision), path);
    const target = await createFixture("failed-recheck-target", {
      instructions: "Existing local expert.",
    });
    const inspection = await target.service.inspect(path);
    const installation = await target.service.startImport({
      ...importInput(
        path,
        exported.bundleFingerprint,
        exported.projectFingerprint,
        inspection.projectRevision,
      ),
      conflicts: inspection.conflicts.map((conflict) => ({
        resourceRef: conflict.ref,
        action: "copy" as const,
      })),
    });
    const catalogPath = target.paths.bundleInstallationsCatalog();
    const catalog = JSON.parse(await readFile(catalogPath, "utf8")) as {
      installations: Record<string, unknown>[];
    };
    catalog.installations = catalog.installations.map((record) => ({
      ...record,
      status: "failed",
      error: "Import failed.",
    }));
    await writeFile(catalogPath, `${JSON.stringify(catalog)}\n`);
    const archivePath = target.paths.bundleInstallationArchive(installation.id);
    await writeFile(archivePath, "retry archive");

    await expect(target.service.recheckInstallation(installation.id)).rejects.toThrow(
      "cannot be rechecked",
    );
    await expect(readFile(archivePath, "utf8")).resolves.toBe("retry archive");
    await expect(target.service.listInstallations()).resolves.toEqual([
      expect.objectContaining({ id: installation.id, status: "failed" }),
    ]);
  });

  it("checks the health of the capability revision bound by the resource", async () => {
    const capabilityId = "00000000-0000-4000-8000-000000000190";
    const resource = portableCapability();
    resource.spec.binding = desktopCapabilityBindingRef(capabilityId, 1);
    const boundRevision = {
      definition: { kind: "http_service" },
      health: { revision: 1, status: "ready" },
    } as unknown as Capability;
    const latestRevision = {
      definition: { kind: "http_service" },
      health: {
        revision: 2,
        status: "needs_attention",
        diagnostic: { code: "config_invalid", message: "Needs setup." },
      },
    } as unknown as Capability;
    const capabilities = {
      get: async (_id: string, revision?: number) =>
        revision === 1 ? boundRevision : latestRevision,
    } as unknown as CapabilityStore;

    await expect(
      inspectBundleReadiness([resource], {
        capabilities,
        contextStores: {} as ContextStoreStore,
        plugins: {} as PluginStore,
        runtimes: [],
      }),
    ).resolves.toMatchObject([
      { kind: "capability", status: "ready", code: "ready", targetId: capabilityId },
    ]);
  });

  it("rejects a bundle whose indexed project file was modified", async () => {
    const fixture = await createFixture("tamper");
    const path = join(fixture.root, "workflow.pragma");
    await fixture.service.exportTo(exportInput(fixture.projectRevision), path);
    const archive = unzipSync(new Uint8Array(await readFile(path)));
    archive["project/pragma.yaml"] = strToU8(
      `${strFromU8(archive["project/pragma.yaml"]!)}\n# tampered\n`,
    );
    await writeFile(path, zipSync(archive));

    await expect(fixture.service.inspect(path)).rejects.toThrow(
      "Bundle file verification failed: project/pragma.yaml",
    );
  });

  it("reports an actionable error for a malformed Desktop payload descriptor", async () => {
    const fixture = await createFixture("malformed-descriptor");
    const snapshot = await fixture.project.get();
    const sourceExpert = snapshot.resources.find(
      (resource): resource is PragmaExpertResource => resource.kind === "Expert",
    );
    if (sourceExpert === undefined) throw new Error("Expected an Expert.");
    const capability = portableCapability();
    const published = await fixture.project.publish({
      expectedRevision: snapshot.revision,
      resources: [
        {
          ...sourceExpert,
          spec: {
            ...sourceExpert.spec,
            capabilities: [{ ref: canonicalPragmaResourceRef(capability), kind: "tools" }],
          },
        },
        ...snapshot.resources.filter((resource) => resource.kind !== "Expert"),
        capability,
      ],
    });
    const project = await fixture.project.openRevision(published.revision);
    const path = join(fixture.root, "malformed.pragma");
    try {
      const exported = await project.exportBundle({
        roots: ["expert:1xddvess309a6gme"],
        host: {
          exportPayload: async ({ requirement }) =>
            requirement.kind === "binding"
              ? {
                  codec: "pragma.desktop.capability@v1",
                  files: new Map([["descriptor.json", strToU8("{not-json")]]),
                }
              : undefined,
        },
      });
      await writeFile(path, exported.bytes);
    } finally {
      await project.dispose();
    }

    await expect(fixture.service.inspect(path)).rejects.toThrow(
      /Capability descriptor req-.+ is not valid JSON/,
    );
  });

  it("accepts only the .pragma transfer format", async () => {
    const fixture = await createFixture("extension");

    await expect(
      fixture.service.inspect(join(fixture.root, "workflow.pragma.bundle")),
    ).rejects.toThrow("Select a .pragma file.");
  });

  it("imports conflicts as a copy and rewrites internal Runtime references", async () => {
    const source = await createFixture("copy-source");
    const path = join(source.root, "workflow.pragma");
    const exported = await source.service.exportTo(exportInput(source.projectRevision), path);
    const target = await createFixture("copy-target", {
      instructions: "A conflicting local instruction.",
      runtimeId: "local-runtime",
    });

    const installation = await target.service.startImport({
      ...importInput(
        path,
        exported.bundleFingerprint,
        exported.projectFingerprint,
        target.projectRevision,
      ),
      conflicts: [
        { resourceRef: "expert:1xddvess309a6gme", action: "copy" },
        { resourceRef: "runtime-profile:zdkgs0fde4xt00vr", action: "copy" },
      ],
    });
    const snapshot = await target.project.get();
    const copiedExpert = snapshot.resources.find(
      (resource): resource is PragmaExpertResource =>
        resource.kind === "Expert" && canonicalPragmaResourceRef(resource) === installation.rootRef,
    );

    expect(installation.status).toBe("ready");
    expect(installation.rootRef).not.toBe("expert:1xddvess309a6gme");
    expect(copiedExpert?.metadata.name).toContain("(copy)");
    expect(copiedExpert?.spec.runtime?.ref).not.toBe("runtime-profile:zdkgs0fde4xt00vr");
    expect(
      snapshot.resources.some(
        (resource) =>
          resource.kind === "RuntimeProfile" &&
          canonicalPragmaResourceRef(resource) === copiedExpert?.spec.runtime?.ref,
      ),
    ).toBe(true);
    expect(installation.createdResourceRefs).toHaveLength(2);

    await target.service.discardInstallation(installation.id);
    await expect(target.service.listInstallations()).resolves.toEqual([]);
    await expect(target.project.get()).resolves.toMatchObject({
      resources: expect.arrayContaining([
        expect.objectContaining({
          kind: "Expert",
          metadata: expect.objectContaining({ id: "1xddvess309a6gme" }),
        }),
      ]),
    });
    expect((await target.project.get()).resources).toHaveLength(2);
  });

  it("applies a selected Runtime and model during the final import commit", async () => {
    const source = await createFixture("runtime-binding-source");
    const path = join(source.root, "workflow.pragma");
    const exported = await source.service.exportTo(exportInput(source.projectRevision), path);
    const target = await createFixture("runtime-binding-target", {
      instructions: "Existing local expert.",
      runtimes: [
        {
          id: "pi",
          isDefault: true,
          kind: "local",
          displayName: "Pragma Runtime",
          status: "available",
          models: [
            {
              id: "gpt-test",
              displayName: "GPT Test",
              provider: { kind: "registered", id: "openai", displayName: "OpenAI" },
            },
          ],
        },
      ],
    });
    const runtimeRequirement = (await target.service.inspect(path)).requirements.find(
      (requirement) => requirement.kind === "runtime",
    );
    expect(runtimeRequirement).toBeDefined();

    const installation = await target.service.startImport({
      ...importInput(
        path,
        exported.bundleFingerprint,
        exported.projectFingerprint,
        target.projectRevision,
      ),
      conflicts: [
        { resourceRef: "expert:1xddvess309a6gme", action: "copy" },
        { resourceRef: "runtime-profile:zdkgs0fde4xt00vr", action: "copy" },
      ],
      runtimes: [
        {
          requirementId: runtimeRequirement!.id,
          resourceRef: "runtime-profile:zdkgs0fde4xt00vr",
          runtimeId: "pi",
          providerId: "openai",
          modelId: "gpt-test",
        },
      ],
    });
    const importedRuntime = (await target.project.get()).resources.find(
      (resource): resource is PragmaRuntimeProfileResource =>
        resource.kind === "RuntimeProfile" &&
        installation.createdResourceRefs.includes(canonicalPragmaResourceRef(resource)),
    );

    expect(installation.status).toBe("ready");
    expect(importedRuntime?.spec.config).toEqual({
      runtimeId: "pi",
      providerId: "openai",
      model: "gpt-test",
    });
  });

  it("prompts for identical resource conflicts and permits repeated copy imports", async () => {
    const source = await createFixture("repeat-copy-source");
    const path = join(source.root, "workflow.pragma");
    const exported = await source.service.exportTo(exportInput(source.projectRevision), path);
    const target = await createFixture("repeat-copy-target");

    const initialInspection = await target.service.inspect(path);
    expect(initialInspection.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: "expert:1xddvess309a6gme",
          matches: expect.arrayContaining([expect.objectContaining({ kind: "identity" })]),
        }),
        expect.objectContaining({
          ref: "runtime-profile:zdkgs0fde4xt00vr",
          matches: expect.arrayContaining([expect.objectContaining({ kind: "identity" })]),
        }),
      ]),
    );
    await expect(
      target.service.startImport(
        importInput(
          path,
          exported.bundleFingerprint,
          exported.projectFingerprint,
          target.projectRevision,
        ),
      ),
    ).rejects.toThrow("Choose one import action");

    const first = await target.service.startImport({
      ...importInput(
        path,
        exported.bundleFingerprint,
        exported.projectFingerprint,
        target.projectRevision,
      ),
      conflicts: [
        { resourceRef: "expert:1xddvess309a6gme", action: "copy" },
        { resourceRef: "runtime-profile:zdkgs0fde4xt00vr", action: "copy" },
      ],
    });
    const repeatedInspection = await target.service.inspect(path);

    expect(first.status).toBe("ready");
    expect(repeatedInspection.alreadyInstalledId).toBeUndefined();
    expect(repeatedInspection.conflicts).not.toHaveLength(0);

    const second = await target.service.startImport({
      ...importInput(
        path,
        exported.bundleFingerprint,
        exported.projectFingerprint,
        first.projectRevision,
      ),
      conflicts: repeatedInspection.conflicts.map((conflict) => ({
        resourceRef: conflict.ref,
        action: "copy" as const,
      })),
    });
    const snapshot = await target.project.get();

    expect(second.status).toBe("ready");
    expect(second.id).not.toBe(first.id);
    expect(second.rootRef).not.toBe(first.rootRef);
    expect(snapshot.resources).toHaveLength(6);
    expect(
      snapshot.resources
        .filter((resource) => resource.kind === "Expert")
        .map((resource) => resource.metadata.name)
        .toSorted(),
    ).toEqual(["Writer", "Writer (copy 2)", "Writer (copy)"]);
  });

  it("updates normalized name conflicts by retaining local identities", async () => {
    const source = await createFixture("update-source");
    const path = join(source.root, "workflow.pragma");
    const exported = await source.service.exportTo(exportInput(source.projectRevision), path);
    const target = await createFixture("update-target", {
      expertId: "3sfd30h5017wd17d",
      runtimeResourceId: "v3b460tasfhyf22d",
    });

    const installation = await target.service.startImport({
      ...importInput(
        path,
        exported.bundleFingerprint,
        exported.projectFingerprint,
        target.projectRevision,
      ),
      conflicts: [
        { resourceRef: "expert:1xddvess309a6gme", action: "update" },
        { resourceRef: "runtime-profile:zdkgs0fde4xt00vr", action: "update" },
      ],
    });
    const snapshot = await target.project.get();
    const updated = snapshot.resources.find(
      (resource): resource is PragmaExpertResource =>
        resource.kind === "Expert" && canonicalPragmaResourceRef(resource) === installation.rootRef,
    );

    expect(installation.rootRef).toBe("expert:3sfd30h5017wd17d");
    expect(installation.createdResourceRefs).toEqual([]);
    expect(updated?.spec.runtime?.ref).toBe("runtime-profile:v3b460tasfhyf22d");
    expect(snapshot.resources).toHaveLength(2);
    await expect(target.service.discardInstallation(installation.id)).rejects.toThrow(
      "changed existing project resources",
    );
  });

  it("resolves new identities without mutating opaque plugin config", () => {
    const sourceExpert = expert("Write verified release notes.");
    sourceExpert.spec.plugins = [
      {
        ref: "plugin:example@1.0.0",
        config: {
          literalResourceRef: "runtime-profile:zdkgs0fde4xt00vr",
          nested: { zdkgs0fde4xt00vr: "expert:1xddvess309a6gme" },
        },
      },
    ];

    const originalConfig = structuredClone(sourceExpert.spec.plugins[0]?.config);
    const resolved = resolveBundleIdentities(
      [sourceExpert, runtime("codex")],
      [expert("Existing"), runtime("codex")],
      [
        { resourceRef: "expert:1xddvess309a6gme", action: "copy" },
        { resourceRef: "runtime-profile:zdkgs0fde4xt00vr", action: "copy" },
      ],
    );
    const copied = resolved.identities.find(
      (identity) => identity.sourceRef === "expert:1xddvess309a6gme",
    );

    expect(copied?.targetId).not.toBe(sourceExpert.metadata.id);
    expect(sourceExpert.spec.plugins[0]?.config).toEqual(originalConfig);
  });

  it("supports mixed copy and update decisions across one resource graph", () => {
    const sourceExpert = expert("Use the imported Runtime.");
    const localExpert = expert("Keep the local Expert.");
    const localRuntime = runtime("codex", "v3b460tasfhyf22d");

    const resolved = resolveBundleIdentities(
      [sourceExpert, runtime("codex")],
      [localExpert, localRuntime],
      [
        { resourceRef: "expert:1xddvess309a6gme", action: "copy" },
        { resourceRef: "runtime-profile:zdkgs0fde4xt00vr", action: "update" },
      ],
    );
    const copied = resolved.identities.find(
      (identity) => identity.sourceRef === "expert:1xddvess309a6gme",
    );
    const updatedRuntime = resolved.identities.find(
      (identity) => identity.sourceRef === "runtime-profile:zdkgs0fde4xt00vr",
    );

    expect(copied?.targetId).not.toBe("1xddvess309a6gme");
    expect(updatedRuntime?.targetId).toBe("v3b460tasfhyf22d");
  });

  it("reserves unchanged imported names when naming conflict copies", () => {
    const conflicting = runtime("codex");
    const unchanged = runtime("pi", "v3b460tasfhyf22d");
    unchanged.metadata.name = "Writer Runtime (copy)";

    const resolved = resolveBundleIdentities(
      [conflicting, unchanged],
      [runtime("codex")],
      [{ resourceRef: "runtime-profile:zdkgs0fde4xt00vr", action: "copy" }],
    );

    expect(
      resolved.identities.find(
        (identity) => identity.sourceRef === "runtime-profile:zdkgs0fde4xt00vr",
      )?.targetName,
    ).toBe("Writer Runtime (copy 2)");
  });

  it("exports an ExpertTeam whose member uses a bound host capability", async () => {
    const fixture = await createFixture("bound-team");
    const snapshot = await fixture.project.get();
    const sourceExpert = snapshot.resources.find(
      (resource): resource is PragmaExpertResource => resource.kind === "Expert",
    );
    if (sourceExpert === undefined) throw new Error("Expected an Expert.");
    const capability = portableCapability();
    const team = expertTeam();
    const published = await fixture.project.publish({
      expectedRevision: snapshot.revision,
      resources: [
        {
          ...sourceExpert,
          spec: {
            ...sourceExpert.spec,
            capabilities: [{ ref: canonicalPragmaResourceRef(capability), kind: "tools" as const }],
          },
        },
        ...snapshot.resources.filter((resource) => resource.kind !== "Expert"),
        capability,
        team,
      ],
    });
    const path = join(fixture.root, "team.pragma");

    await fixture.service.exportTo(
      {
        ...exportInput(published.revision),
        rootRef: canonicalPragmaResourceRef(team),
      },
      path,
    );
    const archive = unzipSync(new Uint8Array(await readFile(path)));
    const projectFiles = Object.entries(archive)
      .filter(([name]) => name.endsWith(".yaml"))
      .map(([, contents]) => strFromU8(contents))
      .join("\n");

    expect(projectFiles).toContain("key: portable");
    expect(projectFiles).toContain("binding: binding:pragma.bundle.req-");
    expect(projectFiles).not.toContain("binding: binding:portable");
  });

  it("rejects foreign and unavailable bindings and gates transitive Flow execution", async () => {
    const source = await createFixture("pending-source");
    const path = join(source.root, "workflow.pragma");
    const exported = await source.service.exportTo(exportInput(source.projectRevision), path);
    const target = await createFixture("pending-target", {
      instructions: "Existing local expert.",
      runtimes: [],
    });
    const installation = await target.service.startImport({
      ...importInput(
        path,
        exported.bundleFingerprint,
        exported.projectFingerprint,
        target.projectRevision,
      ),
      conflicts: [
        { resourceRef: "expert:1xddvess309a6gme", action: "copy" },
        { resourceRef: "runtime-profile:zdkgs0fde4xt00vr", action: "copy" },
      ],
    });
    const importedRuntimeRef = installation.resourceRefs.find((ref) =>
      ref.startsWith("runtime-profile:"),
    );
    const pendingRuntime = installation.pending.find((item) => item.kind === "runtime");
    expect(installation.status).toBe("needs_setup");
    expect(importedRuntimeRef).toBeDefined();
    expect(pendingRuntime).toBeDefined();

    await expect(
      target.service.resolveInstallation({
        installationId: installation.id,
        baseRevision: installation.projectRevision,
        runtimes: [
          {
            requirementId: pendingRuntime!.id,
            resourceRef: "runtime-profile:zdkgs0fde4xt00vr",
            runtimeId: "codex",
            providerId: "openai",
            modelId: "gpt-test",
          },
        ],
        capabilities: [],
        contextStores: [],
        secrets: {},
      }),
    ).rejects.toThrow("not pending in this installation");
    await expect(
      target.service.resolveInstallation({
        installationId: installation.id,
        baseRevision: installation.projectRevision,
        runtimes: [
          {
            requirementId: pendingRuntime!.id,
            resourceRef: importedRuntimeRef!,
            runtimeId: "codex",
            providerId: "openai",
            modelId: "gpt-test",
          },
        ],
        capabilities: [],
        contextStores: [],
        secrets: {},
      }),
    ).rejects.toThrow("unavailable");

    const snapshot = await target.project.get();
    const flow = flowCalling(installation.rootRef);
    await target.project.publish({
      expectedRevision: snapshot.revision,
      resources: [...snapshot.resources, flow],
    });
    await expect(target.service.isRefPending(canonicalPragmaResourceRef(flow))).resolves.toBe(true);
  });

  it("rejects unindexed archive paths before installing anything", async () => {
    const fixture = await createFixture("duplicate-path");
    const path = join(fixture.root, "workflow.pragma");
    await fixture.service.exportTo(exportInput(fixture.projectRevision), path);
    const archive = unzipSync(new Uint8Array(await readFile(path)));
    archive["UNINDEXED.txt"] = strToU8("not declared by bundle.json");
    await writeFile(path, zipSync(archive));

    await expect(fixture.service.inspect(path)).rejects.toThrow(
      "The bundle file index does not match the archive.",
    );
  });

  it("finishes recovered local setup and removes the retained source archive", async () => {
    const source = await createFixture("resolve-source");
    const path = join(source.root, "workflow.pragma");
    const exported = await source.service.exportTo(exportInput(source.projectRevision), path);
    const runtimes: DesktopRuntimeAvailability[] = [];
    const target = await createFixture("resolve-target", {
      instructions: "Existing local expert.",
      runtimes,
    });
    const installation = await target.service.startImport({
      ...importInput(
        path,
        exported.bundleFingerprint,
        exported.projectFingerprint,
        target.projectRevision,
      ),
      conflicts: [
        { resourceRef: "expert:1xddvess309a6gme", action: "copy" },
        { resourceRef: "runtime-profile:zdkgs0fde4xt00vr", action: "copy" },
      ],
    });
    const runtimeRef = installation.resourceRefs.find((ref) => ref.startsWith("runtime-profile:"));
    const pendingRuntime = installation.pending.find((item) => item.kind === "runtime");
    expect(runtimeRef).toBeDefined();
    expect(pendingRuntime).toBeDefined();
    runtimes.push({
      id: "codex",
      isDefault: true,
      kind: "local",
      displayName: "Codex",
      status: "available",
      models: [
        {
          id: "gpt-test",
          displayName: "GPT Test",
          provider: { kind: "registered", id: "openai", displayName: "OpenAI" },
        },
      ],
    });

    const ready = await target.service.resolveInstallation({
      installationId: installation.id,
      baseRevision: installation.projectRevision,
      runtimes: [
        {
          requirementId: pendingRuntime!.id,
          resourceRef: runtimeRef!,
          runtimeId: "codex",
          providerId: "openai",
          modelId: "gpt-test",
        },
      ],
      capabilities: [],
      contextStores: [],
      secrets: {},
    });

    expect(ready.status).toBe("ready");
    await expect(
      stat(target.paths.bundleInstallationArchive(installation.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function createFixture(
  name: string,
  overrides: {
    readonly instructions?: string;
    readonly runtimeId?: string;
    readonly expertId?: string;
    readonly runtimeResourceId?: string;
    readonly avatarId?: string;
    readonly runtimes?: DesktopRuntimeAvailability[];
    readonly contextStores?: ContextStoreStore;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), `pragma-bundle-${name}-`));
  directories.push(root);
  const paths = new PragmaPaths({ pragmaHome: join(root, ".pragma") });
  const project = createPragmaProjectStore({
    projectsPath: paths.projectsRoot(),
    objectsPath: paths.contentObjectsRoot(),
    projectViewsPath: paths.projectViewsCacheRoot(),
    storagePaths: paths,
  });
  const published = await project.publish({
    expectedRevision: 0,
    resources: [
      expert(
        overrides.instructions ?? "Write verified release notes.",
        overrides.expertId,
        overrides.runtimeResourceId,
        overrides.avatarId,
      ),
      runtime(overrides.runtimeId ?? "codex", overrides.runtimeResourceId),
    ],
  });
  const service = createPragmaBundleService({
    paths,
    project,
    capabilities: {
      list: async () => [],
    } as unknown as CapabilityStore,
    contextStores:
      overrides.contextStores ??
      ({
        list: async () => [],
      } as unknown as ContextStoreStore),
    plugins: {
      list: async () => [],
    } as unknown as PluginStore,
    layouts: createWorkflowLayoutStore({ projectsPath: paths.projectsRoot() }),
    getRuntimes: async () =>
      overrides.runtimes ?? [
        {
          id: "codex",
          isDefault: true,
          kind: "local",
          displayName: "Codex",
          status: "available",
          models: [
            {
              id: "gpt-test",
              displayName: "GPT Test",
              provider: { kind: "registered", id: "openai", displayName: "OpenAI" },
            },
          ],
        },
      ],
  });
  return { root, paths, project, projectRevision: published.revision, service };
}

function exportInput(projectRevision: number) {
  return {
    rootRef: "expert:1xddvess309a6gme" as const,
    projectRevision,
    modules: {
      capabilities: true,
      plugins: true,
      knowledgeBases: false,
      flowLayouts: true,
    },
  };
}

function importInput(
  sourcePath: string,
  expectedFingerprint: string,
  expectedProjectFingerprint: string,
  expectedProjectRevision: number,
) {
  return {
    sourcePath,
    rootRef: "expert:1xddvess309a6gme" as const,
    expectedFingerprint,
    expectedProjectFingerprint,
    expectedProjectRevision,
    conflicts: [],
    runtimes: [],
    capabilities: [],
    contextStores: [],
    secrets: {},
  };
}

function expert(
  instructions: string,
  id = "1xddvess309a6gme",
  runtimeResourceId = "zdkgs0fde4xt00vr",
  avatarId = "pragma.avatar.expert.default",
): PragmaExpertResource {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Expert",
    metadata: {
      id,
      avatarId,
      name: "Writer",
      description: "Writes release notes",
      tags: [],
    },
    spec: {
      scope: "Release communication",
      instructions,
      runtime: { ref: `runtime-profile:${runtimeResourceId}` },
      capabilities: [],
      toolApprovals: {},
      contextStores: [],
      plugins: [],
      tools: [],
    },
  };
}

function runtime(runtimeId: string, resourceId = "zdkgs0fde4xt00vr"): PragmaRuntimeProfileResource {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "RuntimeProfile",
    metadata: {
      id: resourceId,
      name: "Writer Runtime",
      description: "Writer runtime profile.",
      tags: ["desktop-managed"],
    },
    spec: {
      adapter: "pragma.runtime.profile@v1",
      config: { runtimeId, providerId: "openai", model: "gpt-test" },
    },
  };
}

function contextStore(): PragmaContextStoreResource {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "ContextStore",
    metadata: {
      id: "kqh4nx7rx26mb3e7",
      name: "Context 00000000-0000-4000-8000-000000000191",
      description: "Knowledge used while writing release notes.",
      tags: ["desktop-managed"],
    },
    spec: {
      adapter: "pragma.context.host@v1",
      binding: desktopContextBindingRef("00000000-0000-4000-8000-000000000191"),
      config: { key: "00000000-0000-4000-8000-000000000191" },
    },
  };
}

function portableCapability(): PragmaCapabilityResource {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Capability",
    metadata: {
      id: "nv27faxmxpqnxwqr",
      name: "Portable Capability",
      description: "Portable host capability.",
      tags: [],
    },
    spec: {
      adapter: "pragma.capability.host@v1",
      binding: "binding:portable",
      config: { key: "portable" },
    },
  };
}

function expertTeam(): PragmaExpertTeamResource {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "ExpertTeam",
    metadata: {
      id: "p8cbn3cg2avyksn4",
      avatarId: "pragma.avatar.team.default",
      name: "Reviewers",
      description: "Coordinates review work.",
      tags: [],
    },
    spec: {
      coordinator: { ref: "expert:1xddvess309a6gme" },
      members: [{ ref: "expert:1xddvess309a6gme" }],
      contextStores: [],
      delegation: {
        permissions: { interact: {} },
        maxConcurrency: 2,
        maxDepth: 2,
        runtimes: {},
      },
    },
  };
}

function flowCalling(expertRef: string): PragmaFlowResource {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Flow",
    metadata: {
      id: "qj3t30sa520dvfvj",
      name: "Pending dependency flow",
      description: "Calls an imported Expert.",
      tags: [],
    },
    spec: {
      limits: { maxNodeVisits: 10 },
      graph: {
        start: "run",
        steps: {
          run: {
            expert: { ref: expertRef as `expert:${string}` },
            prompt: { segments: [{ text: "Run." }] },
          },
        },
        transitions: { run: { end: true } },
        loops: {},
      },
    },
  };
}
