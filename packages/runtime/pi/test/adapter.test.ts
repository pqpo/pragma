import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  ContextSystem,
  ExpertAgent,
  FileSystemContextStore,
  HOST_CONTEXT_NAMESPACE,
} from "@pragma/core";
import type { ExpertAgentRunContext } from "@pragma/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPiRuntime } from "../src/adapter.ts";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: {
    create: vi.fn(() => ({})),
  },
  DefaultResourceLoader: class {
    async reload() {
      return undefined;
    }
  },
  ModelRegistry: {
    create: vi.fn(() => ({
      getAll: () => [],
    })),
    inMemory: vi.fn(() => ({
      getAll: () => [],
      registerProvider: vi.fn(),
    })),
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
    vi.mocked(SessionManager.open).mockClear();
  });

  it("exposes runtime availability through the adapter", async () => {
    await expect(createPiRuntime().canUse()).resolves.toEqual({
      usable: true,
    });
  });

  it("runs session destroy hooks when PI session creation fails", async () => {
    const events: string[] = [];
    let sessionContext: ExpertAgentRunContext | undefined;
    const workspace = await createTempDir();
    const agent = await ExpertAgent.create({
      schemaVersion: "pragma.expert/v1",
      id: "agent-1",
      name: "Test Agent",
      description: "Agent for runtime adapter tests.",
      tags: ["test"],
      version: "0.0.0",
      scope: "test",
      workspace,
      hooks: {
        beforeSessionCreate: ({ context }) => {
          sessionContext = context;
          events.push("beforeSessionCreate");
        },
        beforeSessionDestroy: () => {
          events.push("beforeSessionDestroy");
        },
        afterSessionDestroy: () => {
          events.push("afterSessionDestroy");
        },
      },
    });
    vi.mocked(createAgentSession).mockRejectedValue(new Error("PI session failed"));

    await expect(createPiRuntime().createSession({ agent })).rejects.toThrow("PI session failed");

    expect(events).toEqual(["beforeSessionCreate", "beforeSessionDestroy", "afterSessionDestroy"]);
    expect(sessionContext).toEqual({
      source: {
        type: "system",
      },
      attributes: {},
    });
  });

  it("merges supplied run context before creating the lifecycle", async () => {
    let sessionContext: ExpertAgentRunContext | undefined;
    const workspace = await createTempDir();
    const agent = await ExpertAgent.create({
      schemaVersion: "pragma.expert/v1",
      id: "agent-1",
      name: "Test Agent",
      description: "Agent for runtime adapter tests.",
      tags: ["test"],
      version: "0.0.0",
      scope: "test",
      workspace,
      hooks: {
        beforeSessionCreate: ({ context }) => {
          sessionContext = context;
        },
      },
    });
    vi.mocked(createAgentSession).mockRejectedValue(new Error("PI session failed"));

    await expect(
      createPiRuntime().createSession({
        agent,
        context: {
          source: {
            type: "user",
            id: "user-1",
          },
          attributes: {
            tenantId: "tenant-1",
          },
        },
      }),
    ).rejects.toThrow("PI session failed");

    expect(sessionContext).toEqual({
      source: {
        type: "user",
        id: "user-1",
      },
      attributes: {
        tenantId: "tenant-1",
      },
    });
  });

  it("restores requested runtime sessions and syncs the active session directory", async () => {
    const workspace = await createTempDir();
    const agent = await ExpertAgent.create({
      schemaVersion: "pragma.expert/v1",
      id: "agent-1",
      name: "Test Agent",
      description: "Agent for runtime adapter tests.",
      tags: ["test"],
      version: "0.0.0",
      scope: "test",
      workspace,
      contextSystem: createHostContextSystem(new FileSystemContextStore({ rootDir: workspace })),
    });
    const restore = vi.fn();
    const sync = vi.fn();
    vi.mocked(createAgentSession).mockResolvedValue({
      extensionsResult: {
        errors: [],
        extensions: [],
        runtime: {} as never,
      },
      session: createFakePiSession("pi-session-1") as never,
    });

    const adapter = createPiRuntime({
      sessionRestoreHandler: restore,
      sessionSyncCallback: sync,
    });
    const runtimeSession = await adapter.createSession({
      agent,
      context: {
        source: {
          type: "user",
          id: "user-1",
        },
        attributes: {
          tenantId: "tenant-1",
        },
      },
      runtimeSession: {
        type: "cloud-pi-agent",
        id: "pi-session-1",
      },
      systemSessionId: "system-session-1",
    });

    const expectedContext = {
      agentId: "agent-1",
      context: {
        source: {
          type: "user",
          id: "user-1",
        },
        attributes: {
          tenantId: "tenant-1",
        },
      },
      runtime: {
        capabilities: {
          executionLocations: ["cloud"],
          supportsAbort: true,
          supportsMcp: true,
          supportsStreaming: true,
          targets: ["agent"],
        },
        displayName: "Cloud PI Agent",
        id: "cloud-pi-agent",
        kind: "cloud-pi-agent",
      },
      runtimeSession: {
        type: "cloud-pi-agent",
        id: "pi-session-1",
      },
      sessionDir: `${workspace}/.pragma/runtime-sessions/pi/agent-1`,
      systemSessionId: "system-session-1",
      workspace,
    };
    expect(restore).toHaveBeenCalledWith(expectedContext);
    expect(sync).toHaveBeenCalledWith(expectedContext);

    await runtimeSession.abort();
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("allows session storage handlers to be replaced after adapter creation", async () => {
    const workspace = await createTempDir();
    const agent = await ExpertAgent.create({
      schemaVersion: "pragma.expert/v1",
      id: "agent-1",
      name: "Test Agent",
      description: "Agent for runtime adapter tests.",
      tags: ["test"],
      version: "0.0.0",
      scope: "test",
      workspace,
    });
    const restore = vi.fn();
    const sync = vi.fn();
    vi.mocked(createAgentSession).mockResolvedValue({
      extensionsResult: {
        errors: [],
        extensions: [],
        runtime: {} as never,
      },
      session: createFakePiSession("pi-session-2") as never,
    });

    const adapter = createPiRuntime();
    adapter.setSessionRestoreHandler?.(restore);
    adapter.setSessionSyncCallback?.(sync);
    const runtimeSession = await adapter.createSession({
      agent,
      runtimeSession: {
        type: "cloud-pi-agent",
        id: "pi-session-2",
      },
    });

    expect(restore).toHaveBeenCalledOnce();
    expect(sync).toHaveBeenCalledOnce();

    await runtimeSession.abort();
  });

  it("injects always-on context as a startup user message after PI session creation", async () => {
    const workspace = await createTempDir();
    await writeFile(
      `${workspace}/startup.md`,
      "---\ntrigger: always_on\n---\nFollow the workspace playbook.",
      "utf8",
    );
    const agent = await ExpertAgent.create({
      schemaVersion: "pragma.expert/v1",
      id: "agent-1",
      name: "Test Agent",
      description: "Agent for runtime adapter tests.",
      tags: ["test"],
      version: "0.0.0",
      scope: "test",
      workspace,
      contextSystem: createHostContextSystem(new FileSystemContextStore({ rootDir: workspace })),
    });
    const agentContext = await agent.buildContext();
    expect(agentContext.startupMessages[0]?.content).toContain("Follow the workspace playbook.");
    const piSession = createFakePiSession("pi-session-context");
    vi.mocked(createAgentSession).mockResolvedValue({
      extensionsResult: {
        errors: [],
        extensions: [],
        runtime: {} as never,
      },
      session: piSession as never,
    });

    const runtimeSession = await createPiRuntime().createSession({ agent });

    expect(piSession.messages).toEqual([
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("Follow the workspace playbook."),
      }),
    ]);
    expect((piSession.messages[0] as { readonly content?: string } | undefined)?.content).toContain(
      "Always-on reference context",
    );

    await runtimeSession.abort();
  });

  it("does not inject startup user messages when resuming an existing PI session", async () => {
    const workspace = await createTempDir();
    await writeFile(
      `${workspace}/startup.md`,
      "---\ntrigger: always_on\n---\nFollow the workspace playbook.",
      "utf8",
    );
    const agent = await ExpertAgent.create({
      schemaVersion: "pragma.expert/v1",
      id: "agent-1",
      name: "Test Agent",
      description: "Agent for runtime adapter tests.",
      tags: ["test"],
      version: "0.0.0",
      scope: "test",
      workspace,
      contextSystem: createHostContextSystem(new FileSystemContextStore({ rootDir: workspace })),
    });
    const piSession = createFakePiSession("pi-session-existing");
    vi.mocked(SessionManager.listAll).mockResolvedValue([
      {
        allMessagesText: "",
        created: new Date("2026-01-01T00:00:00.000Z"),
        cwd: workspace,
        firstMessage: "",
        id: "pi-session-existing",
        messageCount: 1,
        modified: new Date("2026-01-01T00:00:00.000Z"),
        path: `${workspace}/.pragma/runtime-sessions/pi/agent-1/pi-session-existing.jsonl`,
      },
    ]);
    vi.mocked(createAgentSession).mockResolvedValue({
      extensionsResult: {
        errors: [],
        extensions: [],
        runtime: {} as never,
      },
      session: piSession as never,
    });

    const runtimeSession = await createPiRuntime().createSession({
      agent,
      runtimeSession: {
        type: "cloud-pi-agent",
        id: "pi-session-existing",
      },
    });

    expect(SessionManager.open).toHaveBeenCalledOnce();
    expect(piSession.messages).toEqual([]);

    await runtimeSession.abort();
  });

  it("loads user MCP config into PI custom tools and disposes it on session cleanup", async () => {
    const workspace = await createTempDir();
    const dispose = vi.fn(async () => undefined);
    const agent = await ExpertAgent.create({
      schemaVersion: "pragma.expert/v1",
      id: "agent-1",
      name: "Test Agent",
      description: "Agent for runtime adapter tests.",
      tags: ["test"],
      version: "0.0.0",
      scope: "test",
      workspace,
      mcp: {
        mcpServers: {
          docs: {
            name: "Docs MCP",
            inProcess: {
              listTools: async () => [
                {
                  name: "lookup",
                  description: "Lookup docs.",
                  inputSchema: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                  },
                },
              ],
              callTool: async () => ({
                content: [
                  {
                    type: "text",
                    text: "docs",
                  },
                ],
              }),
              dispose,
            },
          },
        },
      },
    });
    vi.mocked(createAgentSession).mockResolvedValue({
      extensionsResult: {
        errors: [],
        extensions: [],
        runtime: {} as never,
      },
      session: createFakePiSession("pi-session-mcp") as never,
    });

    const runtimeSession = await createPiRuntime().createSession({ agent });
    const sessionOptions = vi.mocked(createAgentSession).mock.calls[0]?.[0] as
      | { readonly customTools?: readonly { readonly name: string }[] }
      | undefined;

    expect(sessionOptions?.customTools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["mcp_docs_lookup"]),
    );

    await runtimeSession.abort();

    expect(dispose).toHaveBeenCalledOnce();
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "pragma-pi-adapter-"));
  tempDirs.push(dir);
  return dir;
}

function createHostContextSystem(store: FileSystemContextStore): ContextSystem {
  const contextSystem = new ContextSystem();
  const result = contextSystem.register({
    namespace: HOST_CONTEXT_NAMESPACE,
    store,
  });

  if (!result.ok) {
    throw new Error(result.error.message);
  }

  return contextSystem;
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
