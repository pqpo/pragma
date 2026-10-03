import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeResolver } from "@pragma/core";
import { describe, expect, it, vi } from "vitest";

import { createLocalHostMissionController, type MissionCommandConsumer } from "../src/index.ts";
import {
  createLocalHostNodeApplication,
  type LocalHostNodeApplicationPorts,
} from "../src/node-application.ts";
import { createLocalHostMissionExecutionRunPort } from "../src/missions/execution-run-port.ts";
import type { LocalHostMissionExecutionService } from "../src/missions/execution-service.ts";

describe("Local Host Node application composition", () => {
  it("composes injected Mission control without accepting a surface-owned run implementation", async () => {
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
      expect(application.run).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("rejects an arbitrary execution service even when it supplies run methods", () => {
    const foreignService = {
      assertLocalHostRunAllowed: vi.fn(),
      startLocalHostRun: vi.fn(),
    } as unknown as LocalHostMissionExecutionService;
    expect(() =>
      createLocalHostMissionExecutionRunPort(foreignService, async () => undefined),
    ).toThrow("Mission execution must be created by the Local Host execution service factory.");
    expect(foreignService.startLocalHostRun).not.toHaveBeenCalled();
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
    missionControlAdapter: { consumer: input.consumer, bindApplication: vi.fn() },
    board: {
      list: async () => ({ items: [] }),
      read: async () => ({ id: "missing" }),
      search: async () => ({ matches: [] }),
    },
  };
}
