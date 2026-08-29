import { readFile } from "node:fs/promises";

import { createLocalHostApplication } from "@pragma/local-host";
import { describe, expect, it } from "vitest";

describe("CLI-side Local Host harness", () => {
  it("loads the compiled ESM application boundary and returns canonical fixture DTOs", async () => {
    const application = createLocalHostApplication({
      integrationCapability: async () => ({
        schemaVersion: "pragma.integration-capability/v1",
        protocol: "pragma.integration/v1",
        readableVersions: ["pragma.integration/v1"],
        migratableFromVersions: [],
        features: ["mission.query", "workspace.resolve", "board.shared.read"],
      }),
      catalog: {
        listProjects: async () => [{ id: "project-1" }],
        getProjectRevision: async (id, revision) => ({ id, revision }),
        listExecutors: async () => [{ ref: "expert:catalog" }],
      },
      missions: {
        get: async (id) => ({ id, title: "Fixture Mission" }),
        list: async () => [{ id: "mission-1", title: "Fixture Mission" }],
      },
      workspace: {
        stat: async () => ({ isDirectory: () => true }),
        access: async () => undefined,
        realpath: async () => "/workspace/fixture",
      },
      board: {
        list: async () => ({ items: [] }),
        read: async () => ({ content: "" }),
        search: async () => ({ matches: [] }),
      },
      runtime: { resolver: {} as never },
    });

    await expect(application.listMissions()).resolves.toEqual([
      { id: "mission-1", title: "Fixture Mission" },
    ]);
    await expect(application.getMission("mission-1")).resolves.toEqual({
      id: "mission-1",
      title: "Fixture Mission",
    });
    await expect(application.resolveWorkspace("/fixture")).resolves.toMatchObject({
      requestedPath: "/fixture",
      canonicalPath: "/workspace/fixture",
      displayName: "fixture",
    });

    const localHostDist = await readFile(
      new URL("../../../packages/local-host/dist/index.js", import.meta.url),
      "utf8",
    );
    expect(localHostDist).not.toContain(".ts");
    expect(localHostDist).toContain("node:crypto");
  });
});
