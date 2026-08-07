import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  DefineRuntimeDriverOptions,
  McpToolRegistryPool,
  RuntimeDriver,
  RuntimeDriverSessionContext,
  RuntimeSessionReadContext,
} from "@pragma/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAntigravityRuntime } from "../src/adapter.ts";
import type { AntigravityNativeSession } from "../src/session.ts";

const runtimeMocks = vi.hoisted(() => ({
  driver: undefined as unknown,
  registrationDisposals: [] as Array<ReturnType<typeof vi.fn>>,
  registerExpertToolsMcpSession: vi.fn(async () => {
    const dispose = vi.fn(async () => undefined);
    runtimeMocks.registrationDisposals.push(dispose);
    return {
      id: "registration",
      name: "pragma",
      url: "http://127.0.0.1:43127/private/mcp",
      dispose,
    };
  }),
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

const temporaryDirectories: string[] = [];
const restoredConversationId = "11111111-2222-4333-8444-555555555555";

afterEach(async () => {
  runtimeMocks.registrationDisposals.splice(0);
  runtimeMocks.registerExpertToolsMcpSession.mockClear();
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("Antigravity Runtime adapter lifecycle", () => {
  it("wires private HOME, MCP, startup-message restore semantics, and resource cleanup", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pragma-agy-adapter-"));
    temporaryDirectories.push(sessionDir);
    const releases: Array<ReturnType<typeof vi.fn>> = [];
    const mcpToolRegistryPool: McpToolRegistryPool = {
      acquire: vi.fn(async () => {
        const release = vi.fn(async () => undefined);
        releases.push(release);
        return {
          registry: { tools: [] },
          stats: { openedConnections: 0, reusedConnections: 0, coalescedConnections: 0 },
          release,
        };
      }),
      close: vi.fn(async () => undefined),
    };
    createAntigravityRuntime({
      executablePath: "/opt/agy",
      canUse: () => ({ usable: true }),
      listModels: async () => [],
      mcpToolRegistryPool,
    });
    const driver = runtimeMocks.driver as RuntimeDriver<unknown, AntigravityNativeSession>;
    const readContext = {
      agent: createSessionContext(sessionDir).agent,
      runContext: {},
    } satisfies RuntimeSessionReadContext;

    const fresh = await driver.createSession(createSessionContext(sessionDir));
    expect(fresh.sessionId).toBe("");
    expect(fresh.pendingStartupMessages).toEqual([{ role: "user", content: "always-on context" }]);
    expect(driver.consumeStartupMessages?.(fresh, readContext)).toEqual([
      { role: "user", content: "always-on context" },
    ]);
    expect(driver.consumeStartupMessages?.(fresh, readContext)).toEqual([]);
    expect(fresh.env["HOME"]).toBe(join(sessionDir, "home"));
    await expect(
      readFile(
        join(fresh.managedHome.configDir, "agents", fresh.managedHome.agentName, "agent.md"),
        "utf8",
      ),
    ).resolves.toContain("# System Prompt\n\nsystem prompt\n");
    await expect(
      readFile(join(fresh.managedHome.configDir, "mcp_config.json"), "utf8"),
    ).resolves.toContain("http://127.0.0.1:43127/private/mcp");
    await driver.closeSession?.(fresh, closeContext());

    const restored = await driver.createSession(
      createSessionContext(sessionDir, restoredConversationId),
    );
    expect(restored.sessionId).toBe(restoredConversationId);
    expect(restored.pendingStartupMessages).toEqual([]);
    expect(driver.consumeStartupMessages?.(restored, readContext)).toEqual([]);
    await driver.closeSession?.(restored, closeContext());

    expect(mcpToolRegistryPool.acquire).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.registerExpertToolsMcpSession).toHaveBeenCalledTimes(2);
    expect(runtimeMocks.registrationDisposals).toHaveLength(2);
    expect(
      runtimeMocks.registrationDisposals.every((dispose) => dispose.mock.calls.length === 1),
    ).toBe(true);
    expect(releases).toHaveLength(2);
    expect(releases.every((release) => release.mock.calls.length === 1)).toBe(true);
  });

  it("continues resource cleanup when an earlier disposer throws synchronously", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pragma-agy-disposal-"));
    temporaryDirectories.push(sessionDir);
    const dispose = vi.fn(() => {
      throw new Error("registration dispose failed synchronously");
    });
    runtimeMocks.registerExpertToolsMcpSession.mockImplementationOnce(async () => ({
      id: "registration",
      name: "pragma",
      url: "http://127.0.0.1:43127/private/mcp",
      dispose,
    }));
    const release = vi.fn(async () => undefined);
    const mcpToolRegistryPool: McpToolRegistryPool = {
      acquire: vi.fn(async () => ({
        registry: { tools: [] },
        stats: { openedConnections: 0, reusedConnections: 0, coalescedConnections: 0 },
        release,
      })),
      close: vi.fn(async () => undefined),
    };
    createAntigravityRuntime({
      executablePath: "/opt/agy",
      canUse: () => ({ usable: true }),
      listModels: async () => [],
      mcpToolRegistryPool,
    });
    const driver = runtimeMocks.driver as RuntimeDriver<unknown, AntigravityNativeSession>;
    const session = await driver.createSession(createSessionContext(sessionDir));
    const mutableSession = session as unknown as {
      hookRelay: { close: () => Promise<void> };
    };
    const originalCloseRelay = mutableSession.hookRelay.close;
    const closeRelay = vi.fn(async () => await originalCloseRelay());
    mutableSession.hookRelay.close = closeRelay;

    await expect(driver.closeSession?.(session, closeContext())).rejects.toBeInstanceOf(
      AggregateError,
    );
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(closeRelay).toHaveBeenCalledTimes(1);
  });

  it("rejects workspace customizations before allocating MCP or spawning agy", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pragma-agy-unsafe-workspace-session-"));
    const workspace = await mkdtemp(join(tmpdir(), "pragma-agy-unsafe-workspace-"));
    temporaryDirectories.push(sessionDir, workspace);
    await mkdir(join(workspace, ".agents", "hooks"), { recursive: true });
    const mcpToolRegistryPool: McpToolRegistryPool = {
      acquire: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    createAntigravityRuntime({
      executablePath: "/opt/agy",
      canUse: () => ({ usable: true }),
      listModels: async () => [],
      mcpToolRegistryPool,
    });
    const driver = runtimeMocks.driver as RuntimeDriver<unknown, AntigravityNativeSession>;

    await expect(
      driver.createSession(createSessionContext(sessionDir, undefined, workspace)),
    ).rejects.toThrow(/workspace customization root/i);
    expect(mcpToolRegistryPool.acquire).not.toHaveBeenCalled();
  });
});

function createSessionContext(
  sessionDir: string,
  restoredRuntimeSessionId?: string,
  workspace = "/workspace/project",
): RuntimeDriverSessionContext {
  const agent = {
    id: "expert-1",
    name: "Review Expert",
    description: "Review the workspace",
    workspace,
  };
  return {
    agent,
    request: {
      agent,
      owner: { type: "expert-session", ownerId: "owner-1", contextId: "context-1" },
    },
    descriptor: {
      id: "antigravity",
      kind: "antigravity-local",
      displayName: "Antigravity CLI",
      capabilities: { targets: ["agent"], executionLocations: ["local"] },
    },
    systemSessionId: "system-session-1",
    owner: { type: "expert-session", ownerId: "owner-1", contextId: "context-1" },
    runContext: {},
    workspace,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    paths: {
      pragma: {},
      systemSessionDir: sessionDir,
      runtimeSessionDir: () => sessionDir,
    },
    processEnvironment: { API_KEY: "preserved" },
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

function closeContext() {
  return {
    sessionInfo: {},
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as Parameters<NonNullable<RuntimeDriver<unknown, unknown>["closeSession"]>>[1];
}
