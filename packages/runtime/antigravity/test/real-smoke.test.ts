import { spawn as nodeSpawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
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

const runSmoke = process.env["PRAGMA_ANTIGRAVITY_REAL_SMOKE"] === "1";
const roots: string[] = [];

afterAll(async () => {
  if (process.env["PRAGMA_ANTIGRAVITY_SMOKE_KEEP"] === "1") return;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(runSmoke)("Antigravity real CLI smoke", () => {
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
