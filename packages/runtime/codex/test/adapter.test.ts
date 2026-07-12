import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ContextSystem,
  createPragma,
  createRuntimeRegistry,
  ExpertAgent,
  PragmaPaths,
} from "@pragma/core";
import type {
  AgentMessage,
  IExpertAgentMcpConfig,
  IExpertAgentSkillsConfig,
  RuntimeAgentSession,
  RuntimeStreamEvent,
  RuntimeSubmitHandle,
  RuntimeSubmitRequest,
} from "@pragma/core";
import type { RuntimeDriverSessionRequest } from "@pragma/core";
import { createCodexRuntime as createCodexRuntimeAdapter } from "../src/adapter.ts";
import { canUseCodexRuntime } from "../src/availability.ts";
import type { CodexRuntimeSpawn } from "../src/types.ts";
import type { CodexRuntimeAdapterOptions } from "../src/types.ts";

function createCodexRuntime(options?: CodexRuntimeAdapterOptions) {
  const runtime = createCodexRuntimeAdapter(options);
  return {
    ...runtime,
    createSession(request: Omit<RuntimeDriverSessionRequest, "workflowExecution">) {
      return createPragmaTestSession(runtime, request);
    },
  };
}

async function createPragmaTestSession(
  runtime: ReturnType<typeof createCodexRuntimeAdapter>,
  request: Omit<RuntimeDriverSessionRequest, "workflowExecution">,
): Promise<RuntimeAgentSession & { readonly workflowRunId: () => string | undefined }> {
  const availability = await runtime.canUse();
  if (!availability.usable) {
    throw new Error(
      `Runtime is not available: ${runtime.descriptor.displayName} (${runtime.descriptor.id}).${availability.reason === undefined ? "" : ` ${availability.reason}`}`,
    );
  }
  let info = {
    systemSessionId: request.systemSessionId ?? "pending",
    runtimeSession: request.runtimeSession ?? { type: runtime.descriptor.kind, id: "pending" },
    agentId: request.agent.id,
    runtime: runtime.descriptor,
    sessionState: "active" as const,
    runState: undefined,
  };
  let workflowRunId: string | undefined;
  const messages: AgentMessage[] = [];

  return {
    info: () => info,
    workflowRunId: () => workflowRunId,
    messages: () => messages,
    submit<TOutput>(submission: RuntimeSubmitRequest<TOutput>): RuntimeSubmitHandle<TOutput> {
      const runtimeEvents: RuntimeStreamEvent[] = [];
      let usage: Extract<RuntimeStreamEvent, { type: "run.completed" }>["payload"]["usage"];
      const execution = (async () => {
        const app = createPragma({
          runtimes: createRuntimeRegistry({
            runtimes: [runtime],
            defaultRuntime: runtime.descriptor.id,
          }),
        });
        const handle = await app.start(request.agent, {
          input: submission.query,
          modelName: submission.modelName,
          thinkingLevel: submission.thinkingLevel,
          output: submission.output,
          runtimeSession: request.runtimeSession,
          systemSessionId: request.systemSessionId,
        });
        workflowRunId = handle.workflowRunId;
        for await (const event of handle.events) {
          if (event.type.startsWith("workflow.") || event.type.startsWith("human.")) {
            continue;
          }
          const projected = { type: event.type, payload: event.payload } as RuntimeStreamEvent;
          runtimeEvents.push(projected);
          if (projected.type === "run.completed") {
            usage = projected.payload.usage;
          }
        }
        const result = await handle.result;
        info = {
          ...info,
          systemSessionId: result.systemSessionId ?? info.systemSessionId,
          runtimeSession: result.runtimeSession ?? info.runtimeSession,
        };
        return { result, usage };
      })();

      return {
        runId: submission.runId ?? "pragma-test-run",
        events: {
          async *[Symbol.asyncIterator]() {
            await execution.catch(() => undefined);
            yield* runtimeEvents;
          },
        },
        result: execution.then(({ result, usage: runUsage }) => ({
          runId: submission.runId ?? "pragma-test-run",
          result: {
            output: result.output as TOutput,
            ...(runUsage === undefined ? {} : { usage: runUsage }),
          },
        })),
        cancel: async () => undefined,
      };
    },
    abort: async () => undefined,
  };
}

