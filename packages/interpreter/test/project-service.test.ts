import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { defineExpert, type Expert, type Flow } from "@pragma/core";
import { describe, expect, it } from "vitest";

import {
  PragmaProjectRevisionConflictError,
  PragmaProjectValidationError,
  PragmaProjectService,
  type PragmaProjectRevisionLocation,
  type PragmaProjectSourceRepository,
} from "../src/index.ts";
import type {
  PragmaCapabilityResource,
  PragmaExpertResource,
  PragmaFlowResource,
  PragmaRuntimeProfileResource,
} from "../src/ast/index.ts";

describe("PragmaProjectService", () => {
  it("publishes with compare-and-swap and compiles a pinned revision", async () => {
    const repository = await createRepository();
    const service = new PragmaProjectService({ repository });
    const first = await service.publish({
      projectId: "studio",
      expectedRevision: 0,
      resources: [runtime(), skill(), expert()],
      artifacts: new Map([["assets/writing-skill/SKILL.md", "# Writing\n\nWrite clearly.\n"]]),
    });

    expect(first.revision).toBe(1);
    expect(first.lock?.projectFingerprint).toBe(first.projectFingerprint);
    await expect(
      service.publish({ projectId: "studio", expectedRevision: 0, resources: [runtime()] }),
    ).rejects.toBeInstanceOf(PragmaProjectRevisionConflictError);
    const second = await service.applyChangeSet({
      projectId: "studio",
      changeSet: {
        baseRevision: 1,
        upserts: [
          {
            ...expert(),
            metadata: { ...expert().metadata, description: "Updated writer." },
          },
        ],
      },
    });
    expect(second.revision).toBe(2);

    const compiled = await service.compile<Expert>({
      projectId: "studio",
      revision: 2,
      ref: "expert:1xddvess309a6gme",
      workspace: repository.root,
      environmentId: "test",
      adapterHost: {
        environmentId: "test",
        projectRoot: repository.root,
        async resolveBinding() {
          return undefined;
        },
        async resolveArtifact(source) {
          throw new Error(`Unexpected artifact: ${JSON.stringify(source)}`);
        },
        async resolveSecret() {
          return undefined;
        },
      },
    });
    expect(compiled.value.id).toBe("1xddvess309a6gme");
    expect(compiled.value.skills?.skills).toHaveLength(1);
    expect(compiled.rootRuntimeId).toBe("codex");
    expect(compiled.projectFingerprint).toBe(second.projectFingerprint);
  });

  it("preserves artifacts during candidate validation and refuses a missing persisted lock", async () => {
    const repository = await createRepository();
    const service = new PragmaProjectService({ repository });
    await service.publish({
      projectId: "studio",
      expectedRevision: 0,
      resources: [runtime(), skill(), expert()],
      artifacts: new Map([["assets/writing-skill/SKILL.md", "# Writing\n"]]),
    });

    await expect(
      service.validateChangeSet({
        projectId: "studio",
        changeSet: {
          baseRevision: 1,
          upserts: [{ ...expert(), metadata: { ...expert().metadata, description: "Updated" } }],
        },
      }),
    ).resolves.toEqual([]);

    repository.filesFor(1).delete("pragma.lock.yaml");
    await rm(join(repository.root, "studio", "1", "pragma.lock.yaml"));
    const broken = await service.get("studio");
    expect(broken.projectFingerprint).toBeUndefined();
    expect(broken.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "lock.missing" })]),
    );
    await expect(
      service.applyChangeSet({
        projectId: "studio",
        changeSet: { baseRevision: 1, upserts: [expert()] },
      }),
    ).rejects.toBeInstanceOf(PragmaProjectValidationError);
  });

  it("validates and compiles a Flow that targets an allowlisted external system Expert", async () => {
    const repository = await createRepository();
    const systemRef = "expert:0000000000pragma" as const;
    const service = new PragmaProjectService({
      repository,
      externalResourceRefs: new Set([systemRef]),
    });
    const published = await service.publish({
      projectId: "studio",
      expectedRevision: 0,
      resources: [flowWithExternalExpert(systemRef)],
    });
    const systemExpert = await defineExpert({
      id: "0000000000pragma",
      name: "Pragma",
      description: "External system Expert.",
      tags: [],
      scope: "Complete the Flow step.",
      instructions: "Complete the Flow step.",
      workspace: repository.root,
    });
    const resolved: string[] = [];

    const compiled = await service.compile<Flow>({
      projectId: "studio",
      revision: published.revision,
      ref: "flow:0000000000000002",
      workspace: repository.root,
      environmentId: "test",
      adapterHost: {
        environmentId: "test",
        projectRoot: repository.root,
        async resolveBinding() {
          return undefined;
        },
        async resolveArtifact(source) {
          throw new Error(`Unexpected artifact: ${JSON.stringify(source)}`);
        },
        async resolveSecret() {
          return undefined;
        },
      },
      resolveExternalInvocable: async (ref) => {
        resolved.push(ref);
        return ref === systemRef ? systemExpert : undefined;
      },
    });

    expect(compiled.value.kind).toBe("flow");
    expect(resolved).toEqual([systemRef]);
  });

  it("rebases changes to different refs and reports changes to the same ref", async () => {
    const repository = await createRepository();
    const service = new PragmaProjectService({ repository });
    const initial = await service.publish({
      projectId: "studio",
      expectedRevision: 0,
      resources: [runtime(), skill(), expert()],
      artifacts: new Map([["assets/writing-skill/SKILL.md", "# Writing\n"]]),
    });
    const changedSkill = {
      ...skill(),
      metadata: { ...skill().metadata, description: "Changed in the background." },
    };
    const changedRuntime = {
      ...runtime(),
      metadata: { ...runtime().metadata, description: "Changed in the editor." },
    };

    await service.applyChangeSet({
      projectId: "studio",
      changeSet: { baseRevision: initial.revision, upserts: [changedSkill] },
    });
    const rebased = await service.applyChangeSet({
      projectId: "studio",
      changeSet: { baseRevision: initial.revision, upserts: [changedRuntime] },
    });

    expect(rebased.revision).toBe(initial.revision + 2);
    expect(rebased.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "Capability",
          metadata: expect.objectContaining({ description: "Changed in the background." }),
        }),
        expect.objectContaining({
          kind: "RuntimeProfile",
          metadata: expect.objectContaining({ description: "Changed in the editor." }),
        }),
      ]),
    );
    await expect(
      service.applyChangeSet({
        projectId: "studio",
        changeSet: {
          baseRevision: initial.revision,
          upserts: [
            {
              ...runtime(),
              metadata: { ...runtime().metadata, description: "Conflicting editor change." },
            },
          ],
        },
      }),
    ).rejects.toMatchObject({
      baseRevision: initial.revision,
      currentRevision: initial.revision + 2,
      conflictingRefs: ["runtime-profile:rdzgnq05qfqcpqcm"],
      retryable: false,
    } satisfies Partial<PragmaProjectRevisionConflictError>);
  });

  it("enforces unchanged read preconditions when creating a new version", async () => {
    const repository = await createRepository();
    const service = new PragmaProjectService({ repository });
    const initial = await service.publish({
      projectId: "studio",
      expectedRevision: 0,
      resources: [runtime(), skill(), expert()],
      artifacts: new Map([["assets/writing-skill/SKILL.md", "# Writing\n"]]),
    });
    await service.applyChangeSet({
      projectId: "studio",
      changeSet: {
        baseRevision: initial.revision,
        upserts: [
          {
            ...skill(),
            metadata: { ...skill().metadata, description: "Changed before versioning." },
          },
        ],
      },
    });
    const versionTwo = {
      ...skill(),
      metadata: { ...skill().metadata },
    };

    await expect(
      service.applyChangeSet({
        projectId: "studio",
        changeSet: {
          baseRevision: initial.revision,
          upserts: [versionTwo],
          requiredUnchangedRefs: ["capability:d5zzezmprnyqzmhk"],
        },
      }),
    ).rejects.toMatchObject({
      conflictingRefs: ["capability:d5zzezmprnyqzmhk"],
      retryable: false,
    } satisfies Partial<PragmaProjectRevisionConflictError>);
  });

  it("retries a compare-and-swap race for concurrent changes to different refs", async () => {
    const repository = await createRepository();
    const first = new PragmaProjectService({ repository });
    const second = new PragmaProjectService({ repository });
    const initial = await first.publish({
      projectId: "studio",
      expectedRevision: 0,
      resources: [runtime(), skill(), expert()],
      artifacts: new Map([["assets/writing-skill/SKILL.md", "# Writing\n"]]),
    });

    const results = await Promise.all([
      first.applyChangeSet({
        projectId: "studio",
        changeSet: {
          baseRevision: initial.revision,
          upserts: [
            {
              ...runtime(),
              metadata: { ...runtime().metadata, description: "Concurrent runtime change." },
            },
          ],
        },
      }),
      second.applyChangeSet({
        projectId: "studio",
        changeSet: {
          baseRevision: initial.revision,
          upserts: [
            {
              ...skill(),
              metadata: { ...skill().metadata, description: "Concurrent capability change." },
            },
          ],
        },
      }),
    ]);

    expect(new Set(results.map((result) => result.revision))).toEqual(
      new Set([initial.revision + 1, initial.revision + 2]),
    );
  });
});

