import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeResolver } from "@pragma/core";
import { describe, expect, it } from "vitest";

import { createLocalHostMissionController, type MissionCommandConsumer } from "../src/index.ts";
import {
  createLocalHostNodeApplication,
  type LocalHostNodeApplicationPorts,
} from "../src/node-application.ts";

describe("Local Host Node application composition", () => {
  it("composes injected Mission control and run ports instead of requiring app wiring", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-local-host-node-"));
    try {
      const lifecycle = createLocalHostMissionController({
        missionsPath: join(home, "data", "missions"),
      });
      const consumer: MissionCommandConsumer = {
        apply: async () => ({ result: {} }),
      };
      const resolver = {} as RuntimeResolver;
      const application = createLocalHostNodeApplication({
        pragmaHome: home,
        runtimes: resolver,
        client: { surface: "desktop", version: "test", instanceId: "node-test" },
        workspace: {
          stat: async () => ({ isDirectory: () => true }),
          access: async () => undefined,
          realpath: async (path) => path,
        },
        application: createPorts({ lifecycle, consumer }),
      });

      expect(application.runtimeResolver()).toBe(resolver);
      expect(application.missionControl).toBeDefined();
      expect(application.run).toBeDefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

function createPorts(input: {
  readonly lifecycle: ReturnType<typeof createLocalHostMissionController>;
  readonly consumer: MissionCommandConsumer;
}): LocalHostNodeApplicationPorts {
  return {
    catalog: {
      listProjects: async () => [],
      getProjectRevision: async () => undefined,
      listExecutors: async () => [],
    },
    missions: {
      get: async (id) => ({ id }),
      list: async () => [],
      query: async () => ({ items: [], nextCursor: undefined }),
    },
    missionLifecycle: input.lifecycle,
    missionControlAdapter: { consumer: input.consumer },
    board: {
      list: async () => ({ items: [] }),
      read: async () => ({ id: "missing" }),
      search: async () => ({ matches: [] }),
    },
    runExecutor: {
      resolve: async () => undefined,
      start: async () => {
        throw new Error("not invoked by this composition test");
      },
    },
  };
}
