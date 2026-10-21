import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createFileExpertSessionStore,
  createStaticRuntimeResolver,
  PragmaPaths,
} from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import { describe, expect, it, vi } from "vitest";
import { createLocalHostNodeExecutionResourcePorts } from "../src/node-execution-resources.ts";
import { createMissionStore } from "../src/missions/repository/mission-store.ts";
import { createSqliteExecutionStore } from "../src/execution/sqlite-execution-store.ts";

describe("Node stop-only Runtime permissions", () => {
  it.each(["request-approval", "full-access"] as const)(
    "restores persisted %s without preparing tools, memory or mounts",
    async (mode) => {
      const home = await mkdtemp(join(tmpdir(), "pragma-stop-resources-"));
      const paths = new PragmaPaths({ pragmaHome: home });
      const missions = createMissionStore({ missionsPath: paths.missionsRoot() });
      const executionStore = createSqliteExecutionStore({ pragmaHome: home });
      const expertSessionStore = createFileExpertSessionStore({
        pragmaHome: home,
        executions: executionStore,
      });
      const adapter = defineRuntimeTestDriver<never, { id: string }>({
        descriptor: { id: "owned-runtime", kind: "test", displayName: "Owned Runtime" },
        createSession: () => ({ id: "unused" }),
        readSession: (session) => ({ runtimeSessionId: session.id }),
        startTurn: async () => {
          throw new Error("Stop must not start a turn");
        },
        mapEvent: () => ({ events: [] }),
      });
      const selected = createStaticRuntimeResolver({
        runtimes: [adapter],
        defaultRuntimeId: adapter.descriptor.id,
      });
      const binding = (await selected.bind()).binding;
      const base = {
        ...selected,
        resolve: vi.fn(async () => {
          throw new Error("Base Runtime permissions must not be used");
        }),
      };
      const modes = vi.fn(() => selected);
      const unavailable = new Proxy(
        {},
        {
          get: () => {
            throw new Error("Stop must not prepare execution dependencies");
          },
        },
      );
      const ports = createLocalHostNodeExecutionResourcePorts({
        pragmaHome: home,
        runtimes: base,
        runtimesForToolPermissionMode: modes,
        compiler: unavailable as Parameters<
          typeof createLocalHostNodeExecutionResourcePorts
        >[0]["compiler"],
        memory: unavailable as Parameters<
          typeof createLocalHostNodeExecutionResourcePorts
        >[0]["memory"],
        missions,
        usageSink: { record: async () => undefined },
      });
      try {
        const created = await missions.create({
          workspace: { path: home, basename: "workspace" },
          goal: "stop fixture",
          flowInput: {},
          project: { id: "studio", revision: 1 },
          executor: { kind: "flow", ref: "flow:0000000000000400", name: "Stop fixture" },
          toolPermissionMode: mode,
        });
        const mission = await createMissionStore({ missionsPath: paths.missionsRoot() }).get(
          created.id,
        );
        const resources = await ports.createExecutionContextResources({
          mission,
          purpose: "stop",
          executionStore,
          expertSessionStore,
        });
        expect((await resources.runtimes.resolve({ binding })).binding).toEqual(binding);
        expect(resources.appOptions.runtimes).toBe(resources.runtimes);
        expect(modes).toHaveBeenCalledWith(mode);
        expect(base.resolve).not.toHaveBeenCalled();
        expect(() => resources.setToolPermissionMode("auto-approve")).toThrow("stop-only");
        expect(resources.appOptions.hostContextBindings).toBeUndefined();
      } finally {
        await executionStore.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});
