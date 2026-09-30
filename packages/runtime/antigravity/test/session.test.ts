import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";

import { RUNTIME_CONTEXT_COMPACTION_STAGES, type RuntimeTurnContext } from "@pragma/core";
import { describe, expect, it, vi } from "vitest";

import {
  collectAntigravityUsage,
  consumeAntigravityStartupMessages,
  createAntigravityArgs,
  createAntigravityNativeSession,
  expandAntigravitySkillInvocation,
  createAntigravityUserMessage,
  closeAntigravitySession,
  normalizeAntigravityStreamRecord,
  readAntigravityTranscriptAssistantText,
  startAntigravityTurn,
  type AntigravityNativeEvent,
  type AntigravityNativeSession,
} from "../src/session.ts";

const conversation1 = "11111111-2222-4333-8444-555555555551";
const conversation2 = "11111111-2222-4333-8444-555555555552";
const conversation3 = "11111111-2222-4333-8444-555555555553";
const conversation4 = "11111111-2222-4333-8444-555555555554";

describe("Antigravity CLI invocation", () => {
  it("keeps simultaneous thought snapshots and body deltas, without repeating terminal snapshots", async () => {
    const spawn = createStreamSpawn([
      {
        event: "step_update",
        step_update: {
          step_index: 1,
          step_type: "agent_response",
          state: "ACTIVE",
          text_delta: "Hel",
          raw_thought: "Inspect",
        },
      },
      {
        event: "step_update",
        step_update: {
          step_index: 1,
          step_type: "agent_response",
          state: "ACTIVE",
          text_delta: "lo",
          raw_thought: "Inspect",
        },
      },
      {
        event: "step_update",
        step_update: {
          step_index: 1,
          step_type: "agent_response",
          state: "DONE",
          content: "Hello",
          raw_thought: "Inspect",
        },
      },
      {
        event: "result",
        result: { status: "SUCCESS", response: "Hello", conversation_id: conversation2 },
      },
    ]);
    const events: AntigravityNativeEvent[] = [];
    await startAntigravityTurn(
      createSession(spawn),
      createTurn({ writeNative: (event) => events.push(event) }),
    );
    expect(events.filter((event) => event.kind === "message-delta")).toEqual([
      { kind: "message-delta", text: "Hel" },
      { kind: "message-delta", text: "lo" },
    ]);
    expect(events.slice(0, 2)).toContainEqual({ kind: "thought-delta", text: "Inspect" });
    expect(events.filter((event) => event.kind === "thought-delta")).toEqual([
      { kind: "thought-delta", text: "Inspect" },
    ]);
    expect(
      events
        .filter((event) => event.kind === "thought-delta" || event.kind === "message-delta")
        .slice(0, 2),
    ).toEqual([
      { kind: "thought-delta", text: "Inspect" },
      { kind: "message-delta", text: "Hel" },
    ]);
  });

  it("shows the actual MCP operation while retaining server identity and stable lifecycle", async () => {
    const spawn = createStreamSpawn([
      {
        event: "step_update",
        step_update: {
          step_index: 1,
          step_type: "tool",
          state: "ACTIVE",
          tool_info: {
            name: "call_mcp_tool",
            parameters: {
              ServerName: "pragma-0123456789abcdef_p",
              ToolName: "read_expert_context",
              Arguments: { namespace: "mission-board", id: "test/262.md" },
            },
          },
        },
      },
      {
        event: "step_update",
        step_update: {
          step_index: 1,
          step_type: "tool",
          state: "DONE",
          tool_info: { name: "call_mcp_tool", output: "ROUNDTRIP_262" },
        },
      },
      {
        event: "result",
        result: { status: "SUCCESS", response: "OK", conversation_id: conversation2 },
      },
    ]);
    const events: AntigravityNativeEvent[] = [];
    await startAntigravityTurn(
      createSession(spawn),
      createTurn({ writeNative: (event) => events.push(event) }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "tool-started",
        name: "read_expert_context",
        input: expect.objectContaining({ ServerName: "pragma-0123456789abcdef_p" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "tool-completed", name: "read_expert_context" }),
    );
  });

  it("uses only documented headless flags and pins the process workspace", () => {
    expect(
      createAntigravityArgs({
        agentName: "pragma-review",
        workspace: "/workspace/project",
        logPath: "/state/logs/turn.log",
        permissionMode: "request-approval",
        sessionId: conversation1,
        modelName: "gemini-3.1-pro",
        thinkingLevel: "high",
        customizationWorkspace: "/state/managed-customizations",
      }),
    ).toEqual([
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--agent",
      "pragma-review",
      "--add-dir",
      "/workspace/project",
      "--add-dir",
      "/state/managed-customizations",
      "--log-file",
      "/state/logs/turn.log",
      "--mode",
      "accept-edits",
      "--sandbox",
      "--dangerously-skip-permissions",
      "--conversation",
      conversation1,
      "--model",
      "gemini-3.1-pro",
      "--effort",
      "high",
    ]);
  });

  it("maps permission modes to sandbox and explicit dangerous overrides", () => {
    const common = {
      agentName: "pragma-review",
      workspace: "/workspace/project",
      logPath: "/tmp/log",
    } as const;
    expect(createAntigravityArgs({ ...common, permissionMode: "request-approval" })).toContain(
      "--sandbox",
    );
    expect(createAntigravityArgs({ ...common, permissionMode: "auto-approve" })).toContain(
      "--sandbox",
    );
    expect(createAntigravityArgs({ ...common, permissionMode: "full-access" })).toContain(
      "--dangerously-skip-permissions",
    );
    for (const permissionMode of ["request-approval", "auto-approve", "full-access"] as const) {
      const args = createAntigravityArgs({ ...common, permissionMode });
      expect(args).toContain("--dangerously-skip-permissions");
      expect(args).not.toContain("--cwd");
      expect(args).not.toContain("--app_data_dir");
    }
  });

  it("rejects non-UUID native conversation identifiers before they reach argv or transcript recovery", () => {
    expect(() =>
      createAntigravityArgs({
        agentName: "pragma-review",
        workspace: "/workspace/project",
        logPath: "/state/logs/turn.log",
        permissionMode: "request-approval",
        sessionId: "../../other-session",
      }),
    ).toThrow(/invalid conversation identifier/i);
  });

  it("rewrites only an explicit leading Pragma Skill invocation", () => {
    const session = {
      agent: {
        skills: {
          skills: [
            {
              type: "local",
              name: "review-code",
              description: "Review code",
              path: "/skills/review/SKILL.md",
            },
          ],
        },
      },
      managedHome: { skills: ["pragma-session-review-code"] },
    } as unknown as Pick<AntigravityNativeSession, "agent" | "managedHome">;

    expect(
      expandAntigravitySkillInvocation(
        session,
        "/review-code inspect this change",
        "# My request\n/review-code inspect this change",
      ),
    ).toBe("/pragma-session-review-code\n\n# My request\n/review-code inspect this change");
    expect(
      expandAntigravitySkillInvocation(
        session,
        "please apply review-code",
        "please apply review-code",
      ),
    ).toBe("please apply review-code");

    for (const heading of [
      "# Images mentioned by the user:\n## image.png: /workspace/image.png",
      "# Files mentioned by the user:\n## notes.md: /workspace/notes.md",
      "# Directories mentioned by the user:\n## src: /workspace/src",
    ]) {
      const attachmentQuery = `${heading}\n\n# My request\n/review-code inspect this change`;
      expect(expandAntigravitySkillInvocation(session, attachmentQuery, attachmentQuery)).toBe(
        `/pragma-session-review-code\n\n${attachmentQuery}`,
      );
    }
  });
});

describe("Antigravity startup messages", () => {
  it("serializes startup blocks in order in one user event", () => {
    expect(
      createAntigravityUserMessage(
        [
          { role: "user", content: "always on" },
          { role: "user", content: "承知" },
        ],
        "current request",
      ),
    ).toEqual({
      event: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "always on" },
          { type: "text", text: "承知" },
          { type: "text", text: "current request" },
        ],
      },
    });
    expect(createAntigravityUserMessage([], "unchanged").message.content).toEqual([
      { type: "text", text: "unchanged" },
    ]);
  });

  it("consumes first-turn startup messages exactly once", () => {
    const session = createSession(createStreamSpawn([]));
    session.pendingStartupMessages = [{ role: "user", content: "mounted context" }];

    expect(consumeAntigravityStartupMessages(session)).toEqual([
      { role: "user", content: "mounted context" },
    ]);
    expect(consumeAntigravityStartupMessages(session)).toEqual([]);
    expect(session.messages).toEqual([]);
  });
});