async function createRepository(): Promise<
  PragmaProjectSourceRepository & {
    readonly root: string;
    filesFor(revision: number): Map<string, string>;
  }
> {
  const root = await mkdtemp(join(tmpdir(), "pragma-project-service-test-"));
  const locations = new Map<number, PragmaProjectRevisionLocation>();
  const revisionFiles = new Map<number, ReadonlyMap<string, string>>();
  let commitTail = Promise.resolve();
  return {
    root,
    filesFor(revision) {
      const files = revisionFiles.get(revision);
      if (files === undefined) throw new Error(`Missing revision: ${revision}`);
      return files as Map<string, string>;
    },
    async getHead() {
      return locations.get(Math.max(0, ...locations.keys()));
    },
    async getRevision(_projectId, revision) {
      return locations.get(revision);
    },
    async readFiles(location) {
      return revisionFiles.get(location.revision) ?? new Map();
    },
    async commit(input) {
      const previousCommit = commitTail;
      let releaseCommit: (() => void) | undefined;
      commitTail = new Promise<void>((resolve) => {
        releaseCommit = resolve;
      });
      await previousCommit;
      try {
        const actualRevision = Math.max(0, ...locations.keys());
        if (actualRevision !== input.expectedRevision) {
          throw new PragmaProjectRevisionConflictError(input.expectedRevision, actualRevision);
        }
        const revision = actualRevision + 1;
        const revisionRoot = join(root, input.projectId, String(revision));
        for (const [relativePath, contents] of input.files) {
          const path = join(revisionRoot, relativePath);
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, contents);
        }
        const location = {
          projectId: input.projectId,
          revision,
          rootDir: revisionRoot,
          entryFile: join(revisionRoot, "pragma.yaml"),
        } satisfies PragmaProjectRevisionLocation;
        locations.set(revision, location);
        revisionFiles.set(revision, new Map(input.files));
        return location;
      } finally {
        releaseCommit?.();
      }
    },
  };
}

