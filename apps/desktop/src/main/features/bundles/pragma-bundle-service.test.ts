import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PragmaPaths } from "@pragma/core";
import { pragmaManagementCapabilityResource } from "@pragma/built-in-agents";
import { createPragmaBundleFingerprint } from "@pragma/interpreter";
import {
  legacyWindowsSkillBundleContentHashChunks,
  resolvePragmaAvatarId,
  skillBundleContentHashChunks,
  serializeSkillBundleFileManifest,
  type SkillBundleFile,
} from "@pragma/shared";
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
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CapabilityCredentialStore } from "../capabilities/capability-credential-store.ts";
import {
  createCapabilityStore,
  hashSkillDirectoryContent,
  type CapabilityStore,
} from "../capabilities/capability-store.ts";
import { scanSkillWorkingTree } from "../capabilities/skill-revision-draft-store.ts";
import type {
  Capability,
  DesktopRuntimeAvailability,
  PragmaBundleInstallation,
  StartPragmaBundleImport,
} from "../../../shared/contracts/index.ts";
import { PragmaBundleInstallationSchema } from "../../../shared/contracts/index.ts";
import {
  createContextStoreStore,
  type ContextStoreStore,
} from "../context-stores/context-store-store.ts";
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

const removeTemporaryDirectory = async (directory: string): Promise<void> => {
  await rm(directory, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  });
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTemporaryDirectory));
});

