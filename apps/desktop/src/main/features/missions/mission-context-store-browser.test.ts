import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
  kind: "ExpertTeam",
  metadata: {
    id: "vyv9pwwzaksth2dd",
    avatarId: "pragma.avatar.team.default",
    name: "Editorial Team",
    description: "Coordinates editorial work",
    tags: [],
  },
  spec: {
    coordinator: { ref: "expert:1xddvess309a6gme" },
    members: [{ ref: "expert:3sfd30h5017wd17d" }],
    contextStores: [],
    delegation: {
      permissions: {
        spawn: {},
        interact: {},
      },
      maxConcurrency: 2,
      maxDepth: 2,
      context: "context-policy:pragma.fresh@v1",
      runtimes: {},
    },
  },
};

const mission = MissionSchema.parse({
  schemaVersion: "pragma.mission/v8",
  id: "00000000-0000-4000-8000-000000000000",
  title: "Editorial mission",
  goal: "Write and review",
  initialMessageId: "00000000-0000-4000-8000-000000000001",
  toolPermissionMode: "request-approval",
  workspace: { path: "/tmp/work", basename: "work" },
  project: { id: "pragma", revision: 7 },
  contextStoreIds: [],
  executor: { kind: "team", ref: "team:vyv9pwwzaksth2dd", name: "Editorial Team" },
  lifecycleStatus: "active",
  origin: { type: "user" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

describe("MissionContextStoreBrowserService", () => {
  it("browses shared Mission Board text, images, and unsupported files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-mission-board-browser-"));
    const missionRoot = join(directory, mission.id);
    const boardRoot = join(missionRoot, "board", "shared");
    await mkdir(join(boardRoot, "notes"), { recursive: true });
    await Promise.all([
      writeFile(join(boardRoot, "notes", "plan.md"), "# Plan\nShip the board browser."),
      writeFile(
        join(boardRoot, "preview.png"),
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
          "base64",
        ),
      ),
      writeFile(join(boardRoot, "archive.pdf"), "%PDF-1.4"),
      writeFile(join(boardRoot, "oversized.png"), ""),
    ]);
    await truncate(join(boardRoot, "oversized.png"), 5_000_001);
    const service = createMissionContextStoreBrowserService({
      missions: {
        get: vi.fn(async () => mission),
        storagePath: () => missionRoot,
      } as unknown as MissionStore,
      project: {
        openRevision: vi.fn(async () => ({ listResources: () => [writer, reviewer, team] })),
      } as unknown as PragmaProjectStore,
      systemExperts: {
        getResource: () => undefined,
        getAdditionalResources: () => [],
      } as unknown as DesktopSystemExpertRegistry,
      memory: {
        getContextStoreViewStatus: vi.fn(async () => "available" as const),
        createContextStoreView: vi.fn(async () => new StaticContextStore()),
      } as unknown as DesktopMemoryPlane,
      runner: {
        getWork: vi.fn(async () => ({ missionId: mission.id, revision: 0, records: [] })),
      } as unknown as Pick<MissionRunner, "getWork">,
    });

    try {
      const descriptor = await service.get({
        missionId: mission.id,
        storeId: "mission-board",
      });
      expect(descriptor.defaultScopeId).toBe("mission-board:shared");
      expect(descriptor.scopes).toHaveLength(1);

      const entries = await service.list({
        missionId: mission.id,
        storeId: "mission-board",
        scopeId: descriptor.defaultScopeId,
      });
      expect(entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "GUIDE.md", previewKind: "text" }),
          expect.objectContaining({ id: "notes/plan.md", previewKind: "text" }),
          expect.objectContaining({
            id: "preview.png",
            previewKind: "image",
            mediaType: "image/png",
          }),
          expect.objectContaining({ id: "archive.pdf", previewKind: "unsupported" }),
        ]),
      );

      const text = await service.read({
        missionId: mission.id,
        storeId: "mission-board",
        scopeId: descriptor.defaultScopeId,
        id: "notes/plan.md",
        start: 0,
        maxBytes: 64_000,
      });
      expect(text).toMatchObject({
        content: "# Plan\nShip the board browser.",
        previewKind: "text",
      });

      const image = await service.read({
        missionId: mission.id,
        storeId: "mission-board",
        scopeId: descriptor.defaultScopeId,
        id: "preview.png",
        start: 0,
        maxBytes: 64_000,
      });
      expect(image).toMatchObject({
        previewKind: "image",
        mediaType: "image/png",
        contentEncoding: "base64",
      });
      expect(Buffer.from(image.content, "base64").subarray(1, 4).toString("ascii")).toBe("PNG");

      await expect(
        service.read({
          missionId: mission.id,
          storeId: "mission-board",
          scopeId: descriptor.defaultScopeId,
          id: "oversized.png",
          start: 0,
          maxBytes: 64_000,
        }),
      ).rejects.toMatchObject({ code: "preview_too_large" });

      const unsupported = await service.read({
        missionId: mission.id,
        storeId: "mission-board",
        scopeId: descriptor.defaultScopeId,
        id: "archive.pdf",
        start: 0,
        maxBytes: 64_000,
      });
      expect(unsupported).toMatchObject({ previewKind: "unsupported", content: "" });

      const matches = await service.search({
        missionId: mission.id,
        storeId: "mission-board",
        scopeId: descriptor.defaultScopeId,
        query: "Ship",
        maxResults: 50,
        contextLines: 2,
      });
      expect(matches).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "notes/plan.md" })]),
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("separates the Team root from each Expert's personal Memory scope", async () => {
    const getContextStoreViewStatus = vi.fn(async () => "available" as const);
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
        getContextStoreViewStatus,
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
    expect(descriptor.schemaVersion).toBe("pragma.desktop-mission-context-store/v2");
    expect(descriptor.defaultScopeId).toBe(`team:${team.metadata.id}`);
    expect(descriptor.scopes).toEqual([
      expect.objectContaining({
        id: `team:${team.metadata.id}`,
        expertId: team.metadata.id,
        role: "root",
        availability: "available",
      }),
      expect.objectContaining({ expertId: writer.metadata.id, role: "coordinator" }),
      expect.objectContaining({
        expertId: reviewer.metadata.id,
        role: "member",
        participation: "participated",
      }),
    ]);
    expect(getContextStoreViewStatus).toHaveBeenCalledTimes(3);
    expect(createContextStoreView).not.toHaveBeenCalled();

    getContextStoreViewStatus.mockClear();
    await service.list({
      missionId: mission.id,
      storeId: "memory",
      scopeId: `team:${team.metadata.id}`,
    });
    expect(createContextStoreView).toHaveBeenLastCalledWith({
      rootRef: { type: "pragma.expert-team", id: team.metadata.id },
      projectId: mission.project.id,
    });

    await service.list({
      missionId: mission.id,
      storeId: "memory",
      scopeId: `expert:${reviewer.metadata.id}`,
    });
    expect(createContextStoreView).toHaveBeenLastCalledWith({
      rootRef: { type: "pragma.expert", id: reviewer.metadata.id },
      expertRef: { type: "pragma.expert", id: reviewer.metadata.id },
      projectId: mission.project.id,
      policyScope: {
        rootRef: { type: "pragma.expert-team", id: team.metadata.id },
        producerRefs: [{ type: "pragma.expert", id: reviewer.metadata.id }],
      },
    });
    expect(getContextStoreViewStatus).not.toHaveBeenCalled();
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
        getContextStoreViewStatus: vi.fn(async () => "available" as const),
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
        getContextStoreViewStatus: vi.fn(async () => "available" as const),
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
        getContextStoreViewStatus: vi.fn(async () => "available" as const),
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
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Expert",
    metadata: {
      id,
      avatarId: "pragma.avatar.expert.default",
      name,
      description: name,
      tags: [],
    },
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