function skill(): PragmaCapabilityResource {
  return {
    apiVersion: "pragma/v3",
    kind: "Capability",
    metadata: {
      id: "d5zzezmprnyqzmhk",
      name: "Writing skill",
      description: "Project-local writing guidance.",
      tags: [],
    },
    spec: {
      adapter: "pragma.capability.skill@v1",
      config: {
        source: { type: "project", path: "assets/writing-skill" },
        entry: "SKILL.md",
      },
    },
  };
}

function flowWithExternalExpert(expertRef: `expert:${string}`): PragmaFlowResource {
  return {
    apiVersion: "pragma/v3",
    kind: "Flow",
    metadata: {
      id: "0000000000000002",
      name: "System Expert Flow",
      description: "Calls an external system Expert.",
      tags: [],
    },
    spec: {
      limits: { maxNodeVisits: 10 },
      graph: {
        start: "run",
        steps: {
          run: {
            expert: { ref: expertRef },
            prompt: { segments: [{ text: "Complete the task." }] },
          },
        },
        transitions: { run: { end: true } },
        loops: {},
      },
    },
  };
}

function runtime(): PragmaRuntimeProfileResource {
  return {
    apiVersion: "pragma/v3",
    kind: "RuntimeProfile",
    metadata: {
      id: "rdzgnq05qfqcpqcm",
      name: "Writer runtime",
      description: "Runtime for the writer.",
      tags: [],
    },
    spec: { adapter: "pragma.runtime.profile@v1", config: { runtimeId: "codex" } },
  };
}

function expert(): PragmaExpertResource {
  return {
    apiVersion: "pragma/v3",
    kind: "Expert",
    metadata: {
      id: "1xddvess309a6gme",
      name: "Writer",
      description: "Writes concise text.",
      tags: [],
    },
    spec: {
      scope: "writing",
      instructions: "Write concise text.",
      runtime: { ref: "runtime-profile:rdzgnq05qfqcpqcm" },
      capabilities: [{ ref: "capability:d5zzezmprnyqzmhk", kind: "skill" }],
      toolApprovals: {},
      contextStores: [],
      plugins: [],
      tools: [],
    },
  };
}
