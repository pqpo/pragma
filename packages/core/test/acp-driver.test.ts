import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AcpRuntimeSession,
  defineAcpRuntimeDriver,
  steerAcpSession,
  type AcpRuntimeEvent,
} from "../src/runtime/acp-driver.ts";
import { RuntimeProcessSupervisor } from "../src/runtime/process-supervisor.ts";
import {
  SteerDeliveryUncertainError,
  SteerNotDispatchedError,
} from "../src/execution/steer-delivery-error.ts";
import type { RuntimeTurnContext } from "../src/runtime/driver.ts";
import { createRuntimeTestFeatures } from "../src/testing/index.ts";
import { openRuntimeSession } from "../src/runtime/session-factory.ts";
import { ContextSystem, StaticContextStore } from "../src/index.ts";
import { defineExpert } from "../src/agent/expert-agent.ts";
import { RuntimeMessageAccumulator } from "../src/execution/runtime-message-accumulator.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
const sessions: AcpRuntimeSession[] = [];
const roots: string[] = [];
const fixture = fileURLToPath(new URL("./fixtures/acp/agent.mjs", import.meta.url));
afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map((session) => session.close()));
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function open(
  steering = "injected",
  restore?: string,
  usageScope: "turn" | "session" = "session",
) {
  const child = spawn(process.execPath, [fixture], {
    stdio: "pipe",
    env: { ...process.env, STEERING: steering, USAGE_SCOPE: usageScope },
  });
  // Assigned synchronously before the SDK starts receiving notifications.
  // eslint-disable-next-line prefer-const
  let session: AcpRuntimeSession;
  const connection = client()
    .onNotification(methods.client.session.update, ({ params }) =>
      session.update(params.sessionId, params.update),
    )
    .onNotification(
      "_test/usage",
      (value) => value,
      () => {
        if (session.active !== undefined)
          session.active.usage = {
            measurement: "reported",
            input: 5,
            output: 4,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 9,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
      },
    )
    .connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
  const supervisor = new RuntimeProcessSupervisor(child);
  void supervisor.exit.then(() => connection.close());
  session = new AcpRuntimeSession(connection, supervisor, {
    promptUsageScope: usageScope,
    command: { executablePath: process.execPath, args: [fixture], env: process.env },
    session: { cwd: process.cwd(), mcpServers: [] },
    steer: steerAcpSession,
    compact: async (session) => {
      await session.connection.agent.request(methods.agent.session.prompt, {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "/compact" }],
      });
    },
  });
  sessions.push(session);
  await session.open(restore);
  const events: AcpRuntimeEvent[] = [];
  const turn = (prompt: string) =>
    ({
      runId: "run-1",
      attempt: 1,
      isRetry: false,
      rawQuery: prompt,
      prompt,
      attachments: [],
      startupMessages: [],
      signal: new AbortController().signal,
      stream: { writeNative: (event: AcpRuntimeEvent) => events.push(event), write: vi.fn() },
    }) as unknown as RuntimeTurnContext<AcpRuntimeEvent>;
  return { session, events, turn };
}

