import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { ExpertAgent, PragmaPaths, createPragma, createRuntimeRegistry } from "@pragma/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPiRuntime } from "../src/adapter.ts";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: { create: vi.fn(() => ({})) },
  DefaultResourceLoader: class {
    async reload() {}
  },
  ModelRegistry: {
    create: vi.fn(() => ({ getAll: () => [] })),
    inMemory: vi.fn(() => ({ getAll: () => [], registerProvider: vi.fn() })),
  },
  SessionManager: {
    create: vi.fn(() => ({})),
    inMemory: vi.fn(() => ({})),
    list: vi.fn(async () => []),
    listAll: vi.fn(async () => []),
    open: vi.fn(() => ({})),
  },
  createAgentSession: vi.fn(),
  createSyntheticSourceInfo: vi.fn(() => ({})),
  getAgentDir: vi.fn(() => "/tmp/pragma-agent-dir"),
}));

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createPiRuntime", () => {
  beforeEach(() => {
    vi.mocked(createAgentSession).mockReset();
    vi.mocked(SessionManager.listAll).mockResolvedValue([]);
  });

  it("exposes availability without a public Session factory", async () => {
    const runtime = createPiRuntime();

    await expect(runtime.canUse()).resolves.toEqual({ usable: true });
    expect("createSession" in runtime).toBe(false);
  });

  it("executes through Pragma and stores the Session under the real Workflow owner", async () => {
    const agent = await createTestAgent();
    vi.mocked(createAgentSession).mockResolvedValue({
      extensionsResult: { errors: [], extensions: [], runtime: {} as never },
      session: createFakePiSession("pi-session-1") as never,
    });
    const runtime = createPiRuntime();
    const result = await createPragma({
      runtimes: createRuntimeRegistry({
        runtimes: [runtime],
        defaultRuntime: runtime.descriptor.id,
      }),
    }).run(agent, { input: "Say hello" });

    expect(result.systemSessionId).toBeDefined();
    expect(result.runtimeSession).toEqual({ type: "cloud-pi-agent", id: "pi-session-1" });
    expect(
      new PragmaPaths({ pragmaHome: agent.pragmaHome }).systemSessionManifest(
        result.workflowRunId,
        result.systemSessionId as string,
      ),
    ).toContain("/state/workflows/");
  });

  it("runs destroy hooks when native Session creation fails", async () => {
    const events: string[] = [];
    const agent = await createTestAgent({
      hooks: {
        beforeSessionCreate: () => {
          events.push("before");
        },
        beforeSessionDestroy: () => {
          events.push("destroying");
        },
        afterSessionDestroy: () => {
          events.push("destroyed");
        },
      },
    });
    vi.mocked(createAgentSession).mockRejectedValue(new Error("PI session failed"));
    const runtime = createPiRuntime();

    await expect(
      createPragma({
        runtimes: createRuntimeRegistry({
          runtimes: [runtime],
          defaultRuntime: runtime.descriptor.id,
        }),
      }).run(agent, { input: "fail" }),
    ).rejects.toThrow("PI session failed");
    expect(events).toEqual(["before", "destroying", "destroyed"]);
  });
});

async function createTestAgent(
  overrides: Partial<Parameters<typeof ExpertAgent.create>[0]> = {},
): Promise<ExpertAgent> {
  const workspace = await mkdtemp(resolve(tmpdir(), "pragma-pi-adapter-"));
  tempDirs.push(workspace);
  return await ExpertAgent.create({
    id: "pi-test-agent",
    name: "PI Test Agent",
    description: "PI runtime test Agent.",
    tags: ["test"],
    version: "0.0.0",
    scope: "test",
    workspace,
    pragmaHome: resolve(workspace, "pragma-test-home"),
    ...overrides,
  });
}

function createFakePiSession(sessionId: string) {
  return {
    abort: vi.fn(async () => undefined),
    dispose: vi.fn(),
    messages: [],
    prompt: vi.fn(async () => undefined),
    sessionId,
    setModel: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
  };
}