describe("createCodexRuntime", () => {
  beforeEach(async () => {
    vi.stubEnv("CODEX_HOME", await mkdtemp(join(tmpdir(), "pragma-codex-shared-home-")));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("declares MCP support", () => {
    const adapter = createCodexRuntime();

    expect(adapter.descriptor.capabilities?.supportsMcp).toBe(true);
  });

  it("exposes runtime availability through the adapter", async () => {
    const adapter = createCodexRuntime({
      canUse: () => ({
        usable: true,
        details: {
          source: "test",
        },
      }),
    });

    await expect(adapter.canUse()).resolves.toEqual({
      usable: true,
      details: {
        source: "test",
      },
    });
  });

  it("probes Codex CLI availability", async () => {
    const fake = new FakeProbeProcess({
      exitCode: 0,
      stdout: "codex-cli 1.2.3\n",
    });

    const availability = await canUseCodexRuntime({
      spawn: fake.spawn,
    });

    expect(fake.command).toBe("codex");
    expect(fake.args).toEqual(["--version"]);
    expect(availability).toEqual({
      usable: true,
      details: {
        executablePath: "codex",
        version: "codex-cli 1.2.3",
      },
    });
  });

  it("rejects session creation when Codex is unavailable", async () => {
    const adapter = createCodexRuntime({
      canUse: () => ({
        usable: false,
        reason: "Codex test probe failed.",
      }),
    });
    const agent = await createTestAgent();

    await expect(adapter.createSession({ agent })).rejects.toThrow(
      "Runtime is not available: Codex Local (codex-local). Codex test probe failed.",
    );
  });

  it("starts codex app-server and streams a turn result", async () => {
    const fake = new FakeCodexAppServer();
    const adapter = createCodexRuntime({
      spawn: fake.spawn,
      defaultModelName: "gpt-5-codex",
      defaultThinkingLevel: "high",
      listModels: async () => [
        {
          id: "gpt-5-codex",
          displayName: "GPT-5 Codex",
          provider: "openai",
          default: true,
          thinking: {
            supportedLevels: [{ value: "high", label: "High" }],
            defaultLevel: "high",
          },
        },
      ],
    });
    const agent = await createTestAgent();

    const session = await adapter.createSession({ agent });
    const handle = session.submit({ query: "Say hello" });
    const events = await collectAsync(handle.events);
    const result = await handle.result;

    expect(fake.command).toBe("codex");
    expect(fake.args.slice(0, 3)).toEqual(["app-server", "--listen", "stdio://"]);
    expectCodexMcpArgs(fake.args);
    expect(fake.env["CODEX_HOME"]).toContain(
      new PragmaPaths({ pragmaHome: agent.pragmaHome }).workflowSessionsRoot(
        session.workflowRunId() as string,
      ),
    );
    expect(fake.env["CODEX_HOME"]).toMatch(/\/runtime\/codex\/home$/);
    expect(fake.requests.map((request) => request.method).slice(0, 4)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
    ]);
    expect(fake.requests.find((request) => request.method === "thread/start")?.params).toEqual(
      expect.objectContaining({
        config: { model_reasoning_effort: "high" },
      }),
    );
    expect(fake.requests.find((request) => request.method === "turn/start")?.params).toEqual(
      expect.objectContaining({ effort: "high" }),
    );
    expect(session.info().runtimeSession.id).toBe("thread-1");
    expect(result.result.output).toBe("Hello world");
    expect(result.result.usage).toEqual(
      createExpectedUsage({
        input: 8,
        output: 3,
        cacheRead: 2,
        cacheWrite: 0,
      }),
    );
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "message.delta",
      "message.completed",
      "run.completed",
    ]);
    await session.abort();
  });

  it("loads and disposes user MCP config for the workflow tools server", async () => {
    const fake = new FakeCodexAppServer();
    const dispose = vi.fn(async () => undefined);
    const adapter = createCodexRuntime({
      spawn: fake.spawn,
    });
    const agent = await createTestAgent({
      mcp: {
        mcpServers: {
          docs: {
            name: "Docs MCP",
            transport: "in-process",
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

    const session = await adapter.createSession({ agent });
    await session.submit({ query: "Use the configured MCP server." }).result;

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("does not treat codex userMessage items as tool events", async () => {
    const fake = new FakeCodexAppServer({ emitUserMessageItem: true });
    const adapter = createCodexRuntime({
      spawn: fake.spawn,
    });
    const agent = await createTestAgent();

    const session = await adapter.createSession({ agent });
    const handle = session.submit({ query: "Say hello" });
    const events = await collectAsync(handle.events);

    await handle.result;

    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "message.delta",
      "message.completed",
      "run.completed",
    ]);

    await session.abort();
  });

  it("still streams explicit codex tool items as tool events", async () => {
    const fake = new FakeCodexAppServer({ emitCommandExecutionItem: true });
    const adapter = createCodexRuntime({
      spawn: fake.spawn,
    });
    const agent = await createTestAgent();

    const session = await adapter.createSession({ agent });
    const handle = session.submit({ query: "Run a command" });
    const events = await collectAsync(handle.events);

    await handle.result;

    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "tool.started",
      "tool.completed",
      "message.delta",
      "message.completed",
      "run.completed",
    ]);
    expect(events[1]?.type === "tool.started" ? events[1].payload.toolName : undefined).toBe(
      "exec_command",
    );
    expect(events[2]?.type === "tool.completed" ? events[2].payload.toolName : undefined).toBe(
      "exec_command",
    );

    await session.abort();
  });

  it("reads usage from nested codex turn payloads", async () => {
    const fake = new FakeCodexAppServer({ usageLocation: "turn" });
    const adapter = createCodexRuntime({
      spawn: fake.spawn,
    });
    const agent = await createTestAgent();

    const session = await adapter.createSession({ agent });
    const handle = session.submit({ query: "Say hello" });
    const result = await handle.result;

    expect(result.result.usage).toEqual(
      createExpectedUsage({
        input: 8,
        output: 3,
        cacheRead: 2,
        cacheWrite: 0,
      }),
    );

    await session.abort();
  });

  it("reads usage from codex token usage notifications", async () => {
    const fake = new FakeCodexAppServer({ usageLocation: "thread-notification" });
    const adapter = createCodexRuntime({
      spawn: fake.spawn,
    });
    const agent = await createTestAgent();

    const session = await adapter.createSession({ agent });
    const handle = session.submit({ query: "Say hello" });
    const result = await handle.result;

    expect(result.result.usage).toEqual(
      createExpectedUsage({
        input: 4,
        output: 2,
        cacheRead: 1,
        cacheWrite: 0,
      }),
    );

    await session.abort();
  });

  it("falls back to codex session jsonl usage when RPC usage is missing", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "pragma-codex-home-"));
    const fake = new FakeCodexAppServer({
      usageLocation: "none",
      onTurnStart: () => {
        writeCodexSessionTokenCount(readSpawnCodexHome(fake), {
          inputTokens: 11,
          outputTokens: 5,
          cachedInputTokens: 4,
          reasoningOutputTokens: 2,
          lastUsage: {
            inputTokens: 9,
            outputTokens: 3,
            cachedInputTokens: 2,
            reasoningOutputTokens: 1,
          },
          mtimeOffsetMs: -1_000,
        });
      },
    });
    const adapter = createCodexRuntime({
      env: { CODEX_HOME: codexHome },
      spawn: fake.spawn,
    });
    const agent = await createTestAgent();

    const session = await adapter.createSession({ agent });
    const handle = session.submit({ query: "Say hello" });
    const result = await handle.result;

    expect(result.result.usage).toEqual(
      createExpectedUsage({
        input: 7,
        output: 3,
        cacheRead: 2,
        cacheWrite: 0,
      }),
    );

    await session.abort();
  });

  it("keeps RPC usage when codex session jsonl usage also exists", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "pragma-codex-home-"));
    const fake = new FakeCodexAppServer({
      onTurnStart: () => {
        writeCodexSessionTokenCount(readSpawnCodexHome(fake), {
          inputTokens: 100,
          outputTokens: 100,
          cachedInputTokens: 50,
          reasoningOutputTokens: 50,
        });
      },
    });
    const adapter = createCodexRuntime({
      env: { CODEX_HOME: codexHome },
      spawn: fake.spawn,
    });
    const agent = await createTestAgent();

    const session = await adapter.createSession({ agent });
    const handle = session.submit({ query: "Say hello" });
    const result = await handle.result;

    expect(result.result.usage).toEqual(
      createExpectedUsage({
        input: 8,
        output: 3,
        cacheRead: 2,
        cacheWrite: 0,
      }),
    );

    await session.abort();
  });

  it("materializes ExpertAgent skills into the managed Codex home", async () => {
    const fake = new FakeCodexAppServer();
    const sourceDir = await mkdtemp(join(tmpdir(), "pragma-codex-skill-source-"));
    await writeFile(
      join(sourceDir, "SKILL.md"),
      "# Local Skill\n\nFollow the local skill instructions.\n",
    );
    await mkdir(join(sourceDir, "references"), { recursive: true });
    await writeFile(join(sourceDir, "references", "guide.md"), "Reference content.");

    const agent = await createTestAgent({
      skills: {
        skills: [
          {
            type: "local",
            name: "Local Skill",
            description: "Use for local skill runtime tests.",
            path: join(sourceDir, "SKILL.md"),
          },
          {
            type: "registry",
            name: "Unresolved Registry Skill",
            description: "This should be ignored until it has a path.",
          },
        ],
      },
    });
    const adapter = createCodexRuntime({
      spawn: fake.spawn,
    });

    const session = await adapter.createSession({ agent });
    await session.submit({ query: "Use the local skill." }).result;
    const codexHome = readSpawnCodexHome(fake);
    const skillContent = await readFile(
      join(codexHome, "skills", "local-skill", "SKILL.md"),
      "utf8",
    );
    const referenceContent = await readFile(
      join(codexHome, "skills", "local-skill", "references", "guide.md"),
      "utf8",
    );

    expect(skillContent).toContain('name: "local-skill"');
    expect(skillContent).toContain('description: "Use for local skill runtime tests."');
    expect(skillContent).toContain("Follow the local skill instructions.");
    expect(referenceContent).toBe("Reference content.");
    await expect(
      lstat(join(codexHome, "skills", "unresolved-registry-skill")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await session.abort();
  });
});

