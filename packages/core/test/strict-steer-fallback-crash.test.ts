import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFileExecutionStore,
  createFileExpertSessionStore,
  createPragma,
  createStaticRuntimeResolver,
  defineExpert,
  defineRuntimeDriver,
  type RuntimeNativeSessionContext,
} from "../src/index.ts";
import { createRuntimeTestFeatures } from "../src/testing/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

interface FixtureSession {
  readonly context: RuntimeNativeSessionContext;
  readonly id: string;
}

describe("strict steer fallback crash recovery", () => {
  it("replays a durable not-dispatched strict fallback after a crash without native redelivery", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-strict-fallback-crash-"));
    roots.push(pragmaHome);
    const sessionId = "strict-fallback-crash-session";
    const repositoryRoot = join(import.meta.dirname, "..", "..", "..");
    const tsxLoader = await resolveTsxLoader(repositoryRoot);
    const child = spawn(
      process.execPath,
      [
        "--import",
        tsxLoader,
        fileURLToPath(new URL("./fixtures/queue-steer-crash.ts", import.meta.url)),
        "seed",
        pragmaHome,
        sessionId,
        "strict-fallback",
      ],
      { cwd: repositoryRoot, detached: process.platform !== "win32", stdio: "pipe" },
    );
    let releaseActive!: () => void;
    const activeGate = new Promise<void>((resolve) => {
      releaseActive = resolve;
    });
    let markActiveStarted!: () => void;
    const activeStarted = new Promise<void>((resolve) => {
      markActiveStarted = resolve;
    });
    let nativeSteers = 0;
    try {
      await waitForLine(child, "fallback-ready");
      child.stdin.end("crash\n");
      await waitForExit(child);
      expect(child.signalCode).toBe("SIGKILL");
      const executions = createFileExecutionStore({ pragmaHome });
      const sessions = createFileExpertSessionStore({ executions, pragmaHome });
      const app = createPragma({
        pragmaHome,
        executionStore: executions,
        expertSessionStore: sessions,
        runtimes: createStaticRuntimeResolver({
          runtimes: [
            createRecoveryRuntime({
              onSteer: () => {
                nativeSteers += 1;
              },
              onTurn: async (query) => {
                if (query === "after-crash") {
                  markActiveStarted();
                  await activeGate;
                }
              },
            }),
          ],
          defaultRuntimeId: "queue-steer-crash-runtime",
        }),
      });
      const expert = await defineExpert({
        id: "queue-steer-crash-expert",
        name: "Queue steer crash expert",
        description: "Exercises durable queue steer recovery.",
        tags: [],
        scope: "test",
        workspace: pragmaHome,
      });
      const recovered = await app.experts.resumeSession(expert, { sessionId });
      try {
        expect(
          (await recovered.getPromptQueue()).find((p) => p.requestId === "redirect"),
        ).toMatchObject({
          mode: "steer",
          status: "failed",
          deliveryAttempt: { state: "not_dispatched" },
        });
        const active = await recovered.prompt("after-crash", { requestId: "after-crash" });
        await recovered.resumePromptQueue();
        await activeStarted;
        await vi.waitFor(async () => expect((await active.getState()).status).toBe("running"));
        await expect(
          recovered.prompt("different", {
            requestId: "redirect",
            mode: "steer",
            steerFallback: "enqueue",
          }),
        ).rejects.toThrow("Prompt idempotency conflict");
        await expect(
          recovered.prompt("redirect", { requestId: "redirect", mode: "steer" }),
        ).rejects.toThrow("Native turn has ended.");
        const fallback = await recovered.prompt("redirect", {
          requestId: "redirect",
          mode: "steer",
          steerFallback: "enqueue",
        });
        expect(fallback).toMatchObject({ requestedMode: "steer", effectiveMode: "enqueue" });
        expect(nativeSteers).toBe(0);
        expect(
          (await recovered.getPromptQueue()).filter((p) => p.requestId === "redirect"),
        ).toHaveLength(1);
        const duplicate = await recovered.prompt("redirect", { requestId: "redirect" });
        expect(duplicate.executionId).toBe(fallback.executionId);
        expect((await active.getState()).status).toBe("running");
        releaseActive();
        await active.result;
        await expect(fallback.result).resolves.toBe("recovery");
        const state = await recovered.getState();
        expect(state.executionIds.filter((id) => id === fallback.executionId)).toHaveLength(1);
        expect(nativeSteers).toBe(0);
      } finally {
        releaseActive();
        await recovered.close();
      }
    } finally {
      releaseActive();
      if (child.exitCode === null && child.signalCode === null) killProcessTree(child, "SIGKILL");
    }
  }, 20_000);
});

function createRecoveryRuntime(
  hooks: {
    readonly onSteer?: () => void;
    readonly onTurn?: (query: string) => Promise<void>;
  } = {},
) {
  return defineRuntimeDriver<never, FixtureSession>({
    features: createRuntimeTestFeatures({ enabled: ["cancellation", "close", "steering"] }),
    descriptor: {
      id: "queue-steer-crash-runtime",
      kind: "fake",
      displayName: "Queue steer crash runtime",
    },
    createSession: async (context) => ({
      context,
      id: `native-${context.systemSessionId}`,
    }),
    restoreSession: (context) => ({
      context,
      id: context.request.runtimeSession!.id,
    }),
    readSession: (session) => ({ runtimeSessionId: session.id }),
    startTurn: async (_session, turn) => {
      await hooks.onTurn?.(turn.rawQuery);
      return { outputText: "recovery", runtimeSessionId: "recovery" };
    },
    steerTurn: () => hooks.onSteer?.(),
    mapEvent: () => ({ events: [] }),
    cancelTurn: () => undefined,
    closeSession: () => undefined,
  });
}

async function waitForLine(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const finish = (callback: () => void) => {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      callback();
    };
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.split("\n").includes(expected)) finish(resolve);
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onExit = () =>
      finish(() => reject(new Error(`Queue steer crash fixture exited early: ${stderr}`)));
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function killProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // The fixture may have exited between the state marker and the kill.
  }
}

async function resolveTsxLoader(repositoryRoot: string): Promise<string> {
  const launcher = await readFile(join(repositoryRoot, "node_modules", ".bin", "tsx"), "utf8");
  const match = launcher.match(/node_modules\/\.pnpm\/([^/]+)\/node_modules\/tsx/u);
  if (match?.[1] === undefined) throw new Error("Could not locate the repository tsx loader.");
  return join(
    repositoryRoot,
    "node_modules",
    ".pnpm",
    match[1],
    "node_modules",
    "tsx",
    "dist",
    "loader.mjs",
  );
}
