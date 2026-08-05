import { StaticContextStore } from "@pragma/core";
import type { PragmaExpertResource, PragmaExpertTeamResource } from "@pragma/interpreter/ast";
import { describe, expect, it, vi } from "vitest";

import { MissionSchema } from "../../../shared/contracts/index.ts";
import type { DesktopMemoryPlane } from "../memory/desktop-memory-plane.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { DesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";
import type { MissionRunner } from "./mission-runner.ts";
import type { MissionStore } from "./mission-store.ts";
import { createMissionContextStoreBrowserService } from "./mission-context-store-browser.ts";

const writer = expert("1xddvess309a6gme", "Writer");
const reviewer = expert("3sfd30h5017wd17d", "Reviewer");
const team: PragmaExpertTeamResource = {
  apiVersion: "pragma/v3",
  kind: "ExpertTeam",
  metadata: {
    id: "vyv9pwwzaksth2dd",
    name: "Editorial Team",
    description: "Coordinates editorial work",
    tags: [],
  },
  spec: {
    coordinator: { ref: "expert:1xddvess309a6gme" },
    members: [{ ref: "expert:3sfd30h5017wd17d" }],
    delegation: {
      allow: { "1xddvess309a6gme": ["3sfd30h5017wd17d"] },
      maxConcurrency: 2,
      maxDepth: 2,
      context: "context-policy:pragma.fresh@v1",
      runtimes: {},
    },
  },
};

