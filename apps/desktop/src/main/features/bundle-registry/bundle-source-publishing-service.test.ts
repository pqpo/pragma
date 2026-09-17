import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { PragmaBundleService } from "../bundles/pragma-bundle-service.ts";
import { createBundleSourcePublishingService } from "./bundle-source-publishing-service.ts";
import type { DesktopBundleRegistrySourceService } from "./bundle-registry-source-service.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Bundle Source publishing", () => {
  it("prepares listing metadata from the root resource description", async () => {
    const prepareExport = vi.fn(async () => ({
      root: {
        ref: "expert:1234567890abcdef",
        kind: "Expert" as const,
        name: "Reviewer",
        description: "Reviews code changes.\n\nLonger implementation notes.",
        tags: ["code-review", "typescript"],
        avatarId: "pragma.avatar.expert.07",
      },
      projectRevision: 3,
      resourceCount: 2,
      capabilityCount: 2,
      pluginCount: 1,
      knowledgeBaseCount: 0,
      hasFlowLayouts: false,
      defaults: {
        capabilities: true,
        plugins: true,
        knowledgeBases: false,
        flowLayouts: true,
      },
    }));
    const service = createBundleSourcePublishingService({
      cacheRoot: "/unused",
      bundles: { prepareExport } as unknown as PragmaBundleService,
      sources: {
        preparePublicationSources: vi.fn(async () => []),
      } as unknown as DesktopBundleRegistrySourceService,
      readGitIdentity: async () => ({ name: "Pragma Test", email: "test@pragma.invalid" }),
    });

    await expect(
      service.prepare({ rootRef: "expert:1234567890abcdef", projectRevision: 3 }),
    ).resolves.toMatchObject({
      root: { description: "Reviews code changes.\n\nLonger implementation notes." },
      moduleCounts: { capabilities: 2, plugins: 1, knowledgeBases: 0, flowLayouts: 0 },
      modules: {
        capabilities: true,
        plugins: true,
        knowledgeBases: false,
        flowLayouts: false,
      },
      metadata: {
        description: "Reviews code changes.\n\nLonger implementation notes.",
        summary: "Reviews code changes.",
        tags: ["code-review", "typescript"],
        avatarId: "pragma.avatar.expert.07",
      },
    });
  });

  it("generates one Bundle and retains per-source partial results", async () => {
    const cacheRoot = await mkdtemp(join(tmpdir(), "pragma-publishing-"));
    roots.push(cacheRoot);
    const prepareExport = vi.fn(async () => ({
      root: {
        ref: "expert:1234567890abcdef",
        kind: "Expert" as const,
        name: "Reviewer",
        description: "Reviews code changes from the project resource.",
        tags: ["review"],
        avatarId: "pragma.avatar.expert.07",
      },
      projectRevision: 3,
      resourceCount: 1,
      capabilityCount: 0,
      pluginCount: 0,
      knowledgeBaseCount: 0,
      hasFlowLayouts: false,
      defaults: {
        capabilities: true,
        plugins: true,
        knowledgeBases: false,
        flowLayouts: true,
      },
    }));
    const exportTo = vi.fn(async (_input, path: string) => ({
      path,
      bundleFingerprint: "a".repeat(64),
      projectFingerprint: "b".repeat(64),
    }));
    const publishBundleToSource = vi.fn(
      async (
        input: Parameters<DesktopBundleRegistrySourceService["publishBundleToSource"]>[0],
      ) => ({
        sourceId: input.target.sourceId,
        sourceName: input.target.sourceId === SOURCE_A ? "Source A" : "Source B",
        status: input.target.sourceId === SOURCE_A ? ("published" as const) : ("failed" as const),
        version: input.target.version,
        ...(input.target.sourceId === SOURCE_A
          ? { commit: "c".repeat(40) }
          : { errorCode: "git_auth_failed", errorMessage: "Permission denied" }),
      }),
    );
    const service = createBundleSourcePublishingService({
      cacheRoot,
      bundles: { prepareExport, exportTo } as unknown as PragmaBundleService,
      sources: { publishBundleToSource } as unknown as DesktopBundleRegistrySourceService,
      readGitIdentity: async () => ({ name: "Pragma Test", email: "test@pragma.invalid" }),
    });

    const result = await service.publish({
      rootRef: "expert:1234567890abcdef",
      projectRevision: 3,
      modules: {
        capabilities: true,
        plugins: true,
        knowledgeBases: false,
        flowLayouts: true,
      },
      metadata: {
        itemId: "reviewer",
        name: "Reviewer",
        summary: "Reviews code",
        description: "Reviews code changes.",
        authorName: "Pragma Test",
        license: "MIT",
        tags: ["review"],
        avatarId: "pragma.avatar.expert.07",
      },
      targets: [
        { sourceId: SOURCE_A, categoryId: "general", version: "1.0.0" },
        { sourceId: SOURCE_B, categoryId: "general", version: "1.0.0" },
      ],
    });

    expect(exportTo).toHaveBeenCalledTimes(1);
    expect(publishBundleToSource).toHaveBeenCalledTimes(2);
    expect(publishBundleToSource).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ avatarId: "pragma.avatar.expert.07" }),
      }),
    );
    expect(result.results).toEqual([
      expect.objectContaining({ sourceId: SOURCE_A, status: "published" }),
      expect.objectContaining({ sourceId: SOURCE_B, status: "failed" }),
    ]);
  });
});

const SOURCE_A = "11111111-1111-4111-8111-111111111111";
const SOURCE_B = "22222222-2222-4222-8222-222222222222";
