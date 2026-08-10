import { describe, expect, it, vi } from "vitest";
import { PragmaExpertTeamResourceSchema } from "@pragma/interpreter/ast";
import { ok } from "@pragma/core";

import { createTeamMemoryContextStoreBrowserService } from "./team-memory-context-store-browser.ts";
import type { DesktopMemoryPlane } from "./desktop-memory-plane.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";

describe("team Memory ContextStore browser", () => {
  it("detects and opens only the ExpertTeam root scope", async () => {
    const team = PragmaExpertTeamResourceSchema.parse({
      apiVersion: "pragma/v3",
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
      isContextStoreViewAvailable: vi.fn(async () => true),
      hasContextStoreViewContent: vi.fn(async () => true),
      createContextStoreView,
    } as unknown as DesktopMemoryPlane;
    const project = {
      projectId: "project-a",
      get: async () => ({ resources: [team] }),
    } as unknown as PragmaProjectStore;
    const service = createTeamMemoryContextStoreBrowserService({ project, memory });

    await expect(service.get({ teamRef: "team:vyv9pwwzaksth2dd" })).resolves.toMatchObject({
      hasMemory: true,
      readOnly: true,
      root: { type: "pragma.expert-team", id: "vyv9pwwzaksth2dd" },
      defaultScopeId: "team:vyv9pwwzaksth2dd",
    });
    await service.list({
      teamRef: "team:vyv9pwwzaksth2dd",
      scopeId: "team:vyv9pwwzaksth2dd",
    });

    expect(memory.hasContextStoreViewContent).toHaveBeenCalledWith({
      rootRef: { type: "pragma.expert-team", id: "vyv9pwwzaksth2dd" },
      projectId: "project-a",
    });
    expect(createContextStoreView).toHaveBeenCalledWith({
      rootRef: { type: "pragma.expert-team", id: "vyv9pwwzaksth2dd" },
      projectId: "project-a",
    });
  });
});
