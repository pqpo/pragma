import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode } from "@opencode/client";
import {
  createPragma,
  createRuntimeTokenCounter,
  createFileExecutionStore,
  createStaticRuntimeResolver,
  defineExpert,
  SteerNotDispatchedError,
} from "@pragma/core";
import { describe, expect, it, vi } from "vitest";
import { createOpenCodeRuntime } from "../src/adapter.ts";
import { connectOpenCode } from "../src/client.ts";
import { prepareOpenCodeConfiguration } from "../src/configuration.ts";
import { prepareOpenCodeDataHome } from "../src/data-home.ts";
import { startOpenCodeProcess } from "../src/process.ts";
import { openCodeSteerMessageId } from "../src/steering.ts";

const executablePath = process.env["PRAGMA_OPENCODE_V2_PATH"];
describe.runIf(executablePath !== undefined)("OpenCode 2.x real steering", () => {
  it.each([true, false])(
    "steers in its original execution without replay (reported usage: %s)",
    async (reportedUsage) => {
      const f = await fixture(reportedUsage);
      const tokenCounter = createRuntimeTokenCounter();
      const countText = vi.spyOn(tokenCounter, "countText");
      const runtime = createOpenCodeRuntime({
        executablePath: executablePath!,
        env: f.env,
        permissionMode: "full-access",
        tokenCounter,
      });
      const app = createPragma({
        pragmaHome: join(f.root, "pragma"),
        runtimes: createStaticRuntimeResolver({
          runtimes: [runtime],
          defaultRuntimeId: runtime.descriptor.id,
        }),
      });
      const expert = await defineExpert({
        id: "steering-probe",
        name: "Steering Probe",
        description: "Synthetic provider test",
        scope: "test",
        tags: [],
        workspace: f.root,
      });
      const session = await app.experts.createSession(expert);
      try {
        const active = await session.prompt("INITIAL_MARKER");
        await vi.waitFor(() => expect(f.requests.length).toBeGreaterThan(0), { timeout: 60_000 });
        const queued = await session.prompt("STEER_MARKER");
        await expect(session.attemptQueuedPromptSteer(queued.requestId)).resolves.toMatchObject({
          outcome: "steered",
          turn: { executionId: active.executionId },
        });
        f.release();
        await expect(active.result).resolves.toBe("Steered reply.");
        expect(f.requests.some((input) => JSON.stringify(input).includes("STEER_MARKER"))).toBe(
          true,
        );
        expect(
          (await session.getPromptQueue()).find((item) => item.requestId === queued.requestId),
        ).toMatchObject({ status: "succeeded", deliveryAttempt: { state: "confirmed" } });
        if (reportedUsage) {
          expect(await active.usage).toMatchObject({
            measurement: "reported",
            input: 34,
            output: 8,
          });
          expect(countText).not.toHaveBeenCalled();
        } else {
          expect(await active.usage).toMatchObject({ measurement: "estimated" });
          expect(countText.mock.calls[0]?.[0]).toContain("STEER_MARKER");
          expect(countText.mock.calls[1]?.[0]).toContain("Initial reply.");
          expect(countText.mock.calls[1]?.[0]).toContain("Steered reply.");
        }
        const count = f.requests.length;
        await (
          await session.prompt("NEXT_MARKER")
        ).result;
        expect(f.requests.length - count).toBe(1);
        expect(
          (
            await createFileExecutionStore({ pragmaHome: join(f.root, "pragma") }).get(
              queued.executionId,
            )
          )?.status,
        ).toBe("cancelled");
      } finally {
        f.release();
        await session.close();
        tokenCounter.dispose();
        await f.close();
      }
    },
    90_000,
  );

  it("reconciles pending and delivered receipts across private-server restart", async () => {
    const f = await fixture();
    f.release();
    const sessionDir = join(f.root, "native-session");
    const configured = await prepareOpenCodeConfiguration({
      env: await prepareOpenCodeDataHome(f.env, sessionDir),
      workspace: f.root,
      sessionDir,
      major: 2,
    });
    const start = async () =>
      await startOpenCodeProcess({
        executablePath: executablePath!,
        env: configured.env,
        cwd: f.root,
        major: 2,
        version: "2.0.16",
      });
    const native = await start();
    const client = connectOpenCode(native, f.root);
    try {
      const id = await client.createSession("", "Steering probe", [
        { action: "*", resource: "*", effect: "allow" },
      ]);
      const delivered = {
        requestId: "delivered",
        targetRunId: "target",
        attemptId: "attempt",
        content: "DELIVERED_MARKER",
      };
      const pending = { ...delivered, requestId: "pending", content: "PENDING_MARKER" };
      const sdk = OpenCode.make({ baseUrl: native.url, headers: { ...native.headers } });
      await sdk.session.update({ sessionID: id, title: "Pragma Steering Test" });
      const inject = async (request: typeof delivered, resume: boolean) =>
        await sdk.session.synthetic({
          sessionID: id,
          id: openCodeSteerMessageId(id, request),
          text: request.content,
          metadata: {
            "pragma.steering": {
              version: 1,
              requestId: request.requestId,
              targetRunId: request.targetRunId,
              attemptId: request.attemptId,
            },
          },
          delivery: "steer",
          resume,
        });
      await inject(delivered, true);
      await sdk.session.wait({ sessionID: id });
      await inject(pending, false);
      await client.close();
      const restored = connectOpenCode(await start(), f.root);
      try {
        await restored.createSession(id, "Steering probe", [
          { action: "*", resource: "*", effect: "allow" },
        ]);
        await expect(restored.reconcileSteer(id, delivered)).resolves.toBe("delivered");
        await expect(restored.reconcileSteer(id, pending)).resolves.toBe("not_dispatched");
        await expect(
          restored.reconcileSteer(id, { ...pending, requestId: "never-admitted" }),
        ).resolves.toBe("uncertain");
        const count = f.requests.length;
        await restored.prompt({
          sessionId: id,
          runId: "next",
          text: "NEXT_MARKER",
          files: [],
          signal: AbortSignal.timeout(15_000),
          onEvent() {},
        });
        expect(f.requests.length - count).toBe(1);
        expect(JSON.stringify(f.requests.at(-1))).not.toContain("PENDING_MARKER");
        await expect(
          restored.steer(id, { ...delivered, targetRunId: "next" }),
        ).rejects.toBeInstanceOf(SteerNotDispatchedError);
      } finally {
        await restored.close();
      }
    } finally {
      await client.close();
      await f.close();
    }
  }, 90_000);
  it("stops an owned server after a lost native receipt and reconciles without resending", async () => {
    const f = await fixture();
    const sessionDir = join(f.root, "native-session");
    const configured = await prepareOpenCodeConfiguration({
      env: await prepareOpenCodeDataHome(f.env, sessionDir),
      workspace: f.root,
      sessionDir,
      major: 2,
    });
    const start = async () =>
      await startOpenCodeProcess({
        executablePath: executablePath!,
        env: configured.env,
        cwd: f.root,
        major: 2,
        version: "2.0.16",
      });
    const native = await start();
    let admissions = 0;
    const proxy = createServer((request, response) => {
      const upstream = httpRequest(
        new URL(request.url ?? "/", native.url),
        { method: request.method, headers: request.headers },
        (incoming) => {
          if (request.url?.endsWith("/synthetic") && incoming.statusCode === 200) {
            admissions += 1;
            incoming.resume();
            incoming.once("end", () => response.destroy());
            return;
          }
          response.writeHead(incoming.statusCode ?? 502, incoming.headers);
          incoming.pipe(response);
        },
      );
      upstream.on("error", () => response.destroy());
      response.on("close", () => upstream.destroy());
      request.pipe(upstream);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address();
    if (address === null || typeof address === "string") throw new Error("Proxy has no port.");
    const client = connectOpenCode({ ...native, url: `http://127.0.0.1:${address.port}` }, f.root);
    try {
      const id = await client.createSession("", "Steering probe", [
        { action: "*", resource: "*", effect: "allow" },
      ]);
      const prompt = client.prompt({
        sessionId: id,
        runId: "original",
        text: "INITIAL_MARKER",
        files: [],
        signal: AbortSignal.timeout(90_000),
        onEvent() {},
      });
      const failure = prompt.then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(f.requests.length).toBeGreaterThan(0), { timeout: 60_000 });
      const instruction = {
        requestId: "lost-receipt",
        targetRunId: "original",
        attemptId: "attempt",
        content: "LOST_RECEIPT_MARKER",
      };
      await expect(client.steer(id, instruction)).rejects.toThrow(/could not be confirmed/);
      expect(admissions).toBe(1);
      await failure;
      expect(native.child.exitCode !== null || native.child.signalCode !== null).toBe(true);
      await expect(
        client.prompt({
          sessionId: id,
          runId: "next",
          text: "NEXT_MARKER",
          files: [],
          signal: AbortSignal.timeout(5_000),
          onEvent() {},
        }),
      ).rejects.toThrow(/reconciliation/);
      f.release();
      const restored = connectOpenCode(await start(), f.root);
      try {
        await restored.createSession(id, "Steering probe", [
          { action: "*", resource: "*", effect: "allow" },
        ]);
        const outcome = await restored.reconcileSteer(id, instruction);
        expect(["delivered", "not_dispatched"]).toContain(outcome);
        expect(admissions).toBe(1);
      } finally {
        await restored.close();
      }
    } finally {
      f.release();
      await client.close();
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await f.close();
    }
  }, 90_000);
});

async function fixture(reportedUsage = true) {
  const root = await mkdtemp(join(tmpdir(), "pragma-opencode-steering-"));
  const requests: unknown[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createServer(async (request, response) => {
    if (request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const payload = JSON.parse(body) as { stream?: boolean };
    // Native title generation is a separate, non-streaming request, not an Agent turn.
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
              message: { role: "assistant", content: "Steering Test" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
      return;
    }
    requests.push(payload);
    await held;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = {
      id: `chatcmpl-${requests.length}`,
      object: "chat.completion.chunk",
      created: 1,
      model: "echo",
    };
    response.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: body.includes("STEER_MARKER") ? "Steered reply." : "Initial reply." }, finish_reason: null }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], ...(reportedUsage ? { usage: { prompt_tokens: 17, completion_tokens: 4, total_tokens: 21 } } : {}) })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Provider has no port.");
  await mkdir(join(root, "config", "opencode"), { recursive: true });
  await writeFile(
    join(root, "config", "opencode", "opencode.jsonc"),
    JSON.stringify({
      model: "pragma_mock/echo",
      providers: {
        pragma_mock: {
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: "test" },
          models: { echo: { name: "Echo", limit: { context: 128000, output: 4096 } } },
        },
      },
    }),
  );
  return {
    root,
    requests,
    release,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_DATA_HOME: join(root, "data"),
      XDG_CACHE_HOME: join(root, "cache"),
    },
    async close() {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