const mission = MissionSchema.parse({
  schemaVersion: "pragma.mission/v6",
  id: "00000000-0000-4000-8000-000000000000",
  title: "Editorial mission",
  goal: "Write and review",
  initialMessageId: "00000000-0000-4000-8000-000000000001",
  toolPermissionMode: "request-approval",
  workspace: { path: "/tmp/work", basename: "work" },
  project: { id: "pragma", revision: 7 },
  executor: { kind: "team", ref: "team:vyv9pwwzaksth2dd", name: "Editorial Team" },
  lifecycleStatus: "active",
  origin: { type: "user" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("MissionContextStoreBrowserService", () => {
  it("exposes exact per-Expert scopes while preserving the Team root", async () => {
    const isContextStoreViewAvailable = vi.fn(async () => true);
    const createContextStoreView = vi.fn(
      async () =>
        new StaticContextStore([
          {
            id: "overview.md",
            content: "# Overview\nTeam and personal memory",
            metadata: { trigger: "always_on", priority: "high" },
          },
          {
            id: "semantic/items/fact-a.md",
            content: "# Fact\nReview policy",
            metadata: { trigger: "manual", priority: "normal" },
          },
        ]),
    );
    const service = createMissionContextStoreBrowserService({
      missions: { get: vi.fn(async () => mission) } as unknown as MissionStore,
      project: {
        openRevision: vi.fn(async () => ({ listResources: () => [writer, reviewer, team] })),
      } as unknown as PragmaProjectStore,
      systemExperts: {
        getResource: () => undefined,
        getAdditionalResources: () => [],
      } as unknown as DesktopSystemExpertRegistry,
      memory: {
        isContextStoreViewAvailable,
        createContextStoreView,
      } as unknown as DesktopMemoryPlane,
      runner: {
        getWork: vi.fn(async () => ({
          missionId: mission.id,
          revision: 1,
          records: [
            {
              recordId: "review",
              kind: "agent",
              sessionId: "session",
              title: "Reviewer",
              executorId: reviewer.metadata.id,
              origin: "core",
              status: "succeeded",
              tasks: [],
              summary: "Reviewed",
              createdAt: mission.createdAt,
              updatedAt: mission.updatedAt,
            },
          ],
        })),
      } as unknown as Pick<MissionRunner, "getWork">,
    });

    const descriptor = await service.get({ missionId: mission.id, storeId: "memory" });
    expect(descriptor.defaultScopeId).toBe(`expert:${writer.metadata.id}`);
    expect(descriptor.scopes).toEqual([
      expect.objectContaining({ expertId: writer.metadata.id, role: "coordinator" }),
      expect.objectContaining({
        expertId: reviewer.metadata.id,
        role: "member",
        participation: "participated",
      }),
    ]);
    expect(isContextStoreViewAvailable).toHaveBeenCalledTimes(2);
    expect(createContextStoreView).not.toHaveBeenCalled();

    isContextStoreViewAvailable.mockClear();
    await service.list({
      missionId: mission.id,
      storeId: "memory",
      scopeId: `expert:${reviewer.metadata.id}`,
    });
    expect(createContextStoreView).toHaveBeenLastCalledWith({
      rootRef: { type: "pragma.expert-team", id: team.metadata.id },
      expertRef: { type: "pragma.expert", id: reviewer.metadata.id },
      projectId: mission.project.id,
    });
    expect(isContextStoreViewAvailable).not.toHaveBeenCalled();
  });

  it("rejects a renderer-provided Expert outside the Mission catalog", async () => {
    const service = createMissionContextStoreBrowserService({
      missions: { get: vi.fn(async () => mission) } as unknown as MissionStore,
      project: {
        openRevision: vi.fn(async () => ({ listResources: () => [writer, reviewer, team] })),
      } as unknown as PragmaProjectStore,
      systemExperts: {
        getResource: () => undefined,
        getAdditionalResources: () => [],
      } as unknown as DesktopSystemExpertRegistry,
      memory: {
        isContextStoreViewAvailable: vi.fn(async () => true),
        createContextStoreView: vi.fn(async () => new StaticContextStore()),
      } as unknown as DesktopMemoryPlane,
      runner: {
        getWork: vi.fn(async () => ({ missionId: mission.id, revision: 0, records: [] })),
      } as unknown as Pick<MissionRunner, "getWork">,
    });

    await expect(
      service.list({
        missionId: mission.id,
        storeId: "memory",
        scopeId: "expert:kp8tkn2szy1xhpb5",
      }),
    ).rejects.toMatchObject({ message: "context_store_scope_not_found" });
  });

  it("surfaces work history failures instead of misreporting every Expert as unparticipated", async () => {
    const service = createMissionContextStoreBrowserService({
      missions: { get: vi.fn(async () => mission) } as unknown as MissionStore,
      project: {
        openRevision: vi.fn(async () => ({ listResources: () => [writer, reviewer, team] })),
      } as unknown as PragmaProjectStore,
      systemExperts: {
        getResource: () => undefined,
        getAdditionalResources: () => [],
      } as unknown as DesktopSystemExpertRegistry,
      memory: {
        isContextStoreViewAvailable: vi.fn(async () => true),
        createContextStoreView: vi.fn(async () => new StaticContextStore()),
      } as unknown as DesktopMemoryPlane,
      runner: {
        getWork: vi.fn(async () => {
          throw new Error("work history is corrupt");
        }),
      } as unknown as Pick<MissionRunner, "getWork">,
    });

    await expect(service.get({ missionId: mission.id, storeId: "memory" })).rejects.toThrow(
      "work history is corrupt",
    );
  });

  it("rejects a persisted executor whose kind and semantic ref prefix disagree", async () => {
    const mismatched = MissionSchema.parse({
      ...mission,
      executor: { kind: "expert", ref: teamRef(), name: "Editorial Team" },
    });
    const service = createMissionContextStoreBrowserService({
      missions: { get: vi.fn(async () => mismatched) } as unknown as MissionStore,
      project: {
        openRevision: vi.fn(async () => ({ listResources: () => [writer, reviewer, team] })),
      } as unknown as PragmaProjectStore,
      systemExperts: {
        getResource: () => undefined,
        getAdditionalResources: () => [],
      } as unknown as DesktopSystemExpertRegistry,
      memory: {
        isContextStoreViewAvailable: vi.fn(async () => true),
        createContextStoreView: vi.fn(async () => new StaticContextStore()),
      } as unknown as DesktopMemoryPlane,
      runner: {
        getWork: vi.fn(async () => ({ missionId: mission.id, revision: 0, records: [] })),
      } as unknown as Pick<MissionRunner, "getWork">,
    });

    await expect(service.get({ missionId: mission.id, storeId: "memory" })).rejects.toMatchObject({
      code: "invalid_mission_executor_ref",
    });
  });
});

function teamRef(): `team:${string}` {
  return `team:${team.metadata.id}`;
}

function expert(id: string, name: string): PragmaExpertResource {
  return {
    apiVersion: "pragma/v3",
    kind: "Expert",
    metadata: { id, name, description: name, tags: [] },
    spec: {
      scope: name,
      instructions: `${name} instructions`,
      capabilities: [],
      toolApprovals: {},
      contextStores: [],
      plugins: [],
      tools: [],
    },
  };
}
