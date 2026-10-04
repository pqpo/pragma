import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RuntimeResolver } from "@pragma/core";
import { describe, expect, it, vi } from "vitest";

import { createLocalHostNodeApplication } from "../src/node-application.ts";
import { createLocalHostMissionExecutionRunPort } from "../src/missions/execution-run-port.ts";
import type { LocalHostMissionExecutionService } from "../src/missions/execution-service.ts";

describe("Local Host Node application composition", () => {
  it("composes the default Mission kernel for both surfaces without a service override", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-local-host-node-"));
    try {
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
      });

      expect(application.runtimeResolver()).toBe(resolver);
      expect(application.missionControl).toBeDefined();
      expect(application.run?.start).toEqual(expect.any(Function));
      await expect(application.listMissions()).resolves.toEqual([]);
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
