import { createInMemoryExecutionStore } from "@pragma/core/testing";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentMessageSchema,
  ContextSystem,
  InMemoryContextStore,
  StaticContextStore,
  createLoggerProvider,
  createPragma,
  createStaticRuntimeResolver,
  defineExpert,
  type PragmaLogRecord,
} from "@pragma/core";
import {
  ExpertAgentStreamEventSchema,
  type ExecutionEvent,
  type ExecutionOutputItem,
  type ExpertAgentStreamEvent,
} from "@pragma/shared";
import { afterAll, describe, expect, it, vi } from "vitest";

import { createAntigravityRuntime } from "../src/index.ts";
import type { AntigravityAuthenticationMode } from "../src/types.ts";

const executions = createInMemoryExecutionStore();
const runSmoke = process.env["PRAGMA_ANTIGRAVITY_REAL_SMOKE"] === "1";
const roots: string[] = [];

afterAll(async () => {
  if (process.env["PRAGMA_ANTIGRAVITY_SMOKE_KEEP"] === "1") return;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(runSmoke)("Antigravity real CLI smoke", () => {
  it("keeps assistant segments around native tools separate through Core streaming", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-agy-message-segments-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const pragmaHome = join(root, "pragma-home");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "probe.txt"), "SEGMENT_READ_OK\n");
    const loggerProvider = createLoggerProvider({ handler: { write() {} } });
    const runtime = createAntigravityRuntime({
      authenticationMode: readAuthenticationMode(),
      permissionMode: "auto-approve",
      defaultModelName: process.env["PRAGMA_ANTIGRAVITY_SMOKE_MODEL"] ?? "gemini-3.8-flash-low",
    });
    const expert = await defineExpert({
      id: "01h8z8e7m6p5t4r3",
      name: "Message segment smoke",
      description: "Verify text before and after native tools.",
      scope: "test",
      tags: [],
      workspace,
      pragmaHome,
      loggerProvider,
    });
    const app = createPragma({
      executionStore: executions,
      pragmaHome,
      loggerProvider,
      runtimes: createStaticRuntimeResolver({
        runtimes: [runtime],
        defaultRuntimeId: runtime.descriptor.id,
      }),
    });
    const session = await app.experts.createSession(expert);
    try {
      const turn = await session.prompt(
        "Follow these steps strictly in order: first send an assistant message containing only BEFORE_TOOL_MARKER. Then call native view_file to read probe.txt. Next send a separate assistant message containing only BETWEEN_TOOLS_MARKER. Then call native list_dir on the workspace. Finally reply with only AFTER_TOOL_MARKER. Do not combine the assistant messages or include the earlier markers in the final answer.",
      );
      const outputTask = collectOutput(await turn.subscribeOutput({ scope: { kind: "root" } }));
      const result = await turn.result;
      const output = await outputTask;
      const messages = output.flatMap((item) => {
        if (item.channel !== "message" || item.value === undefined) return [];
        const message = AgentMessageSchema.parse(item.value);
        return message.role === "assistant" ? [message] : [];
      });
      const text = messages.map((message) =>
        message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(""),
      );
      expect(text.map((part) => part.trim())).toEqual([
        "BEFORE_TOOL_MARKER",
        "BETWEEN_TOOLS_MARKER",
        "AFTER_TOOL_MARKER",
      ]);
      expect(messages.map((message) => message.stopReason)).toEqual(["toolUse", "toolUse", "stop"]);
      expect(String(result).trim()).toBe("AFTER_TOOL_MARKER");
      for (const marker of ["BEFORE_TOOL_MARKER", "BETWEEN_TOOLS_MARKER"]) {
        const completed = output.findIndex(
          (item) =>
            item.channel === "message" &&
            item.value !== undefined &&
            JSON.stringify(item.value).includes(marker),
        );
        const nextDelta = output.findIndex(
          (item, index) =>
            index > completed && item.channel === "message" && item.delta !== undefined,
        );
        expect(output.slice(completed + 1, nextDelta).some((item) => item.channel === "tool")).toBe(
          true,
        );
      }
    } finally {
      await session.close("Message segment smoke complete");
    }
  }, 180_000);

  it.each(["auto-approve", "request-approval", "full-access"] as const)(
    "creates and edits workspace files with native tools in %s",
    async (permissionMode) => {
      const root = await mkdtemp(join(tmpdir(), "pragma-agy-native-write-"));
      roots.push(root);
      const workspace = join(root, "workspace");
      const pragmaHome = join(root, "pragma-home");
      await mkdir(workspace, { recursive: true });
      const loggerProvider = createLoggerProvider({ handler: { write() {} } });
      const runtime = createAntigravityRuntime({
        authenticationMode: readAuthenticationMode(),
        permissionMode,
        defaultModelName: process.env["PRAGMA_ANTIGRAVITY_SMOKE_MODEL"] ?? "gemini-3.8-flash-low",
      });
      const expert = await defineExpert({
        id: "01h8z8e7m6p5t4r3",
        loggerProvider,
        name: "Native write smoke",
        description: "Verify native filesystem and shell operations.",
        scope: "test",
        tags: [],
        workspace,
        pragmaHome,
      });
      const app = createPragma({
        executionStore: executions,
        loggerProvider,
        pragmaHome,
        runtimes: createStaticRuntimeResolver({
          runtimes: [runtime],
          defaultRuntimeId: runtime.descriptor.id,
        }),
      });
      let session = await app.experts.createSession(expert);
      const run = async (prompt: string) => {
        const turn = await session.prompt(prompt);
        const events = await turn.subscribeEvents({ scope: { kind: "all" } });
        const approvals: string[] = [];
        const approvalTask = (async () => {
          for await (const event of events) {
            if (event.type !== "human.requested") continue;
            const interaction = event.data as {
              interactionId: string;
              request: { kind: string; toolName: string };
            };
            expect(interaction.request.kind).toBe("tool_approval");
            approvals.push(interaction.request.toolName);
            await turn.respondToHumanInteraction(
              interaction.interactionId,
              { kind: "tool_approval", approved: true },
              { requestId: `native-smoke-${interaction.interactionId}` },
            );
          }
        })();
        try {
          const result = await turn.result;
          await approvalTask;
          return { result, approvals, events: readRuntimeEvents((await turn.listEvents()).items) };
        } finally {
          await events.close();
        }
      };
      try {
        const first = await run(
          'Use native write_to_file to create native.txt containing exactly "NATIVE_CREATED". Then use native replace_file_content to change it to exactly "NATIVE_EDITED". Do not use shell or MCP for these steps. Read the file back before answering.',
        );
        expect(
          (await readFile(join(workspace, "native.txt"), "utf8")).trim(),
          String(first.result),
        ).toBe("NATIVE_EDITED");
        expect(hasCompletedTool(first.events, "write_to_file")).toBe(true);
        expect(hasCompletedTool(first.events, "replace_file_content")).toBe(true);
        if (permissionMode === "request-approval") {
          expect(first.approvals).toContain("write_to_file");
          expect(first.approvals).toContain("replace_file_content");
        } else expect(first.approvals).toEqual([]);
        await session.releaseAfterTerminal();
        session = await app.experts.resumeSession(expert, { sessionId: session.sessionId });
        const restored = await run(
          'Use native replace_file_content to change native.txt to exactly "NATIVE_RESTORED". Read it back. ' +
            (permissionMode === "auto-approve"
              ? "Do not run shell commands."
              : "Also use native run_command to execute: printf SHELL_CREATED > shell.txt. Read shell.txt back."),
        );
        expect((await readFile(join(workspace, "native.txt"), "utf8")).trim()).toBe(
          "NATIVE_RESTORED",
        );
        expect(hasCompletedTool(restored.events, "replace_file_content")).toBe(true);
        if (permissionMode !== "auto-approve") {
          expect(await readFile(join(workspace, "shell.txt"), "utf8")).toBe("SHELL_CREATED");
          expect(hasCompletedTool(restored.events, "run_command")).toBe(true);
          if (permissionMode === "request-approval")
            expect(restored.approvals).toContain("run_command");
        }
      } finally {
        await session.close("Native write smoke complete");
      }
    },
    180_000,
  );

  it.concurrent.each(["auto-approve", "request-approval", "full-access"] as const)(
    "executes Context MCP and an independent tool in %s, then restores with a new Runtime",
    async (permissionMode) => {
      const root = await mkdtemp(join(tmpdir(), "pragma-antigravity-262-"));
      roots.push(root);
      const workspace = join(root, "workspace");
      const pragmaHome = join(root, "pragma-home");
      await mkdir(workspace, { recursive: true });
      const records: PragmaLogRecord[] = [];
      const loggerProvider = createLoggerProvider({
        minimumLevel: "debug",
        handler: {
          write(record) {
            records.push(record);
          },
        },
        host: { kind: "antigravity-262-smoke" },
      });
      const contextSystem = new ContextSystem();
      expect(
        contextSystem.register({
          namespace: "mission-board",
          store: new InMemoryContextStore(),
          mutationApproval: "none",
        }).ok,
      ).toBe(true);
      let calls = 0;
      const probeName =
        permissionMode === "full-access" ? `probe_gateway_${"x".repeat(70)}` : "probe_gateway";
      const expert = await defineExpert({
        id: "01h8z8e7m6p5t4r3",
        name: "MCP roundtrip",
        description: "Verify managed tools",
        scope: "test",
        tags: [],
        workspace,
        pragmaHome,
        loggerProvider,
        contextSystem,
        tools: [
          {
            name: probeName,
            description: "Return an independent verification marker.",
            inputSchema: {
              type: "object",
              properties: { schema_code: { type: "string", enum: ["AGY_SCHEMA_ONLY_8526"] } },
              required: ["schema_code"],
              additionalProperties: false,
            },
            async call(input) {
              expect(input).toEqual({ schema_code: "AGY_SCHEMA_ONLY_8526" });
              calls++;
              return { text: "GATEWAY_OK_262" };
            },
          },
        ],
      });
      const createApp = () => {
        const runtime = createAntigravityRuntime({
          authenticationMode: readAuthenticationMode(),
          permissionMode,
          defaultModelName: process.env["PRAGMA_ANTIGRAVITY_SMOKE_MODEL"] ?? "gemini-3.8-flash-low",
        });
        return createPragma({
          executionStore: executions,
          pragmaHome,
          loggerProvider,
          runtimes: createStaticRuntimeResolver({
            runtimes: [runtime],
            defaultRuntimeId: runtime.descriptor.id,
          }),
        });
      };
      let session = await createApp().experts.createSession(expert);
      try {
        const first = await session.prompt(
          'Use managed MCP tools directly: add_expert_context(namespace="mission-board", id="test/262.md", content="ROUNDTRIP_262"), read_expert_context on that item, then the tool described as "Return an independent verification marker." Use the exact exposed name in your tool catalog. Reply with both returned markers.',
        );
        const result = await first.result;
        expect(result).toContain("ROUNDTRIP_262");
        expect(result).toContain("GATEWAY_OK_262");
        expect(calls).toBe(1);
        await expect(
          contextSystem.read({ namespace: "mission-board", id: "test/262.md" }),
        ).resolves.toMatchObject({ ok: true, value: { content: "ROUNDTRIP_262" } });
        const completed = records.filter((record) => record.event === "tool.call_completed");
        for (const toolName of ["add_expert_context", "read_expert_context", probeName])
          expect(
            completed.some(
              (record) =>
                record.attributes?.["toolName"] === toolName &&
                record.attributes?.["isError"] === false,
            ),
          ).toBe(true);
        await session.releaseAfterTerminal();
        expect(
          (
            await contextSystem.edit({
              namespace: "mission-board",
              id: "test/262.md",
              mode: "replace",
              content: "ROUNDTRIP_RESTORED_262",
            })
          ).ok,
        ).toBe(true);
        session = await createApp().experts.resumeSession(expert, { sessionId: session.sessionId });
        const resumeLogStart = records.length;
        const restored = await session.prompt(
          'Use read_expert_context to read mission-board item test/262.md again; it may have changed. Then call the tool described as "Return an independent verification marker." Reply RESTORED plus both returned markers.',
        );
        const restoredResult = await restored.result;
        expect(restoredResult).toContain("RESTORED");
        expect(restoredResult).toContain("ROUNDTRIP_RESTORED_262");
        expect(restoredResult).toContain("GATEWAY_OK_262");
        expect(calls).toBe(2);
        for (const toolName of ["read_expert_context", probeName])
          expect(
            records
              .slice(resumeLogStart)
              .some(
                (record) =>
                  record.event === "tool.call_completed" &&
                  record.attributes?.["toolName"] === toolName &&
                  record.attributes?.["isError"] === false,
              ),
          ).toBe(true);
      } finally {
        await session.close("MCP roundtrip complete");
        if (process.env["PRAGMA_ANTIGRAVITY_SMOKE_KEEP"] === "1")
          await writeFile(
            join(root, "evidence.json"),
            JSON.stringify(
              records.filter((record) =>
                [
                  "runtime.antigravity_session_ready",
                  "runtime.antigravity_hook_decision",
                  "tool.call_started",
                  "tool.call_completed",
                ].includes(record.event),
              ),
              null,
              2,
            ),
          );
      }
    },
    180_000,
  );

  it("verifies streaming, native tools, managed MCP, plugin Skills, image fallback, and resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-antigravity-real-smoke-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    const pragmaHome = join(root, "pragma-home");
    const skillDir = join(root, "skill");
    const imagePath = join(workspace, "smoke-image.png");
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(pragmaHome, { recursive: true }),
      mkdir(join(skillDir, "references"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(workspace, "SMOKE_FILE.txt"), "native view_file smoke\n"),
      writeFile(imagePath, "not-a-real-image; path fallback only\n"),
      writeFile(
        join(skillDir, "references", "smoke-reference.md"),
        "Include AGY_SKILL_REFERENCE_7295 in the final answer.\n",
      ),
      writeFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "name: pragma-antigravity-smoke",
          "description: Antigravity managed plugin discovery smoke.",
          "---",
          "",
          "When this Skill is requested, include the exact marker AGY_SKILL_DISCOVERED_7419 in the final answer.",
          "Before answering, read references/smoke-reference.md relative to this Skill directory and include its verification marker.",
          "",
        ].join("\n"),
      ),
    ]);

    const records: PragmaLogRecord[] = [];
    const loggerProvider = createLoggerProvider({
      handler: { write: (record) => records.push(record) },
      minimumLevel: "debug",
      host: { kind: "antigravity-real-smoke" },
    });
    const streamInputs: { readonly mock: { readonly calls: readonly (readonly unknown[])[] } }[] =
      [];
    const runtime = createAntigravityRuntime({
      spawn(command, args, options) {
        const child = nodeSpawn(command, [...args], options);
        if (args.includes("--input-format")) streamInputs.push(vi.spyOn(child.stdin, "write"));
        return child;
      },
      authenticationMode: readAuthenticationMode(),
      defaultModelName: process.env["PRAGMA_ANTIGRAVITY_SMOKE_MODEL"] ?? "gemini-3.8-flash-low",
      permissionMode: "auto-approve",
    });
    const expert = await defineExpert({
      id: "01h8z8e7m6p5t4r3",
      name: "Antigravity smoke",
      description: "Exercises the public agy CLI integration.",
      instructions:
        "Follow the requested smoke steps exactly. Include the exact marker AGY_SYSTEM_PROMPT_APPLIED_5931 in every final answer.",
      tags: ["smoke"],
      scope: "test",
      workspace,
      pragmaHome,
      loggerProvider,
      contextSystem: new ContextSystem({
        stores: {
          policy: new StaticContextStore([
            {
              id: "startup.md",
              content: "Include AGY_STARTUP_CONTEXT_4186 in every final answer.",
              metadata: { trigger: "always_on" },
            },
          ]),
        },
        roots: [{ namespace: "policy" }],
      }),
      skills: {
        skills: [
          {
            type: "local",
            name: "pragma-antigravity-smoke",
            description: "Antigravity managed plugin discovery smoke.",
            path: join(skillDir, "SKILL.md"),
            baseDir: skillDir,
          },
        ],
      },
    });
    const app = createPragma({
      executionStore: executions,
      pragmaHome,
      loggerProvider,
      runtimes: createStaticRuntimeResolver({
        runtimes: [runtime],
        defaultRuntimeId: runtime.descriptor.id,
      }),
    });
    const session = await app.experts.createSession(expert, {
      runtime: runtime.descriptor.id,
    });

    try {
      const first = await session.prompt(
        [
          "Use the available Antigravity managed plugin discovery smoke Skill for this task.",
          "Perform every step before answering:",
          "1. Use the native view_file tool to read SMOKE_FILE.txt in the current workspace.",
          "2. Use the managed list_expert_context MCP tool once.",
          "3. Discover and apply the pragma-antigravity-smoke Skill.",
          "4. Write at least 120 words, include the exact marker required by that Skill, and include the exact image path from the attachment context.",
        ].join("\n"),
        {
          requestId: "antigravity-real-smoke-first",
          attachments: [
            {
              id: "00000000-0000-4000-8000-000000000001",
              kind: "image",
              name: "smoke-image.png",
              path: imagePath,
              mimeType: "image/png",
            },
          ],
        },
      );
      let firstDeltaAt: number | undefined;
      let resultSettledAt: number | undefined;
      const firstOutputPromise = collectOutput(
        await first.subscribeOutput({ scope: { kind: "root" } }),
        (item) => {
          if (item.channel === "message" && item.delta !== undefined) {
            firstDeltaAt ??= performance.now();
          }
        },
      );
      const firstResult = await first.result
        .catch((error: unknown) => {
          const hookDecisions = records.filter(
            (record) => record.event === "runtime.antigravity_hook_decision",
          );
          throw new Error(
            `Antigravity smoke turn failed: ${error instanceof Error ? error.message : String(error)}\nHook decisions: ${JSON.stringify(hookDecisions, null, 2)}`,
          );
        })
        .finally(() => {
          resultSettledAt = performance.now();
        });
      const firstOutput = await firstOutputPromise;
      const firstEvents = readRuntimeEvents((await first.listEvents()).items);

      const deltaIndex = firstOutput.findIndex(
        (item) => item.channel === "message" && item.delta !== undefined,
      );
      const completedIndex = firstOutput.findIndex(
        (item) => item.channel === "message" && item.value !== undefined,
      );
      expect(deltaIndex).toBeGreaterThanOrEqual(0);
      expect(completedIndex).toBeGreaterThan(deltaIndex);
      expect(firstDeltaAt).toBeTypeOf("number");
      expect(resultSettledAt! - firstDeltaAt!).toBeGreaterThan(100);
      expect(firstResult).toContain("AGY_SKILL_DISCOVERED_7419");
      expect(firstResult).toContain("AGY_SKILL_REFERENCE_7295");
      expect(firstResult).toContain("AGY_SYSTEM_PROMPT_APPLIED_5931");
      expect(firstResult).toContain("AGY_STARTUP_CONTEXT_4186");
      expect(firstResult).toContain(imagePath);
      expect(records).toContainEqual(
        expect.objectContaining({ event: "runtime.image_input_degraded" }),
      );
      expect(hasCompletedTool(firstEvents, "view_file")).toBe(true);
      expect(hasCompletedTool(firstEvents, "SMOKE_FILE.txt")).toBe(true);
      expect(
        hasCompletedTool(firstEvents, "list_expert_context"),
        JSON.stringify({ root, firstResult, firstEvents }, null, 2),
      ).toBe(true);

      const resumed = await session.prompt(
        "Reply with RESUME_OK and the exact prior Skill marker if you remember the immediately preceding turn.",
        { requestId: "antigravity-real-smoke-resume" },
      );
      await expect(resumed.result).resolves.toMatch(/RESUME_OK[\s\S]*AGY_SKILL_DISCOVERED_7419/i);
      const third = await session.prompt("Reply THREE_TURNS_OK.");
      await expect(third.result).resolves.toContain("THREE_TURNS_OK");
      expect(streamInputs).toHaveLength(1);
      const inputs = streamInputs[0]!.mock.calls.map(
        (call) =>
          JSON.parse(String(call[0])) as {
            event: string;
            message: { content: { text: string }[] };
          },
      );
      expect(inputs).toHaveLength(3);
      expect(
        inputs[0]!.message.content
          .slice(0, -1)
          .map((block) => block.text)
          .join("\n"),
      ).toContain("AGY_STARTUP_CONTEXT_4186");
      expect(inputs.slice(1).map((input) => input.message.content.length)).toEqual([1, 1]);
    } finally {
      await session.close("Antigravity real smoke completed.");
    }
  }, 300_000);
});