async function createTestAgent(
  options: {
    readonly contextSystem?: ContextSystem | undefined;
    readonly mcp?: IExpertAgentMcpConfig | undefined;
    readonly skills?: IExpertAgentSkillsConfig | undefined;
  } = {},
): Promise<ExpertAgent> {
  const workspace = await mkdtemp(join(tmpdir(), "pragma-codex-runtime-test-"));
  return await ExpertAgent.create({
    id: "agent-codex-test",
    name: "Codex Test Agent",
    description: "Agent used by Codex runtime tests.",
    instructions: "Answer briefly.",
    tags: [],
    version: "0.0.0",
    scope: "test",
    workspace,
    pragmaHome: join(workspace, "pragma-test-home"),
    ...(options.contextSystem === undefined ? {} : { contextSystem: options.contextSystem }),
    ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
    ...(options.skills === undefined ? {} : { skills: options.skills }),
  });
}

async function collectAsync<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];

  for await (const value of iterable) {
    values.push(value);
  }

  return values;
}

interface FakeRequest {
  readonly id?: number | undefined;
  readonly method: string;
  readonly params?: unknown;
}

interface FakeResponse {
  readonly id: number;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface FakeCodexAppServerOptions {
  readonly requestApproval?: boolean | undefined;
  readonly emitUserMessageItem?: boolean | undefined;
  readonly emitCommandExecutionItem?: boolean | undefined;
  readonly usageLocation?: "top-level" | "turn" | "thread-notification" | "none" | undefined;
  readonly onTurnStart?: (() => void) | undefined;
  readonly failFirstTurnStart?: boolean | undefined;
  readonly failThreadResume?: boolean | undefined;
}

class FakeCodexAppServer extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly requests: FakeRequest[] = [];
  readonly responses: FakeResponse[] = [];
  command = "";
  args: readonly string[] = [];
  env: NodeJS.ProcessEnv = {};
  killed = false;
  private turnStartCount = 0;

