import { createInMemoryExecutionStore } from "@pragma/core/testing";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPragma,
  createRuntimeTokenCounter,
  createStaticRuntimeResolver,
  defineExpert,
  type ExecutionOutputItem,
} from "@pragma/core";
import { describe, expect, it, vi } from "vitest";
import { createOpenCodeRuntime } from "../src/adapter.ts";

for (const major of [1, 2] as const) {
  const executablePath = process.env[`PRAGMA_OPENCODE_V${major}_PATH`];
  describe.runIf(executablePath !== undefined)(`OpenCode ${major}.x real streaming`, () => {
    it.each([true, false])(
      "keeps reasoning, tools and usage correct (reported: %s)",
      async (reportedUsage) => {
        const root = await mkdtemp(join(tmpdir(), "pragma-opencode-stream-"));
        let calls = 0;
        let turns = 0;
        const server = createServer(async (request, response) => {
          let body = "";
          for await (const chunk of request) body += String(chunk);
          const payload = JSON.parse(body) as {
            stream?: boolean;
            tools?: { function: { name: string } }[];
            messages: { role: string; content?: unknown }[];
          };
          const tool = payload.tools?.find(
            (item) =>
              item.function.name.includes("stream_probe") ||
              (major === 2 && item.function.name === "execute"),
          );
          const namespace = JSON.stringify(payload.messages).match(/pragma_ses_[a-zA-Z0-9_]+/)?.[0];
          const argumentsText =
            major === 2
              ? JSON.stringify({
                  code: `return await tools.${namespace}.stream_probe({ marker: "STREAM_ARGUMENT" });`,
                })
              : JSON.stringify({ marker: "STREAM_ARGUMENT" });
          if (!payload.stream) {
            response.writeHead(200, { "content-type": "application/json" }).end(
              JSON.stringify({
                id: "title",
                object: "chat.completion",
                created: 1,
                model: "echo",
                choices: [
                  {
                    index: 0,
                    message: { role: "assistant", content: "Stream Test" },
                    finish_reason: "stop",
                  },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              }),
            );
            return;
          }
          const afterTool = payload.messages.some((item) => item.role === "tool");
          if (tool !== undefined) turns++;
          response.writeHead(200, { "content-type": "text/event-stream" });
          const chunk = (delta: unknown, finish: string | null = null) =>
            response.write(
              `data: ${JSON.stringify({ id: `completion-${turns}`, object: "chat.completion.chunk", created: 1, model: "echo", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
            );
          chunk({
            role: "assistant",
            reasoning_content: afterTool ? "Think after." : "Think before.",
          });
          chunk({
            content: afterTool || tool === undefined ? "Final answer once." : "Before tool.",
          });
          if (tool !== undefined && !afterTool) {
            chunk({
              tool_calls: [
                {
                  index: 0,
                  id: "call_stream_probe",
                  type: "function",
                  function: { name: tool.function.name, arguments: argumentsText },
                },
              ],
            });
            chunk({}, "tool_calls");
          } else chunk({}, "stop");
          if (reportedUsage)
            response.write(
              `data: ${JSON.stringify({ id: `completion-${turns}`, object: "chat.completion.chunk", created: 1, model: "echo", choices: [], usage: { prompt_tokens: 17, completion_tokens: 4, total_tokens: 21 } })}\n\n`,
            );
          response.end("data: [DONE]\n\n");
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (address === null || typeof address === "string")
          throw new Error("Provider has no port.");
        await mkdir(join(root, "config", "opencode"), { recursive: true });
        const settings = { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "test" };
        const models = {
          echo: {
            name: "Echo",
            limit: { context: 128000, output: 4096 },
          },
        };
        await writeFile(
          join(root, "config", "opencode", "opencode.jsonc"),
          JSON.stringify({
            model: "pragma_mock/echo",
            ...(major === 1
              ? {
                  provider: {
                    pragma_mock: { npm: "@ai-sdk/openai-compatible", options: settings, models },
                  },
                }
              : {
                  providers: {
                    pragma_mock: {
                      package: "@opencode/ai/providers/openai-compatible",
                      settings,
                      models,
                    },
                  },
                }),
          }),
        );
        const tokenCounter = createRuntimeTokenCounter();
        const countText = vi.spyOn(tokenCounter, "countText");
        const runtime = createOpenCodeRuntime({
          tokenCounter,
          executablePath: executablePath!,
          permissionMode: "full-access",
          env: {
            PATH: process.env.PATH,
            HOME: root,
            XDG_CONFIG_HOME: join(root, "config"),
            XDG_DATA_HOME: join(root, "data"),
            XDG_CACHE_HOME: join(root, "cache"),
          },
        });
        const app = createPragma({
          executionStore: createInMemoryExecutionStore(),
          pragmaHome: join(root, "pragma"),
          runtimes: createStaticRuntimeResolver({
            runtimes: [runtime],
            defaultRuntimeId: runtime.descriptor.id,
          }),
        });
        const expert = await defineExpert({
          id: "stream-probe",
          name: "Stream Probe",
          description: "Synthetic streaming test",
          scope: "test",
          tags: [],
          workspace: root,
          tools: [
            {
              name: "stream_probe",
              description: "Return a stream test marker",
              inputSchema: {
                type: "object",
                properties: { marker: { type: "string" } },
                required: ["marker"],
              },
              async call(input) {
                expect(input).toEqual({ marker: "STREAM_ARGUMENT" });
                calls++;
                return { text: "STREAM_TOOL_RESULT" };
              },
            },
          ],
        });
        const session = await app.experts.createSession(expert);
        try {
          const turn = await session.prompt("Run stream_probe once and then reply.");
          const subscription = await turn.subscribeOutput();
          const outputs: ExecutionOutputItem[] = [];
          const collect = (async () => {
            for await (const output of subscription) outputs.push(output);
          })();
          await expect(turn.result).resolves.toBe("Final answer once.");
          await collect;
          expect(calls).toBe(1);
          expect(turns).toBe(2);
          expect(
            outputs
              .filter((item) => item.channel === "message" && item.delta !== undefined)
              .map((item) => item.delta)
              .join(""),
          ).toBe("Before tool.Final answer once.");
          const toolIndex = outputs.findIndex((item) => item.channel === "tool");
          expect(toolIndex).toBeGreaterThan(0);
          expect(
            outputs
              .slice(0, toolIndex)
              .some((item) => item.channel === "message" && item.value !== undefined),
          ).toBe(true);
          expect(
            outputs.slice(toolIndex + 1).some((item) => item.delta === "Final answer once."),
          ).toBe(true);
          const messages = (await turn.getMessageHistory({ scope: { kind: "root" } }))
            .flatMap((history) => history.messages)
            .map((record) => record.message);
          const texts = messages
            .filter((message) => message.role === "assistant")
            .flatMap((message) =>
              message.content.filter((part) => part.type === "text").map((part) => part.text),
            );
          expect(texts.filter((text) => text !== "")).toEqual([
            "Before tool.",
            "Final answer once.",
          ]);
          expect(
            messages.filter(
              (message) => message.role === "assistant" && message.stopReason === "stop",
            ),
          ).toHaveLength(1);
          const toolCalls = messages.flatMap((message) =>
            message.role === "assistant"
              ? message.content.filter((part) => part.type === "toolCall")
              : [],
          );
          expect(toolCalls).toHaveLength(1);
          expect(toolCalls[0]?.arguments).toEqual(
            major === 1
              ? { marker: "STREAM_ARGUMENT" }
              : { code: expect.stringContaining("STREAM_ARGUMENT") },
          );
          if (reportedUsage) {
            expect(await turn.usage).toMatchObject({
              measurement: "reported",
              input: 34,
              output: 8,
            });
            expect(countText).not.toHaveBeenCalled();
          } else {
            expect(await turn.usage).toMatchObject({ measurement: "estimated" });
            expect(countText.mock.calls[1]?.[0]).toContain("Before tool.");
            expect(countText.mock.calls[1]?.[0]).toContain("Think before.");
            expect(countText.mock.calls[1]?.[0]).toContain("Final answer once.");
          }

          const thinking = outputs
            .filter((item) => item.channel === "thought")
            .map((item) => item.delta ?? "")
            .join("");
          expect(thinking).toBe("Think before.Think after.");
        } finally {
          await session.close();
          tokenCounter.dispose();
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          await rm(root, { recursive: true, force: true });
        }
      },
      90_000,
    );
  });
}
