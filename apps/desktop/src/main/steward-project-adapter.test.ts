import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { Capability } from "../shared/desktop-api.ts";
import { createPragmaProjectStore } from "./pragma-project-store.ts";
import { createDesktopStewardProjectPort } from "./steward-project-adapter.ts";
import type { CapabilityStore } from "./capability-store.ts";
import type { RuntimeEnvironmentService } from "./runtime-environment-service.ts";

describe("Desktop Steward DSL project adapter", () => {
  it("creates and updates the same exact ref through immutable project revisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-steward-project-"));
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopStewardProjectPort(adapterOptions(project, join(root, "state")));
    const runtimeRef = (await adapter.listExpertOptions()).runtimeModels[0]!.runtimeProfileRef;
    const first = await adapter.prepare({
      expectedProjectRevision: 0,
      sources: [expert("First", runtimeRef)],
    });
    expect(first.diagnostics).toEqual([]);
    expect(first.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: "expert:writer@1.0.0", kind: "created" }),
      ]),
    );
    await expect(
      adapter.commit({ changeSetId: first.changeSetId, operationId: "first" }),
    ).resolves.toMatchObject({ projectRevision: 1 });

    const second = await adapter.prepare({
      expectedProjectRevision: 1,
      sources: [expert("Second", runtimeRef)],
    });
    expect(second.changes).toMatchObject([{ ref: "expert:writer@1.0.0", kind: "updated" }]);
    const committed = await adapter.commit({
      changeSetId: second.changeSetId,
      operationId: "second",
    });
    expect(committed.projectRevision).toBe(2);
    expect((await adapter.read("expert:writer@1.0.0")).source).toContain("Second");
  });

  it("replays a committed operation idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-steward-idempotent-"));
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopStewardProjectPort(adapterOptions(project, join(root, "state")));
    const runtimeRef = (await adapter.listExpertOptions()).runtimeModels[0]!.runtimeProfileRef;
    const candidate = await adapter.prepare({
      expectedProjectRevision: 0,
      sources: [expert("One", runtimeRef)],
    });
    const first = await adapter.commit({ changeSetId: candidate.changeSetId, operationId: "same" });
    const second = await adapter.commit({
      changeSetId: candidate.changeSetId,
      operationId: "same",
    });
    expect(second).toEqual(first);
    expect((await project.get()).revision).toBe(1);
  });

  it("exposes only available models and ready capabilities through the portable port", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-steward-options-"));
    const project = createPragmaProjectStore({ projectsPath: join(root, "projects") });
    const adapter = createDesktopStewardProjectPort(
      adapterOptions(project, join(root, "state"), [
        capability("00000000-0000-4000-8000-000000000001", "ready"),
        capability("00000000-0000-4000-8000-000000000002", "needs_attention"),
      ]),
    );

    const options = await adapter.listExpertOptions();

    expect(options.runtimeModels).toEqual([
      expect.objectContaining({
        runtimeName: "Test Runtime",
        providerName: "Test",
        modelName: "Test Model",
        isDefault: true,
      }),
    ]);
    expect(options.capabilities).toEqual([
      expect.objectContaining({
        name: "Repository access",
        kind: "skill",
        toolNames: [],
      }),
    ]);
  });
});

function expert(description: string, runtimeRef: string): string {
  return [
    "apiVersion: pragma/v2",
    "kind: Expert",
    "metadata:",
    "  id: writer",
    "  version: 1.0.0",
    "  name: Writer",
    `  description: ${description}`,
    "  tags: []",
    "spec:",
    "  scope: Write.",
    "  instructions: Write concise text.",
    "  runtime:",
    `    ref: ${runtimeRef}`,
    "  capabilities: []",
    "  toolApprovals: {}",
    "  contextStores: []",
    "  plugins: []",
    "  tools: []",
    "",
  ].join("\n");
}

function adapterOptions(
  project: ReturnType<typeof createPragmaProjectStore>,
  stateRoot: string,
  values: readonly Capability[] = [],
) {
  const capabilities = { list: async () => values } as unknown as CapabilityStore;
  const runtimes = {
    getDefaultRuntimeId: async () => "test",
    list: async () => [
      {
        head: {
          entry: { runtimeId: "test" },
          revision: {
            revision: 1,
            status: "active",
            definition: {
              id: "test",
              displayName: "Test Runtime",
              origin: "built-in",
              adapter: { id: "test.adapter", version: "v1" },
              config: {},
            },
          },
        },
        adapter: {
          descriptor: { id: "test", kind: "test", displayName: "Test Runtime" },
          canUse: async () => ({ usable: true as const }),
          listModels: async () => [
            {
              id: "model",
              displayName: "Test Model",
              provider: { kind: "runtime-managed" as const, id: "test", displayName: "Test" },
              default: true,
            },
          ],
        },
      },
    ],
  } as unknown as RuntimeEnvironmentService;
  return { project, stateRoot, capabilities, runtimes };
}

function capability(id: string, status: "ready" | "needs_attention"): Capability {
  return {
    manifest: {
      schemaVersion: "pragma.capability/v1",
      id,
      runtimeKey: `repository_${id.at(-1)}`,
      name: "Repository access",
      kind: "skill",
      latestRevision: 1,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
    },
    definition: {
      name: "Repository access",
      description: "Reads repository context.",
      kind: "skill",
      entryPath: "SKILL.md",
      contentHash: "a".repeat(64),
    },
    health: {
      revision: 1,
      status,
      checkedAt: "2026-07-19T00:00:00.000Z",
      ...(status === "needs_attention"
        ? { diagnostic: { code: "unavailable", message: "Unavailable", retryable: true } }
        : {}),
    },
  };
}