describe("Antigravity persistent stream-json", () => {
  it("accounts for a failed terminal result and differences the next cumulative snapshot", async () => {
    let turnIndex = 0;
    const spawn = createPersistentSpawn((_input, child) => {
      const result =
        turnIndex++ === 0
          ? {
              status: "ERROR",
              error: "request failed",
              conversation_id: conversation1,
              usage: { input_tokens: 10, output_tokens: 3 },
            }
          : {
              response: "next answer",
              conversation_id: conversation1,
              usage: { input_tokens: 15, output_tokens: 5 },
            };
      child.stdout.write(`${JSON.stringify({ event: "result", result })}\n`);
    });
    const session = createSession(spawn);
    const firstEvents: AntigravityNativeEvent[] = [];
    await expect(
      startAntigravityTurn(
        session,
        createTurn({ writeNative: (event) => firstEvents.push(event) }),
      ),
    ).rejects.toMatchObject({ code: "ANTIGRAVITY_PROCESS_FAILED" });
    expect(firstEvents.filter((event) => event.kind === "usage")).toEqual([
      { kind: "usage", usage: expect.objectContaining({ input: 10, output: 3 }) },
    ]);
    const nextEvents: AntigravityNativeEvent[] = [];
    await expect(
      startAntigravityTurn(session, createTurn({ writeNative: (event) => nextEvents.push(event) })),
    ).resolves.toMatchObject({ outputText: "next answer" });
    expect(nextEvents.filter((event) => event.kind === "usage")).toEqual([
      { kind: "usage", usage: expect.objectContaining({ input: 5, output: 2 }) },
    ]);
    expect(spawn).toHaveBeenCalledTimes(1);
    await closeAntigravitySession(session);
  });

  it("classifies a generic failed result using only this turn's log tail", async () => {
    const root = await mkdtemp(join(tmpdir(), "agy-failed-result-log-"));
    let logPath = "";
    let turnIndex = 0;
    const baseSpawn = createPersistentSpawn((_input, child) => {
      void (async () => {
        if (turnIndex++ === 0) {
          await writeFile(
            logPath,
            "agent executor error: authentication failed in an earlier turn\n",
          );
          child.stdout.write(
            `${JSON.stringify({
              event: "result",
              result: {
                response: "first",
                conversation_id: conversation1,
              },
            })}\n`,
          );
        } else {
          await writeFile(logPath, "agent executor error: quota exhausted (429)\n", { flag: "a" });
          child.stdout.write(
            `${JSON.stringify({
              event: "result",
              result: {
                status: "ERROR",
                error: "provider request failed",
                conversation_id: conversation1,
              },
            })}\n`,
          );
        }
      })();
    });
    const spawn: NonNullable<AntigravityNativeSession["spawn"]> = (...args) => {
      logPath = args[1][args[1].indexOf("--log-file") + 1]!;
      return baseSpawn(...args);
    };
    const session = createSession(spawn, undefined, { logDir: root });
    try {
      await startAntigravityTurn(session, createTurn());
      await expect(startAntigravityTurn(session, createTurn())).rejects.toMatchObject({
        code: "ANTIGRAVITY_RATE_LIMITED",
        retryable: true,
      });
      expect(baseSpawn).toHaveBeenCalledTimes(1);
    } finally {
      await closeAntigravitySession(session);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not classify earlier or transient log errors as a settled-response failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "agy-review-log-"));
    let logPath = "";
    const baseSpawn = createPersistentSpawn((_input, child, index) => {
      void (async () => {
        if (index === 0) {
          await writeFile(
            logPath,
            "agent executor error: authentication failed in an earlier attempt\n",
          );
          child.stdout.write(
            `${JSON.stringify({ event: "result", result: { response: "first", conversation_id: conversation1 } })}\n`,
          );
        } else {
          await writeFile(
            logPath,
            "agent executor error: transient error before settled response\n",
            { flag: "a" },
          );
          child.stdout.end(
            `${JSON.stringify({ event: "step_update", step_update: { step_id: "current", step_type: "agent_response", state: "DONE", content: "current settled answer" } })}\n`,
          );
          child.emit("exit", 0, null);
        }
      })();
    });
    const spawn: NonNullable<AntigravityNativeSession["spawn"]> = (...args) => {
      logPath = args[1][args[1].indexOf("--log-file") + 1]!;
      return baseSpawn(...args);
    };
    const session = createSession(spawn, undefined, { logDir: root });
    try {
      await startAntigravityTurn(session, createTurn());
      await expect(startAntigravityTurn(session, createTurn())).resolves.toMatchObject({
        outputText: "current settled answer",
        runtimeSessionId: conversation1,
      });
    } finally {
      await closeAntigravitySession(session);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts a new process if the previous one exited between turns", async () => {
    let previous: PersistentChild | undefined;
    const spawn = createPersistentSpawn((_input, child) => {
      previous = child;
      child.stdout.write(
        `${JSON.stringify({ event: "result", result: { response: "OK", conversation_id: conversation1 } })}\n`,
      );
    });
    const session = createSession(spawn);
    await startAntigravityTurn(session, createTurn());
    previous?.emit("exit", 0, null);
    await expect(startAntigravityTurn(session, createTurn())).resolves.toMatchObject({
      outputText: "OK",
    });
    expect(spawn).toHaveBeenCalledTimes(2);
    await closeAntigravitySession(session);
  });

  it("rearms startup after an asynchronous OS spawn failure that could not dispatch", async () => {
    const session = createSession(
      (_command, args, options) =>
        nodeSpawn("/nonexistent/pragma-agy-review-executable", [...args], {
          ...options,
          cwd: process.cwd(),
        }),
      undefined,
      { sessionId: conversation1 },
    );
    await expect(
      startAntigravityTurn(
        session,
        createTurn({
          startupMessages: [{ role: "user", content: "post-compaction startup" }],
        }),
      ),
    ).rejects.toMatchObject({ name: "RuntimeTurnNotDispatchedError" });
    expect(session.messages).toEqual([]);
    expect(session.connection).toBeUndefined();
  });

  it("rejects successful fresh output without an owned conversation ID", async () => {
    const session = createSession(
      createStreamSpawn([{ event: "result", result: { response: "unowned answer" } }]),
    );
    await expect(startAntigravityTurn(session, createTurn())).rejects.toMatchObject({
      code: "ANTIGRAVITY_PROTOCOL_ERROR",
    });
    expect(session.messages.some((message) => message.role === "assistant")).toBe(false);
  });

  it("bounds waiting when stdout ends while the process stays alive", async () => {
    let child: PersistentChild | undefined;
    const session = createSession(
      createPersistentSpawn((_input, current) => {
        child = current;
        current.stdout.end();
      }),
    );
    const outcome = await Promise.race([
      startAntigravityTurn(session, createTurn()).then(
        () => "success",
        (error: unknown) => error,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 1600)),
    ]);
    await closeAntigravitySession(session);
    expect(outcome).toMatchObject({ code: "ANTIGRAVITY_PROTOCOL_ERROR" });
    expect(child?.kill).toHaveBeenCalledTimes(1);
  });

  it("bounds stdout draining after process exit even with an inherited open pipe", async () => {
    const session = createSession(
      createPersistentSpawn((_input, child) => {
        child.emit("exit", 0, null);
      }),
    );
    const outcome = await Promise.race([
      startAntigravityTurn(session, createTurn()).then(
        () => "success",
        (error: unknown) => error,
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 1600)),
    ]);
    await closeAntigravitySession(session);
    expect(outcome).toMatchObject({ code: "ANTIGRAVITY_PROTOCOL_ERROR" });
  });

  it("ignores late output from a replaced process without killing its successor", async () => {
    let old: PersistentChild | undefined;
    let current: PersistentChild | undefined;
    const spawn = createPersistentSpawn((_input, child) => {
      if (old === undefined) {
        old = child;
        // A subprocess can retain the old stdout after the agent process exits.
        child.kill.mockImplementation(() => {
          child.emit("exit", 0, null);
          return true;
        });
        child.stdout.write(
          `${JSON.stringify({ event: "result", result: { response: "first", conversation_id: conversation1 } })}\n`,
        );
      } else {
        current = child;
        old.stdout.write("invalid old output\n");
        setImmediate(() =>
          child.stdout.write(
            `${JSON.stringify({ event: "result", result: { response: "second", conversation_id: conversation1 } })}\n`,
          ),
        );
      }
    });
    const session = createSession(spawn);
    await startAntigravityTurn(session, createTurn());
    const outcome = await startAntigravityTurn(session, {
      ...createTurn(),
      modelSelection: { model: { modelId: "gemini-test" }, thinkingLevel: "high" },
    } as RuntimeTurnContext<AntigravityNativeEvent>).then(
      (result) => result.outputText,
      (error: unknown) => error,
    );
    expect(current?.kill).not.toHaveBeenCalled();
    await closeAntigravitySession(session);
    old?.stdout.end();
    expect(outcome).toBe("second");
  });

  it("does not reject the next request from a delayed previous write callback", async () => {
    const callbacks: ((error?: Error | null) => void)[] = [];
    const baseSpawn = createPersistentSpawn((_input, child, index) => {
      if (index === 1) callbacks[0]?.(new Error("late previous write error"));
      setImmediate(() =>
        child.stdout.write(
          `${JSON.stringify({ event: "result", result: { response: `answer-${index}`, conversation_id: conversation1 } })}\n`,
        ),
      );
    });
    const spawn: NonNullable<AntigravityNativeSession["spawn"]> = (...args) => {
      const child = baseSpawn(...args);
      const write = child.stdin.write.bind(child.stdin);
      vi.spyOn(child.stdin, "write").mockImplementation((chunk, encoding, callback) => {
        const done = typeof encoding === "function" ? encoding : callback;
        if (done !== undefined) callbacks.push(done);
        return write(chunk);
      });
      return child;
    };
    const session = createSession(spawn);
    await startAntigravityTurn(session, createTurn());
    const outcome = await startAntigravityTurn(session, createTurn()).then(
      (result) => result.outputText,
      (error: unknown) => error,
    );
    await closeAntigravitySession(session);
    expect(outcome).toBe("answer-1");
  });

  it("sends startup once, retains one process and differences cumulative usage", async () => {
    const inputs: unknown[] = [];
    const spawn = createPersistentSpawn((input, child, index) => {
      inputs.push(input);
      if (index === 0)
        child.stdout.write(
          `${JSON.stringify({ event: "init", init: { conversation_id: conversation1 } })}\n`,
        );
      child.stdout.write(
        `${JSON.stringify({
          event: "result",
          result: {
            response: `answer-${index}`,
            conversation_id: conversation1,
            usage: { input_tokens: (index + 1) * 10, output_tokens: (index + 1) * 3 },
          },
        })}\n`,
      );
    });
    const session = createSession(spawn);
    const usages: unknown[] = [];
    for (let index = 0; index < 3; index++) {
      await startAntigravityTurn(
        session,
        createTurn({
          startupMessages: index === 0 ? [{ role: "user", content: "startup" }] : [],
          writeNative: (event) => {
            if (event.kind === "usage") usages.push(event.usage);
          },
        }),
      );
    }
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(inputs).toEqual([
      createAntigravityUserMessage([{ role: "user", content: "startup" }], "rendered user request"),
      createAntigravityUserMessage([], "rendered user request"),
      createAntigravityUserMessage([], "rendered user request"),
    ]);
    expect(usages).toEqual(
      Array.from({ length: 3 }, () => expect.objectContaining({ input: 10, output: 3 })),
    );
    await closeAntigravitySession(session);
    expect(session.connection).toBeUndefined();
  });

  it("does not attribute a restored conversation's cumulative first result to its new turn", async () => {
    const spawn = createPersistentSpawn((_input, child) =>
      child.stdout.write(
        `${JSON.stringify({
          event: "result",
          result: {
            response: "restored",
            conversation_id: conversation1,
            usage: { input_tokens: 1000, output_tokens: 100 },
          },
        })}\n`,
      ),
    );
    const session = createSession(spawn, undefined, { sessionId: conversation1 });
    const events: AntigravityNativeEvent[] = [];
    const result = await startAntigravityTurn(
      session,
      createTurn({ writeNative: (event) => events.push(event) }),
    );
    expect(events.filter((event) => event.kind === "usage")).toEqual([]);
    expect(result.usage).toMatchObject({ measurement: "estimated" });
    await closeAntigravitySession(session);
  });

  it("rejects identity changes without silently replacing the conversation", async () => {
    const spawn = createPersistentSpawn((_input, child) =>
      child.stdout.write(
        `${JSON.stringify({
          event: "result",
          result: { response: "wrong conversation", conversation_id: conversation2 },
        })}\n`,
      ),
    );
    const session = createSession(spawn, undefined, { sessionId: conversation1 });
    await expect(startAntigravityTurn(session, createTurn())).rejects.toMatchObject({
      code: "ANTIGRAVITY_PROTOCOL_ERROR",
    });
    expect(session.sessionId).toBe(conversation1);
  });

  it("uses attributable step usage on restored turns and does not count repeated snapshots", async () => {
    const events: AntigravityNativeEvent[] = [];
    const spawn = createPersistentSpawn((_input, child) => {
      const step = {
        event: "step_update",
        step_update: {
          step_id: "one-model-call",
          step_type: "agent_response",
          state: "DONE",
          content: "OK",
          usage: { input_tokens: 7, output_tokens: 2 },
        },
      };
      child.stdout.write(`${JSON.stringify(step)}\n${JSON.stringify(step)}\n`);
      child.stdout.write(
        `${JSON.stringify({ event: "result", result: { response: "OK", conversation_id: conversation1, usage: { input_tokens: 1000, output_tokens: 200 } } })}\n`,
      );
    });
    const session = createSession(spawn, undefined, { sessionId: conversation1 });
    const result = await startAntigravityTurn(
      session,
      createTurn({ writeNative: (event) => events.push(event) }),
    );
    expect(result.usage).toBeUndefined();
    expect(events.filter((event) => event.kind === "usage")).toEqual([
      {
        kind: "usage",
        usage: expect.objectContaining({ measurement: "reported", input: 7, output: 2 }),
      },
    ]);
    await closeAntigravitySession(session);
  });

  it("restarts on effort changes and resumes the same ID without startup replay", async () => {
    const inputs: unknown[] = [];
    const spawn = createPersistentSpawn((input, child) => {
      inputs.push(input);
      child.stdout.write(
        `${JSON.stringify({ event: "result", result: { response: "OK", conversation_id: conversation1 } })}\n`,
      );
    });
    const session = createSession(spawn);
    await startAntigravityTurn(
      session,
      createTurn({ startupMessages: [{ role: "user", content: "initial" }] }),
    );
    await startAntigravityTurn(session, {
      ...createTurn(),
      modelSelection: { model: { modelId: "gemini-test" }, thinkingLevel: "high" },
    } as RuntimeTurnContext<AntigravityNativeEvent>);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[1]?.[1]).toEqual(
      expect.arrayContaining(["--conversation", conversation1, "--effort", "high"]),
    );
    expect(inputs[1]).toEqual(createAntigravityUserMessage([], "rendered user request"));
    await closeAntigravitySession(session);
  });

  it("labels spawn failure before dispatch and restores the local message history", async () => {
    const session = createSession(() => {
      throw new Error("spawn unavailable");
    });
    await expect(
      startAntigravityTurn(
        session,
        createTurn({ startupMessages: [{ role: "user", content: "initial" }] }),
      ),
    ).rejects.toMatchObject({ name: "RuntimeTurnNotDispatchedError" });
    expect(session.messages).toEqual([]);
  });

  it("cancels an active request and keeps its owned identity for the following request", async () => {
    const abort = new AbortController();
    const spawn = createPersistentSpawn((_input, child) => {
      child.stdout.write(
        `${JSON.stringify({ event: "init", init: { conversation_id: conversation1 } })}\n`,
      );
      setImmediate(() => abort.abort());
    });
    const session = createSession(spawn);
    await expect(
      startAntigravityTurn(session, createTurn({ signal: abort.signal })),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(session.sessionId).toBe(conversation1);
    expect(session.connection).toBeUndefined();
  });

  it("deduplicates completed compaction operations across native turns", async () => {
    const events: AntigravityNativeEvent[] = [];
    const spawn = createPersistentSpawn((_input, child) => {
      child.stdout.write(
        `${JSON.stringify({ event: "step_update", step_update: { step_id: "compact-1", step_type: "compaction", state: "DONE", compaction_info: { operation_id: "same-operation" } } })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({ event: "result", result: { response: "OK", conversation_id: conversation1 } })}\n`,
      );
    });
    const session = createSession(spawn);
    for (let index = 0; index < 2; index++)
      await startAntigravityTurn(
        session,
        createTurn({ writeNative: (event) => events.push(event) }),
      );
    expect(
      events.filter(
        (event) =>
          event.kind === "progress" && event.stage === RUNTIME_CONTEXT_COMPACTION_STAGES.completed,
      ),
    ).toHaveLength(1);
    await closeAntigravitySession(session);
  });

  it("does not turn statusless compaction info into completion", () => {
    const events = normalizeAntigravityStreamRecord({
      event: "step_update",
      step_update: {
        step_type: "compaction",
        compaction_info: { operation_id: "unknown" },
      },
    });
    expect(events).not.toContainEqual(
      expect.objectContaining({ stage: RUNTIME_CONTEXT_COMPACTION_STAGES.completed }),
    );
  });
});

