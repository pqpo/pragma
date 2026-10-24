import {
  createNoopLoggerProvider,
  createPragma,
  createStaticRuntimeResolver,
  defineExpert,
  type ResolvedModelProvider,
} from "@pragma/core";
import { createInMemoryExecutionStore } from "@pragma/core/testing";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPiRuntime } from "../src/adapter.ts";

describe("Pi Session native approvals", () => {
  it.each([undefined, "request-approval", "auto-approve", "full-access"] as const)(
    "preserves native approvals after restoring %s",
    async (permissionMode) => {
      const root = await mkdtemp(join(tmpdir(), "pragma-pi-session-"));
      vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent-config"));
      let step = 0;
      let approvals = 0;
      const server = createServer(async (request, response) => {
        let body = "";
        for await (const chunk of request) body += String(chunk);
        const payload = JSON.parse(body) as { tools?: { function: { name: string } }[] };
        response.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta: unknown, finish: string | null = null) =>
          response.write(
            `data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", created: 1, model: "echo", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
          );
        if (step++ === 0) {
          expect(payload.tools?.some((tool) => tool.function.name === "bash")).toBe(true);
          chunk({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "shell-probe",
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({ command: "printf SESSION_OK > native.txt" }),
                },
              },
            ],
          });
          chunk({}, "tool_calls");
        } else chunk({ role: "assistant", content: "done" }, "stop");
        response.end("data: [DONE]\n\n");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No port");
      const provider: ResolvedModelProvider = {
        id: "mock",
        catalogId: "custom-openai",
        displayName: "Mock",
        api: "openai-completions",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        apiKey: "test",
        credentialFingerprint: "mock",
        models: [
          {
            kind: "generation",
            id: "echo",
            name: "Echo",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 4096,
          },
        ],
      };
      const runtime = createPiRuntime({
        permissionMode,
        modelProviders: {
          listProviders: async () => [provider],
          resolveProvider: async () => provider,
        },
        env: { ...process.env },
      });
      const app = createPragma({
        pragmaHome: join(root, "pragma"),
        executionStore: createInMemoryExecutionStore(),
        loggerProvider: createNoopLoggerProvider(),
        runtimes: createStaticRuntimeResolver({
          runtimes: [runtime],
          defaultRuntimeId: runtime.descriptor.id,
        }),
      });
      const expert = await defineExpert({
        id: "pi-permissions",
        name: "Pi Permissions",
        description: "Test",
        scope: "test",
        tags: [],
        workspace: root,
        loggerProvider: createNoopLoggerProvider(),
      });
      let session = await app.experts.createSession(expert, {
        modelSelection: { model: { providerId: "mock", modelId: "echo" } },
      });
      const run = async (approved: boolean) => {
        step = 0;
        const turn = await session.prompt("Use bash once to run the probe and report done.");
        const events = await turn.subscribeEvents();
        const decisions = (async () => {
          for await (const event of events) {
            if (event.type !== "human.requested") continue;
            approvals++;
            await turn.respondToHumanInteraction(
              (event.data as { interactionId: string }).interactionId,
              { kind: "tool_approval", approved },
              { requestId: `approval-${turn.executionId}` },
            );
          }
        })();
        try {
          expect(await turn.result).toBe("done");
          await decisions;
          await turn.settled;
        } finally {
          await events.close();
        }
      };
      try {
        await run(true);
        expect(await readFile(join(root, "native.txt"), "utf8")).toBe("SESSION_OK");
        await session.releaseAfterTerminal();
        session = await app.experts.resumeSession(expert, { sessionId: session.sessionId });
        await rm(join(root, "native.txt"));
        await run(true);
        expect(await readFile(join(root, "native.txt"), "utf8")).toBe("SESSION_OK");
        expect(approvals).toBe(permissionMode === "request-approval" ? 2 : 0);
        if (permissionMode === "request-approval") {
          await rm(join(root, "native.txt"));
          await run(false);
          await expect(readFile(join(root, "native.txt"))).rejects.toMatchObject({
            code: "ENOENT",
          });
          await run(true);
          expect(await readFile(join(root, "native.txt"), "utf8")).toBe("SESSION_OK");
        }
      } finally {
        await session.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
