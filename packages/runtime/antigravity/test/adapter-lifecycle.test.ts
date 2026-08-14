import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import type {
  DefineRuntimeDriverOptions,
  McpToolRegistryPool,
  RuntimeDriver,
  RuntimeDriverSessionContext,
  RuntimeFeatureSessionPrepareContext,
  RuntimeSessionReadContext,
} from "@pragma/core";
import { RuntimeResourceScope } from "@pragma/core";
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
    expect(driver.resolvePersistence?.(createSessionContext(sessionDir))).toMatchObject({
      metadata: { format: "antigravity-managed-session" },
    });
    const readContext = {
      agent: createSessionContext(sessionDir).agent,
      runContext: {},
    } satisfies RuntimeSessionReadContext;

    const freshPrepared = await createPreparedSession(driver, createSessionContext(sessionDir));
    const fresh = freshPrepared.session;
    expect(fresh.sessionId).toBe("");
    expect(fresh.pendingStartupMessages).toEqual([{ role: "user", content: "always-on context" }]);
    expect(driver.consumeStartupMessages?.(fresh, readContext)).toEqual([
      { role: "user", content: "always-on context" },
    ]);
    expect(driver.consumeStartupMessages?.(fresh, readContext)).toEqual([]);
    expect(fresh.env["HOME"]).toBe(join(sessionDir, "home"));
    await expect(
      readFile(join(fresh.managedHome.pluginDir, "rules", "pragma-system.md"), "utf8"),
    ).resolves.toContain("# Pragma Runtime System Instructions\n\nsystem prompt\n");
    await expect(
      readFile(join(fresh.managedHome.pluginDir, "mcp_config.json"), "utf8"),
    ).resolves.toContain("http://127.0.0.1:43127/private/mcp");
    await closePreparedSession(driver, freshPrepared);

    const restoredPrepared = await createPreparedSession(
      driver,
      createSessionContext(sessionDir, restoredConversationId),
    );
    const restored = restoredPrepared.session;
    expect(restored.sessionId).toBe(restoredConversationId);
    expect(restored.pendingStartupMessages).toEqual([]);
    expect(driver.consumeStartupMessages?.(restored, readContext)).toEqual([]);
    await closePreparedSession(driver, restoredPrepared);

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
    const prepared = await createPreparedSession(driver, createSessionContext(sessionDir));
    const permissionPreparation = prepared.featureOutputs["permissions"] as {
      hookRelay: { close: () => Promise<void> };
    };
    const originalCloseRelay = permissionPreparation.hookRelay.close;
    const closeRelay = vi.fn(async () => await originalCloseRelay());
    permissionPreparation.hookRelay.close = closeRelay;

    await expect(closePreparedSession(driver, prepared)).rejects.toBeInstanceOf(AggregateError);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
    expect(closeRelay).toHaveBeenCalledTimes(1);
  });

  it("keeps Hook and MCP control resources alive until the native process exits", async () => {
    const sessionDir = await mkdtemp(join(tmpdir(), "pragma-agy-close-order-"));
    temporaryDirectories.push(sessionDir);
    const release = vi.fn(async () => undefined);
    createAntigravityRuntime({
      executablePath: "/opt/agy",
      canUse: () => ({ usable: true }),
      listModels: async () => [],
      mcpToolRegistryPool: {
        acquire: vi.fn(async () => ({
          registry: { tools: [] },
          stats: { openedConnections: 0, reusedConnections: 0, coalescedConnections: 0 },
          release,
        })),
        close: vi.fn(async () => undefined),
      },
    });
    const driver = runtimeMocks.driver as RuntimeDriver<unknown, AntigravityNativeSession>;
    const prepared = await createPreparedSession(driver, createSessionContext(sessionDir));
    const session = prepared.session;
    const dispose = runtimeMocks.registrationDisposals.at(-1)!;
    let resolveRegistrationDispose!: () => void;
    dispose.mockImplementationOnce(
      async () =>
        await new Promise<void>((resolve) => {
          resolveRegistrationDispose = resolve;
        }),
    );
    const permissionPreparation = prepared.featureOutputs["permissions"] as {
      hookRelay: { close: () => Promise<void> };
    };
    const originalCloseRelay = permissionPreparation.hookRelay.close;
    const closeRelay = vi.fn(async () => await originalCloseRelay());
    permissionPreparation.hookRelay.close = closeRelay;

    let exited = false;
    let resolveExit!: (value: { code: number; signal: null }) => void;
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdin = new PassThrough();
    child.kill = vi.fn(() => true);
    session.activeProcess = child as unknown as ChildProcessWithoutNullStreams;
    session.activeExitPromise = new Promise((resolve) => {
      resolveExit = resolve;
    });
    session.activeHasExited = () => exited;

    const closing = closePreparedSession(driver, prepared);
    await new Promise((resolve) => setImmediate(resolve));
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(dispose).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(closeRelay).not.toHaveBeenCalled();

    exited = true;
    resolveExit({ code: 0, signal: null });
    await new Promise((resolve) => setImmediate(resolve));
    expect(dispose).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(closeRelay).toHaveBeenCalledOnce();

    resolveRegistrationDispose();
    await closing;
    expect(release).toHaveBeenCalledOnce();
    expect(closeRelay).toHaveBeenCalledOnce();
  });

  it("materializes host-keyring customizations without replacing the host HOME", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-agy-host-keyring-adapter-"));
    temporaryDirectories.push(root);
    const sessionDir = join(root, "session");
    const hostHome = join(root, "host-home");
    await mkdir(hostHome, { recursive: true });
    createAntigravityRuntime({
      executablePath: "/opt/agy",
      canUse: () => ({ usable: true }),
      listModels: async () => [],
      authenticationMode: "host-keyring",
    });
    const driver = runtimeMocks.driver as RuntimeDriver<unknown, AntigravityNativeSession>;
    const prepared = await createPreparedSession(
      driver,
      createSessionContext(sessionDir, undefined, "/workspace/project", { HOME: hostHome }),
    );
    const session = prepared.session;

    expect(session.env["HOME"]).toBe(hostHome);
    expect(session.managedHome.authenticationMode).toBe("host-keyring");
    expect(session.managedHome.customizationWorkspace).toBe(
      join(sessionDir, "managed-customizations"),
    );
    await expect(
      readFile(
        join(session.managedHome.pluginDir, "agents", session.managedHome.agentName, "agent.md"),
        "utf8",
      ),
    ).resolves.toContain("system prompt");
    await closePreparedSession(driver, prepared);
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
      createPreparedSession(driver, createSessionContext(sessionDir, undefined, workspace)),
    ).rejects.toThrow(/workspace customization root/i);
    expect(mcpToolRegistryPool.acquire).not.toHaveBeenCalled();
  });
});