describe("Antigravity stream-json process", () => {
  it.each([
    ["REJECTED", { error: "User denied access" }],
    ["DONE", { error: "Tool execution failed" }],
  ] as const)("closes a %s tool lifecycle as failed", (status, terminal) => {
    expect(
      normalizeAntigravityStreamRecord({
        event: "step_update",
        step_update: {
          step_id: `tool-${status}`,
          step_type: "tool_use",
          status,
          tool_info: {
            id: `tool-${status}`,
            name: "write_file",
            parameters: { TargetFile: "/workspace/project/out.ts" },
            ...terminal,
          },
        },
      }),
    ).toEqual([
      {
        kind: "tool-started",
        id: `tool-${status}`,
        name: "write_file",
        input: { TargetFile: "/workspace/project/out.ts" },
      },
      {
        kind: "tool-delta",
        id: `tool-${status}`,
        name: "write_file",
        delta: terminal.error,
      },
      {
        kind: "tool-completed",
        id: `tool-${status}`,
        name: "write_file",
        output: terminal.error,
        failed: true,
      },
    ]);
  });

  it("keeps a DONE tool with an explicit null error successful", () => {
    expect(
      normalizeAntigravityStreamRecord({
        event: "step_update",
        step_update: {
          step_id: "tool-success",
          step_type: "tool_use",
          status: "DONE",
          tool_info: {
            id: "tool-success",
            name: "write_to_file",
            parameters: { TargetFile: "/workspace/project/out.ts" },
            output: "created",
            error: null,
          },
        },
      }),
    ).toContainEqual({
      kind: "tool-completed",
      id: "tool-success",
      name: "write_to_file",
      output: "created",
      failed: false,
    });
  });

  it("completes each agy assistant segment before tools and removes the aggregate terminal prefix", async () => {
    const fixture = await readAgyFixture("agy-1.2.13-assistant-segments.ndjson");
    const countText = vi.fn(() => ({ tokens: 1, source: "heuristic" as const }));
    const session = createSession(createStreamSpawn(fixture), countText);
    const events: AntigravityNativeEvent[] = [];
    await expect(
      startAntigravityTurn(session, createTurn({ writeNative: (event) => events.push(event) })),
    ).resolves.toMatchObject({ outputText: "AFTER_TOOL_MARKER\n" });
    expect(countText).toHaveBeenLastCalledWith(
      "BEFORE_TOOL_MARKER\nBETWEEN_TOOLS_MARKER\nAFTER_TOOL_MARKER\n",
      expect.any(Object),
    );
    expect(session.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [
        { type: "text", text: "BEFORE_TOOL_MARKER\nBETWEEN_TOOLS_MARKER\nAFTER_TOOL_MARKER\n" },
      ],
    });
    expect(
      events
        .filter((event) =>
          ["message-delta", "message-completed", "tool-started", "tool-completed"].includes(
            event.kind,
          ),
        )
        .map((event) => ({
          kind: event.kind,
          ...("text" in event ? { text: event.text } : {}),
          ...("final" in event ? { final: event.final } : {}),
        })),
    ).toEqual([
      { kind: "message-delta", text: "BEFORE_TOOL_MARKER" },
      { kind: "message-delta", text: "\n" },
      { kind: "message-completed", text: "BEFORE_TOOL_MARKER\n", final: false },
      { kind: "tool-started" },
      { kind: "tool-completed" },
      { kind: "message-delta", text: "BETWEEN_TOOLS_MARKER" },
      { kind: "message-delta", text: "\n" },
      { kind: "message-completed", text: "BETWEEN_TOOLS_MARKER\n", final: false },
      { kind: "tool-started" },
      { kind: "tool-completed" },
      { kind: "message-delta", text: "AFTER_TOOL_MARKER" },
      { kind: "message-delta", text: "\n" },
      { kind: "message-completed", text: "AFTER_TOOL_MARKER\n" },
    ]);
  });

  it.each([false, true])(
    "removes already completed segments from owned transcript recovery (normalized whitespace: %s)",
    async (normalizedWhitespace) => {
      const root = await mkdtemp(join(tmpdir(), "pragma-agy-segment-recovery-"));
      try {
        const transcript = join(
          root,
          ".gemini",
          "antigravity",
          "brain",
          conversation2,
          ".system_generated",
          "logs",
          "transcript.jsonl",
        );
        await mkdir(dirname(transcript), { recursive: true });
        await writeFile(
          transcript,
          [
            { type: "USER_INPUT", content: "current turn" },
            ...["BEFORE_TOOL_MARKER\n", "BETWEEN_TOOLS_MARKER\n", "AFTER_TOOL_MARKER\n"].map(
              (content) => ({
                type: "PLANNER_RESPONSE",
                source: "MODEL",
                status: "DONE",
                content: normalizedWhitespace ? content.trim() : content,
              }),
            ),
          ]
            .map((record) => JSON.stringify(record))
            .join("\n"),
        );
        const fixture = await readAgyFixture("agy-1.2.13-assistant-segments.ndjson");
        const session = createSession(createStreamSpawn(fixture.slice(0, -1)), undefined, {
          homeDir: root,
        });
        const events: AntigravityNativeEvent[] = [];
        await expect(
          startAntigravityTurn(session, createTurn({ writeNative: (event) => events.push(event) })),
        ).resolves.toMatchObject({
          outputText: normalizedWhitespace ? "AFTER_TOOL_MARKER" : "AFTER_TOOL_MARKER\n",
        });
        expect(
          events.filter((event) => event.kind === "message-completed").map((event) => event.text),
        ).toEqual([
          "BEFORE_TOOL_MARKER\n",
          "BETWEEN_TOOLS_MARKER\n",
          normalizedWhitespace ? "AFTER_TOOL_MARKER" : "AFTER_TOOL_MARKER\n",
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["BEFORE\n", "BEFORE\n final answer"])(
    "preserves a final-only result that repeats narration: %s",
    async (finalText) => {
      const countText = vi.fn(() => ({ tokens: 1, source: "heuristic" as const }));
      const session = createSession(
        createStreamSpawn([
          { event: "init", conversation_id: conversation2 },
          {
            event: "step_update",
            step_update: {
              step_index: 1,
              step_type: "agent_response",
              state: "DONE",
              content: "BEFORE\n",
            },
          },
          {
            event: "step_update",
            step_update: {
              step_index: 2,
              step_type: "tool",
              state: "DONE",
              tool_info: { name: "list_dir", parameters: {}, output: "ok" },
            },
          },
          {
            event: "step_update",
            step_update: {
              step_index: 3,
              step_type: "agent_response",
              state: "DONE",
              content: finalText,
            },
          },
          {
            event: "result",
            result: { conversation_id: conversation2, status: "SUCCESS", response: finalText },
          },
        ]),
        countText,
      );
      const events: AntigravityNativeEvent[] = [];
      await expect(
        startAntigravityTurn(session, createTurn({ writeNative: (event) => events.push(event) })),
      ).resolves.toMatchObject({ outputText: finalText });
      expect(
        events.filter((event) => event.kind === "message-completed").map((event) => event.text),
      ).toEqual(["BEFORE\n", finalText]);
      expect(countText).toHaveBeenLastCalledWith("BEFORE\n" + finalText, expect.any(Object));
    },
  );

  it.each(["final-only", "missing"])(
    "keeps only the final segment with a %s terminal result",
    async (terminal) => {
      const fixture = await readAgyFixture("agy-1.2.13-assistant-segments.ndjson");
      const records = fixture.slice(0, -1);
      if (terminal === "final-only")
        records.push({
          event: "result",
          result: {
            conversation_id: conversation2,
            status: "SUCCESS",
            response: "AFTER_TOOL_MARKER\n",
          },
        });
      const session = createSession(createStreamSpawn(records));
      const events: AntigravityNativeEvent[] = [];
      await expect(
        startAntigravityTurn(session, createTurn({ writeNative: (event) => events.push(event) })),
      ).resolves.toMatchObject({ outputText: "AFTER_TOOL_MARKER\n" });
      expect(
        events.filter((event) => event.kind === "message-completed").map((event) => event.text),
      ).toEqual(["BEFORE_TOOL_MARKER\n", "BETWEEN_TOOLS_MARKER\n", "AFTER_TOOL_MARKER\n"]);
    },
  );

  it("streams agy 1.1.11 agent_response deltas before the terminal result without duplication", async () => {
    const fixture = await readAgyFixture("agy-1.1.11-agent-response.ndjson");
    const session = createSession(createStreamSpawn(fixture));
    const nativeEvents: AntigravityNativeEvent[] = [];

    await expect(
      startAntigravityTurn(
        session,
        createTurn({ writeNative: (event) => nativeEvents.push(event) }),
      ),
    ).resolves.toMatchObject({ outputText: "你好，streamed response" });

    expect(nativeEvents.filter((event) => event.kind === "message-delta")).toEqual([
      { kind: "message-delta", text: "你好，" },
      { kind: "message-delta", text: "streamed response" },
    ]);
    expect(nativeEvents.filter((event) => event.kind === "message-completed")).toEqual([
      { kind: "message-completed", text: "你好，streamed response", final: false },
      { kind: "message-completed", text: "" },
    ]);
    expect(nativeEvents).toEqual(
      expect.arrayContaining([
        {
          kind: "tool-started",
          id: "agy-tool:2:tool_use",
          name: "list_dir",
          input: { DirectoryPath: "/workspace/project" },
        },
        {
          kind: "tool-delta",
          id: "agy-tool:2:tool_use",
          name: "list_dir",
          delta: "src\npackage.json",
        },
        {
          kind: "tool-completed",
          id: "agy-tool:2:tool_use",
          name: "list_dir",
          output: "src\npackage.json",
          failed: false,
        },
      ]),
    );
    expect(nativeEvents).toContainEqual(
      expect.objectContaining({ kind: "progress", stage: "antigravity.error_message" }),
    );
    expect(nativeEvents.findIndex((event) => event.kind === "message-delta")).toBeLessThan(
      nativeEvents.findIndex((event) => event.kind === "message-completed"),
    );
  });

  it("decodes NDJSON when a UTF-8 code point is split across stdout chunks", async () => {
    const source = Buffer.from(
      [
        JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: conversation2,
            step_type: "agent_response",
            status: "DONE",
            text_delta: "你好",
          },
        }),
        JSON.stringify({
          event: "result",
          result: { conversation_id: conversation2, status: "SUCCESS", response: "你好" },
        }),
        "",
      ].join("\n"),
    );
    const splitAt = source.indexOf(Buffer.from("你")) + 1;
    const events: AntigravityNativeEvent[] = [];
    const session = createSession(
      createChunkedRawStreamSpawn([source.subarray(0, splitAt), source.subarray(splitAt)]),
    );

    await expect(
      startAntigravityTurn(session, createTurn({ writeNative: (event) => events.push(event) })),
    ).resolves.toMatchObject({ outputText: "你好" });
    expect(events).toContainEqual({ kind: "message-delta", text: "你好" });
  });

  it("streams messages, thinking, tools, subagents, compaction, session identity, and reported usage", async () => {
    const spawn = createStreamSpawn([
      {
        event: "init",
        init: {
          conversation_id: conversation2,
          model: "gemini-3.1-pro",
          tools: ["view_file"],
          mcp_servers: ["pragma"],
        },
      },
      {
        event: "step_update",
        step_update: {
          step_index: 0,
          step_type: "THOUGHT",
          text_delta: "Inspect",
          status: "running",
        },
      },
      {
        event: "step_update",
        step_update: {
          step_index: 1,
          step_type: "PLANNER_RESPONSE",
          text_delta: "Hel",
          status: "running",
        },
      },
      {
        event: "step_update",
        step_update: {
          step_index: 1,
          step_type: "PLANNER_RESPONSE",
          text_delta: "lo",
          status: "completed",
        },
      },
      {
        event: "step_update",
        step_update: {
          step_id: "tool-step",
          step_type: "tool_use",
          status: "running",
          tool_info: {
            id: "tool-1",
            name: "view_file",
            parameters: { AbsolutePath: "/workspace/project/file.ts" },
          },
        },
      },
      {
        event: "step_update",
        step_update: {
          step_id: "tool-step",
          step_type: "tool_use",
          status: "completed",
          tool_info: {
            id: "tool-1",
            name: "view_file",
            output: "contents",
          },
        },
      },
      {
        event: "step_update",
        step_update: {
          step_id: "subagent-1",
          step_type: "subagent",
          subagent_info: { name: "researcher", status: "running" },
        },
      },
      {
        event: "step_update",
        step_update: {
          step_id: "compact-1",
          step_type: "compaction",
          status: "running",
          compaction_info: { operation_id: "compact-op", trigger: "auto" },
        },
      },
      {
        event: "step_update",
        step_update: {
          step_id: "compact-1",
          step_type: "compaction",
          status: "completed",
          compaction_info: { operation_id: "compact-op", trigger: "auto" },
        },
      },
      {
        event: "result",
        result: {
          conversation_id: conversation2,
          status: "SUCCESS",
          response: "Hello",
          duration_seconds: 1.25,
          num_turns: 1,
          usage: {
            input_tokens: 10,
            output_tokens: 3,
            thinking_tokens: 2,
            cache_read_tokens: 4,
            total_tokens: 19,
          },
        },
      },
    ]);
    const session = createSession(spawn);
    const nativeEvents: AntigravityNativeEvent[] = [];

    const result = await startAntigravityTurn(
      session,
      createTurn({
        startupMessages: [{ role: "user", content: "mounted context" }],
        writeNative: (event) => nativeEvents.push(event),
      }),
    );

    expect(result).toMatchObject({
      outputText: "Hello",
      runtimeSessionId: conversation2,
    });
    expect(result.usage).toBeUndefined();
    expect(nativeEvents).toContainEqual({
      kind: "usage",
      usage: expect.objectContaining({
        measurement: "reported",
        input: 10,
        output: 5,
        cacheRead: 4,
        cacheWrite: 0,
        totalTokens: 19,
      }),
    });
    expect(spawn).toHaveBeenCalledWith(
      "/opt/agy",
      expect.arrayContaining(["--input-format", "stream-json", "--agent", "pragma-review"]),
      expect.objectContaining({ cwd: "/workspace/project", env: { PRIVATE_HOME: "true" } }),
    );
    expect(nativeEvents).toEqual(
      expect.arrayContaining([
        { kind: "session", sessionId: conversation2 },
        { kind: "thought-delta", text: "Inspect" },
        { kind: "message-delta", text: "Hel" },
        { kind: "message-delta", text: "lo" },
        {
          kind: "tool-started",
          id: "tool-1",
          name: "view_file",
          input: { AbsolutePath: "/workspace/project/file.ts" },
        },
        { kind: "tool-delta", id: "tool-1", name: "view_file", delta: "contents" },
        {
          kind: "tool-completed",
          id: "tool-1",
          name: "view_file",
          output: "contents",
          failed: false,
        },
        expect.objectContaining({ kind: "progress", stage: "antigravity.subagent" }),
        expect.objectContaining({
          kind: "progress",
          stage: RUNTIME_CONTEXT_COMPACTION_STAGES.started,
        }),
        expect.objectContaining({
          kind: "progress",
          stage: RUNTIME_CONTEXT_COMPACTION_STAGES.completed,
        }),
        expect.objectContaining({ kind: "usage" }),
        { kind: "message-completed", text: "Hello", final: false, thinking: "Inspect" },
      ]),
    );
    expect(session.messages).toMatchObject([
      { role: "user", content: "mounted context" },
      { role: "user", content: "raw user request" },
      { role: "assistant", provider: "antigravity", api: "antigravity-cli" },
    ]);
  });

  it("uses the shared token counter only when the CLI omits usage, without double-counting startup input", async () => {
    const spawn = createStreamSpawn([
      { event: "init", conversation_id: conversation3 },
      { event: "result", conversation_id: conversation3, result: "Done" },
    ]);
    const countText = vi
      .fn<AntigravityNativeSession["tokenCounter"]["countText"]>()
      .mockReturnValueOnce({ tokens: 12, source: "heuristic" })
      .mockReturnValueOnce({ tokens: 2, source: "heuristic" });
    const session = createSession(spawn, countText);

    const result = await startAntigravityTurn(
      session,
      createTurn({ startupMessages: [{ role: "user", content: "mounted once" }] }),
    );

    expect(result.usage).toMatchObject({ measurement: "estimated", input: 12, output: 2 });
    expect(JSON.parse(countText.mock.calls[0]![0])).toMatchObject({
      systemPrompt: "exact system prompt",
      messages: [],
      prompt: expect.stringContaining("mounted once"),
    });
    expect(countText.mock.calls[0]![0].match(/mounted once/g)).toHaveLength(1);
    expect(countText.mock.calls[1]![0]).toBe("Done");
  });

  it("recovers a non-empty streamed answer when a terminal result is missing", async () => {
    const spawn = createStreamSpawn([
      { event: "init", conversation_id: conversation4 },
      {
        event: "step_update",
        step_update: {
          step_id: "answer",
          step_type: "model_response",
          status: "DONE",
          content: "Recovered answer",
        },
      },
    ]);
    const session = createSession(spawn);
    const events: AntigravityNativeEvent[] = [];

    await expect(
      startAntigravityTurn(session, createTurn({ writeNative: (event) => events.push(event) })),
    ).resolves.toMatchObject({ outputText: "Recovered answer" });
    expect(events).toContainEqual({ kind: "message-completed", text: "Recovered answer" });
    expect(session.logger.warn).toHaveBeenCalledWith(
      "runtime.antigravity_terminal_result_missing",
      expect.any(String),
      expect.objectContaining({ recovered: true }),
    );
  });

  it("does not treat an ACTIVE response after an earlier DONE response as settled", async () => {
    const session = createSession(
      createStreamSpawn([
        { event: "init", conversation_id: conversation4 },
        {
          event: "step_update",
          step_update: {
            step_index: 0,
            step_type: "agent_response",
            status: "DONE",
            text_delta: "Earlier response",
          },
        },
        {
          event: "step_update",
          step_update: {
            step_index: 2,
            step_type: "agent_response",
            status: "ACTIVE",
            text_delta: "Partial final response",
          },
        },
      ]),
    );

    await expect(startAntigravityTurn(session, createTurn())).rejects.toMatchObject({
      code: "ANTIGRAVITY_PROTOCOL_ERROR",
    });
  });

  it("prefers a settled transcript over a partial ACTIVE response when result is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-agy-partial-recovery-"));
    const homeDir = join(root, "home");
    const logDir = join(root, "logs");
    const transcript = join(
      homeDir,
      ".gemini",
      "antigravity",
      "brain",
      conversation4,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    await mkdir(dirname(transcript), { recursive: true });
    await mkdir(logDir, { recursive: true });
    try {
      const spawn = createRawStreamSpawn(
        `${JSON.stringify({
          event: "step_update",
          step_update: {
            conversation_id: conversation4,
            step_type: "agent_response",
            status: "ACTIVE",
            text_delta: "Hel",
          },
        })}\n`,
        "",
        async () => {
          await writeFile(
            transcript,
            [
              JSON.stringify({ type: "USER_INPUT", content: "current request" }),
              JSON.stringify({
                type: "PLANNER_RESPONSE",
                source: "MODEL",
                status: "DONE",
                content: "Hello",
              }),
            ].join("\n"),
          );
        },
      );
      const session = createSession(spawn, undefined, { homeDir, logDir });
      await expect(startAntigravityTurn(session, createTurn())).resolves.toMatchObject({
        outputText: "Hello",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains an initialized native conversation when the turn later fails", async () => {
    const session = createSession(
      createStreamSpawn([
        { event: "init", conversation_id: conversation3 },
        {
          event: "result",
          result: {
            conversation_id: conversation3,
            status: "ERROR",
            message: "provider rejected the request",
          },
        },
      ]),
    );
    const events: AntigravityNativeEvent[] = [];

    await expect(
      startAntigravityTurn(session, createTurn({ writeNative: (event) => events.push(event) })),
    ).rejects.toMatchObject({ code: "ANTIGRAVITY_PROCESS_FAILED" });

    expect(events).toContainEqual({ kind: "session", sessionId: conversation3 });
    expect(session.sessionId).toBe(conversation3);
  });

  it("rejects plain text and malformed stream-json", async () => {
    for (const output of ["First line\n", '{"event":\n']) {
      await expect(
        startAntigravityTurn(createSession(createRawStreamSpawn(output)), createTurn()),
      ).rejects.toMatchObject({ code: "ANTIGRAVITY_PROTOCOL_ERROR" });
    }
  });

  it("uses a transcript only after this turn's user boundary and never reuses a resumed answer", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-agy-transcript-recovery-"));
    const homeDir = join(root, "home");
    const logDir = join(root, "logs");
    const transcript = join(
      homeDir,
      ".gemini",
      "antigravity",
      "brain",
      conversation3,
      ".system_generated",
      "logs",
      "transcript.jsonl",
    );
    await mkdir(dirname(transcript), { recursive: true });
    await mkdir(logDir, { recursive: true });
    try {
      await writeFile(
        transcript,
        [
          JSON.stringify({ type: "USER_INPUT", content: "old request" }),
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            source: "MODEL",
            status: "DONE",
            content: "Old answer that must not become this turn's output",
          }),
        ].join("\n"),
      );
      const resumed = createSession(createRawStreamSpawn(""), undefined, {
        homeDir,
        logDir,
        sessionId: conversation3,
      });
      await expect(startAntigravityTurn(resumed, createTurn())).rejects.toMatchObject({
        code: "ANTIGRAVITY_PROTOCOL_ERROR",
      });

      const freshTranscript = join(
        homeDir,
        ".gemini",
        "antigravity",
        "brain",
        conversation4,
        ".system_generated",
        "logs",
        "transcript.jsonl",
      );
      await mkdir(dirname(freshTranscript), { recursive: true });
      await writeFile(
        freshTranscript,
        [
          JSON.stringify({ type: "USER_INPUT", content: "current request" }),
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            source: "MODEL",
            status: "DONE",
            content: "Recovered current answer",
          }),
        ].join("\n"),
      );
      const fresh = createSession(
        createRawStreamSpawn(
          `${JSON.stringify({ event: "init", init: { conversation_id: conversation4 } })}\n`,
          "",
          async (args) => {
            const logPath = args[args.indexOf("--log-file") + 1]!;
            await writeFile(
              logPath,
              `Print mode: conversation=${conversation4}, sending message\n`,
            );
          },
        ),
        undefined,
        { homeDir, logDir },
      );
      await expect(startAntigravityTurn(fresh, createTurn())).resolves.toMatchObject({
        outputText: "Recovered current answer",
        runtimeSessionId: conversation4,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves structured tool configuration errors despite transient startup auth warnings", async () => {
    const message =
      'failed to construct executor: unknown component: tool "call_mcp_tool" not found in registry';
    const session = createSession(
      createPersistentSpawn((_input, child) => {
        child.stderr.write("error getting token source: You are not logged into Antigravity.\n");
        child.stderr.write("OAuth: authenticated successfully\n");
        child.stdout.write(
          JSON.stringify({
            event: "result",
            result: { conversation_id: conversation1, status: "ERROR", error: message },
          }) + "\n",
        );
      }),
    );
    try {
      await expect(startAntigravityTurn(session, createTurn())).rejects.toMatchObject({
        code: "ANTIGRAVITY_PROCESS_FAILED",
        message,
      });
    } finally {
      await closeAntigravitySession(session);
    }
  });

  it("classifies authentication events", async () => {
    const authSession = createSession(
      createStreamSpawn([
        {
          event: "result",
          result: {
            conversation_id: "",
            status: "ERROR",
            response: "",
            error: "authentication failed or timed out",
            duration_seconds: 0,
            num_turns: 0,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              thinking_tokens: 0,
              cache_read_tokens: 0,
              total_tokens: 0,
            },
          },
        },
      ]),
    );
    await expect(startAntigravityTurn(authSession, createTurn())).rejects.toMatchObject({
      name: "AntigravityRuntimeError",
      code: "ANTIGRAVITY_AUTH_REQUIRED",
      retryable: false,
    });
  });

  it("fails when the process exits successfully without any recoverable assistant output", async () => {
    const session = createSession(createStreamSpawn([{ event: "init" }]));

    await expect(startAntigravityTurn(session, createTurn())).rejects.toMatchObject({
      code: "ANTIGRAVITY_PROTOCOL_ERROR",
    });
  });

  it("terminates an active CLI process and surfaces AbortError when a turn is cancelled", async () => {
    const controller = new AbortController();
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn((signal: NodeJS.Signals) => {
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", null, signal);
      });
      return true;
    });
    let resolveSpawned: (() => void) | undefined;
    const spawned = new Promise<void>((resolveSpawn) => {
      resolveSpawned = resolveSpawn;
    });
    const spawn = vi.fn(() => {
      resolveSpawned?.();
      return child as unknown as ChildProcessWithoutNullStreams;
    });
    const session = createSession(spawn);

    const result = startAntigravityTurn(session, createTurn({ signal: controller.signal }));
    await spawned;
    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(child.kill).not.toHaveBeenCalledWith("SIGKILL");
    expect(session.connection).toBeUndefined();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(session.toolRuntimeState.runId).toBeUndefined();
  });
});

