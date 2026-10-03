import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  createNoopLoggerProvider,
  createPragma,
  createStaticRuntimeResolver,
  defineExpert,
  defineRuntimeDriver,
} from "../src/index.ts";
import { createMcpToolRegistryPool } from "../src/mcp-tools.ts";
import { defineRuntimeFeatures, runtimeFeature } from "../src/runtime/features.ts";
import {
  createExpertToolsHttpMcpFeature,
  type RuntimeMcpPreparation,
} from "../src/runtime/mcp-feature.ts";
import { createInMemoryExecutionStore, createRuntimeTestFeatures } from "../src/testing/index.ts";

describe("ExpertSession ordinary closure", () => {
  it.each(["success", "cleanup failure", "native stop failure"] as const)(
    "releases real MCP registrations after confirmed stop: %s",
    async (outcome) => {
      const home = await mkdtemp(join(tmpdir(), "pragma-expert-close-"));
      const pool = createMcpToolRegistryPool();
      const registrations: RuntimeMcpPreparation["registration"][] = [];
      let failing = false;
      const nativeClose = vi.fn(() => {
        if (failing && outcome === "native stop failure") throw new Error("native stop failed");
      });
      const afterDestroy = vi.fn(() => {
        if (failing && outcome === "cleanup failure") throw new Error("cleanup failed");
      });
      const mcp = createExpertToolsHttpMcpFeature({
        readiness: runtimeFeature.degraded("Real MCP lifecycle regression fixture."),
        pool,
        resourcePrefix: "close-test",
      });
      const runtime = defineRuntimeDriver({
        descriptor: { id: "close-test", kind: "test", displayName: "Close Test" },
        features: defineRuntimeFeatures({
          ...createRuntimeTestFeatures({ enabled: ["close", "resume"] }),
          mcp,
        }),
        createSession(context) {
          registrations.push(context.features.mcp.registration);
          return { id: context.systemSessionId };
        },
        readSession: (session) => ({ runtimeSessionId: session.id }),
        startTurn: () => ({ outputText: "ok" }),
        mapEvent: () => ({ events: [] }),
        closeSession: nativeClose,
      });
      const expert = await defineExpert({
        id: "c10sexpt00000001",
        name: "Close test",
        description: "Close test",
        tags: [],
        scope: "test",
        workspace: home,
        pragmaHome: home,
        hooks: { afterSessionDestroy: afterDestroy },
      });
      const app = createPragma({
        pragmaHome: home,
        executionStore: createInMemoryExecutionStore(),
        loggerProvider: createNoopLoggerProvider(),
        runtimes: createStaticRuntimeResolver({
          runtimes: [runtime],
          defaultRuntimeId: runtime.descriptor.id,
        }),
      });
      const session = await app.experts.createSession(expert);
      try {
        const first = await session.prompt("first");
        await expect(first.result).resolves.toBe("ok");
        await first.settled;
        await session.refreshRuntimeSessions();
        const second = await session.prompt("second");
        await expect(second.result).resolves.toBe("ok");
        await second.settled;
        expect(registrations).toHaveLength(2);
        // Refresh closes the final old registration before opening its successor.
        await expect(fetch(registrations[0]!.url)).rejects.toThrow();
        expect((await fetch(registrations[1]!.url)).status).not.toBe(404);
        failing = true;
        if (outcome === "success") {
          await session.close();
          await session.close();
          expect((await session.getState()).status).toBe("closed");
          expect(afterDestroy).toHaveBeenCalledTimes(2);
        } else {
          await expect(session.close()).rejects.toThrow(
            outcome === "cleanup failure" ? "cleanup failed" : "native stop failed",
          );
          const state = await session.getState();
          expect(state.status).toBe("open");
          expect(state.contexts[state.rootContextId]!.lifecycle).not.toBe("closed");
        }
        expect(nativeClose).toHaveBeenCalledTimes(2);
        if (outcome === "native stop failure") {
          // Unconfirmed stop retains resources; owner deletion still controls
          // when its separate cleanup phase may run.
          expect((await fetch(registrations[1]!.url)).status).not.toBe(404);
          expect(afterDestroy).toHaveBeenCalledOnce();
        } else {
          await expect(fetch(registrations[1]!.url)).rejects.toThrow();
        }
      } finally {
        await session.close().catch(() => undefined);
        await Promise.all(registrations.map((registration) => registration.dispose()));
        await pool.close();
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});