function createSessionContext(
  sessionDir: string,
  restoredRuntimeSessionId?: string,
  workspace = "/workspace/project",
  processEnvironment: NodeJS.ProcessEnv = { API_KEY: "preserved" },
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
    processEnvironment,
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
    features: {} as never,
    steps: { get: () => undefined } as never,
    sessionInfo: {},
  } as unknown as RuntimeDriverSessionContext;
}

interface PreparedSession<TSession> {
  readonly session: TSession;
  readonly resources: RuntimeResourceScope;
  readonly featureOutputs: Readonly<Record<string, unknown>>;
}

async function createPreparedSession<TSession>(
  driver: RuntimeDriver<unknown, TSession>,
  baseContext: RuntimeDriverSessionContext,
): Promise<PreparedSession<TSession>> {
  const resources = new RuntimeResourceScope("antigravity-adapter-test");
  const featureOutputs: Record<string, unknown> = {};
  try {
    const mcp = driver.features.mcp;
    const permissions = driver.features.permissions;
    const skills = driver.features.skills;
    if (mcp.kind !== "feature" || permissions.kind !== "feature" || skills.kind !== "feature") {
      throw new Error("Antigravity test Runtime must expose Session Feature implementations.");
    }
    const prepareMcp = mcp.prepare as unknown as (
      context: RuntimeFeatureSessionPrepareContext,
      needs: Record<never, never>,
    ) => Promise<unknown> | unknown;
    const preparePermissions = permissions.prepare as unknown as (
      context: RuntimeFeatureSessionPrepareContext,
      needs: { readonly mcp: unknown },
    ) => Promise<unknown> | unknown;
    const prepareSkills = skills.prepare as unknown as (
      context: RuntimeFeatureSessionPrepareContext,
      needs: { readonly mcp: unknown; readonly permissions: unknown },
    ) => Promise<unknown> | unknown;
    featureOutputs.mcp = await prepareMcp({ ...baseContext, resources }, {});
    featureOutputs.permissions = await preparePermissions(
      { ...baseContext, resources },
      { mcp: featureOutputs.mcp },
    );
    featureOutputs.skills = await prepareSkills(
      { ...baseContext, resources },
      { mcp: featureOutputs.mcp, permissions: featureOutputs.permissions },
    );
    resources.seal();
    const session = await driver.createSession({
      ...baseContext,
      features: Object.freeze({ ...featureOutputs }) as never,
      steps: { get: () => undefined } as never,
    });
    resources.transfer();
    return {
      session,
      resources,
      featureOutputs: Object.freeze({ ...featureOutputs }),
    };
  } catch (error) {
    try {
      await resources.dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Antigravity test Session preparation and cleanup failed.",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

async function closePreparedSession<TSession>(
  driver: RuntimeDriver<unknown, TSession>,
  prepared: PreparedSession<TSession>,
): Promise<void> {
  const errors: unknown[] = [];
  await Promise.resolve(driver.closeSession?.(prepared.session, closeContext())).catch(
    (error: unknown) => {
      errors.push(error);
    },
  );
  await prepared.resources.dispose().catch((error: unknown) => {
    errors.push(error);
  });
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Antigravity test Session cleanup failed.");
  }
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
