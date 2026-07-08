import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import { ExpertAgent } from "../../src/agent/expert-agent.ts";
import { createCodexLocalRuntimeAdapter } from "../../src/codex-runtime/adapter.ts";
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
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "message.delta",
      "message.completed",
      "run.completed",
    ]);
    expect(session.messages()).toHaveLength(2);

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

async function createTestAgent(): Promise<ExpertAgent> {
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

  constructor(private readonly options: { readonly requestApproval?: boolean } = {}) {
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
        if (this.options.requestApproval === true) {
          this.writeServerRequest(100, "item/commandExecution/requestApproval", {
            command: "echo hello",
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
        this.writeNotification("turn/completed", {
          usage: {
            input_tokens: 10,
            cached_input_tokens: 2,
            output_tokens: 3,
          },
        });
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

function isFakeResponse(message: FakeRequest | FakeResponse): message is FakeResponse {
  return "result" in message || "error" in message;
}
