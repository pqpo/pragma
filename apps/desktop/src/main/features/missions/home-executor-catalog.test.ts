import { describe, expect, it } from "vitest";

import type {
  MissionExecutorOption,
  PragmaProjectSnapshot,
} from "../../../shared/contracts/index.ts";
import type { DesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import { createHomeExecutorCatalog } from "./home-executor-catalog.ts";
import type { HomeExecutorPreferenceStore } from "./home-executor-preference-store.ts";
import type { MissionExecutorCatalog } from "./mission-executor-catalog.ts";

const expertRef = "expert:0000000000000001";
const teamRef = "team:0000000000000002";

describe("Home executor catalog", () => {
  it("projects tags, team membership, workspace usage, and immutable Pragma visibility", async () => {
    const project = {
      projectId: "studio",
      revision: 1,
      resources: [
        {
          apiVersion: "pragma/v3",
          kind: "Expert",
          metadata: {
            id: "0000000000000001",
            name: "Coder",
            description: "Codes",
            tags: ["code"],
          },
          spec: {},
        },
        {
          apiVersion: "pragma/v3",
          kind: "ExpertTeam",
          metadata: {
            id: "0000000000000002",
            name: "Delivery team",
            description: "Delivers",
            tags: ["delivery"],
          },
          spec: {
            coordinator: { ref: expertRef },
            members: [{ ref: expertRef }],
          },
        },
      ],
    } as unknown as PragmaProjectSnapshot;
    const options: MissionExecutorOption[] = [
      option(expertRef, "Coder", "expert"),
      option(teamRef, "Delivery team", "team"),
    ];
    const preferences: HomeExecutorPreferenceStore = {
      list: async () => [
        {
          ref: expertRef,
          favoriteScope: "workspace",
          hidden: false,
          favoriteWorkspace: "/work/favorite",
          lastWorkspace: "/work/project",
          lastUsedAt: "2026-07-29T09:00:00.000Z",
        },
      ],
      prune: async () => undefined,
      recordUsage: async () => {
        throw new Error("not used");
      },
      update: async () => {
        throw new Error("not used");
      },
    };
    const catalog = createHomeExecutorCatalog({
      project: { get: async () => project } as unknown as PragmaProjectStore,
      executors: { list: async () => options } as unknown as MissionExecutorCatalog,
      systemExperts: {
        getResource: () => undefined,
      } as unknown as DesktopSystemExpertRegistry,
      preferences,
      defaultExecutorRef: teamRef,
      validateWorkspace: () => ({ ok: true }),
    });

    const result = await catalog.list();

    expect(result[0]).toMatchObject({
      tags: ["code"],
      teamMemberships: [{ ref: teamRef, name: "Delivery team" }],
      preference: {
        favoriteScope: "workspace",
        favoriteWorkspace: { path: "/work/favorite", basename: "favorite" },
        lastWorkspace: { path: "/work/project", basename: "project" },
      },
    });
    expect(result[1]).toMatchObject({
      alwaysVisible: true,
      preference: { favoriteScope: "global", hidden: false },
    });
  });

  it("strips workspace favorite input when enforcing the default executor preference", async () => {
    const options = [option(teamRef, "Delivery team", "team")];
    let receivedUpdate: Parameters<HomeExecutorPreferenceStore["update"]>[0] | undefined;
    const preferences: HomeExecutorPreferenceStore = {
      list: async () => [],
      prune: async () => undefined,
      recordUsage: async () => {
        throw new Error("not used");
      },
      update: async (input) => {
        receivedUpdate = input;
        return {
          ref: input.ref,
          favoriteScope: input.favoriteScope ?? "none",
          hidden: input.hidden ?? false,
        };
      },
    };
    const catalog = createHomeExecutorCatalog({
      project: { get: async () => ({}) } as unknown as PragmaProjectStore,
      executors: { list: async () => options } as unknown as MissionExecutorCatalog,
      systemExperts: {
        getResource: () => undefined,
      } as unknown as DesktopSystemExpertRegistry,
      preferences,
      defaultExecutorRef: teamRef,
      validateWorkspace: () => {
        throw new Error("The ignored default-executor workspace must not be validated.");
      },
    });

    await expect(
      catalog.update({
        ref: teamRef,
        favoriteScope: "workspace",
        favoriteWorkspace: "/work/favorite",
        clearLastWorkspace: true,
      }),
    ).resolves.toMatchObject({
      favoriteScope: "global",
      hidden: false,
    });
    expect(receivedUpdate).toEqual({
      ref: teamRef,
      favoriteScope: "global",
      hidden: false,
      clearLastWorkspace: true,
    });
  });

  it("validates workspace favorites for non-default executors", async () => {
    const options = [option(expertRef, "Coder", "expert")];
    let validatedWorkspace: string | undefined;
    const preferences: HomeExecutorPreferenceStore = {
      list: async () => [],
      prune: async () => undefined,
      recordUsage: async () => {
        throw new Error("not used");
      },
      update: async () => {
        throw new Error("An invalid workspace must not reach the store.");
      },
    };
    const catalog = createHomeExecutorCatalog({
      project: { get: async () => ({}) } as unknown as PragmaProjectStore,
      executors: { list: async () => options } as unknown as MissionExecutorCatalog,
      systemExperts: {
        getResource: () => undefined,
      } as unknown as DesktopSystemExpertRegistry,
      preferences,
      defaultExecutorRef: teamRef,
      validateWorkspace: (path) => {
        validatedWorkspace = path;
        return { ok: false, reason: "not_directory" };
      },
    });

    await expect(
      catalog.update({
        ref: expertRef,
        favoriteScope: "workspace",
        favoriteWorkspace: "/work/invalid",
      }),
    ).rejects.toThrow("accessible, writable directory");
    expect(validatedWorkspace).toBe("/work/invalid");
  });
});

function option(
  ref: string,
  name: string,
  kind: MissionExecutorOption["kind"],
): MissionExecutorOption {
  return {
    ref,
    name,
    description: name,
    kind,
    origin: "project",
    readOnly: false,
    customized: false,
  };
}
