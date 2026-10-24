import {
  createPragma,
  createTextToolResult,
  createRuntimeTokenCounter,
  createStaticRuntimeResolver,
  defineExpert,
} from "@pragma/core";
import { createInMemoryExecutionStore } from "@pragma/core/testing";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOpenCodeRuntime } from "../src/adapter.ts";

for (const major of [1, 2] as const) {
  const executablePath = process.env[`PRAGMA_OPENCODE_V${major}_PATH`];
  describe.runIf(executablePath !== undefined)(
    `OpenCode ${major}.x native skills and shell`,
    () => {
      it.each(["request-approval", "auto-approve", "full-access"] as const)(
        "loads a skill, reads its reference and runs shell in %s",
        async (mode) => {
          const root = await mkdtemp(join(tmpdir(), "pragma-opencode-skill-smoke-"));
          let step = 0;
          let approvals = 0;
          let mcpCalls = 0;
          const results: string[] = [];
          const approvalTools: string[] = [];
          const server = createServer(async (request, response) => {
            let body = "";
            for await (const chunk of request) body += String(chunk);
            const payload = JSON.parse(body) as {
              stream?: boolean;
              messages: { role: string; content?: unknown }[];
              tools?: { function: { name: string; description?: string } }[];
            };
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
                      message: { role: "assistant", content: "Skill Test" },
                      finish_reason: "stop",
                    },
                  ],
                }),
              );
              return;
            }
            if (payload.tools?.length === 0 || payload.tools === undefined) {
              response.writeHead(200, { "content-type": "text/event-stream" });
              response.end(
                `data: ${JSON.stringify({ id: "background", object: "chat.completion.chunk", created: 1, model: "echo", choices: [{ index: 0, delta: { role: "assistant", content: "Skill Test" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
              );
              return;
            }
            const messages = JSON.stringify(payload.messages);
            const latest = payload.messages.filter((item) => item.role === "tool").at(-1);
            if (latest) results.push(JSON.stringify(latest.content));
            const skillPath = messages.match(
              /\/[^\s"<>]*\/config\/opencode\/skills\/manage-pragma/,
            )?.[0];
            const tools = payload.tools ?? [];
            const name =
              step === 0
                ? "skill"
                : step === 1
                  ? "read"
                  : step === 2
                    ? "pragma_tools_permission_probe"
                    : major === 1
                      ? "bash"
                      : "shell";
            const args =
              step === 0
                ? major === 1
                  ? { name: "manage-pragma" }
                  : { id: "manage-pragma" }
                : step === 1
                  ? major === 1
                    ? { filePath: `${skillPath}/references/skills.md` }
                    : { path: `${skillPath}/references/skills.md` }
                  : step === 2
                    ? {}
                    : {
                        command: "printf SHELL_OK > shell-result.txt",
                        description: "Write the native shell probe result",
                      };
            const tool = tools.find((item) => item.function.name === name);
            response.writeHead(200, { "content-type": "text/event-stream" });
            const chunk = (delta: unknown, finish: string | null = null) =>
              response.write(
                `data: ${JSON.stringify({ id: `completion-${step}`, object: "chat.completion.chunk", created: 1, model: "echo", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
              );
            if (step < 4) {
              // V2 may expose native tools through Code Mode rather than individual functions.
              const execute = tools.find((item) => item.function.name === "execute");
              const selected = tool ?? execute;
              if (selected === undefined) {
                results.push(`MISSING TOOL ${name}: ${JSON.stringify(tools)}`);
                chunk({ role: "assistant", content: "missing tool" }, "stop");
              } else {
                if (step === 0) results.push(JSON.stringify(tools));
                const parameters = tool
                  ? args
                  : { code: `return await tools.${name}(${JSON.stringify(args)});` };
                chunk({
                  role: "assistant",
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${step}`,
                      type: "function",
                      function: {
                        name: selected.function.name,
                        arguments: JSON.stringify(parameters),
                      },
                    },
                  ],
                });
                chunk({}, "tool_calls");
              }
            } else chunk({ role: "assistant", content: "Skill and shell complete." }, "stop");
            step++;
            response.end("data: [DONE]\n\n");
          });
          await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
          const address = server.address();
          if (address === null || typeof address === "string") throw new Error("No provider port");
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
          const source = join(root, "source");
          await mkdir(join(source, "references"), { recursive: true });
          await writeFile(
            join(source, "SKILL.md"),
            "---\nname: manage-pragma\ndescription: Manage Pragma resources\n---\nSKILL_BODY_MARKER. Read references/skills.md, then execute the shell probe.",
          );
          await writeFile(join(source, "references", "skills.md"), "REFERENCE_BODY_MARKER");
          const runtime = createOpenCodeRuntime({
            executablePath: executablePath!,
            tokenCounter: createRuntimeTokenCounter(),
            permissionMode: mode,
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
            automaticHumanInteractionHandler: async (request) =>
              request.kind === "tool_approval" && mode !== "request-approval"
                ? { kind: "tool_approval", approved: true }
                : undefined,
            runtimes: createStaticRuntimeResolver({
              runtimes: [runtime],
              defaultRuntimeId: runtime.descriptor.id,
            }),
          });
          const expert = await defineExpert({
            id: "skill-probe",
            name: "Skill Probe",
            description: "Test",
            scope: "test",
            tags: [],
            workspace: root,
            tools: [
              {
                name: "permission_probe",
                description: "Write the managed MCP probe marker",
                inputSchema: { type: "object", properties: {} },
                approval: { mode: "required" },
                async call() {
                  mcpCalls++;
                  await writeFile(join(root, "mcp-result.txt"), "MCP_OK");
                  return createTextToolResult("MCP_RESULT_MARKER");
                },
              },
            ],
            skills: {
              skills: [
                {
                  type: "local",
                  name: "Manage Pragma",
                  description: "Manage Pragma resources",
                  path: source,
                },
              ],
            },
          });
          let session = await app.experts.createSession(expert);
          const run = async (
            prompt: string,
            approved = true,
            updatedInput?: unknown,
            nativeRejection = false,
          ) => {
            const turn = await session.prompt(prompt);
            const events = await turn.subscribeEvents();
            const approve = (async () => {
              for await (const event of events) {
                if (event.type !== "human.requested" || mode !== "request-approval") continue;
                approvals++;
                approvalTools.push(
                  (event.data as { request: { toolName: string } }).request.toolName,
                );
                await turn.respondToHumanInteraction(
                  (event.data as { interactionId: string }).interactionId,
                  {
                    kind: "tool_approval",
                    approved,
                    ...(updatedInput === undefined ? {} : { updatedInput }),
                  },
                  { requestId: `approve-${approvals}` },
                );
              }
            })();
            try {
              if (nativeRejection) {
                // Native versions may settle with an explanation or terminate the
                // turn after rejection. Approval identity and filesystem checks
                // below independently prove that the shell path was exercised.
                await turn.result.catch((error: unknown) => {
                  expect(error).toBeInstanceOf(Error);
                  expect((error as Error).message).toMatch(/OpenCode turn/);
                });
              } else if (approved) {
                expect(await turn.result, results.join("\n")).toBe("Skill and shell complete.");
              } else {
                await expect(turn.result).rejects.toThrow(/OpenCode turn/);
              }
              await approve;
              await turn.settled;
            } finally {
              await events.close();
            }
          };
          try {
            await run("Load manage-pragma, read its reference and run the shell probe.");
            expect(results.join("\n")).toContain("SKILL_BODY_MARKER");
            expect(results.join("\n")).toContain("REFERENCE_BODY_MARKER");
            expect(await readFile(join(root, "shell-result.txt"), "utf8")).toBe("SHELL_OK");
            expect(approvals).toBe(mode === "request-approval" ? 2 : 0);
            expect(mcpCalls).toBe(1);
            expect(results.join("\n")).toContain("MCP_RESULT_MARKER");
            await session.releaseAfterTerminal();
            session = await app.experts.resumeSession(expert, { sessionId: session.sessionId });
            step = 0;
            results.length = 0;
            await rm(join(root, "shell-result.txt"));
            await run("Load the skill and repeat the probe after restoring the session.");
            expect(results.join("\n")).toContain("SKILL_BODY_MARKER");
            expect(results.join("\n")).toContain("REFERENCE_BODY_MARKER");
            expect(await readFile(join(root, "shell-result.txt"), "utf8")).toBe("SHELL_OK");
            expect(approvals).toBe(mode === "request-approval" ? 4 : 0);
            expect(mcpCalls).toBe(2);
            if (mode === "request-approval") {
              step = 2;
              await rm(join(root, "shell-result.txt"));
              await rm(join(root, "mcp-result.txt"));
              await run("Run the shell probe again, this time with Host rejection.", false);
              await expect(readFile(join(root, "shell-result.txt"))).rejects.toMatchObject({
                code: "ENOENT",
              });
              expect(mcpCalls).toBe(2);
              await expect(readFile(join(root, "mcp-result.txt"))).rejects.toMatchObject({
                code: "ENOENT",
              });
              // Start directly at shell, independently of the MCP refusal above.
              for (const decision of ["reject", "edit"] as const) {
                await session.resumePromptQueue();
                step = 3;
                const before = approvals;
                await run(
                  "Call the shell probe directly.",
                  decision === "edit",
                  decision === "edit"
                    ? { command: "printf REPLACED > replacement-result.txt" }
                    : undefined,
                  true,
                );
                expect(approvals).toBe(before + 1);
                expect(approvalTools.at(-1)).toBe(major === 1 ? "bash" : "shell");
                await expect(readFile(join(root, "shell-result.txt"))).rejects.toMatchObject({
                  code: "ENOENT",
                });
                await expect(readFile(join(root, "replacement-result.txt"))).rejects.toMatchObject({
                  code: "ENOENT",
                });
              }
              await session.resumePromptQueue();
              step = 3;
              const beforeRetry = approvals;
              await run("Approve a new shell probe after rejection.");
              expect(approvals).toBe(beforeRetry + 1);
              expect(approvalTools.at(-1)).toBe(major === 1 ? "bash" : "shell");
              expect(await readFile(join(root, "shell-result.txt"), "utf8")).toBe("SHELL_OK");
              step = 0;
              await run("Retry the probes after the previous rejection.");
              expect(mcpCalls).toBe(3);
              expect(await readFile(join(root, "shell-result.txt"), "utf8")).toBe("SHELL_OK");
            }
          } finally {
            await session.close();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await rm(root, { recursive: true, force: true });
          }
        },
        90_000,
      );
    },
  );
}
