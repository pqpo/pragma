import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Expert } from "@pragma/core";
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
    const second = await service.apply({ projectId: "studio", expectedRevision: 1 });
    expect(second.revision).toBe(2);

    const compiled = await service.compile<Expert>({
      projectId: "studio",
      revision: 2,
      ref: "expert:writer@1.0.0",
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
    expect(compiled.value.id).toBe("writer");
    expect(compiled.value.skills?.skills).toHaveLength(1);
    expect(compiled.rootRuntimeId).toBe("codex");
    expect(compiled.projectFingerprint).toBe(first.projectFingerprint);
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
      service.validateCandidate({
        projectId: "studio",
        expectedRevision: 1,
        upserts: [{ ...expert(), metadata: { ...expert().metadata, description: "Updated" } }],
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
      service.apply({ projectId: "studio", expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(PragmaProjectValidationError);
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
    },
  };
}

function skill(): PragmaCapabilityResource {
  return {
    apiVersion: "pragma/v2",
    kind: "Capability",
    metadata: {
      id: "writing-skill",
      version: "1.0.0",
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

function runtime(): PragmaRuntimeProfileResource {
  return {
    apiVersion: "pragma/v2",
    kind: "RuntimeProfile",
    metadata: {
      id: "writer-runtime",
      version: "1.0.0",
      name: "Writer runtime",
      description: "Runtime for the writer.",
      tags: [],
    },
    spec: { adapter: "pragma.runtime.profile@v1", config: { runtimeId: "codex" } },
  };
}

function expert(): PragmaExpertResource {
  return {
    apiVersion: "pragma/v2",
    kind: "Expert",
    metadata: {
      id: "writer",
      version: "1.0.0",
      name: "Writer",
      description: "Writes concise text.",
      tags: [],
    },
    spec: {
      scope: "writing",
      runtime: { ref: "runtime-profile:writer-runtime@1.0.0" },
      capabilities: [{ ref: "capability:writing-skill@1.0.0", kind: "skill" }],
      toolApprovals: {},
      contextStores: [],
      plugins: [],
      tools: [],
    },
  };
}