describe("ACP stdio driver", () => {
  it.each(["hello", "failed-with-usage", "crash"])(
    "settles provider lifecycle events in the originating turn: %s",
    async (input) => {
      const { session, turn } = await open();
      const settled = vi.fn((current: AcpRuntimeSession) => {
        expect(current.active?.turn.runId).toBe("run-1");
        current.emit({ events: [] });
      });
      Object.assign(session.binding, { onTurnSettled: settled });
      const pending = session.prompt(turn(input));
      if (input === "hello") await pending;
      else await expect(pending).rejects.toThrow();
      expect(settled).toHaveBeenCalledExactlyOnceWith(session);
      expect(session.active).toBeUndefined();
    },
  );
  it("streams before completion, deduplicates tool terminal updates and prefers exact usage", async () => {
    const { session, events, turn } = await open();
    const result = await session.prompt(turn("hello"));
    expect(result.outputText).toBe("answer");
    expect(result.usage).toMatchObject({ measurement: "reported", input: 5, output: 4 });
    expect(events.some((event) => event.update?.sessionUpdate === "agent_thought_chunk")).toBe(
      true,
    );
    expect(events.filter((event) => event.toolTerminal)).toHaveLength(1);
    expect(events.filter((event) => event.toolStarted)).toHaveLength(1);
    expect(
      events.flatMap((event) => (event.toolDelta === undefined ? [] : [event.toolDelta])),
    ).toEqual(["half", " done"]);
    await expect(session.prompt(turn("second"))).resolves.toMatchObject({
      outputText: "answer",
      usage: { measurement: "reported", input: 5, output: 4 },
    });
    await session.prompt(turn("limited"));
    expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "length" });
  });
  it.each(["hello", "json-final", "no-final"])(
    "returns only the terminal answer while retaining ordered streamed history: %s",
    async (input) => {
      const { session, events, turn } = await open();
      const answer =
        input === "no-final" ? "" : input === "json-final" ? '{"answer":"done"}' : "answer";
      const result = await session.prompt(turn(input));
      expect(result.outputText).toBe(answer);
      expect(events.at(-1)?.completedText).toBe(answer);
      const texts = events.flatMap((event) =>
        event.update?.sessionUpdate === "agent_message_chunk" &&
        event.update.content.type === "text"
          ? [event.update.content.text]
          : [],
      );
      expect(texts).toEqual(answer === "" ? ["working"] : ["working", answer]);
      expect(session.messages.filter((message) => message.role === "assistant")).toMatchObject([
        {
          stopReason: "toolUse",
          content: [
            { type: "thinking", thinking: "thinking" },
            { type: "text", text: "working" },
            { type: "toolCall", id: "tool-1", name: "Read", arguments: { path: "/file" } },
          ],
        },
        { stopReason: "stop", content: [{ type: "text", text: answer }] },
      ]);
    },
  );
  it.each<[string, unknown]>([
    ["string-input", "/file"],
    ["array-input", ["/file", "/other"]],
    ["null-input", null],
  ])("preserves non-object tool arguments in completed history: %s", async (input, value) => {
    const { session, events, turn } = await open();
    await session.prompt(turn(input));
    const content = events.flatMap((event) =>
      event.completedMessage?.role === "assistant" ? event.completedMessage.content : [],
    );
    expect(content.find((item) => item.type === "toolCall")).toMatchObject({
      id: "tool-1",
      name: "Read",
      arguments: { input: value },
    });
  });
  it("uses the injected Core token counter when the agent omits usage", async () => {
    const { session, turn } = await open();
    const counter = vi
      .fn<(text: string) => { tokens: number; source: "tokenizer" }>()
      .mockReturnValue({ tokens: 17, source: "tokenizer" });
    Object.assign(session.binding, { tokenCounter: { countText: counter } });
    await expect(session.prompt(turn("estimated"))).resolves.toMatchObject({
      usage: { measurement: "estimated", input: 17, output: 17 },
    });
    expect(counter).toHaveBeenCalledTimes(2);
    expect(counter.mock.calls[1]?.[0]).toBe("workinganswerthinking");
    counter.mockClear();
    await session.prompt({
      ...turn("estimated again"),
      startupMessages: [{ role: "user", content: "startup context" }],
    });
    const serialized = counter.mock.calls[0]?.[0];
    expect(serialized).toContain("contents");
    expect(serialized).toContain("/file");
    counter.mockClear();
    await session.prompt(turn("estimated third"));
    expect(counter.mock.calls[0]?.[0]).toContain("startup context");
  });
  it("preserves turn-scoped totals across repeated prompts and compaction", async () => {
    const { session, turn } = await open("injected", undefined, "turn");
    for (const input of ["first", "second"]) {
      await expect(session.prompt(turn(input))).resolves.toMatchObject({
        usage: { input: 5, output: 4 },
      });
    }
    await session.compact();
    await expect(session.prompt(turn("third"))).resolves.toMatchObject({
      usage: { input: 5, output: 4 },
    });
  });
  it("retains reported usage on RPC errors and avoids counting it again in a session snapshot", async () => {
    const { session, turn, events } = await open();
    await expect(session.prompt(turn("failed-with-usage"))).rejects.toThrow();
    expect(events.filter((event) => event.mapping?.usage !== undefined)).toHaveLength(1);
    expect(events.find((event) => event.mapping?.usage)?.mapping?.usage).toMatchObject({
      measurement: "reported",
      input: 5,
      output: 4,
    });
    await expect(session.prompt(turn("next"))).resolves.toMatchObject({
      usage: { input: 5, output: 4 },
    });
  });
  it("does not dispatch after cancellation during attachment preparation", async () => {
    const { session, turn, events } = await open();
    const controller = new AbortController();
    vi.mocked(readFile).mockImplementationOnce(async () => {
      controller.abort();
      await session.cancel();
      return Buffer.from("image");
    });
    await expect(
      session.prompt({
        ...turn("cancel before send"),
        signal: controller.signal,
        attachments: [{ id: "image-1", kind: "image", path: "/pending-image.png", name: "image" }],
      }),
    ).rejects.toThrow("cancelled before dispatch");
    expect(events).toHaveLength(0);
    expect(session.messages).toHaveLength(0);
    await expect(session.prompt(turn("next"))).resolves.toMatchObject({ outputText: "answer" });
  });
  it.each(["configuration", "compaction"])(
    "retires a connection after a %s timeout",
    async (operation) => {
      const { session, turn } = await open();
      if (operation === "configuration") {
        vi.spyOn(session.connection.agent, "request").mockImplementationOnce(
          () => new Promise(() => {}),
        );
      } else {
        Object.assign(session.binding, { compact: () => new Promise(() => {}) });
      }
      const originalTimer = globalThis.setTimeout;
      const timer = vi
        .spyOn(globalThis, "setTimeout")
        .mockImplementation((callback, milliseconds, ...args) =>
          originalTimer(
            callback,
            milliseconds === 15_000 || milliseconds === 60_000 ? 10 : milliseconds,
            ...args,
          ),
        );
      const pending =
        operation === "configuration" ? session.setConfig("model", "opus") : session.compact();
      timer.mockRestore();
      await expect(pending).rejects.toThrow("timed out");
      expect(session.isClosing).toBe(true);
      expect(session.connection.signal.aborted).toBe(true);
      await expect(session.prompt(turn("next"))).rejects.toThrow("connection is closed");
    },
  );
  it("loads owned history without replaying it into a later turn", async () => {
    const { session, events, turn } = await open("injected", "owned-native-session");
    expect(session.messages).toHaveLength(2);
    expect(events).toHaveLength(0);
    await session.prompt(turn("hello"));
    expect(JSON.stringify(events)).not.toContain("historical answer");
  });
  it("injects into the active prompt and preserves its terminal response", async () => {
    const { session, turn, events } = await open();
    const result = session.prompt(turn("hold"));
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    await session.steer({ targetRunId: "run-1", content: "STEERED" });
    await expect(result).resolves.toMatchObject({ outputText: "STEERED" });
    expect(session.messages.filter((message) => message.role === "user")).toHaveLength(2);
  });
  it("serializes multiple steers within the same prompt", async () => {
    const { session, turn, events } = await open();
    const result = session.prompt(turn("hold"));
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    await Promise.all([
      session.steer({ targetRunId: "run-1", content: "keep running" }),
      session.steer({ targetRunId: "run-1", content: "DONE" }),
    ]);
    await expect(result).resolves.toMatchObject({ outputText: "keep runningDONE" });
  });
  it("completes tool segments separately from the final steered answer", async () => {
    const { session, turn, events } = await open();
    const pending = session.prompt(turn("multi-tool hold"));
    await vi.waitFor(() => expect(events.filter((event) => event.toolTerminal)).toHaveLength(2));
    await session.steer({ targetRunId: "run-1", content: "Stopped testing." });
    await expect(pending).resolves.toMatchObject({
      outputText: "Stopped testing.",
      usage: { measurement: "reported", input: 6, output: 4 },
    });
    const messages = events.flatMap((event) => event.completedMessage ?? []);
    expect(messages).toMatchObject([
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "thinking" },
          { type: "text", text: "working" },
          { type: "toolCall", id: "tool-1", name: "Read", arguments: { path: "/file" } },
        ],
      },
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "searching" },
          { type: "text", text: "checking" },
          { type: "toolCall", id: "tool-2", name: "Search", arguments: { query: "test" } },
        ],
      },
      {
        role: "assistant",
        stopReason: "stop",
        content: [
          { type: "thinking", thinking: "steered" },
          { type: "text", text: "Stopped testing." },
        ],
      },
    ]);
    expect(messages).toHaveLength(3);
    for (const toolCallId of ["tool-1", "tool-2"]) {
      expect(
        events.findIndex(
          (event) =>
            event.completedMessage?.role === "assistant" &&
            event.completedMessage.content.some(
              (item) => item.type === "toolCall" && item.id === toolCallId,
            ),
        ),
      ).toBeLessThan(
        events.findIndex(
          (event) =>
            event.toolStarted &&
            event.update &&
            "toolCallId" in event.update &&
            event.update.toolCallId === toolCallId,
        ),
      );
    }
  });
  it.each(["promptRequired", "unsupported"])(
    "retains safely rejected steering: %s",
    async (mode) => {
      const { session, turn, events } = await open(mode);
      const result = session.prompt(turn("hold")).catch(() => {});
      await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
      await expect(
        session.steer({ targetRunId: "run-1", content: "STEERED" }),
      ).rejects.toBeInstanceOf(SteerNotDispatchedError);
      await session.cancel();
      await result;
      expect(session.messages.filter((message) => message.role === "user")).toHaveLength(1);
    },
  );
  it.each(["detached", "timeout", "disconnect"])(
    "does not retry uncertain delivery: %s",
    async (mode) => {
      const { session, turn, events } = await open(mode);
      const result = session.prompt(turn("hold")).catch(() => {});
      await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
      await expect(
        session.steer({ targetRunId: "run-1", content: "STEERED" }),
      ).rejects.toBeInstanceOf(SteerDeliveryUncertainError);
      if (mode !== "disconnect") await session.cancel();
      await result;
    },
  );
  it("rejects changed targets before dispatch and settles cancellation", async () => {
    const { session, turn, events } = await open();
    const result = session.prompt(turn("hold"));
    const rejected = expect(result).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    await expect(session.steer({ targetRunId: "other", content: "wrong" })).rejects.toBeInstanceOf(
      SteerNotDispatchedError,
    );
    await session.cancel();
    await rejected;
  });
  it("suppresses control prompt output while updating context usage", async () => {
    const { session } = await open();
    await expect(session.compact()).resolves.toMatchObject({ usedTokens: 10 });
    expect(session.messages).toHaveLength(0);
  });
  it("terminates an agent that ignores cancellation and shares close completion", async () => {
    const { session, turn, events } = await open("uncancellable");
    const result = session.prompt(turn("hold"));
    const rejected = expect(result).rejects.toThrow();
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    await session.cancel();
    await rejected;
    expect(session.close()).toBe(session.close());
    expect(session.connection.signal.aborted).toBe(true);
  });
  it("rejects in-flight prompts when the process exits", async () => {
    const { session, turn } = await open();
    await expect(session.prompt(turn("crash"))).rejects.toThrow();
  });
  it("integrates with Core's Session factory and submit lifecycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-acp-driver-"));
    roots.push(root);
    let approvalSignal: AbortSignal | undefined;
    let releaseApproval: (() => void) | undefined;
    const runtime = defineAcpRuntimeDriver({
      descriptor: { id: "acp-test", kind: "test", displayName: "ACP Test" },
      features: createRuntimeTestFeatures({
        enabled: ["steering", "cancellation", "close", "contextWindow", "compaction", "resume"],
        compactionModes: ["manual"],
      }),
      async prepare(ctx) {
        return {
          command: { executablePath: process.execPath, args: [fixture], env: process.env },
          session: { cwd: ctx.workspace, mcpServers: [] },
          compact: async (native) => {
            await native.connection.agent.request(methods.agent.session.prompt, {
              sessionId: native.sessionId,
              prompt: [{ type: "text", text: "/compact" }],
            });
          },
          steer: steerAcpSession,
          async selectModel(native, selection) {
            expect(native.sessionId).toBe("owned-native-session");
            if (selection?.model.modelId === "invalid")
              throw new Error("selection failed before dispatch");
          },
          async requestPermission(params, signal) {
            expect(params.toolCall.toolCallId).toBe("human-tool");
            approvalSignal = signal;
            await new Promise<void>((resolve) => {
              releaseApproval = resolve;
            });
            return { outcome: { outcome: "selected", optionId: "allow" } };
          },
        };
      },
    });
    const createExpert = (content: string) =>
      defineExpert({
        id: "acp-expert",
        name: "ACP",
        workspace: root,
        instructions: "Test",
        contextSystem: new ContextSystem({
          stores: {
            project: new StaticContextStore([
              { id: "POLICY.md", content, metadata: { trigger: "always_on" } },
            ]),
          },
          roots: [{ namespace: "project" }],
        }),
        description: "ACP test",
        tags: [],
        scope: "test",
      });
    const expert = await createExpert("STARTUP_POLICY_6721");
    const session = await openRuntimeSession(runtime, {
      agent: expert,
      owner: { type: "expert-session", ownerId: "owner", contextId: "context" },
      pragmaHome: root,
      systemSessionId: "system",
    });
    try {
      const failed = session.submit({
        query: "inspect-startup",
        execution: {},
        modelSelection: { model: { modelId: "invalid", providerId: "test" } },
      });
      await expect(failed.result).rejects.toThrow("selection failed before dispatch");
      const startup = session.submit({ query: "inspect-startup", execution: {} });
      const first = await startup.result;
      expect(first.result.output).toContain("STARTUP_POLICY_6721");
      expect(
        session
          .messages()
          .some(
            (message) =>
              message.role === "user" &&
              typeof message.content === "string" &&
              message.content.includes("STARTUP_POLICY_6721"),
          ),
      ).toBe(true);
      const steady = session.submit({ query: "inspect-startup again", execution: {} });
      expect((await steady.result).result.output).not.toContain("STARTUP_POLICY_6721");
      await session.contextWindow?.compact?.();
      const reinjected = session.submit({ query: "inspect-startup after compact", execution: {} });
      expect((await reinjected.result).result.output).toContain("STARTUP_POLICY_6721");
      const submission = session.submit({ query: "hello", execution: {} });
      const streamed = (async () => {
        const events = [];
        for await (const event of submission.events) events.push(event);
        return events;
      })();
      await expect(submission.result).resolves.toMatchObject({ result: { output: "answer" } });
      const events = await streamed;
      const delta = events.findIndex((event) => event.type === "message.delta");
      const completed = events.findIndex((event) => event.type === "message.completed");
      expect(delta).toBeGreaterThanOrEqual(0);
      expect(completed).toBeGreaterThan(delta);
      const structured = session.submit({
        query: "json-final",
        output: z.object({ answer: z.literal("done") }),
        outputRetryLimit: 0,
        execution: {},
      });
      await expect(structured.result).resolves.toMatchObject({
        result: { output: { answer: "done" } },
      });
      for (const query of ["parallel-tools", "parallel-tools empty-prelude", "no-final"]) {
        const submission = session.submit({ query, execution: {} });
        const accumulator = new RuntimeMessageAccumulator({ id: "acp", kind: "acp" });
        const messages = (async () => {
          const records = [];
          for await (const event of submission.events) records.push(...accumulator.consume(event));
          return records;
        })();
        await expect(submission.result).resolves.toMatchObject({
          result: { output: query === "no-final" ? "" : "answer" },
        });
        const records = await messages;
        expect(
          records.flatMap((message) =>
            message.role === "assistant"
              ? message.content.flatMap((content) =>
                  content.type === "toolCall" ? [content.id] : [],
                )
              : [],
          ),
        ).toEqual(query === "no-final" ? ["tool-1"] : ["tool-1", "tool-2"]);
        expect(records.at(-1)).toMatchObject({
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: query === "no-final" ? "" : "answer" }],
        });
      }
      const awaitingApproval = session.submit({ query: "hold human", execution: {} });
      const cancelled = expect(awaitingApproval.result).rejects.toThrow();
      await vi.waitFor(() => expect(approvalSignal).toBeDefined());
      await awaitingApproval.cancel();
      expect(approvalSignal!.aborted).toBe(true);
      releaseApproval?.();
      await cancelled;
      // Close before the next reinjection, then reopen with changed Context.
      await session.contextWindow?.compact?.();
    } finally {
      await session.close();
    }
    const restored = await openRuntimeSession(runtime, {
      agent: await createExpert("LATEST_STARTUP_POLICY_8293"),
      owner: { type: "expert-session", ownerId: "owner", contextId: "context" },
      pragmaHome: root,
      systemSessionId: "system",
      runtimeSession: session.info().runtimeSession,
    });
    try {
      expect(restored.info().runtimeSession).toEqual(session.info().runtimeSession);
      expect(JSON.stringify(restored.messages())).toContain("historical answer");
      // A failed first restored turn must keep the newly assembled startup.
      const failed = restored.submit({
        query: "inspect-startup restored",
        execution: {},
        modelSelection: { model: { modelId: "invalid", providerId: "test" } },
      });
      await expect(failed.result).rejects.toThrow("selection failed before dispatch");
      const first = restored.submit({ query: "inspect-startup restored", execution: {} });
      const output = (await first.result).result.output;
      expect(output).toContain("LATEST_STARTUP_POLICY_8293");
      expect(output).not.toContain("STARTUP_POLICY_6721");
      const steady = restored.submit({ query: "inspect-startup restored again", execution: {} });
      expect((await steady.result).result.output).not.toContain("LATEST_STARTUP_POLICY_8293");
    } finally {
      await restored.close();
    }
  });
});