describe("PragmaBundleService", { timeout: 30_000 }, () => {
  it("blocks public Bundle operations for plugin dependencies", async () => {
    const fixture = await createFixture("plugin-boundary");
    const snapshot = await fixture.project.get();
    const resources = snapshot.resources.map((resource) =>
      resource.kind === "Expert"
        ? {
            ...resource,
            spec: { ...resource.spec, plugins: [{ ref: "plugin:example@1.0.0" }] },
          }
        : resource,
    );
    const published = await fixture.project.publish({
      expectedRevision: snapshot.revision,
      resources,
    });
    await expect(
      fixture.service.prepareExport({
        rootRef: "expert:1xddvess309a6gme",
        projectRevision: published.revision,
      }),
    ).rejects.toThrow("plugin dependencies are unavailable");
    const exportRequest = exportInput(published.revision);
    await expect(
      fixture.service.exportTo(
        { ...exportRequest, modules: { ...exportRequest.modules, plugins: true } },
        join(fixture.root, "blocked.pragma"),
      ),
    ).rejects.toThrow("plugin dependencies are unavailable");

    const project = await fixture.project.openRevision(published.revision);
    const path = join(fixture.root, "plugin-boundary.pragma");
    try {
      const exported = await project.exportBundle({ roots: ["expert:1xddvess309a6gme"] });
      await writeFile(path, exported.bytes);
      await expect(fixture.service.inspect(path)).rejects.toThrow("cannot be imported");
      await expect(
        fixture.service.startImport(
          importInput(
            path,
            exported.manifest.bundleFingerprint,
            exported.manifest.project.projectFingerprint,
            published.revision,
          ),
        ),
      ).rejects.toThrow("cannot be imported");
    } finally {
      await project.dispose();
    }
  });

  it("exports a user Skill root from its active ready revision with mandatory files", async () => {
    const capabilityId = "00000000-0000-4000-8000-000000000290";
    const payload = await mkdtemp(join(tmpdir(), "pragma-skill-root-"));
    directories.push(payload);
    const skillContents =
      "---\nname: Bundle Skill\ndescription: Bundle Skill description\n---\n\nActive revision.\n";
    await writeFile(join(payload, "SKILL.md"), skillContents);
    await writeFile(join(payload, "a0"), "flat");
    await mkdir(join(payload, "a"));
    await writeFile(join(payload, "a", "b"), "nested");
    const activeContentHash = testSha256(
      legacyWindowsSkillBundleContentHashChunks([
        { path: "SKILL.md", contents: strToU8(skillContents) },
        { path: "a0", contents: strToU8("flat") },
        { path: "a/b", contents: strToU8("nested") },
      ]),
    );
    expect(activeContentHash).not.toBe(await hashSkillDirectoryContent(payload));
    let active = {
      ...skillCapability(capabilityId, 2, activeContentHash),
      manifest: {
        ...skillCapability(capabilityId, 2, activeContentHash).manifest,
        activeRevision: 2,
      },
    };
    const latest = {
      ...skillCapability(capabilityId, 3, "3".repeat(64)),
      manifest: {
        ...skillCapability(capabilityId, 3, "3".repeat(64)).manifest,
        activeRevision: 2,
      },
    };
    const skillFilesPath = vi.fn(async (_id: string, revision: number) => {
      expect([2, 3]).toContain(revision);
      return payload;
    });
    const source = await createFixture("skill-root", {
      capabilities: {
        list: async () => [latest],
        resolveActive: async () => active,
        skillFilesPath,
      } as unknown as CapabilityStore,
    });
    const snapshot = await source.project.get();
    const resource = portableCapability();
    resource.spec.binding = desktopCapabilityBindingRef(capabilityId);
    resource.spec.config = { key: capabilityId };
    resource.metadata.name = active.definition.name;
    resource.metadata.description = active.definition.description;
    const published = await source.project.publish({
      expectedRevision: snapshot.revision,
      resources: [...snapshot.resources, resource],
    });
    const rootRef = canonicalPragmaResourceRef(resource);

    await expect(
      source.service.prepareExport({ rootRef, projectRevision: published.revision }),
    ).resolves.toMatchObject({
      root: { ref: rootRef, kind: "Capability", activeRevision: 2 },
      capabilityCount: 1,
    });
    const path = join(source.root, "skill.pragma");
    await source.service.exportTo(
      {
        rootRef,
        projectRevision: published.revision,
        modules: {
          capabilities: false,
          plugins: false,
          knowledgeBases: false,
          flowLayouts: false,
        },
      },
      path,
    );

    const archive = unzipSync(new Uint8Array(await readFile(path)));
    const manifest = JSON.parse(strFromU8(archive["bundle.json"]!)) as {
      schemaVersion: string;
      roots: string[];
      requirements: { ownerRef: string; payload?: { codec: string } }[];
    };
    expect(manifest).toMatchObject({ schemaVersion: "pragma.bundle/v3", roots: [rootRef] });
    expect(manifest.requirements).toContainEqual(
      expect.objectContaining({
        ownerRef: rootRef,
        payload: expect.objectContaining({ codec: "pragma.skill@v1" }),
      }),
    );
    await expect(source.service.inspect(path)).resolves.toMatchObject({
      root: { ref: rootRef, kind: "Capability", name: active.definition.name },
      dependencies: [expect.objectContaining({ kind: "capability", included: true })],
    });
    if (active.definition.kind !== "skill") throw new Error("Expected an active Skill.");
    active = {
      ...active,
      definition: { ...active.definition, contentHash: "f".repeat(64) },
    };
    await expect(
      source.service.exportTo(
        {
          rootRef,
          projectRevision: published.revision,
          modules: {
            capabilities: true,
            plugins: false,
            knowledgeBases: false,
            flowLayouts: false,
          },
        },
        join(source.root, "corrupt-skill.pragma"),
      ),
    ).rejects.toThrow("content hash does not match its files");
    expect(skillFilesPath).toHaveBeenCalledTimes(3);
  });

  it("round-trips a real CapabilityStore Skill without changing its content identity", async () => {
    const sourceStoreRoot = await mkdtemp(join(tmpdir(), "pragma-real-skill-source-store-"));
    const targetStoreRoot = await mkdtemp(join(tmpdir(), "pragma-real-skill-target-store-"));
    const skillSource = await mkdtemp(join(tmpdir(), "pragma-real-skill-files-"));
    directories.push(sourceStoreRoot, targetStoreRoot, skillSource);
    await mkdir(join(skillSource, "scripts"));
    await writeFile(
      join(skillSource, "SKILL.md"),
      "---\nname: Real Bundle Skill\ndescription: Round-trip a real Skill.\n---\n\nRun it.\n",
    );
    await writeFile(join(skillSource, "scripts", "run.sh"), "#!/bin/sh\necho ready\n");
    await chmod(join(skillSource, "scripts", "run.sh"), 0o755);

    const sourceCapabilities = createRealSkillCapabilityStore(sourceStoreRoot);
    const importedSourceCapability = await sourceCapabilities.importSkill({
      sourcePath: skillSource,
    });
    if (importedSourceCapability.definition.kind !== "skill") throw new Error("Expected a Skill.");
    const sourceSnapshot = await scanSkillWorkingTree(skillSource);
    const sourceCapability = await sourceCapabilities.publishSkillRevisionCandidate({
      id: importedSourceCapability.manifest.id,
      baseRevision: importedSourceCapability.manifest.latestRevision,
      baseContentHash: importedSourceCapability.definition.contentHash,
      sourcePath: skillSource,
      candidateContentHash: sourceSnapshot.hash,
    });
    if (sourceCapability.definition.kind !== "skill") throw new Error("Expected a Skill.");
    expect(sourceCapability.definition.contentHash).toBe(
      await hashSkillDirectoryContent(skillSource),
    );
    expect(sourceCapability.definition.contentHash).not.toBe(sourceSnapshot.hash);

    const source = await createFixture("real-skill-round-trip-source", {
      capabilities: sourceCapabilities,
    });
    const sourceProjectSnapshot = await source.project.get();
    const sourceResource = portableCapability();
    sourceResource.spec.binding = desktopCapabilityBindingRef(sourceCapability.manifest.id);
    sourceResource.metadata.name = sourceCapability.definition.name;
    sourceResource.metadata.description = sourceCapability.definition.description;
    const sourcePublished = await source.project.publish({
      expectedRevision: sourceProjectSnapshot.revision,
      resources: [...sourceProjectSnapshot.resources, sourceResource],
    });
    const rootRef = canonicalPragmaResourceRef(sourceResource);
    const bundlePath = join(source.root, "real-skill.pragma");
    const exported = await source.service.exportTo(
      {
        rootRef,
        projectRevision: sourcePublished.revision,
        modules: {
          capabilities: true,
          plugins: false,
          knowledgeBases: false,
          flowLayouts: false,
        },
      },
      bundlePath,
    );

    const targetCapabilities = createRealSkillCapabilityStore(targetStoreRoot);
    const target = await createFixture("real-skill-round-trip-target", {
      capabilities: targetCapabilities,
    });
    const firstInspection = await target.service.inspect(bundlePath, rootRef);
    const first = await target.service.startImport({
      sourcePath: bundlePath,
      rootRef,
      expectedFingerprint: exported.bundleFingerprint,
      expectedProjectFingerprint: exported.projectFingerprint,
      expectedProjectRevision: firstInspection.projectRevision,
      conflicts: [],
      assetConflicts: [],
      runtimes: [],
      capabilities: [],
      contextStores: [],
      secrets: {},
    });
    expect(first.status).toBe("ready");
    const [imported] = await targetCapabilities.list();
    expect(imported?.definition).toEqual(sourceCapability.definition);
    expect(imported?.manifest.latestRevision).toBe(1);
    expect(
      (
        await stat(
          join(
            await targetCapabilities.skillFilesPath(imported!.manifest.id, 1),
            "scripts",
            "run.sh",
          ),
        )
      ).mode & 0o111,
    ).not.toBe(0);

    const repeatedInspection = await target.service.inspect(bundlePath, rootRef);
    const repeated = await target.service.startImport({
      sourcePath: bundlePath,
      rootRef,
      expectedFingerprint: exported.bundleFingerprint,
      expectedProjectFingerprint: exported.projectFingerprint,
      expectedProjectRevision: repeatedInspection.projectRevision,
      conflicts: repeatedInspection.conflicts.map((conflict) => ({
        resourceRef: conflict.ref,
        action: "update" as const,
      })),
      assetConflicts: repeatedInspection.assetConflicts.map((conflict) => ({
        resourceRef: conflict.resourceRef,
        assetKind: conflict.assetKind,
        action: "update" as const,
        targetAssetId: imported!.manifest.id,
        expectedTarget: {
          revision: conflict.candidates[0]!.revision,
          fingerprint: conflict.candidates[0]!.fingerprint,
        },
      })),
      runtimes: [],
      capabilities: [],
      contextStores: [],
      secrets: {},
    });
    expect(repeated.status).toBe("ready");
    expect(await targetCapabilities.list()).toEqual([
      expect.objectContaining({
        manifest: expect.objectContaining({ id: imported!.manifest.id, latestRevision: 1 }),
        definition: sourceCapability.definition,
      }),
    ]);

    const nonExecutableStoreRoot = await mkdtemp(
      join(tmpdir(), "pragma-real-skill-non-executable-store-"),
    );
    const nonExecutableSkillSource = await mkdtemp(
      join(tmpdir(), "pragma-real-skill-non-executable-files-"),
    );
    directories.push(nonExecutableStoreRoot, nonExecutableSkillSource);
    await mkdir(join(nonExecutableSkillSource, "scripts"));
    await copyFile(join(skillSource, "SKILL.md"), join(nonExecutableSkillSource, "SKILL.md"));
    await copyFile(
      join(skillSource, "scripts", "run.sh"),
      join(nonExecutableSkillSource, "scripts", "run.sh"),
    );
    await chmod(join(nonExecutableSkillSource, "scripts", "run.sh"), 0o644);
    const nonExecutableCapabilities = createRealSkillCapabilityStore(nonExecutableStoreRoot);
    const nonExecutableCapability = await nonExecutableCapabilities.importSkill({
      sourcePath: nonExecutableSkillSource,
    });
    expect(nonExecutableCapability.definition).toEqual(sourceCapability.definition);
    expect(
      (
        await stat(
          join(
            await nonExecutableCapabilities.skillFilesPath(
              nonExecutableCapability.manifest.id,
              nonExecutableCapability.manifest.latestRevision,
            ),
            "scripts",
            "run.sh",
          ),
        )
      ).mode & 0o111,
    ).toBe(0);

    const nonExecutableTarget = await createFixture("real-skill-executable-update-target", {
      capabilities: nonExecutableCapabilities,
    });
    const executableInspection = await nonExecutableTarget.service.inspect(bundlePath, rootRef);
    expect(executableInspection.assetConflicts).toHaveLength(1);
    const executableConflict = executableInspection.assetConflicts[0]!;
    expect(executableConflict.importedFingerprint).not.toBe(
      executableConflict.candidates[0]!.fingerprint,
    );
    const executableUpdate = await nonExecutableTarget.service.startImport({
      sourcePath: bundlePath,
      rootRef,
      expectedFingerprint: exported.bundleFingerprint,
      expectedProjectFingerprint: exported.projectFingerprint,
      expectedProjectRevision: executableInspection.projectRevision,
      conflicts: executableInspection.conflicts.map((conflict) => ({
        resourceRef: conflict.ref,
        action: "update" as const,
      })),
      assetConflicts: [
        {
          resourceRef: executableConflict.resourceRef,
          assetKind: executableConflict.assetKind,
          action: "update",
          targetAssetId: nonExecutableCapability.manifest.id,
          expectedTarget: {
            revision: executableConflict.candidates[0]!.revision,
            fingerprint: executableConflict.candidates[0]!.fingerprint,
          },
        },
      ],
      runtimes: [],
      capabilities: [],
      contextStores: [],
      secrets: {},
    });
    expect(executableUpdate.status).toBe("ready");
    const updatedExecutableCapability = await nonExecutableCapabilities.get(
      nonExecutableCapability.manifest.id,
    );
    expect(updatedExecutableCapability.manifest.latestRevision).toBe(2);
    expect(
      (
        await stat(
          join(
            await nonExecutableCapabilities.skillFilesPath(
              nonExecutableCapability.manifest.id,
              updatedExecutableCapability.manifest.latestRevision,
            ),
            "scripts",
            "run.sh",
          ),
        )
      ).mode & 0o111,
    ).not.toBe(0);
  });

  it("rejects malformed Skill dependency payloads during inspection", async () => {
    const capabilityId = "0123456789abcdef";
    const source = await createFixture("malformed-skill-dependency");
    const snapshot = await source.project.get();
    const resource = portableCapability();
    resource.spec.binding = desktopCapabilityBindingRef(capabilityId);
    const sourceExpert = snapshot.resources.find(
      (candidate): candidate is PragmaExpertResource => candidate.kind === "Expert",
    )!;
    const published = await source.project.publish({
      expectedRevision: snapshot.revision,
      resources: [
        {
          ...sourceExpert,
          spec: {
            ...sourceExpert.spec,
            capabilities: [{ ref: canonicalPragmaResourceRef(resource), kind: "tools" }],
          },
        },
        ...snapshot.resources.filter((candidate) => candidate.kind !== "Expert"),
        resource,
      ],
    });
    const skillDocument = strToU8(
      "---\nname: Bundle Skill\ndescription: Bundle Skill description\n---\n\nPortable.\n",
    );
    const skillFile: SkillBundleFile = {
      path: "SKILL.md",
      sizeBytes: skillDocument.byteLength,
      sha256: testSha256(skillDocument),
      executable: false,
    };
    const definition = skillCapability(
      capabilityId,
      1,
      testSha256(skillBundleContentHashChunks([{ path: skillFile.path, contents: skillDocument }])),
    ).definition;
    if (definition.kind !== "skill") throw new Error("Expected a Skill definition.");
    const validFingerprint = testSha256(testStableStringify(definition));
    const filesFingerprint = testSha256(serializeSkillBundleFileManifest([skillFile]));
    const exportPayload = async (input: {
      readonly descriptorFingerprint: string;
      readonly includeEntry: boolean;
      readonly output: string;
    }) => {
      const project = await source.project.openRevision(published.revision);
      try {
        const exported = await project.exportBundle({
          roots: [canonicalPragmaResourceRef(sourceExpert)],
          host: {
            exportPayload: async ({ requirement }) =>
              requirement.ownerRef === canonicalPragmaResourceRef(resource)
                ? {
                    codec: "pragma.skill@v1",
                    files: new Map([
                      [
                        "descriptor.json",
                        strToU8(
                          JSON.stringify({
                            schemaVersion: "pragma.skill-bundle-payload/v1",
                            assetKey: capabilityId,
                            name: definition.name,
                            description: definition.description,
                            entryPath: definition.entryPath,
                            contentHash: definition.contentHash,
                            filesFingerprint,
                            fingerprint: input.descriptorFingerprint,
                            files: [skillFile],
                          }),
                        ),
                      ],
                      ...(input.includeEntry ? ([["files/SKILL.md", skillDocument]] as const) : []),
                    ]),
                  }
                : undefined,
          },
        });
        await writeFile(input.output, exported.bytes);
      } finally {
        await project.dispose();
      }
    };

    const mismatchedFingerprint = join(source.root, "skill-fingerprint-mismatch.pragma");
    await exportPayload({
      descriptorFingerprint: "f".repeat(64),
      includeEntry: true,
      output: mismatchedFingerprint,
    });
    await expect(source.service.inspect(mismatchedFingerprint)).rejects.toThrow(
      "definition fingerprint does not match",
    );

    const missingEntry = join(source.root, "skill-entry-missing.pragma");
    await exportPayload({
      descriptorFingerprint: validFingerprint,
      includeEntry: false,
      output: missingEntry,
    });
    await expect(source.service.inspect(missingEntry)).rejects.toThrow("file is missing");
  });

  it("accepts canonical Capability ids in the current installation journal", () => {
    const timestamp = new Date().toISOString();
    expect(
      PragmaBundleInstallationSchema.parse({
        schemaVersion: "pragma.bundle-installation/v8",
        bundleVersion: "pragma.bundle/v3",
        id: "00000000-0000-4000-8000-000000000001",
        bundleFingerprint: "a".repeat(64),
        projectId: "project",
        projectRevision: 1,
        sourceRootRef: "expert:1xddvess309a6gme",
        rootRef: "expert:1xddvess309a6gme",
        rootName: "Expert",
        rootKind: "Expert",
        resourceRefs: ["expert:1xddvess309a6gme"],
        createdResourceRefs: [],
        createdCapabilityIds: ["0123456789abcdef"],
        createdContextStoreIds: [],
        createdPluginRefs: [],
        conflictResolutions: [],
        resourceMappings: [],
        status: "ready",
        pending: [],
        readiness: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      }).createdCapabilityIds,
    ).toEqual(["0123456789abcdef"]);
  });

  it("round-trips only the current knowledge-base snapshot as revision 1", async () => {
    const source = await createFixture("knowledge-source", { realContextStores: true });
    const sourceStore = await source.contextStores.createFromSnapshot({
      name: "Release handbook",
      description: "Current release guidance.",
      author: "user",
      summary: "Initial content.",
      directories: ["guides"],
      files: [knowledgeFile("guides/release.md", "# Release v1\n")],
    });
    const first = await source.contextStores.getSnapshot(sourceStore.id);
    await source.contextStores.applyChangeSet(
      {
        schemaVersion: "pragma.context-store-change-set/v2",
        operation: "revise" as const,
        storeId: sourceStore.id,
        baseRevision: first.revision,
        baseSnapshotHash: first.snapshotHash,
        summary: "Publish v2.",
        operations: [
          {
            operation: "upsert",
            id: "guides/release.md",
            previousContent: "# Release v1\n",
            content: "# Release v2\n",
            metadata: knowledgeFile("guides/release.md", "").metadata,
          },
        ],
      },
      "user",
    );
    const published = await publishKnowledgeResource(source, sourceStore.id);
    const path = join(source.root, "knowledge.pragma");
    const exported = await source.service.exportTo(
      {
        rootRef: "context-store:kqh4nx7rx26mb3e7",
        projectRevision: published,
        modules: {
          capabilities: false,
          plugins: false,
          knowledgeBases: false,
          flowLayouts: false,
        },
      },
      path,
    );
    const archive = unzipSync(new Uint8Array(await readFile(path)));
    const descriptorPath = Object.keys(archive).find((entry) =>
      /assets\/req-.+\/descriptor\.json/u.test(entry),
    );
    expect(descriptorPath).toBeDefined();
    const payloadRoot = descriptorPath!.slice(0, descriptorPath!.lastIndexOf("descriptor.json"));
    expect(strFromU8(archive[`${payloadRoot}files/guides/release.md`]!)).toBe("# Release v2\n");
    const descriptor = JSON.parse(strFromU8(archive[descriptorPath!]!)) as {
      schemaVersion: string;
      snapshot: { files: readonly Record<string, unknown>[] };
    };
    expect(descriptor.schemaVersion).toBe("pragma.desktop.context-store-descriptor/v4");
    expect(descriptor.snapshot.files).toEqual([
      expect.objectContaining({ id: "guides/release.md" }),
    ]);
    expect(descriptor.snapshot.files[0]).not.toHaveProperty("content");

    const target = await createFixture("knowledge-target", { realContextStores: true });
    await target.contextStores.createFromSnapshot({
      name: "Existing identical content",
      description: "This Store must not be reused for a first-class root.",
      author: "user",
      summary: "Existing content.",
      directories: ["guides"],
      files: [knowledgeFile("guides/release.md", "# Release v2\n")],
    });
    const inspection = await target.service.inspect(path, "context-store:kqh4nx7rx26mb3e7");
    const installation = await target.service.startImport({
      sourcePath: path,
      rootRef: inspection.root.ref,
      expectedFingerprint: exported.bundleFingerprint,
      expectedProjectFingerprint: exported.projectFingerprint,
      expectedProjectRevision: inspection.projectRevision,
      conflicts: [],
      runtimes: [],
      capabilities: [],
      contextStores: [],
      secrets: {},
    });
    const importedStore = (await target.contextStores.list()).find(
      (store) => store.name === "Release handbook",
    )!;
    expect(await target.contextStores.list()).toHaveLength(2);
    expect(installation).toMatchObject({ rootKind: "ContextStore", status: "ready" });
    await expect(target.contextStores.getSnapshot(importedStore.id)).resolves.toMatchObject({
      revision: 1,
      directories: ["guides"],
      files: [expect.objectContaining({ id: "guides/release.md", content: "# Release v2\n" })],
    });
    await expect(target.contextStores.history(importedStore.id)).resolves.toEqual([
      expect.objectContaining({ revision: 1, author: "import", parentRevision: null }),
    ]);
  });

  it("rejects a knowledge-base root without its mandatory snapshot payload", async () => {
    const source = await createFixture("knowledge-missing-payload", { realContextStores: true });
    const store = await source.contextStores.createFromSnapshot({
      name: "Release handbook",
      description: "Current release guidance.",
      author: "user",
      summary: "Initial content.",
      files: [knowledgeFile("release.md", "# Release\n")],
    });
    const revision = await publishKnowledgeResource(source, store.id);
    const path = join(source.root, "knowledge-missing-payload.pragma");
    await source.service.exportTo(knowledgeExportInput(revision), path);
    const archive = unzipSync(new Uint8Array(await readFile(path)));
    const manifest = JSON.parse(strFromU8(archive["bundle.json"]!));
    for (const key of Object.keys(archive)) {
      if (key.startsWith("assets/")) delete archive[key];
    }
    manifest.requirements = manifest.requirements.map((requirement: Record<string, unknown>) => {
      const withoutPayload = { ...requirement };
      delete withoutPayload.payload;
      return withoutPayload;
    });
    manifest.files = manifest.files.filter(
      (file: { path: string }) => !file.path.startsWith("assets/"),
    );
    const withoutFingerprint = { ...manifest };
    delete withoutFingerprint.bundleFingerprint;
    manifest.bundleFingerprint = createPragmaBundleFingerprint(withoutFingerprint);
    archive["bundle.json"] = strToU8(`${JSON.stringify(manifest, undefined, 2)}\n`);
    await writeFile(path, zipSync(archive));

    await expect(source.service.inspect(path, "context-store:kqh4nx7rx26mb3e7")).rejects.toThrow(
      "must include its current managed snapshot",
    );
  });

  it("appends knowledge conflicts with snapshot CAS and makes identical imports a no-op", async () => {
    const source = await createFixture("knowledge-update-source", { realContextStores: true });
    const sourceStore = await source.contextStores.createFromSnapshot({
      name: "Release handbook",
      description: "Imported description.",
      author: "user",
      summary: "Imported content.",
      directories: ["imported-empty"],
      files: [knowledgeFile("release.md", "# Imported\n")],
    });
    const sourceRevision = await publishKnowledgeResource(source, sourceStore.id);
    const path = join(source.root, "knowledge-update.pragma");
    const exported = await source.service.exportTo(knowledgeExportInput(sourceRevision), path);

    const target = await createFixture("knowledge-update-target", { realContextStores: true });
    const targetStore = await target.contextStores.createFromSnapshot({
      name: "Local handbook",
      description: "Keep local identity and name.",
      author: "user",
      summary: "Local content.",
      directories: ["local-empty"],
      files: [knowledgeFile("release.md", "# Local\n")],
    });
    await publishKnowledgeResource(target, targetStore.id);
    const inspection = await target.service.inspect(path, "context-store:kqh4nx7rx26mb3e7");
    const conflict = inspection.conflicts.find(
      (candidate) => candidate.ref === "context-store:kqh4nx7rx26mb3e7",
    )!;
    expect(conflict).toMatchObject({ updateAllowed: true, targetRevision: 1 });
    const updateConflict = {
      resourceRef: conflict.ref,
      action: "update" as const,
      expectedTargetRevision: conflict.targetRevision,
      expectedTargetSnapshotHash: conflict.targetSnapshotHash,
    };
    const appended = await target.service.startImport({
      sourcePath: path,
      rootRef: inspection.root.ref,
      expectedFingerprint: exported.bundleFingerprint,
      expectedProjectFingerprint: exported.projectFingerprint,
      expectedProjectRevision: inspection.projectRevision,
      conflicts: [updateConflict],
      runtimes: [],
      capabilities: [],
      contextStores: [],
      secrets: {},
    });
    await expect(target.contextStores.getSnapshot(targetStore.id)).resolves.toMatchObject({
      revision: 2,
      directories: ["imported-empty"],
      files: [expect.objectContaining({ content: "# Imported\n" })],
    });
    await copyFile(path, target.paths.bundleInstallationArchive(appended.id));
    const catalog = JSON.parse(
      await readFile(target.paths.bundleInstallationsCatalog(), "utf8"),
    ) as { installations: Record<string, unknown>[] };
    catalog.installations = catalog.installations.map((record) =>
      record["id"] === appended.id
        ? {
            ...record,
            status: "installing",
            knowledgeBaseUpdate: {
              ...(record["knowledgeBaseUpdate"] as Record<string, unknown>),
              phase: "prepared",
            },
          }
        : record,
    );
    await writeFile(
      target.paths.bundleInstallationsCatalog(),
      `${JSON.stringify(catalog, undefined, 2)}\n`,
    );
    await expect(target.restartService().listInstallations()).resolves.toContainEqual(
      expect.objectContaining({ id: appended.id, status: "ready" }),
    );
    expect((await target.contextStores.getSnapshot(targetStore.id)).revision).toBe(2);
    const repeated = await target.service.inspect(path, "context-store:kqh4nx7rx26mb3e7");
    const repeatedConflict = repeated.conflicts[0]!;
    await target.service.startImport({
      sourcePath: path,
      rootRef: repeated.root.ref,
      expectedFingerprint: exported.bundleFingerprint,
      expectedProjectFingerprint: exported.projectFingerprint,
      expectedProjectRevision: repeated.projectRevision,
      conflicts: [
        {
          resourceRef: repeatedConflict.ref,
          action: "update",
          expectedTargetRevision: repeatedConflict.targetRevision,
          expectedTargetSnapshotHash: repeatedConflict.targetSnapshotHash,
        },
      ],
      assetConflicts: repeated.assetConflicts.map((assetConflict) => ({
        resourceRef: assetConflict.resourceRef,
        assetKind: assetConflict.assetKind,
        action: "update" as const,
        targetAssetId: assetConflict.candidates[0]!.assetId,
        expectedTarget: {
          revision: assetConflict.candidates[0]!.revision,
          fingerprint: assetConflict.candidates[0]!.fingerprint,
        },
      })),
      runtimes: [],
      capabilities: [],
      contextStores: [],
      secrets: {},
    });
    expect((await target.contextStores.getSnapshot(targetStore.id)).revision).toBe(2);

    const copiedInspection = await target.service.inspect(path, "context-store:kqh4nx7rx26mb3e7");
    const copied = await target.service.startImport({
      sourcePath: path,
      rootRef: copiedInspection.root.ref,
      expectedFingerprint: exported.bundleFingerprint,
      expectedProjectFingerprint: exported.projectFingerprint,
      expectedProjectRevision: copiedInspection.projectRevision,
      conflicts: copiedInspection.conflicts.map((candidate) => ({
        resourceRef: candidate.ref,
        action: "copy" as const,
      })),
      assetConflicts: copiedInspection.assetConflicts.map((assetConflict) => ({
        resourceRef: assetConflict.resourceRef,
        assetKind: assetConflict.assetKind,
        action: "copy" as const,
      })),
      runtimes: [],
      capabilities: [],
      contextStores: [],
      secrets: {},
    });
    expect(copied.rootRef).not.toBe("context-store:kqh4nx7rx26mb3e7");
    expect(copied.createdContextStoreIds).toHaveLength(1);
    await expect(
      target.contextStores.getSnapshot(copied.createdContextStoreIds[0]!),
    ).resolves.toMatchObject({ revision: 1 });

    const stale = await target.service.inspect(path, "context-store:kqh4nx7rx26mb3e7");
    await target.contextStores.createFile(targetStore.id, "local.md", "# Concurrent\n");
    await expect(
      target.service.startImport({
        sourcePath: path,
        rootRef: stale.root.ref,
        expectedFingerprint: exported.bundleFingerprint,
        expectedProjectFingerprint: exported.projectFingerprint,
        expectedProjectRevision: stale.projectRevision,
        conflicts: [
          {
            resourceRef: stale.conflicts[0]!.ref,
            action: "update",
            expectedTargetRevision: stale.conflicts[0]!.targetRevision,
            expectedTargetSnapshotHash: stale.conflicts[0]!.targetSnapshotHash,
          },
        ],
        assetConflicts: stale.assetConflicts.map((assetConflict) => ({
          resourceRef: assetConflict.resourceRef,
          assetKind: assetConflict.assetKind,
          action: "update" as const,
          targetAssetId: assetConflict.candidates[0]!.assetId,
          expectedTarget: {
            revision: assetConflict.candidates[0]!.revision,
            fingerprint: assetConflict.candidates[0]!.fingerprint,
          },
        })),
        runtimes: [],
        capabilities: [],
        contextStores: [],
        secrets: {},
      }),
    ).rejects.toThrow("target knowledge base changed");
  });

  it.each([
    { label: "metadata-only", targetContent: "# Imported\n" },
    { label: "content and metadata", targetContent: "# Local\n" },
  ])("recovers an interrupted $label knowledge-base update", async ({ targetContent }) => {
    const source = await createFixture(`knowledge-recovery-source-${targetContent.length}`, {
      realContextStores: true,
    });
    const sourceStore = await source.contextStores.createFromSnapshot({
      name: "Recovery handbook",
      description: "Imported description.",
      author: "user",
      summary: "Imported content.",
      files: [knowledgeFile("release.md", "# Imported\n")],
    });
    const sourceRevision = await publishKnowledgeResource(source, sourceStore.id);
    const path = join(source.root, "knowledge-recovery.pragma");
    await source.service.exportTo(knowledgeExportInput(sourceRevision), path);

    const target = await createFixture(`knowledge-recovery-target-${targetContent.length}`, {
      realContextStores: true,
      interruptNextContextAppend: true,
    });
    const targetStore = await target.contextStores.createFromSnapshot({
      name: "Recovery handbook",
      description: "Local description.",
      author: "user",
      summary: "Local content.",
      files: [knowledgeFile("release.md", targetContent)],
    });
    await publishKnowledgeResource(target, targetStore.id);
    const inspection = await target.service.inspect(path, "context-store:kqh4nx7rx26mb3e7");
    const failed = await target.service.startImport({
      sourcePath: path,
      rootRef: inspection.root.ref,
      expectedFingerprint: inspection.bundleFingerprint,
      expectedProjectFingerprint: inspection.projectFingerprint,
      expectedProjectRevision: inspection.projectRevision,
      conflicts: inspection.conflicts.map((conflict) => ({
        resourceRef: conflict.ref,
        action: "update" as const,
        expectedTargetRevision: conflict.targetRevision,
        expectedTargetSnapshotHash: conflict.targetSnapshotHash,
      })),
      assetConflicts: inspection.assetConflicts.map((conflict) => ({
        resourceRef: conflict.resourceRef,
        assetKind: conflict.assetKind,
        action: "update" as const,
        targetAssetId: conflict.candidates[0]!.assetId,
        expectedTarget: {
          revision: conflict.candidates[0]!.revision,
          fingerprint: conflict.candidates[0]!.fingerprint,
        },
      })),
      runtimes: [],
      capabilities: [],
      contextStores: [],
      secrets: {},
    });
    expect(failed.status).toBe("failed");
    await markInstallationInterrupted(target.paths, failed.id);

    await expect(target.restartService().listInstallations()).resolves.toContainEqual(
      expect.objectContaining({ id: failed.id, status: "ready" }),
    );
    await expect(target.contextStores.list()).resolves.toContainEqual(
      expect.objectContaining({
        id: targetStore.id,
        name: "Recovery handbook",
        description: "Imported description.",
        contentRevision: 2,
      }),
    );
    await expect(target.contextStores.getSnapshot(targetStore.id)).resolves.toMatchObject({
      revision: 2,
      files: [expect.objectContaining({ content: "# Imported\n" })],
    });
  });

  it("recovers an interrupted knowledge-base copy with its resolved local name", async () => {
    const source = await createFixture("knowledge-copy-recovery-source", {
      realContextStores: true,
    });
    const sourceStore = await source.contextStores.createFromSnapshot({
      name: "Shared handbook",
      description: "Imported description.",
      author: "user",
      summary: "Imported content.",
      files: [knowledgeFile("guide.md", "# Imported\n")],
    });
    const sourceRevision = await publishKnowledgeResource(
      source,
      sourceStore.id,
      "Shared handbook",
    );
    const path = join(source.root, "knowledge-copy-recovery.pragma");
    await source.service.exportTo(knowledgeExportInput(sourceRevision), path);

    const storesRoot = await mkdtemp(join(tmpdir(), "pragma-copy-recovery-stores-"));
    directories.push(storesRoot);
    const stores = createContextStoreStore({ storesPath: storesRoot });
    const existing = await stores.createFromSnapshot({
      name: "Shared handbook",
      description: "Local description.",
      author: "user",
      summary: "Local content.",
      files: [knowledgeFile("guide.md", "# Local\n")],
    });
    const target = await createFixture("knowledge-copy-recovery-target", {
      contextStores: stores,
      interruptNextContextSnapshotCreate: true,
    });
    await publishKnowledgeResource(target, existing.id);
    const inspection = await target.service.inspect(path, "context-store:kqh4nx7rx26mb3e7");
    const failed = await target.service.startImport({
      sourcePath: path,
      rootRef: inspection.root.ref,
      expectedFingerprint: inspection.bundleFingerprint,
      expectedProjectFingerprint: inspection.projectFingerprint,
      expectedProjectRevision: inspection.projectRevision,
      conflicts: inspection.conflicts.map((conflict) => ({
        resourceRef: conflict.ref,
        action: "copy" as const,
      })),
      assetConflicts: inspection.assetConflicts.map((conflict) => ({
        resourceRef: conflict.resourceRef,
        assetKind: conflict.assetKind,
        action: "copy" as const,
      })),
      runtimes: [],
      capabilities: [],
      contextStores: [],
      secrets: {},
    });
    expect(failed).toMatchObject({
      status: "failed",
      knowledgeBaseUpdate: { importedName: "Shared handbook (copy)", phase: "prepared" },
    });
    await markInstallationInterrupted(target.paths, failed.id);

    await expect(target.restartService().listInstallations()).resolves.toContainEqual(
      expect.objectContaining({ id: failed.id, status: "ready" }),
    );
    await expect(target.contextStores.list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "Shared handbook" }),
        expect.objectContaining({ name: "Shared handbook (copy)" }),
      ]),
    );
  });

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
                  tools: ["knowledge_revision_list_targets", "knowledge_revision_start"],
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
      "pragma.bundle-installations/v8",
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
      schemaVersion: "pragma.bundle-installations/v9",
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

  it("prepares publication metadata and keeps attached knowledge disabled by default", async () => {
    const fixture = await createFixture("publication-preview", {
      avatarId: "pragma.avatar.expert.07",
    });

    await expect(
      fixture.service.prepareExport({
        rootRef: "expert:1xddvess309a6gme",
        projectRevision: fixture.projectRevision,
      }),
    ).resolves.toMatchObject({
      root: {
        name: "Writer",
        tags: [],
        avatarId: "pragma.avatar.expert.07",
      },
      defaults: { knowledgeBases: false },
    });
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

  it("checks the health of the active Capability revision", async () => {
    const capabilityId = "00000000-0000-4000-8000-000000000190";
    const resource = portableCapability();
    resource.spec.binding = desktopCapabilityBindingRef(capabilityId);
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
      resolveActive: async () => boundRevision,
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

  it("inspects a v2 Capability payload with a canonical logical id", async () => {
    const fixture = await createFixture("canonical-capability-descriptor");
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
    const path = join(fixture.root, "canonical-capability.pragma");
    try {
      const exported = await project.exportBundle({
        roots: ["expert:1xddvess309a6gme"],
        host: {
          exportPayload: async ({ requirement }) =>
            requirement.kind === "binding"
              ? {
                  codec: "pragma.desktop.capability@v2",
                  files: new Map([
                    [
                      "descriptor.json",
                      strToU8(
                        JSON.stringify({
                          schemaVersion: "pragma.desktop.capability-descriptor/v2",
                          logicalId: "0123456789abcdef",
                          revision: 1,
                          definition: {
                            kind: "skill",
                            name: "Synced Skill",
                            description: "Imported from Skill sync.",
                            entryPath: "SKILL.md",
                            contentHash: "a".repeat(64),
                          },
                        }),
                      ),
                    ],
                  ]),
                }
              : undefined,
        },
      });
      await writeFile(path, exported.bytes);
    } finally {
      await project.dispose();
    }

    await expect(fixture.service.inspect(path)).resolves.toMatchObject({
      dependencies: expect.arrayContaining([
        expect.objectContaining({ kind: "capability", included: true }),
      ]),
    });
  });

  it("imports an included needs-attention Capability without requiring an active revision", async () => {
    const source = await createFixture("pending-capability-source");
    const snapshot = await source.project.get();
    const sourceExpert = snapshot.resources.find(
      (resource): resource is PragmaExpertResource => resource.kind === "Expert",
    )!;
    const capabilityResource = portableCapability();
    const published = await source.project.publish({
      expectedRevision: snapshot.revision,
      resources: [
        {
          ...sourceExpert,
          spec: {
            ...sourceExpert.spec,
            capabilities: [{ ref: canonicalPragmaResourceRef(capabilityResource), kind: "tools" }],
          },
        },
        ...snapshot.resources.filter((resource) => resource.kind !== "Expert"),
        capabilityResource,
      ],
    });
    const definition = {
      kind: "http_service" as const,
      name: "Pending HTTP service",
      description: "Requires credentials after import.",
      baseUrl: "https://api.example.test/v1",
      auth: { type: "bearer" as const, credentialRef: "service-auth" },
      timeoutMs: 30_000,
      tools: [
        {
          name: "get_customer",
          description: "Get a customer.",
          method: "GET" as const,
          path: "/customers/{id}",
          parameters: [
            {
              name: "id",
              location: "path" as const,
              required: true,
              type: "string" as const,
            },
          ],
        },
      ],
    };
    const project = await source.project.openRevision(published.revision);
    const path = join(source.root, "pending-capability.pragma");
    try {
      const exported = await project.exportBundle({
        roots: ["expert:1xddvess309a6gme"],
        host: {
          exportPayload: async ({ requirement }) =>
            requirement.kind === "binding"
              ? {
                  codec: "pragma.desktop.capability@v2",
                  files: new Map([
                    [
                      "descriptor.json",
                      strToU8(
                        JSON.stringify({
                          schemaVersion: "pragma.desktop.capability-descriptor/v2",
                          logicalId: "0123456789abcdef",
                          revision: 1,
                          definition,
                        }),
                      ),
                    ],
                  ]),
                }
              : undefined,
        },
      });
      await writeFile(path, exported.bytes);
    } finally {
      await project.dispose();
    }
    const created: Capability = {
      manifest: {
        schemaVersion: "pragma.capability/v4",
        id: "1h2j3k4m5n6p7q8r",
        runtimeKey: "pending-http-service",
        name: definition.name,
        kind: definition.kind,
        latestRevision: 1,
        createdAt: "2026-09-22T00:00:00.000Z",
        updatedAt: "2026-09-22T00:00:00.000Z",
      },
      definition,
      health: {
        revision: 1,
        status: "needs_attention",
        checkedAt: "2026-09-22T00:00:00.000Z",
        diagnostic: {
          code: "credential_missing",
          message: "Credential missing.",
          retryable: true,
        },
      },
    };
    const resolveActive = vi.fn(async () => {
      throw new Error("A pending Capability has no active revision.");
    });
    const target = await createFixture("pending-capability-target", {
      capabilities: {
        list: async () => [],
        create: async () => created,
        get: async () => created,
        resolveActive,
        remove: async () => undefined,
      } as unknown as CapabilityStore,
    });
    const inspection = await target.service.inspect(path);

    const installation = await target.service.startImport({
      ...importInput(
        path,
        inspection.bundleFingerprint,
        inspection.projectFingerprint,
        inspection.projectRevision,
      ),
      conflicts: inspection.conflicts.map((conflict) => ({
        resourceRef: conflict.ref,
        action: "copy" as const,
      })),
    });

    expect(installation).toMatchObject({
      status: "needs_setup",
      createdCapabilityIds: [created.manifest.id],
      pending: [
        expect.objectContaining({
          kind: "capability",
          status: "action_required",
          targetId: created.manifest.id,
        }),
      ],
    });
  });

  it("applies asset conflict decisions to legacy v1 Skill payloads", async () => {
    const source = await createFixture("legacy-skill-payload-source");
    const snapshot = await source.project.get();
    const sourceExpert = snapshot.resources.find(
      (resource): resource is PragmaExpertResource => resource.kind === "Expert",
    )!;
    const sourceResource = portableCapability();
    const published = await source.project.publish({
      expectedRevision: snapshot.revision,
      resources: [
        {
          ...sourceExpert,
          spec: {
            ...sourceExpert.spec,
            capabilities: [{ ref: canonicalPragmaResourceRef(sourceResource), kind: "tools" }],
          },
        },
        ...snapshot.resources.filter((resource) => resource.kind !== "Expert"),
        sourceResource,
      ],
    });
    const project = await source.project.openRevision(published.revision);
    const path = join(source.root, "legacy-skill-payload.pragma");
    const definition = skillCapability("0123456789abcdef", 1, "a".repeat(64)).definition;
    if (definition.kind !== "skill") throw new Error("Expected a Skill definition.");
    try {
      const exported = await project.exportBundle({
        roots: ["expert:1xddvess309a6gme"],
        host: {
          exportPayload: async ({ requirement }) =>
            requirement.kind === "binding"
              ? {
                  codec: "pragma.desktop.capability@v1",
                  files: new Map([
                    ["descriptor.json", strToU8(JSON.stringify(definition))],
                    [
                      "files/SKILL.md",
                      strToU8(
                        "---\nname: Bundle Skill\ndescription: Bundle Skill description\n---\n\nLegacy payload.\n",
                      ),
                    ],
                  ]),
                }
              : undefined,
        },
      });
      await writeFile(path, exported.bytes);
    } finally {
      await project.dispose();
    }

    const existing = skillCapability("fedcba9876543210", 4, "a".repeat(64));
    let copied: Capability | undefined;
    let copiedName: string | undefined;
    const capabilities = {
      list: async () => [existing, ...(copied === undefined ? [] : [copied])],
      publishNewSkillRevisionCandidate: async (input: { id: string; name: string }) => {
        copiedName = input.name;
        copied = {
          ...skillCapability(input.id, 1, "b".repeat(64)),
          manifest: { ...skillCapability(input.id, 1, "b".repeat(64)).manifest, name: input.name },
          definition: { ...definition, name: input.name, contentHash: "b".repeat(64) },
        };
        return copied;
      },
      get: async (id: string) => {
        if (copied?.manifest.id !== id) throw new Error(`Unexpected Capability ${id}.`);
        return copied;
      },
    } as unknown as CapabilityStore;
    const target = await createFixture("legacy-skill-payload-target", { capabilities });
    const inspection = await target.service.inspect(path);
    expect(inspection.assetConflicts).toHaveLength(1);

    const result = await target.service.startImport({
      sourcePath: path,
      rootRef: inspection.root.ref,
      expectedFingerprint: inspection.bundleFingerprint,
      expectedProjectFingerprint: inspection.projectFingerprint,
      expectedProjectRevision: target.projectRevision,
      conflicts: inspection.conflicts.map((conflict) => ({
        resourceRef: conflict.ref,
        action: "copy" as const,
      })),
      assetConflicts: inspection.assetConflicts.map((conflict) => ({
        resourceRef: conflict.resourceRef,
        assetKind: conflict.assetKind,
        action: "copy" as const,
      })),
      runtimes: [],
      capabilities: [],
      contextStores: [],
      secrets: {},
    });

    if (result.status === "failed") throw new Error(result.error);
    expect(result.status).toBe("ready");
    expect(copiedName).toBe("Bundle Skill (copy)");
    expect(copied?.manifest.id).not.toBe(existing.manifest.id);
  });

  it("localizes Bundle Skill updates and copies to ordinary Capability revisions", async () => {
    const sourceCapabilityId = "0123456789abcdef";
    const targetCapabilityId = "fedcba9876543210";
    const sourcePayloads = new Map<number, string>();
    const sourceCapability = async (revision: number) =>
      skillCapability(
        sourceCapabilityId,
        revision,
        await hashSkillDirectoryContent(sourcePayloads.get(revision)!),
      );
    const sourceCapabilities = {
      list: async () => [await sourceCapability(3)],
      get: async (_id: string, revision?: number) => await sourceCapability(revision ?? 3),
      skillFilesPath: async (_id: string, revision: number) => sourcePayloads.get(revision)!,
    } as unknown as CapabilityStore;
    const source = await createFixture("skill-update-source", {
      capabilities: sourceCapabilities,
    });
    for (const revision of [1, 2, 3]) {
      const payload = join(source.root, `skill-r${revision}`);
      await mkdir(payload, { recursive: true });
      await writeFile(
        join(payload, "SKILL.md"),
        `---\nname: Bundle Skill\ndescription: Bundle revision ${revision}\n---\n\nRevision ${revision}.\n`,
      );
      sourcePayloads.set(revision, payload);
    }
    const sourceSnapshot = await source.project.get();
    const sourceResource = portableCapability();
    sourceResource.spec.binding = desktopCapabilityBindingRef(sourceCapabilityId);
    const sourceExpert = sourceSnapshot.resources.find(
      (resource): resource is PragmaExpertResource => resource.kind === "Expert",
    )!;
    const sourcePublished = await source.project.publish({
      expectedRevision: sourceSnapshot.revision,
      resources: [
        {
          ...sourceExpert,
          spec: {
            ...sourceExpert.spec,
            capabilities: [
              { ref: canonicalPragmaResourceRef(sourceResource), kind: "tools" as const },
            ],
          },
        },
        ...sourceSnapshot.resources.filter((resource) => resource.kind !== "Expert"),
        sourceResource,
      ],
    });
    const path = join(source.root, "skill-update.pragma");
    await source.service.exportTo(exportInput(sourcePublished.revision), path);

    let publishedCandidateHash: string | undefined;
    const initialTargetPayload = await mkdtemp(join(tmpdir(), "pragma-skill-update-target-files-"));
    const updatedTargetPayload = await mkdtemp(
      join(tmpdir(), "pragma-skill-updated-target-files-"),
    );
    directories.push(initialTargetPayload, updatedTargetPayload);
    await writeFile(
      join(initialTargetPayload, "SKILL.md"),
      "---\nname: Bundle Skill\ndescription: Bundle Skill description\n---\n\nLocal revision.\n",
    );
    let targetPayloadPath = initialTargetPayload;
    let targetCapability = skillCapability(targetCapabilityId, 7, "f".repeat(64));
    const targetCapabilities = {
      list: async () => [targetCapability],
      skillFilesPath: async () => targetPayloadPath,
      publishSkillRevisionCandidate: async (input: {
        candidateContentHash: string;
        sourcePath: string;
      }) => {
        publishedCandidateHash = input.candidateContentHash;
        await copyFile(join(input.sourcePath, "SKILL.md"), join(updatedTargetPayload, "SKILL.md"));
        targetPayloadPath = updatedTargetPayload;
        targetCapability = {
          ...skillCapability(targetCapabilityId, 8, "e".repeat(64)),
          definition: (await sourceCapability(3)).definition,
        };
        return targetCapability;
      },
      get: async (_id: string, revision?: number) => {
        if (revision !== 8) throw new Error(`Expected binding revision 8, received ${revision}.`);
        return targetCapability;
      },
    } as unknown as CapabilityStore;
    const target = await createFixture("skill-update-target", {
      capabilities: targetCapabilities,
      failImportPublishOnce: true,
    });
    const targetSnapshot = await target.project.get();
    const targetResource = portableCapability();
    targetResource.spec.binding = desktopCapabilityBindingRef(targetCapabilityId);
    const targetExpert = targetSnapshot.resources.find(
      (resource): resource is PragmaExpertResource => resource.kind === "Expert",
    )!;
    const targetPublished = await target.project.publish({
      expectedRevision: targetSnapshot.revision,
      resources: [
        {
          ...targetExpert,
          spec: {
            ...targetExpert.spec,
            capabilities: [
              { ref: canonicalPragmaResourceRef(targetResource), kind: "tools" as const },
            ],
          },
        },
        ...targetSnapshot.resources.filter((resource) => resource.kind !== "Expert"),
        targetResource,
      ],
    });
    const inspection = await target.service.inspect(path);
    const importInput: StartPragmaBundleImport = {
      sourcePath: path,
      rootRef: inspection.root.ref,
      expectedFingerprint: inspection.bundleFingerprint,
      expectedProjectFingerprint: inspection.projectFingerprint,
      expectedProjectRevision: targetPublished.revision,
      conflicts: inspection.conflicts.map((conflict) => ({
        resourceRef: conflict.ref,
        action:
          conflict.ref === canonicalPragmaResourceRef(targetResource)
            ? ("update" as const)
            : ("keep_local" as const),
      })),
      assetConflicts: inspection.assetConflicts.map((assetConflict) => ({
        resourceRef: assetConflict.resourceRef,
        assetKind: assetConflict.assetKind,
        action: "update" as const,
        targetAssetId: assetConflict.candidates[0]!.assetId,
        expectedTarget: {
          revision: assetConflict.candidates[0]!.revision,
          fingerprint: assetConflict.candidates[0]!.fingerprint,
        },
      })),
      runtimes: [],
      capabilities: [],
      contextStores: [],
      secrets: {},
    };
    await expect(target.service.startImport(importInput)).resolves.toMatchObject({
      status: "failed",
    });
    await expect(target.service.startImport(importInput)).resolves.toMatchObject({
      status: "ready",
    });

    expect(publishedCandidateHash).toBe((await scanSkillWorkingTree(sourcePayloads.get(3)!)).hash);
    const installed = await target.project.get();
    const bound = installed.resources.find(
      (resource): resource is PragmaCapabilityResource =>
        canonicalPragmaResourceRef(resource) === canonicalPragmaResourceRef(targetResource),
    );
    expect(bound?.spec.binding).toBe(desktopCapabilityBindingRef(targetCapabilityId));

    let copiedCapability: Capability | undefined;
    const copyCapabilities = {
      list: async () => (copiedCapability === undefined ? [] : [copiedCapability]),
      publishNewSkillRevisionCandidate: async (input: { id: string }) => {
        copiedCapability = skillCapability(input.id, 1, "d".repeat(64));
        return copiedCapability;
      },
      get: async (id: string, revision?: number) => {
        if (
          copiedCapability === undefined ||
          id !== copiedCapability.manifest.id ||
          revision !== 1
        ) {
          throw new Error(`Expected copied Capability revision 1, received ${id}@${revision}.`);
        }
        return copiedCapability;
      },
    } as unknown as CapabilityStore;
    const copyTarget = await createFixture("skill-copy-target", {
      capabilities: copyCapabilities,
    });
    const copyInspection = await copyTarget.service.inspect(path);
    await copyTarget.service.startImport({
      sourcePath: path,
      rootRef: copyInspection.root.ref,
      expectedFingerprint: copyInspection.bundleFingerprint,
      expectedProjectFingerprint: copyInspection.projectFingerprint,
      expectedProjectRevision: copyTarget.projectRevision,
      conflicts: copyInspection.conflicts.map((conflict) => ({
        resourceRef: conflict.ref,
        action: "copy" as const,
      })),
      runtimes: [],
      capabilities: [],
      contextStores: [],
      secrets: {},
    });

    expect(copiedCapability?.manifest.id).not.toBe(sourceCapabilityId);
    expect(copiedCapability?.manifest.latestRevision).toBe(1);
    expect("origin" in copiedCapability!.manifest).toBe(false);
    const copiedProject = await copyTarget.project.get();
    const copiedResource = copiedProject.resources.find(
      (resource): resource is PragmaCapabilityResource =>
        canonicalPragmaResourceRef(resource) === canonicalPragmaResourceRef(sourceResource),
    );
    expect(copiedResource?.spec.binding).toBe(
      desktopCapabilityBindingRef(copiedCapability!.manifest.id),
    );
  });

  it("imports one local Skill for duplicate Bundle references on create and update", async () => {
    const sourceCapabilityId = "0123456789abcdef";
    const payload = await mkdtemp(join(tmpdir(), "pragma-shared-bundle-skill-"));
    directories.push(payload);
    await writeFile(
      join(payload, "SKILL.md"),
      "---\nname: Bundle Skill\ndescription: Bundle Skill description\n---\n\nShared asset.\n",
    );
    await mkdir(join(payload, "scripts"));
    await writeFile(join(payload, "scripts/review.sh"), "#!/bin/sh\necho review\n");
    await chmod(join(payload, "scripts/review.sh"), 0o755);
    const sourceContentHash = await hashSkillDirectoryContent(payload);
    const sourceCapabilities = {
      list: async () => [skillCapability(sourceCapabilityId, 1, sourceContentHash)],
      get: async () => skillCapability(sourceCapabilityId, 1, sourceContentHash),
      skillFilesPath: async () => payload,
    } as unknown as CapabilityStore;
    const source = await createFixture("shared-skill-source", {
      capabilities: sourceCapabilities,
    });
    const snapshot = await source.project.get();
    const first = portableCapability();
    first.spec.binding = desktopCapabilityBindingRef(sourceCapabilityId);
    const second: PragmaCapabilityResource = {
      ...first,
      metadata: { ...first.metadata, id: "2222222222222222", name: "Second Skill Resource" },
    };
    const sourceExpert = snapshot.resources.find(
      (resource): resource is PragmaExpertResource => resource.kind === "Expert",
    )!;
    const published = await source.project.publish({
      expectedRevision: snapshot.revision,
      resources: [
        {
          ...sourceExpert,
          spec: {
            ...sourceExpert.spec,
            capabilities: [first, second].map((resource) => ({
              ref: canonicalPragmaResourceRef(resource),
              kind: "tools" as const,
            })),
          },
        },
        ...snapshot.resources.filter((resource) => resource.kind !== "Expert"),
        first,
        second,
      ],
    });
    const path = join(source.root, "shared-skill.pragma");
    await source.service.exportTo(exportInput(published.revision), path);

    let created: Capability | undefined;
    let createCount = 0;
    let importedExecutable = false;
    const targetCapabilities = {
      list: async () => (created === undefined ? [] : [created]),
      publishNewSkillRevisionCandidate: async (input: { id: string; sourcePath: string }) => {
        createCount += 1;
        importedExecutable =
          ((await stat(join(input.sourcePath, "scripts/review.sh"))).mode & 0o111) !== 0;
        created = skillCapability(input.id, 1, "2".repeat(64));
        return created;
      },
      get: async (id: string) => {
        if (created?.manifest.id !== id) throw new Error(`Unexpected Capability ${id}.`);
        return created;
      },
    } as unknown as CapabilityStore;
    const target = await createFixture("shared-skill-target", {
      capabilities: targetCapabilities,
    });
    const inspection = await target.service.inspect(path);
    const installation = await target.service.startImport({
      sourcePath: path,
      rootRef: inspection.root.ref,
      expectedFingerprint: inspection.bundleFingerprint,
      expectedProjectFingerprint: inspection.projectFingerprint,
      expectedProjectRevision: inspection.projectRevision,
      conflicts: inspection.conflicts.map((conflict) => ({
        resourceRef: conflict.ref,
        action: "copy" as const,
      })),
      assetConflicts: [],
      runtimes: [],
      capabilities: [],
      contextStores: [],
      secrets: {},
    });

    expect(installation.status).toBe("ready");
    expect(createCount).toBe(1);
    expect(importedExecutable).toBe(true);
    const imported = await target.project.get();
    const bindings = imported.resources
      .filter(
        (resource): resource is PragmaCapabilityResource =>
          resource.kind === "Capability" &&
          (resource.metadata.id === first.metadata.id ||
            resource.metadata.id === second.metadata.id),
      )
      .map((resource) => resource.spec.binding);
    const expectedBinding = desktopCapabilityBindingRef(created!.manifest.id);
    expect(bindings).toEqual([expectedBinding, expectedBinding]);

    const existingId = "fedcba9876543210";
    const existingPayload = await mkdtemp(join(tmpdir(), "pragma-shared-local-skill-"));
    directories.push(existingPayload);
    await writeFile(
      join(existingPayload, "SKILL.md"),
      "---\nname: Bundle Skill\ndescription: Bundle Skill description\n---\n\nLocal asset.\n",
    );
    let updated = skillCapability(existingId, 7, "7".repeat(64));
    let updateCount = 0;
    const updateCapabilities = {
      list: async () => [updated],
      skillFilesPath: async () => existingPayload,
      publishSkillRevisionCandidate: async () => {
        updateCount += 1;
        updated = skillCapability(existingId, 8, "8".repeat(64));
        return updated;
      },
      get: async () => updated,
    } as unknown as CapabilityStore;
    const updateTarget = await createFixture("shared-skill-update-target", {
      capabilities: updateCapabilities,
    });
    const updateInspection = await updateTarget.service.inspect(path);
    expect(updateInspection.assetConflicts).toHaveLength(1);
    const updatedInstallation = await updateTarget.service.startImport({
      sourcePath: path,
      rootRef: updateInspection.root.ref,
      expectedFingerprint: updateInspection.bundleFingerprint,
      expectedProjectFingerprint: updateInspection.projectFingerprint,
      expectedProjectRevision: updateInspection.projectRevision,
      conflicts: updateInspection.conflicts.map((conflict) => ({
        resourceRef: conflict.ref,
        action: "copy" as const,
      })),
      assetConflicts: updateInspection.assetConflicts.map((conflict) => ({
        resourceRef: conflict.resourceRef,
        assetKind: conflict.assetKind,
        action: "update" as const,
        targetAssetId: existingId,
        expectedTarget: {
          revision: conflict.candidates[0]!.revision,
          fingerprint: conflict.candidates[0]!.fingerprint,
        },
      })),
      runtimes: [],
      capabilities: [],
      contextStores: [],
      secrets: {},
    });
    expect(updatedInstallation.status).toBe("ready");
    expect(updateCount).toBe(1);
    const updatedProject = await updateTarget.project.get();
    const updatedBindings = updatedProject.resources
      .filter(
        (resource): resource is PragmaCapabilityResource =>
          resource.kind === "Capability" &&
          (resource.metadata.id === first.metadata.id ||
            resource.metadata.id === second.metadata.id),
      )
      .map((resource) => resource.spec.binding);
    expect(updatedBindings).toEqual([
      desktopCapabilityBindingRef(existingId),
      desktopCapabilityBindingRef(existingId),
    ]);
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

  it("keeps matching local resources when requested", async () => {
    const source = await createFixture("keep-local-source");
    const path = join(source.root, "workflow.pragma");
    const exported = await source.service.exportTo(exportInput(source.projectRevision), path);
    const target = await createFixture("keep-local-target", {
      instructions: "Keep this local instruction.",
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
        { resourceRef: "expert:1xddvess309a6gme", action: "keep_local" },
        { resourceRef: "runtime-profile:zdkgs0fde4xt00vr", action: "keep_local" },
      ],
    });
    const snapshot = await target.project.get();

    expect(installation.status).toBe("needs_setup");
    expect(installation.pending).toContainEqual(
      expect.objectContaining({ kind: "runtime", action: "choose_runtime" }),
    );
    expect(installation.createdResourceRefs).toEqual([]);
    expect(snapshot.resources).toHaveLength(2);
    expect(
      snapshot.resources.find((resource) => resource.kind === "Expert")?.spec.instructions,
    ).toBe("Keep this local instruction.");
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

  it("maps keep-local decisions to the existing local identity", () => {
    const resolved = resolveBundleIdentities(
      [runtime("codex")],
      [runtime("codex", "v3b460tasfhyf22d")],
      [{ resourceRef: "runtime-profile:zdkgs0fde4xt00vr", action: "keep_local" }],
    );

    expect(resolved.identities).toContainEqual(
      expect.objectContaining({
        sourceRef: "runtime-profile:zdkgs0fde4xt00vr",
        targetId: "v3b460tasfhyf22d",
      }),
    );
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
    readonly realContextStores?: boolean;
    readonly capabilities?: CapabilityStore;
    readonly failImportPublishOnce?: boolean;
    readonly interruptNextContextAppend?: boolean;
    readonly interruptNextContextSnapshotCreate?: boolean;
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
  const baseContextStores =
    overrides.contextStores ??
    (overrides.realContextStores
      ? createContextStoreStore({ storesPath: join(root, "context-stores") })
      : ({ list: async () => [] } as unknown as ContextStoreStore));
  let remainingContextAppendInterruptions = overrides.interruptNextContextAppend ? 1 : 0;
  let remainingContextCreateInterruptions = overrides.interruptNextContextSnapshotCreate ? 1 : 0;
  const contextStores = new Proxy(baseContextStores, {
    get(target, property, receiver) {
      if (property === "createFromSnapshot") {
        return async (...args: Parameters<ContextStoreStore["createFromSnapshot"]>) => {
          if (remainingContextCreateInterruptions > 0) {
            remainingContextCreateInterruptions -= 1;
            throw new Error("Injected ContextStore snapshot creation interruption.");
          }
          return await target.createFromSnapshot(...args);
        };
      }
      if (property !== "appendSnapshot") return Reflect.get(target, property, receiver);
      return async (...args: Parameters<ContextStoreStore["appendSnapshot"]>) => {
        if (remainingContextAppendInterruptions > 0) {
          remainingContextAppendInterruptions -= 1;
          throw new Error("Injected ContextStore append interruption.");
        }
        return await target.appendSnapshot(...args);
      };
    },
  });
  let remainingPublishFailures = overrides.failImportPublishOnce ? 1 : 0;
  const serviceProject = new Proxy(project, {
    get(target, property, receiver) {
      if (property !== "publish") return Reflect.get(target, property, receiver);
      return async (...args: Parameters<typeof project.publish>) => {
        if (remainingPublishFailures > 0) {
          remainingPublishFailures -= 1;
          throw new Error("Injected Project publish failure.");
        }
        return await project.publish(...args);
      };
    },
  });
  const baseCapabilities =
    overrides.capabilities ??
    ({
      list: async () => [],
    } as unknown as CapabilityStore);
  const capabilities = new Proxy(baseCapabilities, {
    get(target, property, receiver) {
      if (property === "resolveActive" && target.resolveActive === undefined) {
        return async (id: string) => {
          const listed = await target.list();
          const capability = listed.find((candidate) => candidate.manifest.id === id);
          return await target.get(
            id,
            capability?.manifest.activeRevision ?? capability?.manifest.latestRevision,
          );
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const serviceOptions = {
    paths,
    project: serviceProject,
    capabilities,
    contextStores,
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
  } as const;
  const service = createPragmaBundleService(serviceOptions);
  return {
    root,
    paths,
    project,
    projectRevision: published.revision,
    service,
    contextStores,
    restartService: () => createPragmaBundleService(serviceOptions),
  };
}

function createRealSkillCapabilityStore(root: string): CapabilityStore {
  const credentials: CapabilityCredentialStore = {
    overlay: () => credentials,
    setMany: async () => undefined,
    prepareMany: async () => undefined,
    activate: async () => undefined,
    finalize: async () => undefined,
    rollback: async () => undefined,
    pending: async () => undefined,
    get: async () => undefined,
    removeCapability: async () => undefined,
    fingerprint: async () => createHash("sha256").update("[]").digest("hex"),
  };
  return createCapabilityStore({
    capabilitiesPath: join(root, "capabilities"),
    credentials,
    verify: async (definition) => ({
      definition,
      health: { status: "ready", checkedAt: "2026-09-23T00:00:00.000Z" },
    }),
    mutations: {
      publish: async (input) => {
        await input.validateCurrent?.();
        return await input.commit();
      },
      publishHealth: async (input) => {
        await input.validateCurrent?.();
        return await input.commit();
      },
      mutate: async (input) => {
        await input.validateCurrent?.();
        await input.commit();
      },
    },
    isReferenced: async () => false,
  });
}

function knowledgeFile(id: string, content: string) {
  return {
    id,
    content,
    metadata: {
      description: "Release guidance",
      trigger: "always_on" as const,
      priority: "high" as const,
    },
  };
}

async function markInstallationInterrupted(paths: PragmaPaths, installationId: string) {
  const catalog = JSON.parse(await readFile(paths.bundleInstallationsCatalog(), "utf8")) as {
    installations: Record<string, unknown>[];
  };
  catalog.installations = catalog.installations.map((record) =>
    record["id"] === installationId
      ? { ...record, status: "installing", error: undefined }
      : record,
  );
  await writeFile(paths.bundleInstallationsCatalog(), `${JSON.stringify(catalog, undefined, 2)}\n`);
}

function knowledgeExportInput(projectRevision: number) {
  return {
    rootRef: "context-store:kqh4nx7rx26mb3e7" as const,
    projectRevision,
    modules: {
      capabilities: false,
      plugins: false,
      knowledgeBases: true,
      flowLayouts: false,
    },
  };
}

async function publishKnowledgeResource(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  storeId: string,
  resourceName?: string,
): Promise<number> {
  const snapshot = await fixture.project.get();
  const resource = contextStore(storeId);
  if (resourceName !== undefined) resource.metadata.name = resourceName;
  const published = await fixture.project.publish({
    expectedRevision: snapshot.revision,
    resources: [
      ...snapshot.resources.filter((resource) => resource.kind !== "ContextStore"),
      resource,
    ],
  });
  return published.revision;
}

function exportInput(projectRevision: number) {
  return {
    rootRef: "expert:1xddvess309a6gme" as const,
    projectRevision,
    modules: {
      capabilities: true,
      plugins: false,
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

function contextStore(
  storeId = "00000000-0000-4000-8000-000000000191",
): PragmaContextStoreResource {
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
      binding: desktopContextBindingRef(storeId),
      config: { key: storeId },
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

function testSha256(value: string | Uint8Array | readonly (string | Uint8Array)[]): string {
  const hash = createHash("sha256");
  if (typeof value === "string" || value instanceof Uint8Array) hash.update(value);
  else for (const chunk of value) hash.update(chunk);
  return hash.digest("hex");
}

function testStableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(testStableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${testStableStringify(entry)}`)
    .join(",")}}`;
}

function skillCapability(id: string, latestRevision: number, contentHash: string): Capability {
  const timestamp = "2026-09-21T00:00:00.000Z";
  return {
    manifest: {
      schemaVersion: "pragma.capability/v4",
      id,
      runtimeKey: `skill-${id}`,
      name: "Bundle Skill",
      kind: "skill",
      latestRevision,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    definition: {
      kind: "skill",
      name: "Bundle Skill",
      description: "Bundle Skill description",
      entryPath: "SKILL.md",
      contentHash,
    },
    health: { revision: latestRevision, status: "ready", checkedAt: timestamp },
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
