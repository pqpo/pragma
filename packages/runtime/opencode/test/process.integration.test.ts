import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { connectOpenCode } from "../src/client.ts";
import { prepareOpenCodeDataHome } from "../src/data-home.ts";
import { probeOpenCode, startOpenCodeProcess } from "../src/process.ts";

for (const [major, variable] of [
  [1, "PRAGMA_OPENCODE_V1_PATH"],
  [2, "PRAGMA_OPENCODE_V2_PATH"],
] as const) {
  const executablePath = process.env[variable];
  describe.runIf(executablePath !== undefined)(`OpenCode ${major}.x CLI integration`, () => {
    it("starts a private server, resumes a session, and keeps Pragma MCP out of the project config", async () => {
      const root = await mkdtemp(join(tmpdir(), `pragma-opencode-v${major}-`));
      const env = {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"),
      };
      try {
        const detected = await probeOpenCode(executablePath!, env);
        expect(detected.major).toBe(major);
        const sessionEnv = await prepareOpenCodeDataHome(env, join(root, "pragma-session"));
        expect(sessionEnv["XDG_DATA_HOME"]).toBe(join(root, "pragma-session", "data"));
        const native = await startOpenCodeProcess({
          executablePath: executablePath!,
          env: sessionEnv,
          cwd: root,
          ...detected,
          permissionMode: "request-approval",
          mcpUrl: "http://127.0.0.1:9/mcp",
        });
        const client = connectOpenCode(native, root);
        let sessionId = "";
        try {
          sessionId = await client.createSession("", "Pragma integration test", [
            { action: "*", resource: "*", effect: "ask" },
          ]);
          expect(sessionId).not.toBe("");
          expect(await client.createSession(sessionId, "Pragma integration test", [])).toBe(
            sessionId,
          );
          expect(await client.createSession(sessionId, "", [])).toBe(sessionId);
          expect(Array.isArray(await client.listModels())).toBe(true);
          if (major === 2) await client.addMcp("pragma_tools", "http://127.0.0.1:9/mcp");
        } finally {
          await client.close();
        }
        const resumed = await startOpenCodeProcess({
          executablePath: executablePath!,
          env: sessionEnv,
          cwd: root,
          ...detected,
        });
        const restoredClient = connectOpenCode(resumed, root);
        try {
          expect(await restoredClient.createSession(sessionId, "Pragma integration test", [])).toBe(
            sessionId,
          );
          const otherDirectory = join(root, "other");
          await mkdir(otherDirectory);
          await expect(
            connectOpenCode(resumed, otherDirectory).createSession(sessionId, "", []),
          ).rejects.toThrow(/workspace/);
        } finally {
          await restoredClient.close();
        }
        expect(await readdir(root)).not.toContain("opencode.jsonc");
        const configPath = join(root, "config", "opencode", "opencode.jsonc");
        expect(await readFile(configPath, "utf8").catch(() => "")).not.toContain("pragma_tools");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }, 30_000);
  });
}

describe("OpenCode process startup", () => {
  it("reports a missing executable instead of leaving an unhandled child error", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-opencode-missing-"));
    try {
      await expect(
        startOpenCodeProcess({
          executablePath: join(root, "missing-opencode"),
          env: process.env,
          cwd: root,
          major: 1,
          version: "1.0.0",
        }),
      ).rejects.toThrow(/ENOENT/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});

for (const [major, variable] of [
  [1, "PRAGMA_OPENCODE_V1_PATH"],
  [2, "PRAGMA_OPENCODE_V2_PATH"],
] as const) {
  describe.runIf(process.env[variable] !== undefined)(`OpenCode ${major}.x model turn`, () => {
    it("streams a response through the real CLI and versioned client", async () => {
      const root = await mkdtemp(join(tmpdir(), `pragma-opencode-v${major}-turn-`));
      const endpoint = createServer((request, response) => {
        if (request.url !== "/v1/chat/completions") {
          response.writeHead(404).end();
          return;
        }
        request.resume();
        request.on("end", () => {
          response.writeHead(200, { "content-type": "text/event-stream" });
          const base = {
            id: "chatcmpl-test",
            object: "chat.completion.chunk",
            created: 1,
            model: "echo",
          };
          response.write(
            `data: ${JSON.stringify({
              ...base,
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "Hello from mock model." },
                  finish_reason: null,
                },
              ],
            })}\n\n`,
          );
          response.write(
            `data: ${JSON.stringify({
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\n`,
          );
          response.end("data: [DONE]\n\n");
        });
      });
      await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
      const address = endpoint.address();
      if (address === null || typeof address === "string")
        throw new Error("Mock provider has no port.");
      const env = {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_DATA_HOME: join(root, "data"),
        XDG_CACHE_HOME: join(root, "cache"),
      };
      try {
        const model = { echo: { name: "Echo", limit: { context: 128000, output: 4096 } } };
        await writeFile(
          join(root, "opencode.jsonc"),
          JSON.stringify(
            major === 1
              ? {
                  model: "pragma_mock/echo",
                  provider: {
                    pragma_mock: {
                      npm: "@ai-sdk/openai-compatible",
                      name: "Mock",
                      options: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "test" },
                      models: model,
                    },
                  },
                }
              : {
                  model: "pragma_mock/echo",
                  providers: {
                    pragma_mock: {
                      package: "@opencode/ai/providers/openai-compatible",
                      settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "test" },
                      models: model,
                    },
                  },
                },
          ),
        );
        const native = await startOpenCodeProcess({
          executablePath: process.env[variable]!,
          env,
          cwd: root,
          major,
          version: major === 1 ? "1.18.32" : "2.0.16",
        });
        const client = connectOpenCode(native, root);
        try {
          expect(
            (await client.listModels()).some(
              (item) => item.providerId === "pragma_mock" && item.modelId === "echo",
            ),
          ).toBe(true);
          const sessionId = await client.createSession("", "Reply with one sentence.", [
            { action: "*", resource: "*", effect: "allow" },
          ]);
          const deltas: string[] = [];
          const output = await client.prompt({
            sessionId,
            text: "Say hello.",
            files: [],
            model: { providerId: "pragma_mock", modelId: "echo" },
            signal: AbortSignal.timeout(20_000),
            onEvent(event) {
              if (event.type === "session.text.delta") deltas.push(String(event.data["delta"]));
              if (event.type === "message.part.delta" && event.data["field"] === "text")
                deltas.push(String(event.data["delta"]));
            },
          });
          expect(output.text).toBe("Hello from mock model.");
          expect(deltas.join("")).toBe(output.text);
        } finally {
          await client.close();
        }
      } finally {
        await new Promise<void>((resolve) => endpoint.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      }
    }, 30_000);
  });
}
