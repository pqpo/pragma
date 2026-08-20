import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import { describe, expect, it, vi } from "vitest";
import { PragmaExpertTeamResourceSchema, type PragmaExpertResource } from "@pragma/interpreter/ast";
import { ok } from "@pragma/core";

import { createTeamMemoryContextStoreBrowserService } from "./team-memory-context-store-browser.ts";
import type { DesktopMemoryPlane } from "./desktop-memory-plane.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";

describe("team Memory ContextStore browser", () => {
  it("exposes separate Team, coordinator, and member scopes", async () => {
    const writer = expert("1xddvess309a6gme", "Writer");
    const reviewer = expert("3sfd30h5017wd17d", "Reviewer");
    const team = PragmaExpertTeamResourceSchema.parse({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "ExpertTeam",
      metadata: {
        id: "vyv9pwwzaksth2dd",
        name: "Editorial Team",
        description: "Coordinates editorial work.",
        tags: [],
      },
      spec: {
        coordinator: { ref: "expert:1xddvess309a6gme" },
        members: [{ ref: "expert:3sfd30h5017wd17d" }],
        contextStores: [],
        delegation: {},
      },
    });
    const createContextStoreView = vi.fn(async () => ({
      listContext: async () => ok([]),
      readContext: async () =>
        ok({
          id: "overview.md",
          content: "Team-only memory",
          metadata: {},
          contentRange: {
            requestedStartOffset: 0,
            startOffset: 0,
            endOffset: 16,
            nextStartOffset: 16,
            truncated: false,
          },
        }),
      searchContext: async () => ok([]),
      addContext: async () => {
        throw new Error("read-only");
      },
      editContext: async () => {
        throw new Error("read-only");
      },
      deleteContext: async () => {
        throw new Error("read-only");
      },
    }));
    const memory = {
      getContextStoreViewStatus: vi.fn(async () => "available" as const),
      createContextStoreView,
    } as unknown as DesktopMemoryPlane;
    const project = {
      projectId: "project-a",
      get: async () => ({ resources: [writer, reviewer, team] }),
    } as unknown as PragmaProjectStore;
    const service = createTeamMemoryContextStoreBrowserService({ project, memory });

    await expect(service.get({ teamRef: "team:vyv9pwwzaksth2dd" })).resolves.toMatchObject({
      schemaVersion: "pragma.desktop-team-memory-context-store/v2",
      hasMemory: true,
      readOnly: true,
      root: { type: "pragma.expert-team", id: "vyv9pwwzaksth2dd" },
      defaultScopeId: "team:vyv9pwwzaksth2dd",
      scopes: [
        expect.objectContaining({ id: "team:vyv9pwwzaksth2dd", role: "root" }),
        expect.objectContaining({ id: "expert:1xddvess309a6gme", role: "coordinator" }),
        expect.objectContaining({ id: "expert:3sfd30h5017wd17d", role: "member" }),
      ],
    });
    await service.list({
      teamRef: "team:vyv9pwwzaksth2dd",
      scopeId: "team:vyv9pwwzaksth2dd",
    });

    expect(memory.getContextStoreViewStatus).toHaveBeenCalledWith({
      rootRef: { type: "pragma.expert-team", id: "vyv9pwwzaksth2dd" },
      projectId: "project-a",
    });
    expect(createContextStoreView).toHaveBeenCalledWith({
      rootRef: { type: "pragma.expert-team", id: "vyv9pwwzaksth2dd" },
      projectId: "project-a",
    });

    await service.list({
      teamRef: "team:vyv9pwwzaksth2dd",
      scopeId: "expert:3sfd30h5017wd17d",
    });
    expect(createContextStoreView).toHaveBeenLastCalledWith({
      rootRef: { type: "pragma.expert", id: "3sfd30h5017wd17d" },
      expertRef: { type: "pragma.expert", id: "3sfd30h5017wd17d" },
      projectId: "project-a",
      policyScope: {
        rootRef: { type: "pragma.expert-team", id: "vyv9pwwzaksth2dd" },
        producerRefs: [{ type: "pragma.expert", id: "3sfd30h5017wd17d" }],
      },
    });
  });

  it("marks empty scopes and reports content when any selectable scope has Memory", async () => {
    const writer = expert("1xddvess309a6gme", "Writer");
    const reviewer = expert("3sfd30h5017wd17d", "Reviewer");
    const team = PragmaExpertTeamResourceSchema.parse({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "ExpertTeam",
      metadata: {
        id: "vyv9pwwzaksth2dd",
        name: "Editorial Team",
        description: "Coordinates editorial work.",
        tags: [],
      },
      spec: {
        coordinator: { ref: "expert:1xddvess309a6gme" },
        members: [{ ref: "expert:3sfd30h5017wd17d" }],
        contextStores: [],
        delegation: {},
      },
    });
    const memory = {
      getContextStoreViewStatus: vi.fn(
        async (input: { readonly rootRef: { readonly id: string } }) =>
          input.rootRef.id === reviewer.metadata.id ? ("available" as const) : ("empty" as const),
      ),
      createContextStoreView: vi.fn(async () => {
        throw new Error("not needed");
      }),
    } as unknown as DesktopMemoryPlane;
    const service = createTeamMemoryContextStoreBrowserService({
      project: {
        projectId: "project-a",
        get: async () => ({ resources: [writer, reviewer, team] }),
      } as unknown as PragmaProjectStore,
      memory,
    });

    await expect(service.get({ teamRef: "team:vyv9pwwzaksth2dd" })).resolves.toMatchObject({
      hasMemory: true,
      defaultScopeId: "team:vyv9pwwzaksth2dd",
      scopes: [
        expect.objectContaining({ id: "team:vyv9pwwzaksth2dd", availability: "empty" }),
        expect.objectContaining({ id: "expert:1xddvess309a6gme", availability: "empty" }),
        expect.objectContaining({
          id: "expert:3sfd30h5017wd17d",
          availability: "available",
        }),
      ],
    });
  });
});

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