function readAuthenticationMode(): AntigravityAuthenticationMode {
  const value = process.env["PRAGMA_ANTIGRAVITY_SMOKE_AUTH_MODE"];
  if (value === undefined || value === "host-keyring") return "host-keyring";
  if (value === "isolated-environment") return value;
  throw new Error(
    "PRAGMA_ANTIGRAVITY_SMOKE_AUTH_MODE must be host-keyring or isolated-environment.",
  );
}

async function collectOutput(
  output: AsyncIterable<ExecutionOutputItem>,
  onItem?: (item: ExecutionOutputItem) => void,
): Promise<readonly ExecutionOutputItem[]> {
  const collected: ExecutionOutputItem[] = [];
  for await (const item of output) {
    onItem?.(item);
    collected.push(item);
  }
  return collected;
}

function readRuntimeEvents(events: readonly ExecutionEvent[]): readonly ExpertAgentStreamEvent[] {
  return events.flatMap((event) => {
    if (event.type !== "runtime.event") return [];
    const parsed = ExpertAgentStreamEventSchema.safeParse(event.data);
    return parsed.success ? [parsed.data] : [];
  });
}

function hasCompletedTool(events: readonly ExpertAgentStreamEvent[], expected: string): boolean {
  const starts = events.filter((event) => event.type === "tool.started");
  return starts.some((started) => {
    if (!JSON.stringify(started.payload).toLowerCase().includes(expected.toLowerCase()))
      return false;
    const toolCallId = started.payload.toolCallId;
    return events.some(
      (event) => event.type === "tool.completed" && event.payload.toolCallId === toolCallId,
    );
  });
}
