import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  DefineRuntimeDriverOptions,
  RuntimeDriver,
  RuntimeDriverSessionContext,
  RuntimeModel,
  RuntimeModelSelection,
  RuntimeTurnContext,
} from "@pragma/core";
import { RuntimeResourceScope } from "@pragma/core";
import { describeRuntimeConformance } from "@pragma/core/testing/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ClaudeCodeNativeSession } from "../src/session.ts";

const runtimeMocks = vi.hoisted(() => ({
  driver: undefined as unknown,
  startClaudeCodeTurn: vi.fn(async () => ({ outputText: "ok" })),
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
  };
});

vi.mock("../src/session.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/session.ts")>();
  return { ...actual, startClaudeCodeTurn: runtimeMocks.startClaudeCodeTurn };
});

import { createClaudeCodeRuntime } from "../src/index.ts";

const roots: string[] = [];

beforeEach(() => {
  runtimeMocks.startClaudeCodeTurn.mockClear();
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describeRuntimeConformance("Claude Code", { createRuntime: createClaudeCodeRuntime });

describe("Claude Code Runtime contract", () => {
  it("declares split Session lifecycle capabilities without unsafe steer", () => {
    const runtime = createClaudeCodeRuntime();
    expect(runtime.descriptor.capabilities).toMatchObject({
      supportsResume: true,
      supportsCancel: true,
      supportsClose: true,
      supportsSteer: false,
      supportsContextWindowInspection: true,
      supportsManualCompaction: true,
      supportsContextCompactionEvents: true,
    });
  });

  it.each([
    ["Anthropic", "anthropic", "claude-sonnet-4-6"],
    ["CC Switch", "anthropic-compatible", "opus"],
  ])("starts sessions and turns with %s catalog selections", async (_name, providerId, modelId) => {
    const root = await temporaryRoot();
    const selection = {
      model: { providerId, modelId },
      thinkingLevel: "high",
    } satisfies RuntimeModelSelection;
    const driver = createCapturedDriver(modelCatalog());
    const session = await driver.createSession(createSessionContext(root, selection));
    const turn = { modelSelection: selection } as RuntimeTurnContext<unknown>;

    await expect(driver.startTurn(session, turn)).resolves.toEqual({ outputText: "ok" });

    expect(session.defaultProviderId).toBe(providerId);
    expect(session.tokenModelIdentity.providerId).toBe(providerId);
    expect(runtimeMocks.startClaudeCodeTurn).toHaveBeenCalledWith(session, turn);
  });

  it("rejects selections outside the Claude Code model catalog", async () => {
    const root = await temporaryRoot();
    const driver = createCapturedDriver(modelCatalog());
    const selection = {
      model: { providerId: "openai", modelId: "opus" },
      thinkingLevel: "high",
    } satisfies RuntimeModelSelection;

    await expect(driver.createSession(createSessionContext(root, selection))).rejects.toThrow(
      'Unsupported Claude Code model "openai/opus".',
    );
  });
});

function createCapturedDriver(
  models: readonly RuntimeModel[],
): RuntimeDriver<unknown, ClaudeCodeNativeSession> {
  createClaudeCodeRuntime({
    executablePath: "/opt/claude",
    spawn: vi.fn(),
    canUse: () => ({ usable: true }),
    listModels: async () => models,
  });
  return runtimeMocks.driver as RuntimeDriver<unknown, ClaudeCodeNativeSession>;
}

function modelCatalog(): readonly RuntimeModel[] {
  return [
    {
      id: "claude-sonnet-4-6",
      displayName: "Claude Sonnet 4.6",
      provider: { kind: "runtime-managed", id: "anthropic", displayName: "Anthropic" },
      thinking: { supportedLevels: [{ value: "high", label: "High" }] },
    },
    {
      id: "opus",
      displayName: "Opus → CC Switch local route",
      provider: {
        kind: "runtime-managed",
        id: "anthropic-compatible",
        displayName: "Anthropic-compatible",
      },
      thinking: { supportedLevels: [{ value: "high", label: "High" }] },
    },
  ];
}

function createSessionContext(
  root: string,
  modelSelection: RuntimeModelSelection,
): RuntimeDriverSessionContext {
  const sessionDir = join(root, "session");
  const agent = { id: "expert-1", workspace: "/workspace" };
  const owner = { type: "expert-session" as const, ownerId: "owner-1", contextId: "context-1" };
  return {
    agent,
    request: { agent, owner, modelSelection },
    descriptor: {
      id: "claude-code-local",
      kind: "claude-code-local",
      displayName: "Claude Code Local",
      capabilities: { targets: ["agent"], executionLocations: ["local"] },
    },
    systemSessionId: "system-session-1",
    owner,
    runContext: {},
    workspace: "/workspace",
    logger: { info: vi.fn(), warn: vi.fn() },
    paths: {
      systemSessionDir: sessionDir,
      runtimeSessionDir: () => sessionDir,
    },
    processEnvironment: { CLAUDE_CONFIG_DIR: join(root, "shared-config") },
    agentContext: {
      systemPrompt: "system prompt",
      startupMessages: [],
      context: [],
      snapshot: {},
    },
    lifecycle: { currentContext: undefined },
    persistence: {
      spec: { mode: "checkpoint", sessionDir },
      checkpoint: vi.fn(async () => undefined),
    },
    resources: new RuntimeResourceScope("claude-code-adapter-contract-test"),
    features: {
      mcp: {
        registry: { tools: [] },
        lease: {
          registry: { tools: [] },
          stats: { openedConnections: 0, reusedConnections: 0, coalescedConnections: 0 },
          release: vi.fn(async () => undefined),
        },
        registration: {
          id: "registration",
          name: "pragma",
          url: "http://127.0.0.1:43127/private/mcp",
          dispose: vi.fn(async () => undefined),
        },
      },
      skills: {
        pluginDir: join(sessionDir, "plugin"),
        relay: { subscribe: vi.fn(() => vi.fn()) },
      },
      permissions: { mode: "default" },
    } as never,
    steps: { get: () => undefined } as never,
    sessionInfo: {},
  } as unknown as RuntimeDriverSessionContext;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-claude-adapter-contract-"));
  roots.push(root);
  return root;
}