  readonly spawn: CodexRuntimeSpawn = (command, args, options) => {
    this.command = command;
    this.args = args;
    this.env = options.env;
    return this as unknown as ChildProcessWithoutNullStreams;
  };

  constructor(private readonly options: FakeCodexAppServerOptions = {}) {
    super();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const line of String(chunk).split("\n")) {
          if (line.trim() !== "") {
            this.handleClientLine(line);
          }
        }
        callback();
      },
    });
  }

  kill(): boolean {
    this.killed = true;
    queueMicrotask(() => {
      this.emit("exit", 0, null);
    });
    return true;
  }

  private handleClientLine(line: string): void {
    const message = JSON.parse(line) as FakeRequest | FakeResponse;

    if (isFakeResponse(message)) {
      this.responses.push(message);
      return;
    }

    this.requests.push(message);

    switch (message.method) {
      case "initialize":
        this.writeResponse(message.id, { server: "fake-codex" });
        break;
      case "initialized":
        break;
      case "thread/start":
        this.writeResponse(message.id, { thread: { id: "thread-1" } });
        break;
      case "thread/resume":
        if (this.options.failThreadResume === true) {
          this.writeErrorResponse(message.id, "Injected thread resume failure");
        } else {
          this.writeResponse(message.id, { thread: { id: "thread-existing" } });
        }
        break;
      case "turn/start":
        this.turnStartCount += 1;
        if (this.options.failFirstTurnStart === true && this.turnStartCount === 1) {
          this.writeErrorResponse(message.id, "Injected turn start failure");
          break;
        }
        this.writeResponse(message.id, { turn: { id: "turn-1" } });
        this.options.onTurnStart?.();
        if (this.options.requestApproval === true) {
          this.writeServerRequest(100, "item/commandExecution/requestApproval", {
            command: "echo hello",
          });
        }
        if (this.options.emitUserMessageItem === true) {
          const userMessageItem = {
            id: "user-message-1",
            type: "userMessage",
            content: [{ type: "text", text: "Say hello" }],
          };
          this.writeNotification("item/started", { item: userMessageItem });
          this.writeNotification("item/completed", { item: userMessageItem });
        }
        if (this.options.emitCommandExecutionItem === true) {
          this.writeNotification("item/started", {
            item: {
              id: "command-1",
              type: "commandExecution",
              command: "echo hello",
            },
          });
          this.writeNotification("item/completed", {
            item: {
              id: "command-1",
              type: "commandExecution",
              aggregatedOutput: "hello",
            },
          });
        }
        this.writeNotification("item/agentMessage/delta", { delta: "Hello" });
        this.writeNotification("item/completed", {
          item: {
            id: "item-1",
            type: "agentMessage",
            text: "Hello world",
          },
        });
        if (this.options.usageLocation === "thread-notification") {
          this.writeNotification("thread/tokenUsage/updated", createThreadTokenUsageParams());
        }
        this.writeNotification("turn/completed", createTurnCompletedParams(this.options));
        break;
      default:
        this.writeResponse(message.id, {});
        break;
    }
  }

  private writeResponse(id: number | undefined, result: unknown): void {
    if (id === undefined) {
      return;
    }

    this.stdout.write(`${JSON.stringify({ id, result })}\n`);
  }

  private writeErrorResponse(id: number | undefined, message: string): void {
    if (id === undefined) {
      return;
    }

    this.stdout.write(`${JSON.stringify({ id, error: { code: -32000, message } })}\n`);
  }

  private writeNotification(method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }

  private writeServerRequest(id: number, method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, method, params })}\n`);
  }
}

class FakeProbeProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  command = "";
  args: readonly string[] = [];
  env: NodeJS.ProcessEnv = {};

  readonly spawn: CodexRuntimeSpawn = (command, args, options) => {
    this.command = command;
    this.args = args;
    this.env = options.env;
    queueMicrotask(() => {
      this.stdout.write(this.result.stdout ?? "");
      this.stderr.write(this.result.stderr ?? "");
      this.stdout.end();
      this.stderr.end();
      this.emit("exit", this.result.exitCode, null);
    });
    return this as unknown as ChildProcessWithoutNullStreams;
  };

  constructor(
    private readonly result: {
      readonly exitCode: number;
      readonly stdout?: string | undefined;
      readonly stderr?: string | undefined;
    },
  ) {
    super();
  }

  kill(): boolean {
    this.emit("exit", null, "SIGTERM");
    return true;
  }
}

function createTurnCompletedParams(options: FakeCodexAppServerOptions): unknown {
  const usage = {
    input_tokens: 10,
    cached_input_tokens: 2,
    output_tokens: 3,
  };

  switch (options.usageLocation ?? "top-level") {
    case "none":
    case "thread-notification":
      return { turn: { id: "turn-1", status: "completed" } };
    case "turn":
      return {
        turn: {
          id: "turn-1",
          status: "completed",
          usage,
        },
      };
    case "top-level":
      return { usage };
  }
}

function createThreadTokenUsageParams(): unknown {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    tokenUsage: {
      total: {
        totalTokens: 13,
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 3,
        reasoningOutputTokens: 1,
      },
      last: {
        totalTokens: 7,
        inputTokens: 5,
        cachedInputTokens: 1,
        outputTokens: 2,
        reasoningOutputTokens: 1,
      },
      modelContextWindow: 258400,
    },
  };
}

function writeCodexSessionTokenCount(
  codexHome: string,
  usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
    readonly reasoningOutputTokens: number;
    readonly lastUsage?:
      | {
          readonly inputTokens: number;
          readonly outputTokens: number;
          readonly cachedInputTokens: number;
          readonly reasoningOutputTokens: number;
        }
      | undefined;
    readonly mtimeOffsetMs?: number | undefined;
  },
): void {
  const now = new Date();
  const sessionDir = join(
    codexHome,
    "sessions",
    String(now.getFullYear()).padStart(4, "0"),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  );
  mkdirSync(sessionDir, { recursive: true });
  const sessionPath = join(sessionDir, `${now.getTime()}.jsonl`);
  writeFileSync(
    sessionPath,
    `${JSON.stringify({ type: "turn_context", payload: { model: "gpt-5-codex" } })}\n${JSON.stringify(
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              cached_input_tokens: usage.cachedInputTokens,
              reasoning_output_tokens: usage.reasoningOutputTokens,
            },
            ...(usage.lastUsage === undefined
              ? {}
              : {
                  last_token_usage: {
                    input_tokens: usage.lastUsage.inputTokens,
                    output_tokens: usage.lastUsage.outputTokens,
                    cached_input_tokens: usage.lastUsage.cachedInputTokens,
                    reasoning_output_tokens: usage.lastUsage.reasoningOutputTokens,
                  },
                }),
          },
        },
      },
    )}\n`,
  );

  if (usage.mtimeOffsetMs !== undefined) {
    const mtime = new Date(now.getTime() + usage.mtimeOffsetMs);
    utimesSync(sessionPath, mtime, mtime);
  }
}

function readSpawnCodexHome(fake: FakeCodexAppServer): string {
  const codexHome = fake.env["CODEX_HOME"];

  if (codexHome === undefined) {
    throw new Error("Expected fake Codex app-server to receive CODEX_HOME.");
  }

  return codexHome;
}

function createExpectedUsage(usage: {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}) {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function isFakeResponse(message: FakeRequest | FakeResponse): message is FakeResponse {
  return "result" in message || "error" in message;
}

function expectCodexMcpArgs(args: readonly string[]): void {
  const urlArg = args.find((arg) =>
    /^mcp_servers\.pragma_tools_agent_codex_test_.*\.url=/.test(arg),
  );

  if (urlArg === undefined) {
    throw new Error("Expected Codex MCP server URL argument.");
  }

  const serverKey = urlArg.slice(0, urlArg.indexOf(".url="));

  expect(urlArg).toMatch(/\.url="http:\/\/127\.0\.0\.1:\d+\/mcp"$/);
  expect(args).toContain("-c");
  expect(args).toContain(`${serverKey}.enabled=true`);
  expect(args).toContain(`${serverKey}.required=true`);
  expect(args).toContain(`${serverKey}.default_tools_approval_mode="approve"`);
}
