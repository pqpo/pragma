import {
  createNoopLoggerProvider,
  createPragma,
  createStaticRuntimeResolver,
  defineExpert,
} from "@pragma/core";
import { createInMemoryExecutionStore } from "@pragma/core/testing";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCodexRuntime } from "../src/adapter.ts";
import { createAppServerFixture } from "./app-server-fixture.ts";

describe("Codex permissions across native Session restoration", () => {
  it.each(["request-approval", "auto-approve", "full-access"] as const)(
    "passes current policy on start, resume and retry in %s",
    async (initialMode) => {
      const home = await mkdtemp(join(tmpdir(), "pragma-codex-permissions-"));
      const source = join(home, "source");
      await mkdir(source);
      let mode: string = initialMode;
      const peers: ReturnType<typeof createAppServerFixture>[] = [];
      const runtime = createCodexRuntime({
        env: { CODEX_HOME: source },
        listModels: async () => [],
        get sandboxMode() {
          return mode === "full-access" ? "danger-full-access" : "workspace-write";
        },
        get approvalPolicy() {
          return mode === "full-access" ? "never" : "on-request";
        },
        spawn(command, args, options) {
          const peer = createAppServerFixture();
          peers.push(peer);
          const native = join(options.env["CODEX_HOME"]!, "sessions");
          mkdirSync(native, { recursive: true });
          writeFileSync(join(native, "rollout-thread-1.jsonl"), "");
          return peer.spawn(command, args, options);
        },
      });
      const app = createPragma({
        pragmaHome: home,
        executionStore: createInMemoryExecutionStore(),
        loggerProvider: createNoopLoggerProvider(),
        runtimes: createStaticRuntimeResolver({
          runtimes: [runtime],
          defaultRuntimeId: runtime.descriptor.id,
        }),
        automaticHumanInteractionHandler: async (request) =>
          request.kind === "tool_approval" && mode !== "request-approval"
            ? { kind: "tool_approval", approved: true }
            : undefined,
      });
      const expert = await defineExpert({
        id: "permissions",
        name: "Permissions",
        description: "Test",
        scope: "test",
        tags: [],
        workspace: home,
      });
      let session = await app.experts.createSession(expert);
      const run = async (approved: boolean) => {
        const previous = peers.at(-1);
        const previousCount =
          previous?.requests.filter((request) => request.method === "turn/start").length ?? 0;
        const turn = await session.prompt("Run a native shell command.");
        await vi.waitFor(() => {
          const peer = peers.at(-1);
          const count =
            peer?.requests.filter((request) => request.method === "turn/start").length ?? 0;
          expect(peer !== previous ? count > 0 : count > previousCount).toBe(true);
        });
        const peer = peers.at(-1)!;
        const count = peer.requests.filter((request) => request.method === "turn/start").length;
        const events = await turn.subscribeEvents();
        const decisions = (async () => {
          for await (const event of events) {
            if (event.type === "human.requested" && mode === "request-approval")
              await turn.respondToHumanInteraction(
                (event.data as { interactionId: string }).interactionId,
                { kind: "tool_approval", approved },
                { requestId: `response-${turn.executionId}` },
              );
          }
        })();
        const id = 1000 + count;
        peer.write({
          id,
          method: "item/commandExecution/requestApproval",
          params: { threadId: "thread-1", turnId: `turn-${count}`, command: "printf native" },
        });
        await vi.waitFor(() => expect(peer.responses.some((item) => item["id"] === id)).toBe(true));
        expect(peer.responses.find((item) => item["id"] === id)?.["result"]).toMatchObject({
          decision: mode !== "request-approval" || approved ? "accept" : "reject",
        });
        peer.completeTurn(`turn-${count}`, approved ? "done" : "denied");
        await turn.result;
        await turn.settled;
        await decisions;
        await events.close();
      };
      try {
        await run(true);
        expect(
          peers[0]!.requests.find((request) => request.method === "thread/start")?.params,
        ).toMatchObject({
          sandbox: initialMode === "full-access" ? "danger-full-access" : "workspace-write",
          approvalPolicy: initialMode === "full-access" ? "never" : "on-request",
        });
        if (initialMode === "request-approval") {
          await run(false);
          await run(true);
        }
        await session.releaseAfterTerminal();
        session = await app.experts.resumeSession(expert, { sessionId: session.sessionId });
        await run(true);
        expect(
          peers[1]!.requests.find((request) => request.method === "thread/resume")?.params,
        ).toMatchObject({
          sandbox: initialMode === "full-access" ? "danger-full-access" : "workspace-write",
          approvalPolicy: initialMode === "full-access" ? "never" : "on-request",
        });
        await session.releaseAfterTerminal();
        mode = initialMode === "full-access" ? "request-approval" : "full-access";
        session = await app.experts.resumeSession(expert, { sessionId: session.sessionId });
        await run(true);
        expect(
          peers[2]!.requests.find((request) => request.method === "thread/resume")?.params,
        ).toMatchObject({
          threadId: "thread-1",
          sandbox: mode === "full-access" ? "danger-full-access" : "workspace-write",
          approvalPolicy: mode === "full-access" ? "never" : "on-request",
        });
        if (mode === "request-approval") {
          await run(false);
          await run(true);
        }
      } finally {
        await session.close();
        await rm(home, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
