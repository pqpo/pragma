import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
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
import { afterAll, describe, expect, it } from "vitest";

import { createAntigravityRuntime } from "../src/index.ts";
import type { AntigravityAuthenticationMode } from "../src/types.ts";

const runSmoke = process.env["PRAGMA_ANTIGRAVITY_REAL_SMOKE"] === "1";
const roots: string[] = [];

afterAll(async () => {
  if (process.env["PRAGMA_ANTIGRAVITY_SMOKE_KEEP"] === "1") return;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(runSmoke)("Antigravity real CLI smoke", () => {
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
      mkdir(skillDir, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(workspace, "SMOKE_FILE.txt"), "native list_dir smoke\n"),
      writeFile(imagePath, "not-a-real-image; path fallback only\n"),
      writeFile(
        join(skillDir, "SKILL.md"),
        [
          "---",
          "name: pragma-antigravity-smoke",
          "description: Antigravity managed plugin discovery smoke.",
          "---",
          "",
          "When this Skill is requested, include the exact marker AGY_SKILL_DISCOVERED_7419 in the final answer.",
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
    const runtime = createAntigravityRuntime({
      authenticationMode: readAuthenticationMode(),
      defaultModelName: process.env["PRAGMA_ANTIGRAVITY_SMOKE_MODEL"] ?? "gemini-3.6-flash-low",
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
          "/pragma-antigravity-smoke",
          "Perform every step before answering:",
          "1. Use the native list_dir tool on the current workspace.",
          "2. Use the managed list_expert_context MCP tool once.",
          "3. Apply the invoked pragma-antigravity-smoke Skill.",
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
      expect(firstResult).toContain("AGY_SYSTEM_PROMPT_APPLIED_5931");
      expect(firstResult).toContain(imagePath);
      expect(records).toContainEqual(
        expect.objectContaining({ event: "runtime.image_input_degraded" }),
      );
      expect(hasCompletedTool(firstEvents, "list_dir")).toBe(true);
      expect(
        hasCompletedTool(firstEvents, "list_expert_context"),
        JSON.stringify({ root, firstResult, firstEvents }, null, 2),
      ).toBe(true);

      const resumed = await session.prompt(
        "Reply with RESUME_OK and the exact prior Skill marker if you remember the immediately preceding turn.",
        { requestId: "antigravity-real-smoke-resume" },
      );
      await expect(resumed.result).resolves.toMatch(/RESUME_OK[\s\S]*AGY_SKILL_DISCOVERED_7419/i);
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