describe("Antigravity record normalization and usage collection", () => {
  it("keeps unknown records observable while recursively removing credentials", () => {
    expect(
      normalizeAntigravityStreamRecord({
        event: "future_event",
        authorization: "secret",
        token: "secret",
        visible: "kept",
        nested: { cookie: "secret", visible: ["nested"] },
      }),
    ).toEqual([
      {
        kind: "progress",
        stage: "antigravity.future_event",
        data: { event: "future_event", visible: "kept", nested: { visible: ["nested"] } },
      },
    ]);
  });

  it("prefers direct output token totals over component output fields", () => {
    expect(
      normalizeAntigravityStreamRecord({
        event: "result",
        result: "done",
        usage: {
          inputTokens: 7,
          outputTokens: 11,
          thinkingOutputTokens: 100,
          responseOutputTokens: 200,
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "usage",
          usage: expect.objectContaining({ input: 7, output: 11, measurement: "reported" }),
        }),
      ]),
    );
  });

  it.each(["failed", "error", "cancelled"])(
    "reports a %s compaction as failed instead of completed",
    (status) => {
      const events = normalizeAntigravityStreamRecord({
        event: "step_update",
        step_update: {
          step_id: "compact-1",
          step_type: "compaction",
          status,
          compaction_info: {
            operation_id: "compact-op",
            trigger: "automatic",
            error: "provider unavailable",
          },
        },
      });

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "progress",
            stage: RUNTIME_CONTEXT_COMPACTION_STAGES.started,
          }),
          expect.objectContaining({
            kind: "progress",
            stage: RUNTIME_CONTEXT_COMPACTION_STAGES.failed,
            data: expect.objectContaining({
              operationId: "compact-op",
              trigger: "auto",
              errorMessage: "provider unavailable",
            }),
          }),
        ]),
      );
      expect(events).not.toContainEqual(
        expect.objectContaining({ stage: RUNTIME_CONTEXT_COMPACTION_STAGES.completed }),
      );
    },
  );

  it("redacts credentials from native tool events and vendor failures", async () => {
    const events = normalizeAntigravityStreamRecord({
      event: "step_update",
      step_update: {
        step_id: "tool-1",
        step_type: "tool_use",
        status: "completed",
        tool_info: {
          id: "tool-1",
          name: "mcp__unmanaged__read",
          parameters: {
            Authorization: "Bearer input-secret",
            nested: { token: "nested-secret", visible: "kept" },
          },
          output: 'Authorization: Bearer output-secret {"password":"hidden","visible":"kept"}',
        },
      },
    });
    const serializedEvents = JSON.stringify(events);
    expect(serializedEvents).not.toContain("input-secret");
    expect(serializedEvents).not.toContain("nested-secret");
    expect(serializedEvents).not.toContain("output-secret");
    expect(serializedEvents).not.toContain("hidden");
    expect(serializedEvents).toContain("[redacted]");

    const failed = createSession(
      createStreamSpawn([
        {
          event: "result",
          result: {
            status: "ERROR",
            error: "provider failed: Authorization: Bearer result-secret",
          },
        },
      ]),
    );
    await expect(startAntigravityTurn(failed, createTurn())).rejects.toMatchObject({
      code: "ANTIGRAVITY_PROCESS_FAILED",
      message: expect.not.stringContaining("result-secret"),
    });
  });

  it("uses reported total_tokens to detect input counts that already include cache reads", () => {
    expect(
      normalizeAntigravityStreamRecord({
        event: "result",
        result: {
          status: "SUCCESS",
          response: "done",
          usage: {
            input_tokens: 14,
            output_tokens: 3,
            thinking_tokens: 2,
            cache_read_tokens: 4,
            total_tokens: 19,
          },
        },
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "usage",
          usage: expect.objectContaining({
            input: 10,
            output: 5,
            cacheRead: 4,
            totalTokens: 19,
          }),
        }),
      ]),
    );
  });

  it("preserves existing non-zero usage during final collection", () => {
    const session = createSession(createStreamSpawn([]));
    const usage = {
      measurement: "reported",
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    } as const;

    expect(collectAntigravityUsage(session, "ignored", usage)).toBe(usage);
  });

  it("recovers only the current transcript turn and the latest logged conversation id", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-agy-transcript-test-"));
    const transcript = join(root, "transcript.jsonl");
    try {
      await writeFile(
        transcript,
        [
          JSON.stringify({
            trajectory: {
              steps: [
                {
                  stepType: "CORTEX_STEP_TYPE_PLANNER_RESPONSE",
                  plannerResponse: { response: "Recovered planner answer" },
                },
              ],
            },
          }),
          "{incomplete",
        ].join("\n"),
      );

      await expect(readAntigravityTranscriptAssistantText(transcript)).resolves.toBe(
        "Recovered planner answer",
      );

      await writeFile(
        transcript,
        [
          JSON.stringify({ type: "USER_INPUT", content: "old turn" }),
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            source: "MODEL",
            status: "DONE",
            content: "Old answer that must not leak",
          }),
          JSON.stringify({ type: "USER_INPUT", content: "current turn" }),
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            source: "MODEL",
            status: "DONE",
            content: "Current narration",
          }),
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            source: "MODEL",
            status: "RUNNING",
            content: "Partial text that must not leak",
          }),
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            source: "MODEL",
            status: "DONE",
            content: "Current final answer",
          }),
          "{incomplete",
        ].join("\n"),
      );
      await expect(readAntigravityTranscriptAssistantText(transcript)).resolves.toBe(
        "Current narration\n\nCurrent final answer",
      );

      await writeFile(
        transcript,
        [
          JSON.stringify({ type: "USER_INPUT", content: "old turn" }),
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            source: "MODEL",
            status: "DONE",
            content: "Old answer",
          }),
          JSON.stringify({ type: "USER_INPUT", content: "empty current turn" }),
        ].join("\n"),
      );
      await expect(readAntigravityTranscriptAssistantText(transcript)).resolves.toBeUndefined();
      await writeFile(
        transcript,
        [
          JSON.stringify({ type: "USER_INPUT", content: "old turn before the tail" }),
          " ".repeat(4 * 1024 * 1024 + 1_024),
          JSON.stringify({
            type: "PLANNER_RESPONSE",
            source: "MODEL",
            status: "DONE",
            content: "Old answer beyond a truncated boundary",
          }),
        ].join("\n"),
      );
      await expect(readAntigravityTranscriptAssistantText(transcript)).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function createSession(
  spawn: AntigravityNativeSession["spawn"],
  countText: AntigravityNativeSession["tokenCounter"]["countText"] = () => ({
    tokens: 1,
    source: "heuristic",
  }),
  options: {
    readonly homeDir?: string | undefined;
    readonly logDir?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly workspace?: string | undefined;
  } = {},
): AntigravityNativeSession {
  const homeDir = options.homeDir ?? "/state/home";
  const logDir = options.logDir ?? "/state/logs";
  return createAntigravityNativeSession({
    agent: {
      workspace: options.workspace ?? "/workspace/project",
    } as AntigravityNativeSession["agent"],
    executablePath: "/opt/agy",
    env: { PRIVATE_HOME: "true" },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as AntigravityNativeSession["logger"],
    managedHome: {
      authenticationMode: "isolated-environment",
      homeDir,
      appDataDir: join(homeDir, ".gemini", "antigravity-cli"),
      configDir: join(homeDir, ".gemini", "config"),
      agentName: "pragma-review",
      mcpServerName: "p",
      nativeMcpServerName: "pragma-0123456789abcdef_p",
      hookName: "pragma-permission-gate-0123456789abcdef",
      pluginName: "pragma-0123456789abcdef",
      pluginDir: join(homeDir, ".gemini", "config", "plugins", "pragma-0123456789abcdef"),
      logDir,
      env: { PRIVATE_HOME: "true" },
      skills: [],
    },
    permissionMode: "request-approval",
    spawn,
    systemPrompt: "exact system prompt",
    toolRuntimeState: {},
    tokenCounter: { countText },
    sessionId: options.sessionId,
  });
}

