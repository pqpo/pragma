import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  DefineRuntimeDriverOptions,
  McpToolRegistryPool,
  RuntimeDriver,
  RuntimeDriverSessionContext,
  RuntimeSessionReadContext,
} from "@pragma/core";
import { describe, expect, it, vi } from "vitest";

import { createQoderCliRuntime } from "../src/adapter.ts";
import type { QoderNativeSession } from "../src/session.ts";

const runtimeMocks = vi.hoisted(() => ({
  configDir: "",
  driver: undefined as unknown,
  registerExpertToolsMcpSession: vi.fn(async () => ({
    id: "registration",
    name: "pragma",
    url: "http://127.0.0.1/mcp",
    dispose: vi.fn(async () => undefined),
  })),
}));

vi.mock("@pragma/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pragma/core")>();
  return {
    ...actual,
    defineRuntimeDriver(
      driver: RuntimeDriver<unknown, unknown>,
      options?: DefineRuntimeDriverOptions,
    ) {
      runtimeMocks.driver = driver;
      return actual.defineRuntimeDriver(driver, options);
    },
    registerExpertToolsMcpSession: runtimeMocks.registerExpertToolsMcpSession,
  };
});

vi.mock("../src/qoder-config.ts", () => ({
  prepareManagedQoderConfig: vi.fn(async () => runtimeMocks.configDir),
}));

vi.mock("../src/skills.ts", () => ({
  materializeQoderSkillPlugin: vi.fn(async () => ({
    path: "/tmp/qoder-plugin",
    skills: [],
  })),
}));

describe("Qoder CLI Runtime adapter", () => {
  it("declares local streaming, MCP, context inspection, and compaction", () => {
    const adapter = createQoderCliRuntime({
      executablePath: "/opt/qodercli",
      canUse: () => ({ usable: true }),
      listModels: async () => [],
    });

    expect(adapter.descriptor).toMatchObject({
      id: "qodercli-local",
      kind: "qodercli-local",
      capabilities: {
        targets: ["agent"],
        executionLocations: ["local"],
        supportsStreaming: true,
        supportsMcp: true,
        supportsContextWindowInspection: true,
        supportsManualCompaction: true,
        supportsContextCompactionEvents: true,
        supportsResume: true,
        supportsCancel: true,
        supportsClose: true,
        supportsSteer: false,
      },
    });
  });

  it("mounts startup messages only for fresh native sessions and wires one-time consumption", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "pragma-qoder-startup-"));
    runtimeMocks.configDir = configDir;
    const mcpToolRegistryPool = createMcpToolRegistryPool();
    createQoderCliRuntime({
      executablePath: "/opt/qodercli",
      canUse: () => ({ usable: true }),
      listModels: async () => [],
      mcpToolRegistryPool,
    });
    const driver = runtimeMocks.driver as RuntimeDriver<unknown, QoderNativeSession>;

    try {
      const fresh = await driver.createSession(createSessionContext(configDir));
      expect(fresh.pendingStartupMessages).toEqual([
        { role: "user", content: "always-on context" },
      ]);
      const readContext = {
        agent: fresh.agent,
        runContext: {},
      } satisfies RuntimeSessionReadContext;
      expect(driver.consumeStartupMessages?.(fresh, readContext)).toEqual([
        { role: "user", content: "always-on context" },
      ]);
      expect(driver.consumeStartupMessages?.(fresh, readContext)).toEqual([]);

      const restoredRuntimeSessionId = "restored-qoder-session";
      const nativeSessionDir = join(configDir, "projects", "project");
      await mkdir(nativeSessionDir, { recursive: true });
      await writeFile(join(nativeSessionDir, `${restoredRuntimeSessionId}.jsonl`), "", "utf8");
      const restored = await driver.createSession(
        createSessionContext(configDir, restoredRuntimeSessionId),
      );

      expect(restored.pendingStartupMessages).toEqual([]);
      expect(driver.consumeStartupMessages?.(restored, readContext)).toEqual([]);
    } finally {
      await rm(configDir, { recursive: true, force: true });
      await mcpToolRegistryPool.close();
    }
  });
});

function createMcpToolRegistryPool(): McpToolRegistryPool {
  return {
    acquire: vi.fn(async () => ({
      registry: { tools: [] },
      stats: { openedConnections: 0, reusedConnections: 0, coalescedConnections: 0 },
      release: vi.fn(async () => undefined),
    })),
    close: vi.fn(async () => undefined),
  };
}

function createSessionContext(
  sessionDir: string,
  restoredRuntimeSessionId?: string,
): RuntimeDriverSessionContext {
  const agent = {
    id: "expert-1",
    workspace: "/workspace",
  };
  return {
    agent,
    request: {
      agent,
      owner: { type: "expert-session", ownerId: "owner-1", contextId: "context-1" },
    },
    descriptor: {
      id: "qodercli-local",
      kind: "qodercli-local",
      displayName: "Qoder CLI Local",
      capabilities: { targets: ["agent"], executionLocations: ["local"] },
    },
    systemSessionId: "system-session-1",
    owner: { type: "expert-session", ownerId: "owner-1", contextId: "context-1" },
    runContext: {},
    workspace: "/workspace",
    logger: { info: vi.fn() },
    paths: {
      pragma: {},
      systemSessionDir: sessionDir,
      runtimeSessionDir: () => sessionDir,
    },
    processEnvironment: {},
    agentContext: {
      systemPrompt: "system prompt",
      startupMessages: [{ role: "user", content: "always-on context" }],
      context: [],
      snapshot: {},
    },
    lifecycle: { currentContext: undefined },
    persistence: {
      spec: { mode: "checkpoint", sessionDir },
      restoredRuntimeSessionId,
      checkpoint: vi.fn(async () => undefined),
    },
    prepared: {},
    sessionInfo: {},
  } as unknown as RuntimeDriverSessionContext;
}
