import { createInMemoryExecutionStore } from "@pragma/core/testing";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPragma,
  createStaticRuntimeResolver,
  defineExpert,
  type RuntimeStreamEvent,
} from "@pragma/core";
import { describe, expect, it } from "vitest";
import { createClaudeCodeRuntime } from "../src/index.ts";

const fixture = fileURLToPath(new URL("./fixtures/failure-agent.mjs", import.meta.url));
describe("Claude ACP failures through Core", () => {
  it.each([
    ["session-auth", "runtime.auth_invalid", false],
    ["session-rate", "runtime.rate_limited", true],
    ["exit-auth", "runtime.auth_invalid", false],
    ["exit-rate", "runtime.rate_limited", true],
    ["exit-crash", "runtime.process_failed", true],
  ] as const)(
    "preserves Host failure metadata: %s",
    async (mode, code, retryable) => {
      const root = await mkdtemp(join(tmpdir(), "pragma-acp-failure-"));
      const runtime = createClaudeCodeRuntime({
        acpWorkerPath: fixture,
        env: { PATH: process.env.PATH },
        spawn: (_command, _args, options) =>
          spawn(process.execPath, [fixture], {
            ...options,
            env: { ...options.env, FAILURE_MODE: mode },
            stdio: "pipe",
          }),
        listModels: async () => [
          {
            id: "sonnet",
            displayName: "Sonnet",
            default: true,
            provider: { id: "anthropic", kind: "runtime-managed", displayName: "Claude" },
          },
        ],
      });
      const events: RuntimeStreamEvent[] = [];
      const expert = await defineExpert({
        id: "failure-test",
        name: "Failure",
        workspace: root,
        pragmaHome: root,
        description: "Failure test",
        tags: [],
        scope: "test",
        hooks: {
          onStreamEvent: ({ event }) => {
            events.push(event);
          },
        },
      });
      const app = createPragma({
        executionStore: createInMemoryExecutionStore(),
        pragmaHome: root,
        runtimes: createStaticRuntimeResolver({
          runtimes: [runtime],
          defaultRuntimeId: runtime.descriptor.id,
        }),
      });
      const session = await app.experts.createSession(expert, { runtime: runtime.descriptor.id });
      try {
        const submission = await session.prompt("fail", { requestId: "first" });
        await expect(submission.result).rejects.toThrow();
        const failure = events.find((event) => event.type === "run.failed");
        expect(failure).toMatchObject({
          payload: { code, retryable, message: expect.stringContaining("provider diagnostic") },
        });
        if (mode.startsWith("session-")) {
          const next = await session.prompt("retry", { requestId: "next" });
          expect(String(await next.result)).toContain("recovered");
          if (mode === "session-rate") {
            const crashed = await session.prompt("crash after recovery", { requestId: "third" });
            await expect(crashed.result).rejects.toThrow();
            expect(events.filter((event) => event.type === "run.failed").at(-1)).toMatchObject({
              payload: {
                code: "runtime.process_failed",
                retryable: true,
                message: expect.stringContaining("new diagnostic"),
              },
            });
          }
        }
      } finally {
        await session.close();
        await rm(root, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