async function readAgyFixture(name: string): Promise<readonly unknown[]> {
  const source = await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
  return source
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as unknown);
}

function createTurn(
  options: {
    readonly startupMessages?: RuntimeTurnContext<AntigravityNativeEvent>["startupMessages"];
    readonly writeNative?: (event: AntigravityNativeEvent) => void;
    readonly signal?: AbortSignal;
  } = {},
): RuntimeTurnContext<AntigravityNativeEvent> {
  return {
    runId: "run-1",
    attempt: 1,
    isRetry: false,
    rawQuery: "raw user request",
    prompt: "rendered user request",
    attachments: [],
    startupMessages: options.startupMessages ?? [],
    features: {} as never,
    steps: {} as never,
    signal: options.signal ?? new AbortController().signal,
    source: { kind: "runtime", runId: "run-1", path: [] },
    stream: {
      write: vi.fn(),
      writeNative: options.writeNative ?? vi.fn(),
    } as unknown as RuntimeTurnContext<AntigravityNativeEvent>["stream"],
  };
}

function createStreamSpawn(records: readonly unknown[], stderr = "") {
  return createRawStreamSpawn(
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    stderr,
  );
}

function createRawStreamSpawn(
  stdout: string,
  stderr = "",
  beforeExit?: (args: readonly string[]) => Promise<void> | void,
) {
  return vi.fn((_command: string, args: readonly string[]) => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    queueMicrotask(() => {
      void Promise.resolve(beforeExit?.(args)).then(
        () => {
          child.stdout.end(stdout);
          child.stderr.end(stderr);
          child.emit("exit", 0, null);
        },
        (error: unknown) => {
          child.emit("error", error);
        },
      );
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  });
}

function createChunkedRawStreamSpawn(chunks: readonly Buffer[]) {
  return vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    queueMicrotask(() => {
      for (const chunk of chunks) child.stdout.write(chunk);
      child.stdout.end();
      child.stderr.end();
      child.emit("exit", 0, null);
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  });
}

type PersistentChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};
function createPersistentSpawn(
  onInput: (input: unknown, child: PersistentChild, index: number) => void,
) {
  return vi.fn<NonNullable<AntigravityNativeSession["spawn"]>>(() => {
    const child = new EventEmitter() as PersistentChild;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let exited = false;
    child.kill = vi.fn(() => {
      if (!exited) {
        exited = true;
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", 0, null);
      }
      return true;
    });
    let buffer = "";
    let index = 0;
    child.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const input = JSON.parse(buffer.slice(0, newline)) as unknown;
        buffer = buffer.slice(newline + 1);
        onInput(input, child, index++);
      }
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  });
}
