import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { ExpertAgent } from "../../src/agent/expert-agent.ts";
import { createCodexLocalRuntimeAdapter } from "../../src/codex-runtime/adapter.ts";
import {
  AGENTS_CONTEXT_ID,
  ContextSystem,
  HOST_CONTEXT_NAMESPACE,
} from "../../src/context-system/context-system.ts";
import { createInMemoryContextStore } from "../../src/context-system/in-memory-context-store.ts";
import type { CodexRuntimeSpawn } from "../../src/codex-runtime/types.ts";
import type { RuntimeSessionStorageContext } from "../../src/runtime/runtime-adapter.ts";

describe("createCodexLocalRuntimeAdapter", () => {
  it("starts codex app-server and streams a turn result", async () => {
    const fake = new FakeCodexAppServer();
    const adapter = createCodexLocalRuntimeAdapter({
      spawn: fake.spawn,
      defaultModelName: "gpt-5-codex",
    });
    const agent = await createTestAgent();

    const session = await adapter.createSession({ agent });
    const handle = session.submit({ query: "Say hello" });
    const events = await collectAsync(handle.events);
    const result = await handle.result;

    expect(fake.command).toBe("codex");
    expect(fake.args).toEqual(["app-server", "--listen", "stdio://"]);
    expect(fake.requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "thread/start",
      "turn/start",
    ]);
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
    expect(session.messages()).toHaveLength(2);

    await session.abort();
  });

  it("does not treat codex userMessage items as tool events", async () => {
    const fake = new FakeCodexAppServer({ emitUserMessageItem: true });
    const adapter = createCodexLocalRuntimeAdapter({
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
    const adapter = createCodexLocalRuntimeAdapter({
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
    const adapter = createCodexLocalRuntimeAdapter({
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

  it("falls back to codex session jsonl usage when RPC usage is missing", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "pragma-codex-home-"));
    const fake = new FakeCodexAppServer({
      usageLocation: "none",
      onTurnStart: () => {
        writeCodexSessionTokenCount(codexHome, {
          inputTokens: 11,
          outputTokens: 5,
          cachedInputTokens: 4,
          reasoningOutputTokens: 2,
        });
      },
    });
    const adapter = createCodexLocalRuntimeAdapter({
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
        output: 7,
        cacheRead: 4,
        cacheWrite: 0,
      }),
    );

    await session.abort();
  });

  it("keeps RPC usage when codex session jsonl usage also exists", async () => {
    const codexHome = await mkdtemp(join(tmpdir(), "pragma-codex-home-"));
    const fake = new FakeCodexAppServer({
      onTurnStart: () => {
        writeCodexSessionTokenCount(codexHome, {
          inputTokens: 100,
          outputTokens: 100,
          cachedInputTokens: 50,
          reasoningOutputTokens: 50,
        });
      },
    });
    const adapter = createCodexLocalRuntimeAdapter({
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

  it("injects always-on context into codex developer instructions", async () => {
    const fake = new FakeCodexAppServer();
    const adapter = createCodexLocalRuntimeAdapter({
      spawn: fake.spawn,
    });
    const contextSystem = new ContextSystem();
    contextSystem.register({
      namespace: HOST_CONTEXT_NAMESPACE,
      store: createInMemoryContextStore({
        context: [
          {
            id: AGENTS_CONTEXT_ID,
            content: "Codex runtime startup context marker.",
          },
        ],
      }),
    });
    const agent = await createTestAgent({ contextSystem });

    const session = await adapter.createSession({ agent });
    const threadStart = fake.requests.find((request) => request.method === "thread/start");

    expect(readRequestParams(threadStart)?.["developerInstructions"]).toContain(
      "Codex runtime startup context marker.",
    );

    await session.abort();
  });

  it("resumes a matching codex runtime session", async () => {
    const fake = new FakeCodexAppServer();
    const adapter = createCodexLocalRuntimeAdapter({
      spawn: fake.spawn,
    });
    const agent = await createTestAgent();

    const session = await adapter.createSession({
      agent,
      runtimeSession: {
        type: "codex-local",
        id: "thread-existing",
      },
    });

    expect(fake.requests.map((request) => request.method)).toContain("thread/resume");
    expect(fake.requests.map((request) => request.method)).not.toContain("thread/start");
    expect(session.info().runtimeSession.id).toBe("thread-existing");

    await session.abort();
  });

  it("restores a matching codex runtime session before resume", async () => {
    const fake = new FakeCodexAppServer();
    const restoredContexts: RuntimeSessionStorageContext[] = [];
    const adapter = createCodexLocalRuntimeAdapter({
      spawn: fake.spawn,
      sessionRestoreHandler: (context) => {
        restoredContexts.push(context);
      },
    });
    const agent = await createTestAgent();

    const session = await adapter.createSession({
      agent,
      runtimeSession: {
        type: "codex-local",
        id: "thread-existing",
      },
    });
    const [restoredContext] = restoredContexts;

    expect(restoredContext).toBeDefined();
    expect(restoredContext?.runtimeSession).toEqual({
      type: "codex-local",
      id: "thread-existing",
    });
    expect(fake.requests.map((request) => request.method)).toContain("thread/resume");

    await session.abort();
  });

  it("approves app-server approval requests when no human handler is configured", async () => {
    const fake = new FakeCodexAppServer({ requestApproval: true });
    const adapter = createCodexLocalRuntimeAdapter({
      spawn: fake.spawn,
    });
    const agent = await createTestAgent();
    const session = await adapter.createSession({ agent });
    const handle = session.submit({ query: "Run a command" });

    await handle.result;

    expect(fake.responses).toContainEqual({
      id: 100,
      result: {
        decision: "accept",
      },
    });

    await session.abort();
  });
});

async function createTestAgent(
  options: { readonly contextSystem?: ContextSystem | undefined } = {},
): Promise<ExpertAgent> {
  return await ExpertAgent.create({
    id: "agent-codex-test",
    name: "Codex Test Agent",
    description: "Agent used by Codex runtime tests.",
    instructions: "Answer briefly.",
    tags: [],
    version: "0.0.0",
    scope: "test",
    workspace: await mkdtemp(join(tmpdir(), "pragma-codex-runtime-test-")),
    memory: false,
    ...(options.contextSystem === undefined ? {} : { contextSystem: options.contextSystem }),
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
  readonly usageLocation?: "top-level" | "turn" | "none" | undefined;
  readonly onTurnStart?: (() => void) | undefined;
}

class FakeCodexAppServer extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: Writable;
  readonly requests: FakeRequest[] = [];
  readonly responses: FakeResponse[] = [];
  command = "";
  args: readonly string[] = [];

  readonly spawn: CodexRuntimeSpawn = (command, args) => {
    this.command = command;
    this.args = args;
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
        this.writeResponse(message.id, { thread: { id: "thread-existing" } });
        break;
      case "turn/start":
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

  private writeNotification(method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ method, params })}\n`);
  }

  private writeServerRequest(id: number, method: string, params: unknown): void {
    this.stdout.write(`${JSON.stringify({ id, method, params })}\n`);
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

function writeCodexSessionTokenCount(
  codexHome: string,
  usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens: number;
    readonly reasoningOutputTokens: number;
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
  writeFileSync(
    join(sessionDir, `${now.getTime()}.jsonl`),
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
          },
        },
      },
    )}\n`,
  );
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

function readRequestParams(request: FakeRequest | undefined): Record<string, unknown> | undefined {
  if (request === undefined || typeof request.params !== "object" || request.params === null) {
    return undefined;
  }

  return request.params as Record<string, unknown>;
}
